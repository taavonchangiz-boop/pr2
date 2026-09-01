// POSTYAR — /api/bots/incoming/bale
// Bale Bot API webhook handler.
//
// Verification:
//   1. Look up Bot by `bid` query param.
//   2. Verify the `sig` query param (HMAC of botId).
//   3. Compute HMAC of RAW request body keyed by the decrypted
//      `webhookSecret`. Compare to `X-Bale-Webhook-Signature` header.
//      If the header is missing, fall back to `x-postyar-body-sig` (used
//      by the polling endpoint which is internal).
//      Either way: fail-closed if mismatch.
//   4. Parse update. If contains `pre_checkout_query` or
//      `successful_payment`, call `processBaleUpdate(bot, update)` from
//      `@/lib/payments/bale`. Else if message or callback_query,
//      dispatch to the workflow engine.
//   5. C-04/H-03: DURABLY idempotent on update_id via the BotInboundEvent
//      inbox. Payment-bearing updates are additionally protected by the
//      durable BalePaymentRef UNIQUE constraints (the financial
//      correctness owner) — see P0.11 below.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { constantTimeEqual } from "@/lib/security/crypto";
import {
  verifyWebhookSig,
  computeWebhookBodySignature,
} from "@/lib/bots/register-webhook";
import { executeWorkflow, processBaleUpdate, persistInboundOnce } from "@/lib/bots/workflow";
import {
  ensureBotEvent,
  claimBotEvent,
  completeBotEvent,
  failBotEvent,
  recoverBotEvents,
  runMatchedWorkflowsForEvent,
} from "@/lib/bots/event-dedup";
import { audit } from "@/lib/server/auth";
import type { Bot, BotWorkflow } from "@prisma/client";
import { webhookRequestGuard, readBoundedWebhookBody } from "@/lib/bots/webhook-guard";

interface BaleUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat?: { id?: number };
    from?: { id?: number };
    text?: string;
    caption?: string;
    successful_payment?: {
      invoice_payload?: string;
      currency?: string;
      total_amount?: number;
      telegram_payment_charge_id?: string;
      provider_payment_charge_id?: string;
    };
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
  pre_checkout_query?: {
    id: string;
    from?: { id?: number };
    currency?: string;
    total_amount?: number;
    invoice_payload?: string;
  };
}

export async function POST(req: Request) {
  // Hardening (audit W1): per-IP rate limit + body size cap BEFORE any
  // DB/HMAC work (same rationale as the Telegram webhook).
  const guard = await webhookRequestGuard(req);
  if (guard) return guard;

  const url = new URL(req.url);
  const bid = url.searchParams.get("bid") ?? "";
  const sig = url.searchParams.get("sig") ?? "";
  if (!bid || !sig) {
    return NextResponse.json({ ok: false, errorFa: "پارامتر نادرست است." }, { status: 400 });
  }
  if (!verifyWebhookSig(bid, sig)) {
    return NextResponse.json({ ok: false, errorFa: "امضای نامعتبر." }, { status: 403 });
  }
  const bot = await db.bot.findUnique({ where: { id: bid } });
  if (!bot) {
    return NextResponse.json({ ok: false, errorFa: "ربات یافت نشد." }, { status: 404 });
  }
  if (bot.provider !== "bale") {
    return NextResponse.json({ ok: false, errorFa: "پروایدر ناهماهنگ است." }, { status: 400 });
  }
  const bodyRead = await readBoundedWebhookBody(req);
  if (!bodyRead.ok) {
    return NextResponse.json({ ok: false, errorFa: bodyRead.errorFa }, { status: 413 });
  }
  const rawBody = bodyRead.text;
  const bodySig = await computeWebhookBodySignature(bot, rawBody);
  const baleHeader = req.headers.get("x-bale-webhook-signature") ?? "";
  const providedSig = baleHeader || (req.headers.get("x-postyar-body-sig") ?? "");
  if (!bodySig || !providedSig || !constantTimeEqual(bodySig, providedSig)) {
    await audit({
      userId: bot.ownerId,
      actor: "webhook",
      action: "bot_webhook_signature_mismatch",
      targetType: "bot",
      targetId: bot.id,
      meta: { provider: "bale", hadHeader: !!baleHeader },
    });
    return NextResponse.json({ ok: false }, { status: 200 });
  }

  let update: BaleUpdate;
  try {
    update = JSON.parse(rawBody) as BaleUpdate;
  } catch {
    return NextResponse.json({ ok: false, errorFa: "بدنه وب‌هوک نامعتبر است." }, { status: 400 });
  }

  // P0.11 ROOT-CAUSE FIX — payment-bearing updates are durably idempotent
  // in processBaleUpdate itself (BalePaymentRef.chargeId CAS + healing
  // upserts + hard amount/secret checks) and MUST run on every delivery;
  // their event row is recorded for observability, but financial
  // correctness stays owned by BalePaymentRef (no claim, no skip).
  // Non-payment updates take the durable BotInboundEvent claim path:
  // UNIQUE collapses duplicates, the lease + recovery pass make a crash
  // after claim RETRYABLE instead of lost (the old volatile claim was
  // at-most-once and permanently suppressed the provider's retry).
  const updateId = update.update_id;
  const isPaymentUpdate = !!(update.pre_checkout_query || update.message?.successful_payment);
  const event = await ensureBotEvent(bot, "bale", String(updateId), update);

  if (isPaymentUpdate) {
    try {
      await processBaleUpdate(bot, update);
      await completeBotEvent(event.id);
    } catch (err) {
      await failBotEvent(
        event.id,
        err instanceof Error ? `${err.name}: ${err.message}` : "خطای پردازش پرداخت.",
      );
      await audit({
        userId: bot.ownerId,
        actor: "system",
        action: "bot_bale_payment_handler_failed",
        targetType: "bot",
        targetId: bot.id,
        meta: { name: err instanceof Error ? err.name : "Error", eventId: event.id },
      });
    }
    // Always ack 200 so Bale doesn't retry.
    return NextResponse.json({ ok: true, payment: true });
  }

  const claimed = await claimBotEvent(event.id);
  if (!claimed) {
    return NextResponse.json({ ok: true, duplicate: true });
  }
  try {
    await processBaleNonPaymentUpdate(bot, update, {
      isRetry: event.attempts > 1,
      eventId: event.id,
    });
    await completeBotEvent(event.id);
  } catch (err) {
    await failBotEvent(
      event.id,
      err instanceof Error ? `${err.name}: ${err.message}` : "خطای پردازش رویداد.",
    );
  }

  // Bounded crash-recovery pass for this bot (C-04/H-03).
  await recoverBotEvents(bot, (b, payload, o) => processBaleNonPaymentUpdate(b, payload as BaleUpdate, o));

  return NextResponse.json({ ok: true });
}

