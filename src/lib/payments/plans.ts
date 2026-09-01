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
import type { Prisma } from "@prisma/client";

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

/**
 * Quota limit semantics (P0.2 — disabled vs unlimited must not share a
 * representation):
 *   limit >  0  → finite quota (at most `limit` per period)
 *   limit === 0 → DISABLED (the feature/quota is not part of the plan)
 *   limit <  0  → UNLIMITED (explicit sentinel {@link UNLIMITED_QUOTA})
 *
 * The previous model overloaded integer `0` with "unlimited", which made
 * free-plan records (e.g. `automation: 0`) indistinguishable from "no cap"
 * and allowed free users to bypass the enforcement engine entirely.
 * Legacy stored plans that used 0 as "unlimited" are migrated
 * deterministically by the seed refresh (SEED_PLANS.features/quota now
 * carries explicit values for every dimension on every plan).
 */
export const UNLIMITED_QUOTA = -1;

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

/** Read a numeric feature with fallback.
 *  Semantics (P0.2): 0 = disabled, negative (UNLIMITED_QUOTA) = unlimited,
 *  positive = finite quota. Missing key → the caller's fallback. */
export function getFeatureNumber(
  features: PlanFeatures | null | undefined,
  key: PlanNumericFeatureKey,
  fallback = 0,
): number {
  if (!features) return fallback;
  const v = features[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Count enabled features (booleans = true + numerics != 0) for badge display. */
export function countEnabledFeatures(features: PlanFeatures | null | undefined): number {
  if (!features) return 0;
  let n = 0;
  for (const def of ALL_FEATURE_DEFS) {
    const v = features[def.key];
    if (def.type === "boolean") {
      if (v === true) n += 1;
    } else {
      if (typeof v === "number" && v !== 0) n += 1;
    }
  }
  return n;
}

/** Parse + validate a raw features JSON string into a PlanFeatures object.
 *  Numeric values accept the UNLIMITED_QUOTA (-1) sentinel; anything else
 *  is floored at 0 (disabled). */
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
      if (typeof v === "number" && Number.isFinite(v)) {
        out[def.key] = v < 0 ? UNLIMITED_QUOTA : Math.max(0, Math.floor(v));
      } else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
        const n = Number(v);
        out[def.key] = n < 0 ? UNLIMITED_QUOTA : Math.max(0, Math.floor(n));
      }
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
  features: PlanFeatures;
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
    // P0.2: explicit feature set — automation/bot/workflow/integrations are
    // DISABLED (0 / false), publishing + basic AI are finite quotas.
    features: {
      publish: true,
      schedule: true,
      caption: true,
      smartText: true,
      smartReply: true,
      inbox: true,
      wallet: true,
      tickets: true,
      stats: true,
      referral: true,
      publishPerMonth: 5,
      aiPerMonth: 10,
      channels: 1,
      destinations: 1,
      bots: 0,
      contentItems: 25,
      glassButtonsPerDest: 0,
      workflowSteps: 0,
    },
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
    features: {
      publish: true, schedule: true, multiChannel: true, bot: true, workflow: true,
      linkCodes: true, broadcast: true, glassButtons: true, caption: true,
      smartText: true, smartReply: true, autoResponder: true, inbox: true,
      woo: true, goldMonitor: true, advertising: true, referral: true,
      wallet: true, tickets: true, stats: true, automation: true, apiAccess: false,
      publishPerMonth: 100, aiPerMonth: 500, channels: 3, bots: 1,
      destinations: 10, contentItems: 500, glassButtonsPerDest: 3, workflowSteps: 10,
    },
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
    features: {
      publish: true, schedule: true, multiChannel: true, bot: true, workflow: true,
      linkCodes: true, broadcast: true, glassButtons: true, caption: true,
      smartText: true, smartReply: true, autoResponder: true, inbox: true,
      woo: true, goldBot: true, goldMonitor: true, advertising: true, referral: true,
      wallet: true, tickets: true, stats: true, automation: true, apiAccess: true,
      publishPerMonth: 1000, aiPerMonth: 5000, channels: 10, bots: 5,
      destinations: 50, contentItems: 2000, glassButtonsPerDest: 10, workflowSteps: 25,
    },
    isPublic: true,
    active: true,
  },
  {
    code: "business",
    nameFa: "سازمانی",
    descriptionFa: "بدون محدودیت پست و کانال — پشتیبانی اختصاصی.",
    priceRials: 1_500_000_000, // 150 million toman
    intervalMonths: 1,
    // P0.2: "بدون محدودیت" is expressed with the explicit UNLIMITED_QUOTA
    // sentinel (-1), never with 0 (which now means DISABLED).
    quota: {
      publishPerMonth: UNLIMITED_QUOTA,
      aiPerMonth: UNLIMITED_QUOTA,
      channels: UNLIMITED_QUOTA,
      automation: UNLIMITED_QUOTA,
    },
    features: {
      publish: true, schedule: true, multiChannel: true, bot: true, workflow: true,
      linkCodes: true, broadcast: true, glassButtons: true, caption: true,
      smartText: true, smartReply: true, autoResponder: true, inbox: true,
      woo: true, goldBot: true, goldMonitor: true, advertising: true, referral: true,
      wallet: true, tickets: true, stats: true, automation: true, apiAccess: true,
      publishPerMonth: UNLIMITED_QUOTA, aiPerMonth: UNLIMITED_QUOTA,
      channels: UNLIMITED_QUOTA, bots: UNLIMITED_QUOTA, destinations: UNLIMITED_QUOTA,
      contentItems: UNLIMITED_QUOTA, glassButtonsPerDest: UNLIMITED_QUOTA,
      workflowSteps: UNLIMITED_QUOTA,
    },
    isPublic: true,
    active: true,
  },
];

