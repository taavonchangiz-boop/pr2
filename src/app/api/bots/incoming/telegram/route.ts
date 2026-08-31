// POSTYAR — /api/bots/incoming/telegram
// Telegram Bot API webhook handler.
//
// Verification:
//   1. Look up Bot by `bid` query param.
//   2. Verify the `sig` query param matches HMAC("bot-webhook-sig", botId).
//   3. Compute HMAC of the RAW request body keyed by the decrypted
//      `webhookSecret`. Compare to either:
//      - `X-Telegram-Bot-Api-Secret-Token` header (Telegram's secret_token,
//        which we set when registering — preferred), OR
//      - Our body HMAC (defense in depth; used if the header is missing).
//      Either way: fail-closed if mismatch.
//   4. Parse update. If message or callback_query, dispatch to the workflow
//      engine for the bot's enabled workflows. Acknowledge with 200 OK so
//      Telegram doesn't retry.
//   5. Idempotent on update_id (24h cache + BotHistory.raw JSON-embedded
//      `_update_id` for forensic recovery).
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  hmacSign,
  constantTimeEqual,
} from "@/lib/security/crypto";
import {
  verifyWebhookSig,
  verifyTelegramSecretToken,
  computeWebhookBodySignature,
} from "@/lib/bots/register-webhook";
import { webhookRequestGuard, claimUpdateOnce } from "@/lib/bots/webhook-guard";
import { executeWorkflow } from "@/lib/bots/workflow";
import { audit } from "@/lib/server/auth";
import type { Bot, BotWorkflow } from "@prisma/client";

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat?: { id?: number };
    from?: { id?: number };
    text?: string;
    caption?: string;
    date?: number;
  };
  callback_query?: {
    id: string;
    from?: { id?: number };
    data?: string;
    message?: {
      message_id: number;
      chat?: { id?: number };
      text?: string;
    };
  };
}

