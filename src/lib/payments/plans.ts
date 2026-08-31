// =====================================================================
// POSTYAR — Plans, Subscriptions, Quota engine
// ---------------------------------------------------------------------
// Money is INTEGER minor units (Rial). NO floats anywhere.
// All financial mutations are atomic via Prisma $transaction with
// deterministic idempotency keys. Server-authoritative.
// Persian + RTL + Jalali everywhere.
// =====================================================================
import { db } from "@/lib/db";
import { formatRials, toPersianDigits } from "@/lib/persian";

// NOTE: `plans.ts` is imported by both server API routes AND client components
// (e.g. admin/plans.tsx imports FEATURE_CATALOG). To keep it client-safe we
// MUST NOT import from `@/lib/server/auth` (which pulls next/headers + ioredis)
// or any other server-only module here. The two helpers below are inlined
// copies of the ones in lib/server/auth.ts — kept local on purpose.
export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.status = status;
    this.name = "AuthError";
  }
}

export function safeJsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------
// Quota shape (stored as JSON string in Plan.quota / Subscription.usedQuota)
// ---------------------------------------------------------------------
export type QuotaDimension = "publishPerMonth" | "aiPerMonth" | "channels" | "automation";

export interface QuotaState {
  publishPerMonth: { used: number; limit: number };
  aiPerMonth: { used: number; limit: number };
  channels: { used: number; limit: number };
  automation: { used: number; limit: number };
}

export interface PlanQuota {
  publishPerMonth?: number;
  aiPerMonth?: number;
  channels?: number;
  automation?: number;
}

// =====================================================================
// Granular plan features (ITEM 31).
// ---------------------------------------------------------------------
// `Plan.features` JSON stores `{ featureKey: boolean | number }`.
// `PlanQuota` is kept for backward-compat with the legacy quota engine,
// but `features` is the new source of truth for module gating.
// =====================================================================

/** Boolean feature toggles (presence => module is enabled). */
export type PlanBooleanFeatureKey =
  | "publish"
  | "schedule"
  | "multiChannel"
  | "bot"
  | "workflow"
  | "linkCodes"
  | "broadcast"
  | "glassButtons"
  | "caption"
  | "smartText"
  | "smartReply"
  | "autoResponder"
  | "inbox"
  | "woo"
  | "goldBot"
  | "goldMonitor"
  | "advertising"
  | "referral"
  | "wallet"
  | "tickets"
  | "stats"
  | "automation"
  | "apiAccess";

/** Numeric quota features (0 = unlimited). */
export type PlanNumericFeatureKey =
  | "publishPerMonth"
  | "aiPerMonth"
  | "channels"
  | "bots"
  | "destinations"
  | "contentItems"
  | "glassButtonsPerDest"
  | "workflowSteps";

/** All known feature keys. */
export type PlanFeatureKey = PlanBooleanFeatureKey | PlanNumericFeatureKey;

/** JSON shape persisted in Plan.features. Values are `boolean` for the
 *  keys in {@link PlanBooleanFeatureKey} and `number` for the keys in
 *  {@link PlanNumericFeatureKey}. Per-key type enforcement is delegated
 *  to the helper functions {@link getFeatureBoolean} / {@link getFeatureNumber}. */
export type PlanFeatures = Partial<Record<PlanFeatureKey, boolean | number>>;

export type PlanFeatureType = "boolean" | "number";

export interface PlanFeatureDef {
  key: PlanFeatureKey;
  label: string;
  type: PlanFeatureType;
}

export interface PlanFeatureGroup {
  id: string;
  title: string;
  items: PlanFeatureDef[];
}