let seedPromise: Promise<void> | null = null;

export async function ensurePlansSeeded(): Promise<void> {
  if (seedPromise) {
    await seedPromise;
    // Robustness: the memoized seed can be defeated when the Plan table is
    // wiped out-of-band (test reset, operator data restore). Verify the rows
    // still exist with one cheap indexed query; re-seed when they vanished.
    const existing = await db.plan.count({
      where: { code: { in: SEED_PLANS.map((p) => p.code) } },
    });
    if (existing === SEED_PLANS.length) return;
  }
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
          features: JSON.stringify(p.features),
          isPublic: p.isPublic,
          active: p.active,
        },
        update: {
          // Refresh volatile + semantic fields — including `features` and
          // `quota`, which deterministically migrates legacy rows that relied
          // on the old "0 = unlimited" overload (P0.2). Prices are NEVER
          // overwritten so an admin-adjusted price survives re-seeding.
          nameFa: p.nameFa,
          descriptionFa: p.descriptionFa,
          quota: JSON.stringify(p.quota),
          features: JSON.stringify(p.features),
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
}): Promise<{ order: { id: string; amountRials: number; status: string; descriptionFa: string }; created: boolean }> {
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
      created: false,
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
      created: false,
      order: {
        id: existingAfterRace.id,
        amountRials: existingAfterRace.amountRials,
        status: existingAfterRace.status,
        descriptionFa: existingAfterRace.descriptionFa,
      },
    };
  }
  return {
    created: true,
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
}): Promise<{ order: { id: string; amountRials: number; status: string; descriptionFa: string }; created: boolean }> {
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
      created: false,
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
      created: false,
      order: {
        id: existingAfterRace.id,
        amountRials: existingAfterRace.amountRials,
        status: existingAfterRace.status,
        descriptionFa: existingAfterRace.descriptionFa,
      },
    };
  }
  return {
    created: true,
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
// This function is the SINGLE OWNER of every financial side effect that
// follows a successful payment:
//   * order status claim  (pending/awaiting_payment/awaiting_review → paid)
//   * LedgerEntry         (ledger:payment:<orderId>)   — accounting for ALL kinds
//   * WalletTxn credit    (wallet:payment:<orderId>)   — spendable credit for
//     `wallet_credit` orders ONLY (P0.5: a subscription purchase is revenue,
//     not spendable wallet balance — crediting it inflated every derived
//     wallet balance and allowed a paid subscription to be converted into
//     spendable credit)
//   * Subscription activation / RENEWAL EXTENSION (kind === "subscription")
//   * First-paid-SUBSCRIPTION-order referral reward (P0.6: wallet top-ups
//     and other order kinds never qualify)
//
// All of the above happen inside ONE $transaction keyed by deterministic
// orderId-derived idempotency keys, so re-entry (retry/replay/crash
// recovery) can never double-credit, and orders in non-payable states
// (expired/failed/rejected/cancelled) are rejected instead of faking success.
// ---------------------------------------------------------------------
export const PAYABLE_STATUSES = ["pending", "awaiting_payment", "awaiting_review"];

/** Per-user wallet write lock: takes a row lock on the User row so that
 *  concurrent financial transactions for the SAME user serialize their
 *  balance computations (InnoDB row lock on MariaDB; SQLite's single
 *  writer already serializes). */
async function lockUserWalletRow(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.user.update({ where: { id: userId }, data: { updatedAt: new Date() } });
}

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

    // Serialize concurrent wallet mutations for this user (balanceAfter
    // consistency across dialects — see lockUserWalletRow).
    await lockUserWalletRow(tx, order.userId);

    // LedgerEntry — append-only accounting row, created for EVERY paid
    // order kind (subscription AND wallet credit). Keyed per order →
    // per-order uniqueness.
    const ledgerIdemKey = `ledger:payment:${order.id}`;
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

    // WalletTxn — spendable balance mutation. ONLY wallet-credit orders
    // create spendable credit (P0.5): a subscription purchase must never
    // silently increase the user's spendable wallet balance.
    let subscriptionId = "";
    let endsAt = new Date(0);
    if (order.kind === "wallet_credit") {
      const walletIdemKey = `wallet:payment:${order.id}`;
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
    } else if (order.kind === "subscription" && order.planId) {
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
      // P0.9 — DB-backed uniqueness: the live subscription row per
      // (user, plan) is identified by the UNIQUE `activeKey`. Renewal
      // extends endsAt from max(existing.endsAt, now); a concurrent
      // purchase of the same plan loses the UNIQUE race and converges on
      // the winner's row via renewal (never creates a second live row).
      const activeKey = `${order.userId}:${plan.id}`;
      const existing = await tx.subscription.findUnique({ where: { activeKey } });
      if (!existing) {
        try {
          const created = await tx.subscription.create({
            data: {
              userId: order.userId,
              planId: plan.id,
              status: "active",
              startedAt: now,
              endsAt: addInterval(now),
              usedQuota: "{}",
              activeKey,
            },
          });
          subscriptionId = created.id;
          endsAt = created.endsAt;
        } catch (err) {
          // Concurrent activation created the row first — renew it instead.
          const msg = (err as { code?: string; message?: string })?.message ?? "";
          if (!/unique|UNIQUE|constraint/i.test(msg)) throw err;
          const winner = await tx.subscription.findUnique({ where: { activeKey } });
          if (!winner) {
            throw new AuthError("خطای هم‌زمانی در فعال‌سازی اشتراک.", 500);
          }
          const base = winner.endsAt.getTime() > now.getTime() ? winner.endsAt : now;
          const newEndsAt = addInterval(base);
          await tx.subscription.update({
            where: { id: winner.id },
            data: { status: "active", endsAt: newEndsAt },
          });
          subscriptionId = winner.id;
          endsAt = newEndsAt;
        }
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

    // Referral reward — ONLY for the user's FIRST PAID SUBSCRIPTION order
    // (P0.6: wallet top-ups and other order kinds never qualify), only if
    // the user was referred by someone else. A UNIQUE violation on
    // ReferralReward.referredId (reward already granted elsewhere) must
    // NOT abort the whole activation transaction.
    let referralRewardRials = 0;
    if (order.kind === "subscription") {
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
            // Serialize the referrer's wallet mutation too.
            await lockUserWalletRow(tx, user.referredById);
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
    // Free-plan view (read-only — provisioning happens in the enforcement
    // path). If a free enforcement row already exists, its real usage is
    // shown; otherwise usage is zero.
    const freePlan = await db.plan.findUnique({ where: { code: "free" } });
    const freeQuota: PlanQuota = freePlan
      ? safeJsonParse<PlanQuota>(freePlan.quota, { publishPerMonth: 5, aiPerMonth: 10, channels: 1, automation: 0 })
      : { publishPerMonth: 5, aiPerMonth: 10, channels: 1, automation: 0 };
    let used: Record<string, number> = {};
    if (freePlan) {
      const freeRow = await db.subscription.findUnique({
        where: { activeKey: `${userId}:${freePlan.id}` },
        select: { usedQuota: true },
      });
      if (freeRow) used = safeJsonParse<Record<string, number>>(freeRow.usedQuota, {});
    }
    return {
      publishPerMonth: { used: used.publishPerMonth ?? 0, limit: freeQuota.publishPerMonth ?? 5 },
      aiPerMonth: { used: used.aiPerMonth ?? 0, limit: freeQuota.aiPerMonth ?? 10 },
      channels: { used: used.channels ?? 0, limit: freeQuota.channels ?? 1 },
      automation: { used: used.automation ?? 0, limit: freeQuota.automation ?? 0 },
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
 * Resolve the subscription row that quota is enforced against for a user
 * (P0.2 + free-plan enforcement gap fix).
 *
 *  * An active PAID subscription wins (most recent first).
 *  * Otherwise a FREE-plan enforcement row is provisioned lazily and
 *    race-safely (UNIQUE activeKey): free users are no longer invisible
 *    to the quota engine — the old `consumeQuota` returned true for every
 *    user without a subscription, making the free plan UNLIMITED in
 *    practice while the dashboard advertised 5 publishes/month.
 *  * An expired free row is renewed (endsAt extended) and its usage is
 *    RESET — the free quota is per-period.
 *
 * Returns null only when the free plan itself cannot be resolved, in
 * which case enforcement FAILS CLOSED (callers deny the operation).
 */
async function ensureQuotaTarget(userId: string): Promise<{
  id: string;
  usedQuota: string;
  limitFor(dimension: QuotaDimension): number;
} | null> {
  const active = await getActiveSubscription(userId);
  if (active) {
    const planQuota = safeJsonParse<PlanQuota>(active.plan.quota, {});
    return {
      id: active.id,
      usedQuota: active.usedQuota,
      limitFor: (dimension) => planQuota[dimension] ?? 0,
    };
  }

  await ensurePlansSeeded();
  const freePlan = await db.plan.findUnique({ where: { code: "free" } });
  if (!freePlan) return null; // fail closed
  const freeQuota = safeJsonParse<PlanQuota>(freePlan.quota, {});
  const activeKey = `${userId}:${freePlan.id}`;

  const existing = await db.subscription.findUnique({ where: { activeKey } });
  const now = new Date();
  const addInterval = (from: Date): Date => {
    const d = new Date(from);
    d.setMonth(d.getMonth() + freePlan.intervalMonths);
    return d;
  };

  if (!existing) {
    try {
      const created = await db.subscription.create({
        data: {
          userId,
          planId: freePlan.id,
          status: "active",
          startedAt: now,
          endsAt: addInterval(now),
          usedQuota: "{}",
          activeKey,
        },
      });
      return {
        id: created.id,
        usedQuota: created.usedQuota,
        limitFor: (dimension) => freeQuota[dimension] ?? 0,
      };
    } catch (err) {
      // Lost the UNIQUE race → use the winner's row.
      const msg = (err as { code?: string; message?: string })?.message ?? "";
      if (!/unique|UNIQUE|constraint/i.test(msg)) throw err;
      const winner = await db.subscription.findUnique({ where: { activeKey } });
      if (!winner) return null;
      return {
        id: winner.id,
        usedQuota: winner.usedQuota,
        limitFor: (dimension) => freeQuota[dimension] ?? 0,
      };
    }
  }

  if (existing.endsAt.getTime() <= now.getTime()) {
    // Expired free row → renew + reset the period usage (best-effort CAS;
    // a concurrent renewal just means the row was refreshed for us).
    await db.subscription.updateMany({
      where: { id: existing.id, endsAt: existing.endsAt },
      data: { status: "active", endsAt: addInterval(now), usedQuota: "{}" },
    });
  } else if (existing.status !== "active") {
    await db.subscription.updateMany({
      where: { id: existing.id, status: { not: "active" } },
      data: { status: "active" },
    });
  }
  const fresh = await db.subscription.findUnique({ where: { id: existing.id } });
  if (!fresh) return null;
  return {
    id: fresh.id,
    usedQuota: fresh.usedQuota,
    limitFor: (dimension) => freeQuota[dimension] ?? 0,
  };
}

/** Quota check result — distinguishes disabled (limit 0) from exhausted. */
export type QuotaConsumeResult = "ok" | "exhausted" | "disabled" | "unconfigured";

/**
 * Atomically CHECK + RESERVE quota in one CAS loop.
 *
 * Semantics (P0.2):
 *   limit < 0  (UNLIMITED_QUOTA) → always "ok"
 *   limit == 0                   → "disabled" (feature not part of the plan)
 *   limit > 0                    → finite: reserve when used+amount <= limit
 *
 * Reserving happens BEFORE the metered operation so concurrent bursts
 * cannot all pass a stale check (TOCTOU); failed operations keep the
 * reservation by design (documented fail-closed semantics). Free-plan
 * users are enforced through the lazily provisioned free row.
 */
export async function consumeQuotaDetailed(input: {
  userId: string;
  dimension: QuotaDimension;
  amount: number;
}): Promise<QuotaConsumeResult> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new AuthError("مقدار افزایش نامعتبر است.", 400);
  }
  const target = await ensureQuotaTarget(input.userId);
  if (!target) return "unconfigured"; // fail closed — caller must deny
  const limit = target.limitFor(input.dimension);
  if (limit < 0) {
    // Explicit unlimited sentinel — no enforcement, but the usage counter
    // still advances so the dashboard can show real consumption.
    await incrementQuotaUsage(input);
    return "ok";
  }
  if (limit === 0) return "disabled"; // feature disabled on this plan
  for (let attempt = 0; attempt < QUOTA_CAS_RETRIES; attempt++) {
    const fresh = await db.subscription.findUnique({
      where: { id: target.id },
      select: { usedQuota: true },
    });
    const prevRaw = fresh?.usedQuota ?? "{}";
    const used = readQuotaJson(prevRaw);
    const current = used[input.dimension] ?? 0;
    if (current + input.amount > limit) return "exhausted";
    used[input.dimension] = current + input.amount;
    const updated = await db.subscription.updateMany({
      where: { id: target.id, usedQuota: prevRaw },
      data: { usedQuota: JSON.stringify(used) },
    });
    if (updated.count === 1) return "ok";
  }
  throw new AuthError("به‌روزرسانی سهمیه هم‌زمان ناموفق بود. دوباره تلاش کنید.", 409);
}

/**
 * Backward-compatible boolean wrapper around consumeQuotaDetailed.
 * "disabled" and "exhausted" both deny (fail closed); "unconfigured"
 * denies as well (the free plan row could not be resolved).
 */
export async function consumeQuota(input: {
  userId: string;
  dimension: QuotaDimension;
  amount: number;
}): Promise<boolean> {
  return (await consumeQuotaDetailed(input)) === "ok";
}

/**
 * Release a previously-made reservation (or part of it). Used by the
 * publish path when fewer jobs than reserved were actually created
 * (concurrent duplicate won part of the race). CAS-looped, floored at 0.
 */
export async function refundQuota(input: {
  userId: string;
  dimension: QuotaDimension;
  amount: number;
}): Promise<void> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) return;
  const target = await ensureQuotaTarget(input.userId);
  if (!target) return;
  for (let attempt = 0; attempt < QUOTA_CAS_RETRIES; attempt++) {
    const fresh = await db.subscription.findUnique({
      where: { id: target.id },
      select: { usedQuota: true },
    });
    const prevRaw = fresh?.usedQuota ?? "{}";
    const used = readQuotaJson(prevRaw);
    const current = used[input.dimension] ?? 0;
    used[input.dimension] = Math.max(0, current - input.amount);
    const updated = await db.subscription.updateMany({
      where: { id: target.id, usedQuota: prevRaw },
      data: { usedQuota: JSON.stringify(used) },
    });
    if (updated.count === 1) return;
  }
  // Refund is best-effort — exhausted retries leave usage higher than
  // reality, which is fail-closed (never permissive).
}

/**
 * Atomically increment a quota dimension (no limit check — callers that
 * need enforcement must use consumeQuota/consumeQuotaDetailed). Kept for
 * compatibility with existing call-sites that record usage outside the
 * check-and-reserve model.
 */
export async function incrementQuotaUsage(input: {
  userId: string;
  dimension: QuotaDimension;
  amount: number;
}): Promise<void> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new AuthError("مقدار افزایش نامعتبر است.", 400);
  }
  const target = await ensureQuotaTarget(input.userId);
  if (!target) return; // free plan row unresolvable — nothing to record on
  for (let attempt = 0; attempt < QUOTA_CAS_RETRIES; attempt++) {
    const fresh = await db.subscription.findUnique({
      where: { id: target.id },
      select: { usedQuota: true },
    });
    const prevRaw = fresh?.usedQuota ?? "{}";
    const used = readQuotaJson(prevRaw);
    used[input.dimension] = (used[input.dimension] ?? 0) + input.amount;
    const updated = await db.subscription.updateMany({
      where: { id: target.id, usedQuota: prevRaw },
      data: { usedQuota: JSON.stringify(used) },
    });
    if (updated.count === 1) return;
  }
  throw new AuthError("به‌روزرسانی سهمیه هم‌زمان ناموفق بود. دوباره تلاش کنید.", 409);
}

