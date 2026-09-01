// =====================================================================
// POSTYAR — Bale payment provider (SAFE CLEAN REIMPLEMENTATION)
// ---------------------------------------------------------------------
// Per forensic report (BALEPAY-FORENSICS.md §3):
//   - Bale has NO separate Payment API. The wallet/invoice flow lives
//     entirely inside the Bot API: sendInvoice → pre_checkout_query →
//     answerPreCheckoutQuery → message.successful_payment.
//   - NO verify endpoint exists; the successful_payment event IS the
//     verification (we HARDCHECK amount server-side).
//   - Trustworthy fields: update_id, invoice_payload, currency,
//     total_amount, telegram_payment_charge_id, provider_payment_charge_id.
//
// Hardening:
//   - Per-Order-generated `secret_token` (32-byte random) is stored
//     ENCRYPTED in BalePaymentRef.row, NEVER in URL.
//   - The webhook endpoint at /api/bots/incoming/bale is owned by the
//     Bot-builder agent; this file exposes `processBaleUpdate(bot, update)`
//     for them to call AFTER they've authenticated the bot (HMAC of body
//     keyed by bot.webhookSecret OR the bot's botToken decrypted).
//   - Hard amount verification on BOTH pre_checkout_query and
//     successful_payment.
//   - update_id dedup with UNIQUE constraint.
//   - charge_id (telegram_payment_charge_id) idempotency key.
//   - No long-lived secrets in URLs. The invoice payload's secret is
//     one-time, stored encrypted, verified server-side.
//
// Money: INTEGER Rial minor units. NO floats anywhere.
// Persian + RTL user-facing strings only.
// =====================================================================
import { db } from "@/lib/db";
import { audit, AuthError } from "@/lib/server/auth";
import { encryptString, decryptString, randomToken, constantTimeEqual } from "@/lib/security/crypto";
import { formatRials, toPersianDigits } from "@/lib/persian";
import { sanitizeRaw } from "@/lib/providers/util";
import { fetchJsonWithLimit } from "@/lib/security/http";
import type { PaymentProvider, OrderLike } from "@/lib/payments/engine";
import { activateSubscription, PAYABLE_STATUSES } from "@/lib/payments/plans";
import type { Bot } from "@prisma/client";

// ---------------------------------------------------------------------
// Bot API client — mirrors the destination-provider pattern.
// NEVER log the token. NEVER expose it to the browser.
// ---------------------------------------------------------------------
const BALE_BOT_API_BASE = "https://tapi.bale.ai/bot";

async function baleBotCall(botToken: string, method: string, body: Record<string, unknown>): Promise<{
  ok: boolean;
  status: number;
  result?: unknown;
  errorFa?: string;
  raw?: unknown;
}> {
  if (!botToken) {
    return { ok: false, status: 401, errorFa: "توکن ربات تنظیم نشده است." };
  }
  const url = `${BALE_BOT_API_BASE}${botToken}/${method}`;
  // Bounded fetch (L-10): hard timeout + response-size cap — a hostile or
  // misbehaving Bale endpoint cannot over-commit memory. The host is a
  // fixed vendor endpoint, so the SSRF DNS-pinning layer is not required
  // here (all user/admin-configurable URLs use pinnedFetchJson).
  const parsed = await fetchJsonWithLimit<Record<string, unknown>>(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 15_000,
    maxBytes: 1024 * 1024,
  });
  if (!parsed.ok) {
    if (parsed.status) {
      const desc = typeof (parsed as { errorText?: string }).errorText === "string"
        ? (() => { try { return (JSON.parse((parsed as { errorText: string }).errorText) as { description?: string }).description; } catch { return undefined; } })()
        : undefined;
      return { ok: false, status: parsed.status, errorFa: normalizeBaleError(parsed.status, desc) };
    }
    return { ok: false, status: 0, errorFa: "اتصال به سرویس بله ناموفق بود." };
  }
  const j = parsed.data as { ok?: boolean; result?: unknown; description?: string };
  if (j.ok !== true) {
    return {
      ok: false,
      status: parsed.status,
      errorFa: j.description ?? "درخواست ناموفق بود.",
      raw: j,
    };
  }
  return { ok: true, status: parsed.status, result: j.result, raw: j };
}