export async function POST(req: Request) {
  // Hardening (audit W1): per-IP rate limit + body size cap BEFORE any
  // DB/HMAC work — the webhook URL is public and its identifiers are not
  // secrets from someone who has seen it.
  const guard = await webhookRequestGuard(req);
  if (guard) return guard;

  const url = new URL(req.url);
  const bid = url.searchParams.get("bid") ?? "";
  const sig = url.searchParams.get("sig") ?? "";
  if (!bid || !sig) {
    return NextResponse.json({ ok: false, errorFa: "پارامتر نادرست است." }, { status: 400 });
  }
  // Verify the sig (HMAC of botId) — does not leak the token.
  if (!verifyWebhookSig(bid, sig)) {
    return NextResponse.json({ ok: false, errorFa: "امضای نامعتبر." }, { status: 403 });
  }
  const bot = await db.bot.findUnique({ where: { id: bid } });
  if (!bot) {
    return NextResponse.json({ ok: false, errorFa: "ربات یافت نشد." }, { status: 404 });
  }
  if (bot.provider !== "telegram") {
    return NextResponse.json({ ok: false, errorFa: "پروایدر ناهماهنگ است." }, { status: 400 });
  }
  // Read raw body once — we need it for HMAC.
  const rawBody = await req.text();
  // Compute body HMAC keyed by the decrypted webhookSecret.
  const bodySig = await computeWebhookBodySignature(bot, rawBody);

  // Verify signature:
  // - If the `X-Telegram-Bot-Api-Secret-Token` header is present, it should
  //   equal our stored secret_token (set on registration). This is preferred.
  // - If the header is missing, fall back to a body HMAC.
  const tgHeader = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  let verified = false;
  if (tgHeader) {
    verified = await verifyTelegramSecretToken(bot, tgHeader);
  } else if (bodySig) {
    // Fallback: caller computes HMAC over body with same secret_token
    // (used by the polling endpoint, which is internal and can use the
    // same secret_token as the signing key).
    const providedSig = req.headers.get("x-postyar-body-sig") ?? "";
    verified = !!providedSig && constantTimeEqual(bodySig, providedSig);
  }
  if (!verified) {
    await audit({
      userId: bot.ownerId,
      actor: "webhook",
      action: "bot_webhook_signature_mismatch",
      targetType: "bot",
      targetId: bot.id,
      meta: { provider: "telegram", hadHeader: !!tgHeader },
    });
    // Return 200 so Telegram doesn't retry, but skip processing.
    return NextResponse.json({ ok: false }, { status: 200 });
  }

  // Parse JSON update.
  let update: TgUpdate;
  try {
    update = JSON.parse(rawBody) as TgUpdate;
  } catch {
    return NextResponse.json({ ok: false, errorFa: "بدنه وب‌هوک نامعتبر است." }, { status: 400 });
  }

  // Idempotency at the handler level (24h, ATOMIC claim — audit W2).
  // The workflow engine ALSO has its own dedup — but we check early to
  // skip workflow loading. The old get-then-set dedup allowed two
  // concurrent deliveries of the same update_id to both run workflows.
  const updateId = update.update_id;
  const firstDelivery = await claimUpdateOnce(bot.id, bot.provider, String(updateId));
  if (!firstDelivery) {
    // Already processed — ack 200 so Telegram doesn't retry.
    return NextResponse.json({ ok: true, duplicate: true });
  }

  // Extract chat id + incoming text
  let chatId = "";
  let incomingText = "";
  let callbackQueryId: string | undefined;
  if (update.message) {
    chatId = String(update.message.chat?.id ?? "");
    incomingText = update.message.text ?? update.message.caption ?? "";
  } else if (update.callback_query) {
    callbackQueryId = update.callback_query.id;
    chatId = String(update.callback_query.from?.id ?? update.callback_query.message?.chat?.id ?? "");
    incomingText = update.callback_query.data ?? "";
  }

  if (!chatId) {
    // Nothing we can do — but ack so Telegram doesn't retry.
    return NextResponse.json({ ok: true, noChat: true });
  }

  // If the incoming text starts with `POSTYAR-`, it's a link-code consumption
  // attempt — verify + consume.
  if (incomingText.startsWith("POSTYAR-")) {
    const { consumeLinkCode } = await import("@/lib/bots/link");
    const result = await consumeLinkCode({
      botId: bot.id,
      code: incomingText.trim(),
      providerUserId: chatId,
    });
    let reply = "";
    if (result.ok) {
      reply = "حساب پُست‌یار شما با موفقیت به این ربات متصل شد. اکنون می‌توانید از امکانات ربات استفاده کنید.";
    } else {
      reply = result.errorFa ?? "اتصال ناموفق بود.";
    }
    // Send the reply via the destination provider's publishMessage.
    const { getDestinationProvider } = await import("@/lib/providers");
    const { decryptString } = await import("@/lib/security/crypto");
    try {
      const token = decryptString(bot.botTokenEnc);
      const provider = getDestinationProvider("telegram");
      await provider.publishMessage({ botToken: token, chatId, text: reply });
      // Persist outbound
      await db.botHistory.create({
        data: {
          botId: bot.id,
          direction: "outbound",
          providerUserId: chatId,
          userId: result.userId ?? null,
          text: reply.slice(0, 4000),
        },
      });
    } catch { /* best-effort */ }
    return NextResponse.json({ ok: true, linkConsumed: result.ok });
  }

  // Otherwise, run enabled workflows that match this trigger.
  const workflows = await db.botWorkflow.findMany({
    where: { botId: bot.id, enabled: true },
    take: 50,
  });
  let matchedAny = false;
  for (const wf of workflows) {
    if (!matchesTrigger(wf, incomingText)) continue;
    try {
      const r = await executeWorkflow({
        bot,
        providerUserId: chatId,
        rawUpdate: update,
        incomingMessage: incomingText,
        callbackQueryId,
        updateId,
        workflow: wf,
      });
      if (r.matched) matchedAny = true;
    } catch (err) {
      await audit({
        userId: bot.ownerId,
        actor: "system",
        action: "bot_workflow_execute_failed",
        targetType: "bot",
        targetId: bot.id,
        meta: {
          workflowId: wf.id,
          name: err instanceof Error ? err.name : "Error",
        },
      });
    }
  }

  // If no workflow matched, persist the inbound only (for inbox forensics).
  if (!matchedAny) {
    try {
      await db.botHistory.create({
        data: {
          botId: bot.id,
          direction: "inbound",
          providerUserId: chatId,
          text: incomingText.slice(0, 4000),
          raw: JSON.stringify({
            _update_id: String(updateId),
            _payload: { message_id: update.message?.message_id ?? update.callback_query?.message?.message_id },
          }),
        },
      });
    } catch { /* ignore */ }
  }

  // Always 200 so Telegram doesn't retry.
  return NextResponse.json({ ok: true, matched: matchedAny });
}

function matchesTrigger(wf: BotWorkflow, incomingText: string): boolean {
  if (wf.triggerKind === "command") {
    if (!incomingText) return false;
    const val = (wf.triggerValue ?? "").trim().toLowerCase();
    if (!val) return false;
    // Telegram commands start with `/`
    return incomingText.toLowerCase().startsWith(`/${val}`);
  }
  if (wf.triggerKind === "callback") {
    if (!incomingText) return false;
    return incomingText === (wf.triggerValue ?? "");
  }
  // message — matches any inbound message
  return true;
}

// GET handler — for Telegram's webhook validation GET (some bots probe the
// URL after registration). Returns 200 OK + a small Persian payload.
export async function GET() {
  return NextResponse.json({ ok: true, service: "postyar-bot-webhook" });
}

void hmacSign; // referenced via verifyWebhookSig — kept for clarity
void executeWorkflow;
