// =====================================================================
// POSTYAR — Plan feature catalog (CLIENT-SAFE pure module)
// ---------------------------------------------------------------------
// This module contains ONLY pure data + pure helpers (no database, no
// Node APIs). It is imported by client components (admin plan editor)
// AND by the server-side plans service, which re-exports it.
//
// History: these definitions used to live in plans.ts together with the
// Prisma-backed service. Any client component importing the catalog
// therefore pulled the whole Prisma client into the browser and the
// module-load `ensurePlansSeeded()` call attempted DATABASE WRITES from
// the browser ("PrismaClient is unable to run in this browser
// environment" — a real preview/runtime error). Splitting the catalog
// out is the root-cause fix: the client bundle never touches Prisma.
// =====================================================================

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

/** M-02 — strict quota validation/normalization. `Plan.quota` JSON is
 *  a legacy compatibility surface; admin writes must carry ONLY known
 *  dimensions with finite numeric values, stored normalized:
 *  0 = disabled, UNLIMITED_QUOTA (-1) = unlimited, positive = finite.
 *  Unknown keys are REJECTED (never silently persisted), non-finite
 *  values are rejected, and negatives normalize to the unlimited
 *  sentinel so the stored representation matches the engine's
 *  semantics (consumeQuotaInTx treats any negative as unlimited). */
const QUOTA_DIMENSIONS: readonly (keyof PlanQuota)[] = [
  "publishPerMonth", "aiPerMonth", "channels", "automation",
];

export function parsePlanQuota(
  raw: string | Record<string, unknown> | null | undefined,
): { ok: true; quota: PlanQuota } | { ok: false; errorFa: string } {
  const obj: Record<string, unknown> =
    typeof raw === "string"
      ? safeJsonParse<Record<string, unknown>>(raw ?? "{}", {})
      : ((raw ?? {}) as Record<string, unknown>);
  const out: PlanQuota = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!(QUOTA_DIMENSIONS as readonly string[]).includes(key)) {
      return { ok: false, errorFa: `کلید سهمیه «${key}» شناخته‌شده نیست.` };
    }
    if (typeof value !== "number" && typeof value !== "string") {
      return { ok: false, errorFa: `مقدار سهمیه «${key}» باید عدد باشد.` };
    }
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) {
      return { ok: false, errorFa: `مقدار سهمیه «${key}» باید عدد متناهی باشد.` };
    }
    out[key as keyof PlanQuota] = n < 0 ? UNLIMITED_QUOTA : Math.max(0, Math.floor(n));
  }
  return { ok: true, quota: out };
}

/** M-02 — reject unknown feature keys explicitly (the authoritative
 *  catalog is ALL_FEATURE_DEFS). parsePlanFeatures silently DROPS
 *  unknown keys; administrators typo-ing a feature key must get a 400,
 *  not a silently-ignored write. */
export function findUnknownFeatureKeys(input: Record<string, unknown>): string[] {
  const known = new Set<string>(ALL_FEATURE_DEFS.map((d) => d.key as string));
  return Object.keys(input ?? {}).filter((k) => !known.has(k));
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

export const PAYABLE_STATUSES = ["pending", "awaiting_payment", "awaiting_review"];
