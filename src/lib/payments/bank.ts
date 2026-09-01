// =====================================================================
// POSTYAR — Bank gateway provider (Iranian bank gateway abstraction)
// ---------------------------------------------------------------------
// Two modes:
//   - `direct`:    POSTYAR_BANK_DIRECT_URL / _TERMINAL / _MERCHANT / _SECRET
//   - `intermediary`: POSTYAR_BANK_INTERMEDIARY_URL / _MERCHANT / _SECRET
//
// The mode is configured per-Order at request time. If neither is
// configured, returns a clear Persian error — never a fake success.
//
// Protocol shape (generic, Iranian-bank-gateway-like):
//   1. POST token-request { Amount, MerchantId, CallbackURL, OrderId,
//      TerminalId, Timestamp } → returns { Authority }
//   2. User redirected to <URL>/<Authority>
//   3. Bank calls back GET <CallbackURL>?order=<id>&authority=<...>&status=OK
//      Callback URL contains order id + signed state token (HMAC of order id)
//   4. Server-side: re-query gateway verify endpoint with authority;
//      verify returned Amount matches order.amountRials HARDCHECK
//   5. On success: $transaction with LedgerEntry + WalletTxn +
//      activateSubscription + BankGatewayRef.traceNo/paidAt +
//      Order.status=paid + Notification + Audit. Idempotency key =
//      "order.id:authority".
//
// NEVER trust client-supplied amount. Use the amount stored at Order
// creation time.
// Money: INTEGER Rial. NO floats.
// =====================================================================
import { db } from "@/lib/db";
import { audit } from "@/lib/server/auth";
import { hmacSign, hmacVerify } from "@/lib/security/crypto";
import { assertSafeOutboundUrl, UnsafeOutboundUrlError } from "@/lib/security/net-guard";
import { pinnedFetchJson } from "@/lib/security/http";
import { PAYABLE_STATUSES } from "@/lib/payments/plans";
import { formatRials } from "@/lib/persian";
import type { PaymentProvider, OrderLike } from "@/lib/payments/engine";
import { activateSubscription } from "@/lib/payments/plans";

// ---------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------
export type BankMode = "direct" | "intermediary";

interface BankDirectConfig {
  baseUrl: string; // e.g. https://bank.example.com/pg/Token
  merchantId: string;
  terminalId: string;
  secret: string;
  callbackPath: string; // /api/payments/bank/callback
}

interface BankIntermediaryConfig {
  baseUrl: string; // PSP URL
  merchantCode: string;
  secret: string;
  callbackPath: string;
}

function readDirectConfig(): BankDirectConfig | null {
  const baseUrl = process.env.POSTYAR_BANK_DIRECT_URL;
  const merchantId = process.env.POSTYAR_BANK_DIRECT_MERCHANT;
  const terminalId = process.env.POSTYAR_BANK_DIRECT_TERMINAL;
  const secret = process.env.POSTYAR_BANK_DIRECT_SECRET;
  if (!baseUrl || !merchantId || !terminalId || !secret) return null;
  return {
    baseUrl,
    merchantId,
    terminalId,
    secret,
    callbackPath: process.env.POSTYAR_BANK_CALLBACK_PATH ?? "/api/payments/bank/callback",
  };
}

function readIntermediaryConfig(): BankIntermediaryConfig | null {
  const baseUrl = process.env.POSTYAR_BANK_INTERMEDIARY_URL;
  const merchantCode = process.env.POSTYAR_BANK_INTERMEDIARY_MERCHANT;
  const secret = process.env.POSTYAR_BANK_INTERMEDIARY_SECRET;
  if (!baseUrl || !merchantCode || !secret) return null;
  return {
    baseUrl,
    merchantCode,
    secret,
    callbackPath: process.env.POSTYAR_BANK_CALLBACK_PATH ?? "/api/payments/bank/callback",
  };
}