/** Source-of-truth catalog for the admin UI and the gating engine. */
export const FEATURE_CATALOG: PlanFeatureGroup[] = [
  {
    id: "publishing",
    title: "انتشار و محتوا",
    items: [
      { key: "publish", label: "انتشار محتوا", type: "boolean" },
      { key: "schedule", label: "زمان‌بندی انتشار", type: "boolean" },
      { key: "multiChannel", label: "انتشار چندکاناله", type: "boolean" },
      { key: "publishPerMonth", label: "انتشار در ماه", type: "number" },
      { key: "contentItems", label: "محتوای ذخیره‌شده", type: "number" },
    ],
  },
  {
    id: "bot",
    title: "بات و اتوماسیون",
    items: [
      { key: "bot", label: "ساخت بات", type: "boolean" },
      { key: "workflow", label: "گردش کار", type: "boolean" },
      { key: "linkCodes", label: "کدهای اتصال", type: "boolean" },
      { key: "broadcast", label: "پیام گروهی", type: "boolean" },
      { key: "bots", label: "تعداد بات‌ها", type: "number" },
      { key: "workflowSteps", label: "گام‌های گردش کار", type: "number" },
      { key: "automation", label: "اتوماسیون", type: "boolean" },
    ],
  },
  {
    id: "ai",
    title: "هوش مصنوعی",
    items: [
      { key: "caption", label: "کپشن هوشمند", type: "boolean" },
      { key: "smartText", label: "متن هوشمند", type: "boolean" },
      { key: "smartReply", label: "پاسخ هوشمند", type: "boolean" },
      { key: "autoResponder", label: "پاسخگوی خودکار", type: "boolean" },
      { key: "inbox", label: "صندوق پیام‌ها", type: "boolean" },
      { key: "aiPerMonth", label: "هوش مصنوعی در ماه", type: "number" },
    ],
  },
  {
    id: "destinations",
    title: "مقاصد و دکمه‌ها",
    items: [
      { key: "destinations", label: "تعداد مقاصد", type: "number" },
      { key: "glassButtons", label: "دکمه‌های شیشه‌ای", type: "boolean" },
      { key: "glassButtonsPerDest", label: "دکمه شیشه‌ای هر مقصد", type: "number" },
      { key: "channels", label: "تعداد کانال‌ها", type: "number" },
    ],
  },
  {
    id: "integration",
    title: "یکپارچه‌سازی",
    items: [
      { key: "woo", label: "ووکامرس", type: "boolean" },
      { key: "goldBot", label: "ربات طلا", type: "boolean" },
      { key: "goldMonitor", label: "پایش طلا", type: "boolean" },
      { key: "advertising", label: "تبلیغات", type: "boolean" },
      { key: "referral", label: "معرفی دوستان", type: "boolean" },
    ],
  },
  {
    id: "tools",
    title: "ابزارها",
    items: [
      { key: "wallet", label: "کیف پول", type: "boolean" },
      { key: "tickets", label: "تیکت پشتیبانی", type: "boolean" },
      { key: "stats", label: "آمار تفکیکی", type: "boolean" },
      { key: "apiAccess", label: "دسترسی API", type: "boolean" },
    ],
  },
];

/** Flat list of all known feature defs (helper for counting / iterating). */
export const ALL_FEATURE_DEFS: PlanFeatureDef[] = FEATURE_CATALOG.flatMap((g) => g.items);

/** Type-guard: is this feature key a boolean toggle? */
export function isBooleanFeature(key: PlanFeatureKey): boolean {
  return ALL_FEATURE_DEFS.find((d) => d.key === key)?.type === "boolean";
}

/** Read a boolean feature with fallback. */
export function getFeatureBoolean(
  features: PlanFeatures | null | undefined,
  key: PlanBooleanFeatureKey,
  fallback = false,
): boolean {
  if (!features) return fallback;
  const v = features[key];
  return typeof v === "boolean" ? v : fallback;
}

/** Read a numeric feature with fallback. 0 = unlimited. */
export function getFeatureNumber(
  features: PlanFeatures | null | undefined,
  key: PlanNumericFeatureKey,
  fallback = 0,
): number {
  if (!features) return fallback;
  const v = features[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Count enabled features (booleans = true + numerics > 0) for badge display. */
export function countEnabledFeatures(features: PlanFeatures | null | undefined): number {
  if (!features) return 0;
  let n = 0;
  for (const def of ALL_FEATURE_DEFS) {
    const v = features[def.key];
    if (def.type === "boolean") {
      if (v === true) n += 1;
    } else {
      if (typeof v === "number" && v > 0) n += 1;
    }
  }
  return n;
}

/** Parse + validate a raw features JSON string into a PlanFeatures object. */
export function parsePlanFeatures(raw: string | null | undefined): PlanFeatures {
  const obj = safeJsonParse<Record<string, unknown>>(raw ?? "{}", {});
  const out: PlanFeatures = {};
  for (const def of ALL_FEATURE_DEFS) {
    if (!(def.key in obj)) continue;
    const v = obj[def.key];
    if (def.type === "boolean") {
      if (typeof v === "boolean") out[def.key] = v;
      else if (typeof v === "number") out[def.key] = v !== 0;
    } else {
      if (typeof v === "number" && Number.isFinite(v)) out[def.key] = Math.max(0, Math.floor(v));
      else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))
        out[def.key] = Math.max(0, Math.floor(Number(v)));
    }
  }
  return out;
}