function normalizeBaleError(status: number, description?: string): string {
  if (description && /unauthorized|token/i.test(description)) return "توکن ربات نامعتبر است.";
  switch (status) {
    case 401: return "توکن نامعتبر است.";
    case 403: return "ربات دسترسی به این چت را ندارد.";
    case 400: return "چت یافت نشد یا پارامتر نامعتبر است.";
    case 429: return "محدودیت ارسال پیام از سمت بله.";
    default: return "خطای ناشناخته از سمت بله.";
  }
}

async function getBotToken(botId: string): Promise<string> {
  const bot = await db.bot.findUnique({
    where: { id: botId },
    select: { botTokenEnc: true, status: true, provider: true },
  });
  if (!bot) throw new AuthError("ربات یافت نشد.", 404);
  if (bot.provider !== "bale") throw new AuthError("این ربات بله نیست.", 400);
  if (bot.status !== "active") throw new AuthError("ربات فعال نیست.", 400);
  try { return decryptString(bot.botTokenEnc); } catch {
    throw new AuthError("توکن ربات قابل رمزگشایی نیست.", 500);
  }
}

// ---------------------------------------------------------------------
// createPaymentRequest — send a Bale wallet invoice
// ---------------------------------------------------------------------
export async function baleCreatePaymentRequest(input: {
  order: OrderLike;
  botId: string;
  chatId: string;
}): Promise<{
  ok: boolean;
  invoicePayload?: string;
  botInvoiceUrl?: string;
  providerRef?: string;
  errorFa?: string;
}> {
  // H-2: an order that already reached a terminal/paid state can never be
  // re-invoiced — re-issuing an invoice for a PAID order would either
  // regress its status (pre-fix behavior) or collect a second payment for
  // one order. Callers surface the Persian message to the user.
  {
    const current = await db.order.findUnique({
      where: { id: input.order.id },
      select: { status: true },
    });
    if (!current) throw new AuthError("سفارش یافت نشد.", 404);
    if (!PAYABLE_STATUSES.includes(current.status)) {
      throw new AuthError("این سفارش قابل پرداخت نیست؛ سفارش تازه‌ای ایجاد کنید.", 400);
    }
  }

  // 32-byte random secret — stored encrypted, NOT in URL
  const secretToken = randomToken(32); // 64-hex-char string (32 bytes of entropy)
  // Persist BalePaymentRef with the secret encrypted BEFORE calling the API
  let ref;
  try {
    ref = await db.balePaymentRef.create({
      data: {
        orderId: input.order.id,
        botId: input.botId,
        // chargeId/updateId set later; rawPayload stored later
        rawPayload: encryptString(secretToken), // overload: store the secret encrypted
        // currency/paidAt set later
      },
    });
  } catch (err) {
    const msg = (err as { code?: string; message?: string })?.message ?? "";
    if (/unique|UNIQUE|constraint/i.test(msg)) {
      // A BalePaymentRef already exists for this order — that's OK; reuse it.
      ref = await db.balePaymentRef.findUnique({ where: { orderId: input.order.id } });
      if (!ref) throw err;
    } else {
      throw err;
    }
  }
  // Re-key the secret if a ref already existed (regenerate)
  const finalSecret = randomToken(32);
  await db.balePaymentRef.update({
    where: { orderId: input.order.id },
    data: { rawPayload: encryptString(finalSecret), botId: input.botId },
  });

  // Compose the payload: "<orderId>:<secret>". This is what Bale echoes back
  // in invoice_payload on pre_checkout_query and successful_payment.
  const payload = `${input.order.id}:${finalSecret}`;

  // Choose a title based on order kind
  const title =
    input.order.kind === "subscription" ? "اشتراک پُست‌یار"
    : input.order.kind === "wallet_credit" ? "شارژ کیف پول پُست‌یار"
    : "پرداخت پُست‌یار";
  // Compose prices — Bale wants array of {label, amount}
  const prices = [{ label: title, amount: input.order.amountRials }];

  // Call sendInvoice
  const botToken = await getBotToken(input.botId);
  const result = await baleBotCall(botToken, "sendInvoice", {
    chat_id: Number(input.chatId),
    title: title.slice(0, 32),
    description: input.order.descriptionFa.slice(0, 255),
    payload,
    provider_token: "", // wallet-style: no provider_token needed
    prices,
    currency: "IRR",
  });
  if (!result.ok) {
    // CAS-guarded (H-2): only a still-payable order may move to failed —
    // a duplicate workflow trigger must never regress an already-paid
    // order's financial state.
    await db.order.updateMany({
      where: { id: input.order.id, status: { in: PAYABLE_STATUSES } },
      data: { status: "failed", provider: "bale" },
    });
    await audit({
      userId: input.order.userId,
      actor: "provider",
      action: "bale_send_invoice_failed",
      targetType: "order",
      targetId: input.order.id,
      meta: { errorFa: result.errorFa, botId: input.botId },
    });
    return { ok: false, errorFa: result.errorFa };
  }
  // CAS-guarded (H-2): awaiting_payment is only entered from a payable
  // state — never overwrite paid/awaiting_review/terminal states.
  await db.order.updateMany({
    where: { id: input.order.id, status: { in: PAYABLE_STATUSES } },
    data: { status: "awaiting_payment", provider: "bale", providerRef: input.order.id },
  });

  // Bale does NOT return a hosted invoice URL — the invoice is delivered
  // as a message directly in the chat. We expose a "view invoice" URL
  // pointing at the bot's deep-link so the UI can route the user there.
  const botRow = await db.bot.findUnique({
    where: { id: input.botId },
    select: { username: true },
  });
  const botInvoiceUrl = botRow?.username
    ? `https://ble.ir/${botRow.username}`
    : undefined;

  return {
    ok: true,
    invoicePayload: payload,
    botInvoiceUrl,
    providerRef: input.order.id,
  };
}