/**
 * Check quota WITHOUT consuming (read-only). Enforces the same P0.2
 * semantics: limit 0 = disabled → always throws; limit < 0 = unlimited →
 * never throws; finite → throws when used+amount would exceed it.
 */
export async function requireQuota(input: {
  userId: string;
  dimension: QuotaDimension;
  amount: number;
}): Promise<void> {
  const target = await ensureQuotaTarget(input.userId);
  if (!target) {
    throw new AuthError("سهمیه پلان فعلی قابل بررسی نیست.", 403);
  }
  const used = readQuotaJson(target.usedQuota);
  const current = used[input.dimension] ?? 0;
  const limit = target.limitFor(input.dimension);
  if (limit < 0) return; // unlimited
  if (limit === 0) {
    throw new AuthError("این امکان در پلان فعلی شما غیرفعال است. برای افزایش ظرفیت پلان را ارتقا دهید.", 403);
  }
  if (current + input.amount > limit) {
    const dimFa: Record<QuotaDimension, string> = {
      publishPerMonth: "انتشار ماهانه",
      aiPerMonth: "استفاده هوش مصنوعی ماهانه",
      channels: "کانال‌ها",
      automation: "اتوماسیون",
    };
    throw new AuthError(
      `سهمیه ${dimFa[input.dimension]} کافی نیست. ` +
      `استفاده‌شده: ${toPersianDigits(current)} از ${toPersianDigits(limit)}.`,
      403,
    );
  }
}