// State token: HMAC of order id + a bounded TTL. 60 minutes: the bank
// redirect can legally arrive long after the token request (slow PSP
// flows) — the state token is only the FIRST gate; the callback then
// re-verifies authority ownership (BankGatewayRef) and the amount
// server-side, so a longer window does not weaken the trust model.
const STATE_TOKEN_TTL_MS = 60 * 60 * 1000;
const STATE_LABEL = "bank-callback-state";

function makeStateToken(orderId: string): string {
  const exp = Math.floor((Date.now() + STATE_TOKEN_TTL_MS) / 1000).toString(16);
  const payload = `${orderId}:${exp}`;
  const sig = hmacSign(STATE_LABEL, payload);
  return `${exp}.${sig}`;
}

export function verifyStateToken(orderId: string, token: string): boolean {
  if (!token) return false;
  const [expHex, sig] = token.split(".");
  if (!expHex || !sig) return false;
  const exp = parseInt(expHex, 16);
  if (!Number.isFinite(exp)) return false;
  if (exp * 1000 < Date.now()) return false;
  const payload = `${orderId}:${expHex}`;
  return hmacVerify(STATE_LABEL, payload, sig);
}

// ---------------------------------------------------------------------
// Build the public callback URL the bank will redirect to.
// IMPORTANT: NO secret in URL — only orderId + signed state token.
// ---------------------------------------------------------------------
function buildCallbackUrl(orderId: string, publicBaseUrl: string | undefined, path: string): string {
  const state = makeStateToken(orderId);
  if (!publicBaseUrl) {
    // A gateway MUST receive an absolute URL to redirect the payer back.
    // A relative path silently breaks the return flow (money captured,
    // customer stranded). Development keeps the relative form; any
    // non-development runtime must configure POSTYAR_PUBLIC_BASE_URL —
    // fail closed instead of pretending the callback will work.
    if (process.env.NODE_ENV === "production") {
      throw new Error("POSTYAR_PUBLIC_BASE_URL تنظیم نشده است؛ درگاه بانکی بدون نشانی مطلق بازگشت کار نمی‌کند.");
    }
    return `${path}?order=${encodeURIComponent(orderId)}&state=${state}`;
  }
  return `${publicBaseUrl}${path}?order=${encodeURIComponent(orderId)}&state=${state}`;
}

// ---------------------------------------------------------------------
// createPaymentRequest — direct mode
// ---------------------------------------------------------------------
type BankCreateResult = {
  redirectUrl?: string;
  authority?: string;
  providerRef: string;
  mode: BankMode;
  errorFa?: string;
};

