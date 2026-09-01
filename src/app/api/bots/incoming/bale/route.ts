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
//   5. Idempotent on update_id.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { constantTimeEqual } from "@/lib/security/crypto";
import {
  verifyWebhookSig,
  computeWebhookBodySignature,
} from "@/lib/bots/register-webhook";
import { executeWorkflow, processBaleUpdate, persistInboundOnce } from "@/lib/bots/workflow";
import { audit } from "@/lib/server/auth";
import type { BotWorkflow } from "@prisma/client";
import { webhookRequestGuard, claimUpdateOnce, readBoundedWebhookBody } from "@/lib/bots/webhook-guard";

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

  // Idempotency at the handler level (atomic claim — audit W2).
  //
  // P0.11 ROOT-CAUSE FIX — the volatile INCR claim is AT-MOST-ONCE: if the
  // process crashed after claiming a `successful_payment` but before
  // processBaleUpdate persisted the charge, the provider's retry was
  // dropped as a "duplicate" and a REAL payment was lost forever. Payment-
  // bearing updates therefore BYPASS the volatile claim entirely:
  // processBaleUpdate is durably idempotent (BalePaymentRef.chargeId CAS +
  // activateSubscription healing upserts) and safe to run on every
  // delivery. Non-payment updates keep the volatile claim (chat UX only).
  const updateId = update.update_id;
  const isPaymentUpdate = !!(update.pre_checkout_query || update.message?.successful_payment);
  if (!isPaymentUpdate) {
    const firstDelivery = await claimUpdateOnce(bot.id, bot.provider, String(updateId));
    if (!firstDelivery) {
      return NextResponse.json({ ok: true, duplicate: true });
    }
  }

  // Payment branch — delegate to processBaleUpdate.
  if (isPaymentUpdate) {
    try {
      await processBaleUpdate(bot, update);
    } catch (err) {
      await audit({
        userId: bot.ownerId,
        actor: "system",
        action: "bot_bale_payment_handler_failed",
        targetType: "bot",
        targetId: bot.id,
        meta: { name: err instanceof Error ? err.name : "Error" },
      });
    }
    // Always ack 200 so Bale doesn't retry.
    return NextResponse.json({ ok: true, payment: true });
  }

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
    return NextResponse.json({ ok: true, noChat: true });
  }

  // C-11/C-12: persist the inbound history row ONCE per event (owned by
  // the webhook layer, not per workflow).
  await persistInboundOnce(bot, chatId, incomingText, update, updateId);

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
    return NextResponse.json({ ok: true, linkConsumed: result.ok });
  }

  // Workflow dispatch.
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
        meta: { workflowId: wf.id, name: err instanceof Error ? err.name : "Error" },
      });
    }
  }

  return NextResponse.json({ ok: true, matched: matchedAny });
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