// ---------------------------------------------------------------------
// Plan feature resolution (P0.15 — server-side capability checks)
// ---------------------------------------------------------------------

/** Effective PlanFeatures for a user: the active subscription's plan
 *  features, or the free plan's features when no subscription exists. */
export async function getEffectiveFeatures(userId: string): Promise<PlanFeatures> {
  const sub = await getActiveSubscription(userId);
  if (sub) return parsePlanFeatures(sub.plan.features);
  await ensurePlansSeeded();
  const freePlan = await db.plan.findUnique({ where: { code: "free" } });
  return freePlan ? parsePlanFeatures(freePlan.features) : {};
}

const FEATURE_LABEL_FA: Partial<Record<PlanFeatureKey, string>> = {
  publish: "انتشار محتوا",
  schedule: "زمان‌بندی انتشار",
  multiChannel: "انتشار چندکاناله",
  bot: "ساخت بات",
  workflow: "گردش کار",
  linkCodes: "کدهای اتصال",
  broadcast: "پیام گروهی",
  glassButtons: "دکمه‌های شیشه‌ای",
  caption: "کپشن هوشمند",
  smartText: "متن هوشمند",
  smartReply: "پاسخ هوشمند",
  autoResponder: "پاسخگوی خودکار",
  inbox: "صندوق پیام‌ها",
  woo: "ووکامرس",
  goldBot: "ربات طلا",
  goldMonitor: "پایش طلا",
  advertising: "تبلیغات",
  referral: "معرفی دوستان",
  wallet: "کیف پول",
  tickets: "تیکت پشتیبانی",
  stats: "آمار تفکیکی",
  automation: "اتوماسیون",
  apiAccess: "دسترسی API",
};