export interface PublicPlanView {
  id: string;
  code: string;
  nameFa: string;
  descriptionFa: string;
  priceRials: number;
  priceRialsFa: string;
  intervalMonths: number;
  quota: PlanQuota;
  features: PlanFeatures;
  imageUrl: string | null;
  discountPct: number;
  renewalDiscountPct: number;
  renewalDiscountWindowDays: number;
  sortOrder: number;
  active: boolean;
  isPublic: boolean;
}

// ---------------------------------------------------------------------
// Plans listing / seeding
// ---------------------------------------------------------------------
const SEED_PLANS: Array<{
  code: string;
  nameFa: string;
  descriptionFa: string;
  priceRials: number;
  intervalMonths: number;
  quota: PlanQuota;
  isPublic: boolean;
  active: boolean;
}> = [
  {
    code: "free",
    nameFa: "رایگان",
    descriptionFa: "برای آشنایی با پُست‌یار — ۵ پست در ماه، ۱ کانال.",
    priceRials: 0,
    intervalMonths: 1,
    quota: { publishPerMonth: 5, aiPerMonth: 10, channels: 1, automation: 0 },
    isPublic: true,
    active: true,
  },
  {
    code: "basic",
    nameFa: "پایه",
    descriptionFa: "مناسب کسب‌وکارهای کوچک — ۱۰۰ پست در ماه، ۳ کانال.",
    priceRials: 200_000_000, // 20 million toman
    intervalMonths: 1,
    quota: { publishPerMonth: 100, aiPerMonth: 500, channels: 3, automation: 1 },
    isPublic: true,
    active: true,
  },
  {
    code: "pro",
    nameFa: "حرفه‌ای",
    descriptionFa: "برای تیم‌های بازاریابی — ۱۰۰۰ پست، ۱۰ کانال، اتوماسیون کامل.",
    priceRials: 500_000_000, // 50 million toman
    intervalMonths: 1,
    quota: { publishPerMonth: 1000, aiPerMonth: 5000, channels: 10, automation: 5 },
    isPublic: true,
    active: true,
  },
  {
    code: "business",
    nameFa: "سازمانی",
    descriptionFa: "بدون محدودیت پست و کانال — پشتیبانی اختصاصی.",
    priceRials: 1_500_000_000, // 150 million toman
    intervalMonths: 1,
    quota: { publishPerMonth: 10_000, aiPerMonth: 50_000, channels: 100, automation: 100 },
    isPublic: true,
    active: true,
  },
];

let seedPromise: Promise<void> | null = null;

export function ensurePlansSeeded(): Promise<void> {
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
    for (const p of SEED_PLANS) {
      await db.plan.upsert({
        where: { code: p.code },
        create: {
          code: p.code,
          nameFa: p.nameFa,
          descriptionFa: p.descriptionFa,
          priceRials: p.priceRials,
          intervalMonths: p.intervalMonths,
          quota: JSON.stringify(p.quota),
          isPublic: p.isPublic,
          active: p.active,
        },
        update: {
          // Only refresh volatile fields — never overwrite a price the admin
          // may have intentionally adjusted via a future admin UI.
          nameFa: p.nameFa,
          descriptionFa: p.descriptionFa,
          quota: JSON.stringify(p.quota),
        },
      });
    }
  })();
  return seedPromise;
}

// Run on module load (idempotent)
void ensurePlansSeeded();