export async function bankCreatePaymentRequest(input: {
  order: OrderLike;
  mode: BankMode;
}): Promise<BankCreateResult> {
  const directCfg = readDirectConfig();
  const interCfg = readIntermediaryConfig();
  if (input.mode === "direct" && !directCfg) {
    return {
      providerRef: "",
      mode: "direct",
      errorFa: "درگاه بانکی مستقیم پیکربندی نشده است.",
    };
  }
  if (input.mode === "intermediary" && !interCfg) {
    return {
      providerRef: "",
      mode: "intermediary",
      errorFa: "درگاه واسط پیکربندی نشده است.",
    };
  }

  // Build callback URL — use POSTYAR_PUBLIC_BASE_URL if available
  const publicBase = process.env.POSTYAR_PUBLIC_BASE_URL;
  const cfg = input.mode === "direct" ? directCfg! : null;
  const interC = input.mode === "intermediary" ? interCfg! : null;
  const path = cfg?.callbackPath ?? interC?.callbackPath ?? "/api/payments/bank/callback";
  // Try calling the gateway token-request endpoint. If the gateway is not
  // reachable (e.g. dev with no network), we DO NOT return success — we
  // return the Persian error. The user must configure a real gateway
  // OR use the card-to-card path.
  try {
    const callbackUrl = buildCallbackUrl(input.order.id, publicBase, path);
    const isDirect = input.mode === "direct";
    const url = isDirect ? cfg!.baseUrl : interC!.baseUrl;
    // P0.14 — outbound policy: even env/admin-configured endpoints go
    // through the egress guard (https-only, public IPs, safe ports).
    // C-06: pinned connection to the validated public address (SNI-bound).
    await assertSafeOutboundUrl(url, { allowedPorts: [443] });
    const body: Record<string, string | number> = isDirect
      ? {
          Amount: input.order.amountRials,
          MerchantId: cfg!.merchantId,
          CallbackURL: callbackUrl,
          OrderId: input.order.id,
          TerminalId: cfg!.terminalId,
          Timestamp: Math.floor(Date.now() / 1000),
        }
      : {
          Amount: input.order.amountRials,
          MerchantCode: interC!.merchantCode,
          CallbackURL: callbackUrl,
          OrderId: input.order.id,
          Timestamp: Math.floor(Date.now() / 1000),
        };

    const parsed = await pinnedFetchJson<{ authority?: string; Authority?: string; status?: number | string }>(
      url,
      {
        allowedPorts: [443],
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 15_000,
        maxBytes: 512 * 1024,
      },
    );
    if (!parsed.ok) {
      return {
        providerRef: "",
        mode: input.mode,
        errorFa: "درگاه بانکی پاسخ نامعتبری بازگرداند.",
      };
    }
    const json = parsed.data;
    const authority = json.authority ?? json.Authority;
    if (!authority || typeof authority !== "string") {
      return {
        providerRef: "",
        mode: input.mode,
        errorFa: "درگاه بانکی authority معتبری بازنگرداند.",
      };
    }

    // Persist BankGatewayRef. A second payment attempt on the same order
    // violates the UNIQUE(orderId) — surface an explicit Persian message
    // instead of a raw constraint error.
    try {
      await db.bankGatewayRef.create({
        data: {
          orderId: input.order.id,
          authority,
          mode: input.mode,
        },
      });
    } catch (err) {
      const msg = (err as { code?: string; message?: string })?.message ?? "";
      if (/unique|UNIQUE|constraint/i.test(msg)) {
        return {
          providerRef: "",
          mode: input.mode,
          errorFa: "برای این سفارش قبلاً یک تراکنش بانکی ثبت شده است. سفارش تازه‌ای ایجاد کنید.",
        };
      }
      throw err;
    }
    // CAS: never regress an already-paid/awaiting_review order.
    await db.order.updateMany({
      where: { id: input.order.id, status: { in: PAYABLE_STATUSES } },
      data: { status: "awaiting_payment", provider: "bank", providerRef: authority },
    });

    return {
      redirectUrl: `${url.replace(/\/Token.*$/, "")}/StartPay/${authority}`,
      authority,
      providerRef: authority,
      mode: input.mode,
    };
  } catch {
    return {
      providerRef: "",
      mode: input.mode,
      errorFa: "اتصال به درگاه بانکی ناموفق بود.",
    };
  }
}