/**
 * Non-payment Bale update processing — shared by live delivery and
 * durable recovery. Replay-safe: link-code consumption is one-time,
 * workflow runs are UNIQUE per (event, workflow), and side-effecting
 * actions carry deterministic idempotency keys.
 */
async function processBaleNonPaymentUpdate(
  bot: Bot,
  update: BaleUpdate,
  opts: { isRetry: boolean; eventId: string },
): Promise<void> {
  // Extract chat id + text
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
    return;
  }

  // C-11/C-12 + V4 H-04: persist the inbound history row ONCE per event
  // (owned by the webhook layer, not per workflow). The UNIQUE
  // inboundEventId makes this DB-idempotent — it runs on EVERY delivery
  // and heals a crash-before-persist on durable retries.
  await persistInboundOnce(bot, chatId, incomingText, update, update.update_id, undefined, opts.eventId);

  // Link-code consumption attempt.
  if (incomingText.startsWith("POSTYAR-")) {
    const { consumeLinkCode } = await import("@/lib/bots/link");
    const result = await consumeLinkCode({
      botId: bot.id,
      code: incomingText.trim(),
      providerUserId: chatId,
    });
    let reply = "";
    if (result.ok) {
      reply = "حساب پُست‌یار شما با موفقیت به این ربات متصل شد.";
    } else {
      reply = result.errorFa ?? "اتصال ناموفق بود.";
    }
    const { getDestinationProvider } = await import("@/lib/providers");
    const { decryptString } = await import("@/lib/security/crypto");
    try {
      const token = decryptString(bot.botTokenEnc);
      const provider = getDestinationProvider("bale");
      await provider.publishMessage({ botToken: token, chatId, text: reply });
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
    return;
  }

  // Workflow dispatch — per-event UNIQUE run rows guarantee exactly-once
  // execution per intended workflow across retries and recovery.
  // V4 C-01: the callback returns the TYPED engine outcome — an
  // executeWorkflow ok:false is a genuine failure and keeps the run
  // retryable instead of being recorded as completed.
  // V4 C-02: runMatchedWorkflowsForEvent THROWS when any child failed —
  // event completion never implies child completion.
  const workflows = await db.botWorkflow.findMany({
    where: { botId: bot.id, enabled: true },
    take: 50,
  });
  const jobs = workflows
    .filter((wf) => matchesTrigger(wf, incomingText))
    .map((wf) => ({
      workflowId: wf.id,
      execute: async () => {
        const r = await executeWorkflow({
          bot,
          providerUserId: chatId,
          rawUpdate: update,
          incomingMessage: incomingText,
          callbackQueryId,
          updateId: update.update_id,
          workflow: wf,
        });
        return { ok: r.ok, errorFa: r.errorFa };
      },
    }));
  await runMatchedWorkflowsForEvent(opts.eventId, jobs);
}

function matchesTrigger(wf: BotWorkflow, incomingText: string): boolean {
  if (wf.triggerKind === "command") {
    if (!incomingText) return false;
    const val = (wf.triggerValue ?? "").trim().toLowerCase();
    if (!val) return false;
    return incomingText.toLowerCase().startsWith(`/${val}`);
  }
  if (wf.triggerKind === "callback") {
    if (!incomingText) return false;
    return incomingText === (wf.triggerValue ?? "");
  }
  return true;
}

export async function GET() {
  return NextResponse.json({ ok: true, service: "postyar-bot-webhook-bale" });
}
