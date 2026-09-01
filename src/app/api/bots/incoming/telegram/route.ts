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
//   5. C-04/H-03: DURABLY idempotent on update_id via the BotInboundEvent
//      inbox (UNIQUE bot+provider+event, lease + crash-recovery retry);
//      BotHistory.raw JSON-embedded `_update_id` stays for forensics.
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
import { webhookRequestGuard, readBoundedWebhookBody } from "@/lib/bots/webhook-guard";
import {
  ensureBotEvent,
  claimBotEventForOwner,
  finalizeBotEvent,
  failBotEvent,
  recoverBotEvents,
  runMatchedWorkflowsForEvent,
} from "@/lib/bots/event-dedup";
import type { WorkflowResumeContext } from "@/lib/bots/event-dedup";
import { executeWorkflow, persistInboundOnce, sendTrackedBotReply } from "@/lib/bots/workflow";
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
  // Read raw body once — we need it for HMAC. Streamed read with a hard
  // byte cap (M-5): a chunked/lying-length body cannot over-commit memory.
  const bodyRead = await readBoundedWebhookBody(req);
  if (!bodyRead.ok) {
    return NextResponse.json({ ok: false, errorFa: bodyRead.errorFa }, { status: 413 });
  }
  const rawBody = bodyRead.text;
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

  // C-04/H-03 — DURABLE event claim (DB inbox, replaces the volatile
  // cache.incr claim): duplicate deliveries are collapsed by the UNIQUE
  // constraint, a crash after the claim is recoverable (lease takeover +
  // bounded recovery pass on the next inbound request for this bot), and
  // completed events never execute again.
  const updateId = update.update_id;
  const event = await ensureBotEvent(bot, "telegram", String(updateId), update);
  const holder = await claimBotEventForOwner(event.id);
  if (!holder) {
    // Completed/owned elsewhere/stale-unclaimed — ack 200 so Telegram
    // doesn't retry; the durable inbox owns any retry.
    return NextResponse.json({ ok: true, duplicate: true });
  }
  try {
    await processTelegramUpdate(bot, update, { isRetry: event.attempts > 1, eventId: event.id, holder });
    // V5 C-02 — the durable event layer decides completion (all children
    // terminal-success), never this handler's return.
    const done = await finalizeBotEvent(event.id, holder);
    if (!done) {
      await failBotEvent(event.id, "تکمیل رویداد ممکن نبود: یک یا چند گردش کار هنوز کامل نشده است.", holder);
    }
  } catch (err) {
    await failBotEvent(
      event.id,
      err instanceof Error ? `${err.name}: ${err.message}` : "خطای پردازش رویداد.",
      holder,
    );
    // Still ack 200 — the durable inbox retries (provider redelivery or
    // the bounded recovery pass); a 500 would only add unbounded retries.
  }

  // Bounded crash-recovery pass for this bot (C-04/H-03): re-processes
  // failed/stale events from their stored payloads.
  await recoverBotEvents(bot, (b, payload, o) => processTelegramUpdate(b, payload as TgUpdate, o));

  return NextResponse.json({ ok: true });
}

/**
 * Provider-specific processing for one Telegram update — the single code
 * path used by BOTH live delivery and durable recovery. Replay-safety:
 * link-code consumption is one-time (DB UNIQUE), side-effecting workflow
 * actions carry deterministic idempotency keys, and per-event workflow
 * runs (BotWorkflowRun UNIQUE) prevent double execution.
 */
async function processTelegramUpdate(
  bot: Bot,
  update: TgUpdate,
  opts: { isRetry: boolean; eventId: string; holder?: string },
): Promise<void> {
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
    // Nothing we can do — the caller acks and completes the event.
    return;
  }

  // C-11/C-12 + V4 H-04: persist the inbound history row ONCE per event
  // (the old code persisted it inside executeWorkflow — once per matched
  // workflow). The UNIQUE inboundEventId makes this DB-idempotent, so it
  // runs on EVERY delivery — a durable retry after a crash-before-persist
  // heals the missing row instead of skipping it.
  await persistInboundOnce(bot, chatId, incomingText, update, update.update_id, undefined, opts.eventId);

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
    // V5 H-04 — the reply send is tracked: a durable pending BotHistory row
    // is written BEFORE the provider call and converged to
    // sent/failed/uncertain (+ providerMessageId) afterwards. The history
    // write is never swallowed by a bare `catch {}`.
    await sendTrackedBotReply(bot, chatId, reply, result.userId ?? null);
    return;
  }

  // Otherwise, run enabled workflows that match this trigger. Each
  // intended workflow gets a UNIQUE per-event run row: executed exactly
  // once per event, retried when failed, never repeated when completed.
  // V4 C-01: the callback returns the TYPED engine outcome — an
  // executeWorkflow ok:false is a genuine failure and keeps the run
  // retryable instead of being recorded as completed.
  // V4 C-02: runMatchedWorkflowsForEvent THROWS when any child failed,
  // so this handler fails the EVENT — event completion never implies
  // child completion, and recovery re-runs only the failed children.
  const workflows = await db.botWorkflow.findMany({
    where: { botId: bot.id, enabled: true },
    take: 50,
  });
  const jobs = workflows
    .filter((wf) => matchesTrigger(wf, incomingText))
    .map((wf) => ({
      workflowId: wf.id,
      execute: async (resume: WorkflowResumeContext) => {
        const r = await executeWorkflow({
          bot,
          providerUserId: chatId,
          rawUpdate: update,
          incomingMessage: incomingText,
          callbackQueryId,
          updateId: update.update_id,
          workflow: wf,
        }, resume);
        return { ok: r.ok, errorFa: r.errorFa, cursor: r.cursor };
      },
    }));
  await runMatchedWorkflowsForEvent(opts.eventId, jobs, { eventHolder: opts.holder });
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