// ---------------------------------------------------------------------
// Helper for testing: get the decrypted secret for an order
// ---------------------------------------------------------------------
export async function ensureBalePaymentSecret(orderId: string): Promise<string> {
  const ref = await db.balePaymentRef.findUnique({ where: { orderId } });
  if (!ref || !ref.rawPayload) return "";
  try { return decryptString(ref.rawPayload); } catch { return ""; }
}

// ---------------------------------------------------------------------
// answerPreCheckoutQuery — explicitly boolean (BPP's string bug avoided)
// ---------------------------------------------------------------------
async function answerPreCheckoutQuery(
  botToken: string,
  preCheckoutQueryId: string,
  ok: boolean,
  errorMessage?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    pre_checkout_query_id: preCheckoutQueryId,
    ok, // boolean — never string
  };
  if (!ok && errorMessage) body.error_message = errorMessage;
  await baleBotCall(botToken, "answerPreCheckoutQuery", body);
}

// ---------------------------------------------------------------------
// processBaleUpdate — entry point for the webhook endpoint
// ---------------------------------------------------------------------
export interface BaleUpdate {
  update_id: number;
  pre_checkout_query?: {
    id: string;
    from?: { id?: number };
    currency?: string;
    total_amount?: number;
    invoice_payload?: string;
  };
  message?: {
    successful_payment?: {
      invoice_payload?: string;
      currency?: string;
      total_amount?: number;
      telegram_payment_charge_id?: string;
      provider_payment_charge_id?: string;
    };
    chat?: { id?: number };
  };
}