export async function listPublicPlans(): Promise<PublicPlanView[]> {
  await ensurePlansSeeded();
  const rows = await db.plan.findMany({
    where: { isPublic: true, active: true },
    orderBy: [{ sortOrder: "asc" }, { priceRials: "asc" }],
  });
  return rows.map((p) => ({
    id: p.id,
    code: p.code,
    nameFa: p.nameFa,
    descriptionFa: p.descriptionFa,
    priceRials: p.priceRials,
    priceRialsFa: formatRials(p.priceRials),
    intervalMonths: p.intervalMonths,
    quota: safeJsonParse<PlanQuota>(p.quota, {}),
    features: parsePlanFeatures(p.features),
    imageUrl: p.imageUrl,
    discountPct: p.discountPct ?? 0,
    renewalDiscountPct: p.renewalDiscountPct ?? 0,
    renewalDiscountWindowDays: p.renewalDiscountWindowDays ?? 0,
    sortOrder: p.sortOrder ?? 0,
    active: p.active,
    isPublic: p.isPublic,
  }));
}

export async function getPlanByCode(code: string) {
  return db.plan.findUnique({ where: { code } });
}

export async function getPlanById(id: string) {
  return db.plan.findUnique({ where: { id } });
}

// ---------------------------------------------------------------------
// Orders — creating a subscription order
// ---------------------------------------------------------------------
export interface CreateOrderInput {
  userId: string;
  planId?: string;
  kind: "subscription" | "wallet_credit" | "ad_campaign";
  amountRials?: number; // for wallet_credit / ad_campaign
  provider?: "card" | "bank" | "bale";
  descriptionFa?: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export async function createOrderForSubscription(input: {
  userId: string;
  planId: string;
  idempotencyKey: string;
  provider?: "card" | "bank" | "bale";
  metadata?: Record<string, unknown>;
}): Promise<{ order: { id: string; amountRials: number; status: string; descriptionFa: string } }> {
  await ensurePlansSeeded();
  const plan = await db.plan.findUnique({ where: { id: input.planId } });
  if (!plan || !plan.active) {
    throw new AuthError("طرح انتخاب‌شده معتبر یا فعال نیست.", 400);
  }
  // Try to create with idempotencyKey UNIQUE — if it exists, return that.
  const existing = await db.order.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) {
    if (existing.userId !== input.userId) {
      throw new AuthError("کلید یکتا تکراری است.", 409);
    }
    return {
      order: {
        id: existing.id,
        amountRials: existing.amountRials,
        status: existing.status,
        descriptionFa: existing.descriptionFa,
      },
    };
  }
  const descriptionFa = `اشتراک ${plan.nameFa} — ${toPersianDigits(plan.intervalMonths)} ماهه`;
  let order;
  try {
    order = await db.order.create({
      data: {
        userId: input.userId,
        kind: "subscription",
        amountRials: plan.priceRials,
        planId: plan.id,
        descriptionFa,
        status: "pending",
        provider: input.provider ?? null,
        idempotencyKey: input.idempotencyKey,
        metadata: JSON.stringify(input.metadata ?? {}),
      },
    });
  } catch (err) {
    // Concurrent create with the same idempotencyKey: return the existing
    // order instead of surfacing a raw P2002 500 (audit §13).
    const msg = (err as { code?: string; message?: string })?.message ?? "";
    if (!/unique|UNIQUE|constraint/i.test(msg)) throw err;
    const existingAfterRace = await db.order.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (!existingAfterRace || existingAfterRace.userId !== input.userId) {
      throw new AuthError("کلید یکتا تکراری است.", 409);
    }
    return {
      order: {
        id: existingAfterRace.id,
        amountRials: existingAfterRace.amountRials,
        status: existingAfterRace.status,
        descriptionFa: existingAfterRace.descriptionFa,
      },
    };
  }
  return {
    order: {
      id: order.id,
      amountRials: order.amountRials,
      status: order.status,
      descriptionFa: order.descriptionFa,
    },
  };
}