// ---------------------------------------------------------------------
// verifyAndFinalize — server-side verify call
// ---------------------------------------------------------------------
export async function bankVerifyAndFinalize(input: {
  order: OrderLike;
  authority: string;
  status?: string;
  ip?: string;
}): Promise<{ ok: boolean; paidRials?: number; providerRef?: string; errorFa?: string }> {
  const ref = await db.bankGatewayRef.findUnique({
    where: { authority: input.authority },
  });
  if (!ref) {
    return { ok: false, errorFa: "رفرنس بانکی معتبر نیست." };
  }
  if (ref.orderId !== input.order.id) {
    return { ok: false, errorFa: "مبنع Authority با سفارش مطابقت ندارد." };
  }
  if (ref.mode !== "direct" && ref.mode !== "intermediary") {
    return { ok: false, errorFa: "حالت درگاه نامعتبر است." };
  }
  const isDirect = ref.mode === "direct";
  const directCfg = readDirectConfig();
  const interCfg = readIntermediaryConfig();
  const baseUrl = isDirect ? directCfg?.baseUrl : interCfg?.baseUrl;
  const secret = isDirect ? directCfg?.secret : interCfg?.secret;
  const merchantId = isDirect ? directCfg?.merchantId : interCfg?.merchantCode;
  if (!baseUrl || !secret || !merchantId) {
    return { ok: false, errorFa: "درگاه بانکی پیکربندی نشده است." };
  }

  // Re-query verify endpoint with authority
  try {
    const verifyUrl = baseUrl.replace(/\/Token$/, "/Verify");
    // P0.14 — same egress policy for the verify call.
    await assertSafeOutboundUrl(verifyUrl, { allowedPorts: [443] });
    const parsed = await pinnedFetchJson<{
      status?: number | string;
      RefId?: string;
      TraceNo?: string;
      Amount?: number;
    }>(verifyUrl, {
      allowedPorts: [443],
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        Authority: input.authority,
        MerchantId: merchantId,
        Amount: input.order.amountRials,
      }),
      timeoutMs: 15_000,
      maxBytes: 512 * 1024,
    });
    if (!parsed.ok) {
      return { ok: false, errorFa: "پاسخ در gateway نامعتبر است." };
    }
    const json = parsed.data;
    // HARD AMOUNT CHECK
    const returnedAmount = typeof json.Amount === "number"
      ? Math.round(json.Amount)
      : input.order.amountRials; // some gateways omit Amount — trust our stored amount + status
    if (json.Amount === undefined) {
      // P1.10.5 — a gateway that omits Amount is an explicit provider
      // limitation, never proof of correctness. The payment still relies on
      // the gateway's verify status, but the gap is durably audited so the
      // operator can see that the amount was NOT provider-confirmed.
      await audit({
        userId: input.order.userId,
        actor: "provider",
        action: "bank_amount_not_provider_verified",
        targetType: "order",
        targetId: input.order.id,
        ip: input.ip,
        meta: { authority: input.authority, expectedAmount: input.order.amountRials },
      });
    }
    if (json.Amount !== undefined && returnedAmount !== input.order.amountRials) {
      // CAS-guarded (M-2): only a still-payable order may transition to
      // failed — a re-verify racing a successful finalize (or hitting an
      // already-paid order) must NOT corrupt the paid financial state.
      await db.order.updateMany({
        where: { id: input.order.id, status: { in: PAYABLE_STATUSES } },
        data: { status: "failed" },
      });
      await audit({
        userId: input.order.userId,
        actor: "provider",
        action: "bank_payment_mismatch",
        targetType: "order",
        targetId: input.order.id,
        ip: input.ip,
        meta: {
          expected: input.order.amountRials,
          returned: returnedAmount,
          authority: input.authority,
        },
      });
      return { ok: false, errorFa: "مبلغ بازگشتی با مبلغ سفارش مطابقت ندارد." };
    }
    // Some gateways return status=100 or "OK" on success
    const status = String(json.status ?? "");
    const isOkStatus = status === "100" || status === "OK" || status === "ok" || status === "1";
    if (!isOkStatus) {
      // CAS-guarded (M-2): see above — never regress a paid order.
      await db.order.updateMany({
        where: { id: input.order.id, status: { in: PAYABLE_STATUSES } },
        data: { status: "failed" },
      });
      return { ok: false, errorFa: "پرداخت توسط بانک تأیید نشد." };
    }

    const traceNo = json.TraceNo ?? json.RefId ?? null;

    const idemKey = `bank:verify:${input.order.id}:${input.authority}`;
    // Atomic finalize — claim via BankGatewayRef.paidAt CAS (idempotency gate).
    // ROOT-CAUSE FIX (audit §12/§15): the order row is NOT marked paid here.
    // The old code set order.status="paid" inside this transaction and THEN
    // called activateSubscription, whose payable-status CAS saw "paid" and
    // skipped ALL financial effects (no wallet credit, no ledger, no
    // subscription, no referral) — the user was charged real money and
    // received nothing. Now activateSubscription is the single owner of the
    // order→paid claim plus every financial side effect, in one transaction.
    let firstFinalize = false;
    await db.$transaction(async (tx) => {
      const updated = await tx.bankGatewayRef.updateMany({
        where: { authority: input.authority, paidAt: null },
        data: {
          paidAt: new Date(),
          traceNo: traceNo ?? null,
          verifyRefId: traceNo ?? null,
          rawResponse: JSON.stringify(sanitizeRaw(json)),
        },
      });
      firstFinalize = updated.count === 1;
    });

    // Runs on first finalize AND on idempotent re-entry (heals any
    // legacy/crashed state where the ref was marked paid without the
    // financial effects; internally idempotent — no double credit).
    await activateSubscription({
      orderId: input.order.id,
      paidRials: input.order.amountRials,
      idempotencyKey: idemKey,
    });

    // Notify + audit only on the first finalize (no duplicate spam on
    // repeated gateway callbacks). P0.7.7: delivery failures here must
    // never invalidate the committed financial success.
    if (firstFinalize) {
      try {
        await db.notification.create({
          data: {
            userId: input.order.userId,
            category: "payment",
            titleFa: "پرداخت موفق",
            bodyFa: `پرداخت ${formatRials(input.order.amountRials)} با کد پیگیری ${traceNo ?? input.authority.slice(0, 8)} تأیید شد.`,
            link: "/dashboard/wallet",
          },
        });
        await audit({
          userId: input.order.userId,
          actor: "provider",
          action: "bank_payment_paid",
          targetType: "order",
          targetId: input.order.id,
          ip: input.ip,
          meta: { amountRials: input.order.amountRials, authority: input.authority, traceNo },
        });
      } catch (err) {
        console.error(
          "bank finalize notification/audit failed (financial effects already committed):",
          err instanceof Error ? err.message : err,
        );
      }
    }
    return {
      ok: true,
      paidRials: input.order.amountRials,
      providerRef: input.authority,
    };
  } catch {
    return { ok: false, errorFa: "اتصال به درگاه بانکی ناموفق بود." };
  }
}