export async function processBaleUpdate(bot: Bot, update: BaleUpdate): Promise<{ handled: boolean; reason?: string }> {
  // Sanity: bot must be a bale bot
  if (!bot || bot.provider !== "bale") return { handled: false, reason: "not_a_bale_bot" };

  // Idempotency: dedup by update_id (UNIQUE on BalePaymentRef.updateId)
  if (typeof update.update_id !== "number") {
    return { handled: false, reason: "no_update_id" };
  }
  const updateIdStr = String(update.update_id);

  // Decrypt bot token (used to call answerPreCheckoutQuery if needed)
  let botToken = "";
  try { botToken = decryptString(bot.botTokenEnc); } catch { botToken = ""; }

  // ----- pre_checkout_query branch -----
  if (update.pre_checkout_query) {
    const pcq = update.pre_checkout_query;
    const payload = pcq.invoice_payload ?? "";
    const [orderId, secret] = payload.split(":");
    if (!orderId || !secret) {
      await answerPreCheckoutQuery(botToken, pcq.id, false, "پارامترهای فاکتور نامعتبر است.");
      return { handled: true, reason: "invalid_payload" };
    }
    // Look up the BalePaymentRef row
    const ref = await db.balePaymentRef.findUnique({ where: { orderId } });
    if (!ref) {
      await answerPreCheckoutQuery(botToken, pcq.id, false, "سفارش یافت نشد.");
      return { handled: true, reason: "order_not_found" };
    }
    // Verify secret with constant-time comparison
    let storedSecret = "";
    try { storedSecret = ref.rawPayload ? decryptString(ref.rawPayload) : ""; } catch { storedSecret = ""; }
    if (!storedSecret || !constantTimeEqual(storedSecret, secret)) {
      await answerPreCheckoutQuery(botToken, pcq.id, false, "اعتبار فاکتور نامعتبر است.");
      return { handled: true, reason: "secret_mismatch" };
    }
    // Look up the order to hard-check amount + currency
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order) {
      await answerPreCheckoutQuery(botToken, pcq.id, false, "سفارش یافت نشد.");
      return { handled: true, reason: "order_not_found" };
    }
    // HARD AMOUNT CHECK at pre-checkout (BPP skips this; we don't)
    const totalAmount = typeof pcq.total_amount === "number" ? pcq.total_amount : -1;
    if (totalAmount !== order.amountRials) {
      await answerPreCheckoutQuery(botToken, pcq.id, false, "مبلغ فاکتور با مبلغ سفارش مطابقت ندارد.");
      await audit({
        userId: order.userId,
        actor: "provider",
        action: "bale_precheckout_amount_mismatch",
        targetType: "order",
        targetId: order.id,
        meta: { expected: order.amountRials, received: totalAmount },
      });
      return { handled: true, reason: "amount_mismatch" };
    }
    // Currency check
    if (pcq.currency && pcq.currency !== "IRR") {
      await answerPreCheckoutQuery(botToken, pcq.id, false, "ارز فاکتور باید ریال ایران باشد.");
      return { handled: true, reason: "currency_mismatch" };
    }
    // All checks passed — answer OK
    await answerPreCheckoutQuery(botToken, pcq.id, true);
    // Dedup the update_id so we never re-process this pre_checkout
    try {
      await db.balePaymentRef.update({
        where: { orderId: order.id },
        data: { updateId: updateIdStr, currency: pcq.currency ?? "IRR" },
      });
    } catch {
      // If updateId already set by a parallel webhook, ignore the conflict
    }
    return { handled: true, reason: "pre_checkout_ok" };
  }

  // ----- successful_payment branch -----
  if (update.message?.successful_payment) {
    const sp = update.message.successful_payment;
    const payload = sp.invoice_payload ?? "";
    const [orderId, secret] = payload.split(":");
    if (!orderId || !secret) {
      // V6 C-11 — a captured payment that cannot be matched to an order
      // still leaves a DURABLE audit trace (money was likely taken; the
      // operator must be able to find it). No raw payload is stored.
      await audit({
        actor: "provider",
        action: "bale_successful_payment_unmatched",
        targetType: "bale_payment",
        targetId: sp.telegram_payment_charge_id ?? String(update.update_id ?? ""),
        meta: sanitizeRaw({
          reason: "invalid_payload",
          chargeId: sp.telegram_payment_charge_id ?? null,
          totalAmount: sp.total_amount ?? null,
          currency: sp.currency ?? null,
        }) as Record<string, unknown>,
      });
      return { handled: false, reason: "invalid_payload_on_success" };
    }
    const ref = await db.balePaymentRef.findUnique({ where: { orderId } });
    if (!ref) {
      // V6 C-11 — same durable trace for a captured payment with no ref.
      await audit({
        actor: "provider",
        action: "bale_successful_payment_unmatched",
        targetType: "bale_payment",
        targetId: sp.telegram_payment_charge_id ?? String(update.update_id ?? ""),
        meta: sanitizeRaw({
          reason: "order_not_found",
          orderIdHint: orderId.slice(0, 64),
          chargeId: sp.telegram_payment_charge_id ?? null,
          totalAmount: sp.total_amount ?? null,
          currency: sp.currency ?? null,
        }) as Record<string, unknown>,
      });
      return { handled: false, reason: "order_not_found" };
    }
    // IDEMPOTENCY EARLY-PATH: if chargeId is already set, this is a
    // legitimate Bale webhook retry for a claimed payment. The rawPayload
    // was overwritten with sanitized audit JSON after the first
    // finalization, so re-verifying the secret would produce a false
    // mismatch. Still re-run activateSubscription (idempotent, heals a
    // crash between claim and fulfillment), then ack.
    if (ref.chargeId) {
      const stillPayable = await db.order.findUnique({
        where: { id: orderId },
        select: { status: true, amountRials: true, kind: true, userId: true },
      });
      if (stillPayable && stillPayable.status !== "paid" && stillPayable.status !== "rejected" && stillPayable.status !== "failed" && stillPayable.status !== "expired" && stillPayable.status !== "cancelled") {
        await activateSubscription({
          orderId,
          paidRials: stillPayable.amountRials,
          idempotencyKey: `bale:${String(ref.chargeId)}`,
        });
      }
      return { handled: true, reason: "already_paid_idempotent" };
    }
    // Verify secret (constant-time)
    let storedSecret = "";
    try { storedSecret = ref.rawPayload ? decryptString(ref.rawPayload) : ""; } catch { storedSecret = ""; }
    if (!storedSecret || !constantTimeEqual(storedSecret, secret)) {
      // V6 C-11 — a secret mismatch on a REAL captured payment (e.g. the
      // invoice was re-keyed between pre_checkout and success) is money in
      // flight with no matching claim: durable audit, never silent.
      await audit({
        actor: "provider",
        action: "bale_successful_payment_unmatched",
        targetType: "bale_payment",
        targetId: sp.telegram_payment_charge_id ?? String(update.update_id ?? ""),
        meta: sanitizeRaw({
          reason: "secret_mismatch",
          orderId,
          chargeId: sp.telegram_payment_charge_id ?? null,
          totalAmount: sp.total_amount ?? null,
          currency: sp.currency ?? null,
        }) as Record<string, unknown>,
      });
      return { handled: false, reason: "secret_mismatch_on_success" };
    }
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order) {
      await audit({
        actor: "provider",
        action: "bale_successful_payment_unmatched",
        targetType: "bale_payment",
        targetId: sp.telegram_payment_charge_id ?? String(update.update_id ?? ""),
        meta: sanitizeRaw({
          reason: "order_not_found_after_secret",
          orderId,
          chargeId: sp.telegram_payment_charge_id ?? null,
          totalAmount: sp.total_amount ?? null,
        }) as Record<string, unknown>,
      });
      return { handled: false, reason: "order_not_found" };
    }

    // HARD AMOUNT CHECK
    const totalAmount = typeof sp.total_amount === "number" ? sp.total_amount : -1;
    if (totalAmount !== order.amountRials) {
      // CAS-guarded: never regress an already-paid order on a mismatched
      // (or replayed) provider callback.
      await db.order.updateMany({
        where: { id: order.id, status: { in: PAYABLE_STATUSES } },
        data: { status: "failed" },
      });
      await audit({
        userId: order.userId,
        actor: "provider",
        action: "bale_payment_mismatch",
        targetType: "order",
        targetId: order.id,
        meta: { expected: order.amountRials, received: totalAmount, chargeId: sp.telegram_payment_charge_id },
      });
      return { handled: true, reason: "amount_mismatch_on_success" };
    }
    if (sp.currency && sp.currency !== "IRR") {
      // V6 C-11 — non-IRR success: durable audit before refusing.
      await audit({
        actor: "provider",
        action: "bale_successful_payment_unmatched",
        targetType: "bale_payment",
        targetId: sp.telegram_payment_charge_id ?? String(update.update_id ?? ""),
        meta: sanitizeRaw({
          reason: "currency_mismatch",
          orderId,
          chargeId: sp.telegram_payment_charge_id ?? null,
          totalAmount: sp.total_amount ?? null,
          currency: sp.currency ?? null,
        }) as Record<string, unknown>,
      });
      return { handled: false, reason: "currency_mismatch_on_success" };
    }

    // ROOT-CAUSE FIX (audit §5/§8): this transaction only CLAIMS the
    // payment (BalePaymentRef.chargeId CAS). It no longer marks the
    // order paid and no longer credits the wallet here — that split
    // brain (bale inline credit + activateSubscription effects gated on
    // an order that was already "paid") left subscription orders
    // credited but never activated, and a crash between the two steps
    // permanently lost the activation. activateSubscription is now the
    // SINGLE owner of order→paid + ledger + wallet credit + subscription
    // + referral, atomically, keyed by orderId-derived idempotency keys.
    const chargeId = sp.telegram_payment_charge_id ?? `bale-${update.update_id}`;
    const idemKey = `bale:${chargeId}`;

    let firstFinalize = false;
    try {
      const claimed = await db.$transaction(async (tx) => {
        // Record the provider charge reference on the order (traceability
        // metadata only — the STATUS transition is owned exclusively by
        // activateSubscription's CAS below).
        await tx.order.update({
          where: { id: order.id },
          data: { providerRef: chargeId },
        });
        // Set BalePaymentRef.chargeId, paidAt, rawPayload (sanitized),
        // and dedup updateId.
        const updated = await tx.balePaymentRef.updateMany({
          where: { orderId: order.id, chargeId: null },
          data: {
            chargeId,
            updateId: updateIdStr,
            currency: sp.currency ?? "IRR",
            providerPaymentChargeId: sp.provider_payment_charge_id ?? null,
            paidAt: new Date(),
            rawPayload: JSON.stringify(sanitizeRaw({
              update_id: update.update_id,
              charge_id: chargeId,
              provider_charge_id: sp.provider_payment_charge_id,
              total_amount: sp.total_amount,
              currency: sp.currency,
            })),
          },
        });
        return updated.count === 1;
      });
      firstFinalize = claimed;
    } catch (err) {
      // If chargeId was already set (UNIQUE constraint), this is idempotent re-entry
      const msg = (err as { code?: string; message?: string })?.message ?? "";
      if (!/unique|UNIQUE|constraint/i.test(msg)) throw err;
    }

    // Fulfillment — ALWAYS attempted (idempotent): covers first finalize,
    // parallel webhooks, and re-entry after a crash between the claim
    // above and fulfillment. Never double-credits (orderId-keyed upserts).
    await activateSubscription({
      orderId: order.id,
      paidRials: order.amountRials,
      idempotencyKey: idemKey,
    });

    // Notify + audit only on the first finalize (no duplicate spam).
    // P0.7.7: delivery failures here must never invalidate the committed
    // financial success.
    if (firstFinalize) {
      try {
        await db.notification.create({
          data: {
            userId: order.userId,
            category: "payment",
            titleFa: "پرداخت موفق",
            bodyFa: `پرداخت ${formatRials(order.amountRials)} از طریق کیف پول بله با کد پیگیری ${toPersianDigits(chargeId.slice(-12))} تأیید شد.`,
            link: "/dashboard/wallet",
          },
        });
        await audit({
          userId: order.userId,
          actor: "provider",
          action: "bale_payment_paid",
          targetType: "order",
          targetId: order.id,
          meta: {
            chargeId,
            providerChargeId: sp.provider_payment_charge_id,
            amountRials: order.amountRials,
            updateId: updateIdStr,
          },
        });
      } catch (err) {
        console.error(
          "bale finalize notification/audit failed (financial effects already committed):",
          err instanceof Error ? err.message : err,
        );
      }
    }
    return { handled: true, reason: "successful_payment_processed" };
  }

  return { handled: false, reason: "unhandled_update_kind" };
}