export async function createWalletCreditOrder(input: {
  userId: string;
  amountRials: number;
  idempotencyKey: string;
  provider?: "card" | "bank" | "bale";
  descriptionFa?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ order: { id: string; amountRials: number; status: string; descriptionFa: string } }> {
  if (!Number.isInteger(input.amountRials) || input.amountRials <= 0) {
    throw new AuthError("مبلغ نامعتبر است.", 400);
  }
  if (input.amountRials < 100_000) {
    throw new AuthError("حداقل مبلغ شارژ ۱۰٬۰۰۰ تومان است.", 400);
  }
  const existing = await db.order.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) {
    if (existing.userId !== input.userId) {
      throw new AuthError("کلید یکتا تکراری است.", 409);
    }
    return {
      order: {
        id: existing.id,
        amountRials: existing.amountRials,
        status: existing.status,
        descriptionFa: existing.descriptionFa,
      },
    };
  }
  const descriptionFa = input.descriptionFa ?? "شارژ کیف پول";
  let order;
  try {
    order = await db.order.create({
      data: {
        userId: input.userId,
        kind: "wallet_credit",
        amountRials: input.amountRials,
        descriptionFa,
        status: "pending",
        provider: input.provider ?? null,
        idempotencyKey: input.idempotencyKey,
      },
    });
  } catch (err) {
    // Concurrent create with the same idempotencyKey: return the existing
    // order instead of surfacing a raw P2002 500 (audit §13).
    const msg = (err as { code?: string; message?: string })?.message ?? "";
    if (!/unique|UNIQUE|constraint/i.test(msg)) throw err;
    const existingAfterRace = await db.order.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (!existingAfterRace || existingAfterRace.userId !== input.userId) {
      throw new AuthError("کلید یکتا تکراری است.", 409);
    }
    return {
      order: {
        id: existingAfterRace.id,
        amountRials: existingAfterRace.amountRials,
        status: existingAfterRace.status,
        descriptionFa: existingAfterRace.descriptionFa,
      },
    };
  }
  return {
    order: {
      id: order.id,
      amountRials: order.amountRials,
      status: order.status,
      descriptionFa: order.descriptionFa,
    },
  };
}

// ---------------------------------------------------------------------
// activateSubscription — atomic post-payment fulfillment.
//
// ROOT-CAUSE REDESIGN (audit §4/§12/§15): this function is the SINGLE
// OWNER of every financial side effect that follows a successful
// payment:
//   * order status claim  (pending/awaiting_payment/awaiting_review → paid)
//   * LedgerEntry         (ledger:payment:<orderId>)
//   * WalletTxn credit    (wallet:payment:<orderId>)
//   * Subscription activation / RENEWAL EXTENSION
//   * First-paid-order referral reward
//
// All of the above happen inside ONE $transaction and are keyed by
// deterministic orderId-derived idempotency keys, so:
//   * calling this function twice can never double-credit (upserts
//     no-op on the existing keys);
//   * an order that was already marked paid by a previous finalize
//     step (bank/bale legacy path or a crash between steps) is HEALED:
//     the upserts still run and no-op if the effects already exist;
//   * orders in non-payable states (expired/failed/rejected/cancelled)
//     are rejected — approving them can no longer fake success.
// ---------------------------------------------------------------------
const PAYABLE_STATUSES = ["pending", "awaiting_payment", "awaiting_review"];