// Redact sensitive fields from raw response before persisting.
function sanitizeRaw(o: unknown): Record<string, unknown> {
  if (!o || typeof o !== "object") return {};
  const obj = o as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    if (lk.includes("token") || lk.includes("secret") || lk.includes("password")) {
      out[k] = "[redacted]";
    } else if (typeof v === "string" && v.length > 256) {
      out[k] = v.slice(0, 256) + "…";
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Provider shim — implements PaymentProvider interface
// ---------------------------------------------------------------------
export interface BankProvider extends PaymentProvider {
  // expose mode-aware methods for the API routes
  bankCreatePaymentRequest(input: { order: OrderLike; mode: BankMode }): ReturnType<typeof bankCreatePaymentRequest>;
  bankVerifyAndFinalize(input: { order: OrderLike; authority: string; status?: string; ip?: string }): ReturnType<typeof bankVerifyAndFinalize>;
  verifyStateToken(orderId: string, token: string): boolean;
}

export function getBankProvider(): BankProvider {
  return {
    kind: "bank",
    async createPaymentRequest({ order, extras }) {
      const mode = (extras?.mode as BankMode | undefined) ?? "direct";
      const r = await bankCreatePaymentRequest({ order, mode });
      return {
        redirectUrl: r.redirectUrl,
        providerRef: r.providerRef,
        view: { authority: r.authority, mode: r.mode, errorFa: r.errorFa },
      };
    },
    async verifyAndFinalize({ order, requestPayload }) {
      const authority = String(requestPayload.authority ?? requestPayload.Authority ?? "");
      const status = String(requestPayload.status ?? "");
      if (!authority) return { ok: false, errorFa: "Authority ارسال نشده است." };
      return bankVerifyAndFinalize({ order, authority, status });
    },
    bankCreatePaymentRequest,
    bankVerifyAndFinalize,
    verifyStateToken,
  };
}