// ---------------------------------------------------------------------
// Provider shim — implements PaymentProvider interface
// ---------------------------------------------------------------------
export interface BaleProvider extends PaymentProvider {
  baleCreatePaymentRequest(input: {
    order: OrderLike;
    botId: string;
    chatId: string;
  }): ReturnType<typeof baleCreatePaymentRequest>;
  processBaleUpdate(bot: Bot, update: BaleUpdate): ReturnType<typeof processBaleUpdate>;
  ensureBalePaymentSecret(orderId: string): Promise<string>;
}

export function getBaleProvider(): BaleProvider {
  return {
    kind: "bale",
    async createPaymentRequest({ order, extras }) {
      const botId = String(extras?.botId ?? "");
      const chatId = String(extras?.chatId ?? "");
      if (!botId || !chatId) {
        return { providerRef: "", errorFa: "ربات و چت‌آیدی برای پرداخت بله الزامی است." };
      }
      const r = await baleCreatePaymentRequest({ order, botId, chatId });
      return {
        providerRef: r.providerRef ?? "",
        invoicePayload: r.invoicePayload,
        botInvoiceUrl: r.botInvoiceUrl,
        view: { ok: r.ok, errorFa: r.errorFa },
      };
    },
    async verifyAndFinalize() {
      // Bale has no separate verify endpoint — the successful_payment event
      // IS the verification (handled by processBaleUpdate).
      return { ok: false, errorFa: "تأیید نهایی بله از طریق وب‌هوک انجام می‌شود." };
    },
    baleCreatePaymentRequest,
    processBaleUpdate,
    ensureBalePaymentSecret,
  };
}