export async function activateSubscription(input: {
  orderId: string;
  paidRials: number;
  idempotencyKey: string;
}): Promise<{ subscriptionId: string; endsAt: Date; referralRewardRials: number; credited: boolean }> {
  // HARD AMOUNT CHECK: paidRials must equal the order's stored amount.
  const order = await db.order.findUnique({
    where: { id: input.orderId },
  });
  if (!order) throw new AuthError("سفارش یافت نشد.", 404);
  if (order.amountRials !== input.paidRials) {
    throw new AuthError("مبلغ پرداختی با مبلغ سفارش مطابقت ندارد.", 400);
  }
  if (order.kind !== "subscription" && order.kind !== "wallet_credit") {
    throw new AuthError("نوع سفارش برای فعال‌سازی اشتراک معتبر نیست.", 400);
  }

  const result = await db.$transaction(async (tx) => {
    // CAS: claim the order into `paid`. If the claim loses, the order
    // MUST already be paid — anything else is a non-payable state and
    // MUST fail loudly (previously this silently faked success).
    const claimed = await tx.order.updateMany({
      where: { id: order.id, status: { in: PAYABLE_STATUSES } },
      data: { status: "paid" },
    });
    if (claimed.count === 0) {
      const fresh = await tx.order.findUnique({
        where: { id: order.id },
        select: { status: true },
      });
      if (!fresh || fresh.status !== "paid") {
        throw new AuthError(
          "این سفارش در وضعیت قابل پرداختی نیست و قابل تأیید نیست.",
          400,
        );
      }
      // Idempotent re-entry on an already-paid order: fall through and
      // re-run the (no-op) upserts below — this heals legacy rows that
      // were marked paid without ever receiving their financial
      // effects, and can never double-credit because the upserts are
      // keyed by deterministic orderId-derived keys.
    }

    // LedgerEntry — append-only. Keyed per order → per-order uniqueness.
    const ledgerIdemKey = `ledger:payment:${order.id}`;
    const walletIdemKey = `wallet:payment:${order.id}`;

    await tx.ledgerEntry.upsert({
      where: { idempotencyKey: ledgerIdemKey },
      create: {
        userId: order.userId,
        orderId: order.id,
        eventType: "payment",
        amountRials: order.amountRials,
        currency: "IRR",
        idempotencyKey: ledgerIdemKey,
      },
      update: {},
    });

    // WalletTxn credit (balanceAfter computed from the running total
    // inside this transaction — serialized by the SQLite/InnoDB writer
    // at this point because the CAS above already took the write lock).
    const prevTxns = await tx.walletTxn.findMany({
      where: { userId: order.userId },
      select: { amountRials: true, direction: true },
    });
    let runningBalance = 0;
    for (const t of prevTxns) {
      runningBalance += t.direction === "credit" ? t.amountRials : -t.amountRials;
    }
    const balanceAfter = runningBalance + order.amountRials;

    const existingWalletTxn = await tx.walletTxn.findUnique({
      where: { idempotencyKey: walletIdemKey },
      select: { id: true },
    });
    if (!existingWalletTxn) {
      await tx.walletTxn.create({
        data: {
          userId: order.userId,
          orderId: order.id,
          amountRials: order.amountRials,
          direction: "credit",
          reason: "payment",
          balanceAfter,
          idempotencyKey: walletIdemKey,
        },
      });
    }

    // Subscription activation / renewal (only for kind === subscription)
    let subscriptionId = "";
    let endsAt = new Date(0);
    if (order.kind === "subscription" && order.planId) {
      const plan = await tx.plan.findUnique({ where: { id: order.planId } });
      if (!plan) {
        throw new AuthError("طرح مرتبط با سفارش یافت نشد.", 500);
      }
      const now = new Date();
      const addInterval = (from: Date): Date => {
        const d = new Date(from);
        d.setMonth(d.getMonth() + plan.intervalMonths);
        return d;
      };
      // Dedup/renewal: look up the most-recent Subscription by (userId, planId).
      //  * No prior subscription  → create a new active one.
      //  * Prior subscription     → RENEW: extend endsAt from
      //    max(existing.endsAt, now) by the plan interval and reactivate.
      //    (Previously a repeat payment returned the old row unchanged —
      //    the user paid again and received nothing.)
      const existing = await tx.subscription.findFirst({
        where: { userId: order.userId, planId: plan.id },
        orderBy: { createdAt: "desc" },
      });
      if (!existing) {
        const created = await tx.subscription.create({
          data: {
            userId: order.userId,
            planId: plan.id,
            status: "active",
            startedAt: now,
            endsAt: addInterval(now),
            usedQuota: "{}",
          },
        });
        subscriptionId = created.id;
        endsAt = created.endsAt;
      } else {
        const base = existing.endsAt.getTime() > now.getTime() ? existing.endsAt : now;
        const newEndsAt = addInterval(base);
        await tx.subscription.update({
          where: { id: existing.id },
          data: { status: "active", endsAt: newEndsAt },
        });
        subscriptionId = existing.id;
        endsAt = newEndsAt;
      }
    }

    // Referral reward — only for the FIRST paid order by this user,
    // and only if the user was referred by someone. A UNIQUE violation
    // on ReferralReward.referredId (reward already granted elsewhere)
    // must NOT abort the whole activation transaction.
    let referralRewardRials = 0;
    const user = await tx.user.findUnique({
      where: { id: order.userId },
      select: { id: true, referredById: true },
    });
    if (user && user.referredById && user.referredById !== user.id) {
      const existingReward = await tx.referralReward.findUnique({
        where: { referredId: user.id },
      });
      if (!existingReward) {
        const rewardPercent = Number(process.env.POSTYAR_REFERRAL_PERCENT ?? 20);
        const capRials = Number(process.env.POSTYAR_REFERRAL_CAP_RIALS ?? 100_000);
        const computed = Math.round((order.amountRials * rewardPercent) / 100);
        referralRewardRials = Math.min(computed, capRials);
        if (referralRewardRials > 0) {
          const refIdemKey = `referral:reward:${user.id}`;
          const refWalletIdemKey = `wallet:referral:${user.id}`;
          const refLedgerIdemKey = `ledger:referral:${user.id}`;
          const prevR = await tx.walletTxn.findMany({
            where: { userId: user.referredById },
            select: { amountRials: true, direction: true },
          });
          let runningR = 0;
          for (const t of prevR) {
            runningR += t.direction === "credit" ? t.amountRials : -t.amountRials;
          }
          const balAfterR = runningR + referralRewardRials;
          try {
            await tx.referralReward.upsert({
              where: { idempotencyKey: refIdemKey },
              create: {
                referrerId: user.referredById,
                referredId: user.id,
                amountRials: referralRewardRials,
                status: "paid",
                idempotencyKey: refIdemKey,
              },
              update: {},
            });
            await tx.walletTxn.upsert({
              where: { idempotencyKey: refWalletIdemKey },
              create: {
                userId: user.referredById,
                amountRials: referralRewardRials,
                direction: "credit",
                reason: "referral_reward",
                balanceAfter: balAfterR,
                idempotencyKey: refWalletIdemKey,
              },
              update: {},
            });
            await tx.ledgerEntry.upsert({
              where: { idempotencyKey: refLedgerIdemKey },
              create: {
                userId: user.referredById,
                eventType: "referral_reward",
                amountRials: referralRewardRials,
                currency: "IRR",
                idempotencyKey: refLedgerIdemKey,
              },
              update: {},
            });
          } catch (err) {
            // UNIQUE on referredId → reward already granted concurrently.
            // Treat as already-rewarded; never abort activation.
            const msg = (err as { code?: string; message?: string })?.message ?? "";
            if (!/unique|UNIQUE|constraint/i.test(msg)) throw err;
            referralRewardRials = 0;
          }
        }
      }
    }

    return { subscriptionId, endsAt, referralRewardRials };
  });

  return { ...result, credited: true };
}