/**
 * Server-side capability check (P0.15): throws a 403 AuthError when the
 * user's effective plan does not include the boolean feature. UI hiding is
 * NOT authorization — every privileged action boundary must call this.
 */
export async function requirePlanFeature(
  userId: string,
  key: PlanBooleanFeatureKey,
): Promise<void> {
  const features = await getEffectiveFeatures(userId);
  if (getFeatureBoolean(features, key, false)) return;
  const label = FEATURE_LABEL_FA[key] ?? key;
  throw new AuthError(
    `امکان «${label}» در پلان فعلی شما فعال نیست. برای استفاده پلان را ارتقا دهید.`,
    403,
  );
}

/**
 * Numeric-capacity check (P0.15): throws a 403 AuthError when the current
 * entity count already reaches the plan's numeric limit for `key`.
 *
 * Contradiction policy (P0.2.6): when the companion boolean feature is
 * enabled but the numeric quota is 0 (legacy/ambiguous data), the BOOLEAN
 * governs and the numeric check is skipped — a plan that explicitly enables
 * "bot: true" cannot be bricked by a stale "bots: 0". Numeric -1 means
 * unlimited; numeric > 0 is enforced strictly.
 */
export async function requireFeatureCapacity(
  userId: string,
  booleanKey: PlanBooleanFeatureKey,
  numericKey: PlanNumericFeatureKey,
  currentCount: number,
  labelFa: string,
): Promise<void> {
  await requirePlanFeature(userId, booleanKey);
  const features = await getEffectiveFeatures(userId);
  const limit = getFeatureNumber(features, numericKey, 0);
  if (limit < 0) return; // unlimited
  if (limit === 0) return; // boolean governs (see contradiction policy)
  if (currentCount >= limit) {
    throw new AuthError(
      `سقف ${labelFa} در پلن فعلی شما (${toPersianDigits(limit)}) تکمیل شده است. برای افزودن بیشتر پلن را ارتقا دهید.`,
      403,
    );
  }
}