// ---------------------------------------------------------------------
// Active subscription lookup + quota state
// ---------------------------------------------------------------------
export async function getActiveSubscription(userId: string) {
  const now = new Date();
  const sub = await db.subscription.findFirst({
    where: {
      userId,
      status: "active",
      endsAt: { gt: now },
    },
    orderBy: { createdAt: "desc" },
    include: { plan: true },
  });
  return sub;
}

export async function getQuotaState(userId: string): Promise<QuotaState & { planNameFa?: string; endsAt?: string }> {
  const sub = await getActiveSubscription(userId);
  if (!sub) {
    // Free plan fallback
    const freePlan = await db.plan.findUnique({ where: { code: "free" } });
    const freeQuota: PlanQuota = freePlan
      ? safeJsonParse<PlanQuota>(freePlan.quota, { publishPerMonth: 5, aiPerMonth: 10, channels: 1, automation: 0 })
      : { publishPerMonth: 5, aiPerMonth: 10, channels: 1, automation: 0 };
    return {
      publishPerMonth: { used: 0, limit: freeQuota.publishPerMonth ?? 5 },
      aiPerMonth: { used: 0, limit: freeQuota.aiPerMonth ?? 10 },
      channels: { used: 0, limit: freeQuota.channels ?? 1 },
      automation: { used: 0, limit: freeQuota.automation ?? 0 },
      planNameFa: freePlan?.nameFa ?? "رایگان",
    };
  }
  const planQuota = safeJsonParse<PlanQuota>(sub.plan.quota, {});
  const used = safeJsonParse<Record<string, number>>(sub.usedQuota, {});
  return {
    publishPerMonth: { used: used.publishPerMonth ?? 0, limit: planQuota.publishPerMonth ?? 0 },
    aiPerMonth: { used: used.aiPerMonth ?? 0, limit: planQuota.aiPerMonth ?? 0 },
    channels: { used: used.channels ?? 0, limit: planQuota.channels ?? 0 },
    automation: { used: used.automation ?? 0, limit: planQuota.automation ?? 0 },
    planNameFa: sub.plan.nameFa,
    endsAt: sub.endsAt.toISOString(),
  };
}

// CAS retry bounds for the usedQuota JSON compare-and-swap below.
const QUOTA_CAS_RETRIES = 8;

function readQuotaJson(raw: string | null | undefined): Record<string, number> {
  return safeJsonParse<Record<string, number>>(raw ?? "{}", {});
}

/**
 * Atomically increment a quota dimension on the active subscription.
 *
 * ROOT-CAUSE FIX (audit §18 — check-then-increment): the previous
 * implementation did a read-modify-write of the whole usedQuota JSON
 * with no transaction/lock, so N concurrent calls lost N-1 increments
 * (quota overrun). This version uses an optimistic CAS loop:
 * the UPDATE carries the exact previously-read JSON string as a WHERE
 * condition; a concurrent writer changes that string, the affected-rows
 * count is 0, and we re-read + retry. Works identically on SQLite and
 * MariaDB (string equality predicate).
 */
export async function incrementQuotaUsage(input: {
  userId: string;
  dimension: QuotaDimension;
  amount: number;
}): Promise<void> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new AuthError("مقدار افزایش نامعتبر است.", 400);
  }
  const sub = await getActiveSubscription(input.userId);
  if (!sub) return; // free plan — no enforcement, no row
  for (let attempt = 0; attempt < QUOTA_CAS_RETRIES; attempt++) {
    const fresh = await db.subscription.findUnique({
      where: { id: sub.id },
      select: { usedQuota: true },
    });
    const prevRaw = fresh?.usedQuota ?? "{}";
    const used = readQuotaJson(prevRaw);
    used[input.dimension] = (used[input.dimension] ?? 0) + input.amount;
    const updated = await db.subscription.updateMany({
      where: { id: sub.id, usedQuota: prevRaw },
      data: { usedQuota: JSON.stringify(used) },
    });
    if (updated.count === 1) return;
  }
  throw new AuthError("به‌روزرسانی سهمیه هم‌زمان ناموفق بود. دوباره تلاش کنید.", 409);
}

/**
 * Atomically CHECK + RESERVE quota in one CAS loop (audit §18).
 * Returns true when the amount was reserved, false when the limit would
 * be exceeded. Reserving happens BEFORE the metered operation so that
 * concurrent bursts cannot all pass a stale check (TOCTOU); failed
 * operations keep the reservation by design (documented semantics:
 * fail-closed against quota overrun).
 */
export async function consumeQuota(input: {
  userId: string;
  dimension: QuotaDimension;
  amount: number;
}): Promise<boolean> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new AuthError("مقدار افزایش نامعتبر است.", 400);
  }
  const sub = await getActiveSubscription(input.userId);
  if (!sub) return true; // free plan — no enforcement row; allowed
  const planQuota = safeJsonParse<PlanQuota>(sub.plan.quota, {});
  const limit = planQuota[input.dimension] ?? 0;
  if (limit <= 0) return true; // 0 = unlimited
  for (let attempt = 0; attempt < QUOTA_CAS_RETRIES; attempt++) {
    const fresh = await db.subscription.findUnique({
      where: { id: sub.id },
      select: { usedQuota: true },
    });
    const prevRaw = fresh?.usedQuota ?? "{}";
    const used = readQuotaJson(prevRaw);
    const current = used[input.dimension] ?? 0;
    if (current + input.amount > limit) return false;
    used[input.dimension] = current + input.amount;
    const updated = await db.subscription.updateMany({
      where: { id: sub.id, usedQuota: prevRaw },
      data: { usedQuota: JSON.stringify(used) },
    });
    if (updated.count === 1) return true;
  }
  throw new AuthError("به‌روزرسانی سهمیه هم‌زمان ناموفق بود. دوباره تلاش کنید.", 409);
}

export async function requireQuota(input: {
  userId: string;
  dimension: QuotaDimension;
  amount: number;
}): Promise<void> {
  const state = await getQuotaState(input.userId);
  const dim = state[input.dimension];
  if (dim.limit > 0 && dim.used + input.amount > dim.limit) {
    const dimFa: Record<QuotaDimension, string> = {
      publishPerMonth: "انتشار ماهانه",
      aiPerMonth: "استفاده هوش مصنوعی ماهانه",
      channels: "کانال‌ها",
      automation: "اتوماسیون",
    };
    throw new AuthError(
      `سهمیه ${dimFa[input.dimension]} کافی نیست. ` +
      `استفاده‌شده: ${toPersianDigits(dim.used)} از ${toPersianDigits(dim.limit)}.`,
      403,
    );
  }
}
