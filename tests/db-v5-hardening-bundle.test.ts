// =====================================================================
// POSTYAR — V5 hardening bundle (Task 9-d) regression tests
// ---------------------------------------------------------------------
// Pins the 9-d repairs against the real database:
//
//   H-07  bumpSettingsEpoch is CAS-monotonic: two bumps NEVER produce the
//         same value (the old String(Date.now()) collided within one
//         millisecond, leaving old-epoch cache entries reachable), a huge
//         stored epoch still advances strictly upward, and a legacy
//         non-numeric epoch ("abc") falls back sanely without throwing.
//
//   M-05  adminAdjustWallet's critical wallet_adjust audit lives INSIDE
//         the mutation-only branch — an idempotent replay (same key, no
//         money movement) writes no SECOND audit row (and no second txn).
//
//   ordering  admin order reject performs the CAS status write FIRST; a
//         lost race (a paid-transition won) can never leave a rejection
//         note in a PAID order's metadata. A plain reject still writes
//         metadata + notification + audit.
//
//   M-02  validatePlanQuotaFeatureConsistency — the impossible
//         feature/quota combination check now covers the separate legacy
//         `quota` JSON surface (feature ON + paired legacy quota 0 is
//         rejected), with quota values overriding features for the check.
//
//   referral  the activation-path referral reward uses the SAME clamped
//         env parsers as referral.ts — a malformed POSTYAR_REFERRAL_*
//         value degrades to the documented defaults (20% / 100k), never
//         to NaN or a silently-dropped reward.
//
//   H-12  POST /api/tickets enforces the `tickets` plan-feature gate
//         (403 with bounded Persian for a tickets:false plan; success on
//         the free plan), matching the create_ticket workflow action.
// =====================================================================
import { describe, test, expect, beforeAll, beforeEach, mock } from "bun:test";
import { db } from "@/lib/db";
import { resetDb, seedUser, seedPlan, seedOrder, ensureDbConnected } from "./_db-helpers";

// --- Mock next/headers cookies() (same pattern as db-authorization.test.ts;
// --- bun hoists mock.module above the static imports) ---
let _cookieValue: string | undefined = undefined;
const _cookieStore = {
  get: (_name: string) => (_cookieValue !== undefined ? { value: _cookieValue } : undefined),
  set: (_name: string, value: string) => { _cookieValue = value; },
  delete: () => { _cookieValue = undefined; },
};
mock.module("next/headers", () => ({
  cookies: async () => _cookieStore,
}));

import { adminAdjustWallet } from "../src/lib/payments/wallet";
import {
  activateSubscription,
  validatePlanQuotaFeatureConsistency,
} from "../src/lib/payments/plans";
import { PAYABLE_STATUSES } from "../src/lib/payments/plan-catalog";
import { bumpSettingsEpoch, SETTINGS_EPOCH_KEY } from "../src/lib/providers/util";
import { rewardPercent, rewardCapRials } from "../src/lib/payments/referral";
import { createSession } from "@/lib/server/auth";
import * as ticketsRoute from "@/app/api/tickets/route";
import * as rejectRoute from "@/app/api/admin/orders/[id]/reject/route";

function jsonRequest(url: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readEpochRow(): Promise<string> {
  const row = await db.systemSetting.findUnique({
    where: { key: SETTINGS_EPOCH_KEY },
    select: { value: true },
  });
  return row?.value ?? "";
}

/** Seed an ACTIVE subscription row for the gate tests. */
async function seedSubscription(userId: string, planId: string) {
  return db.subscription.create({
    data: {
      userId,
      planId,
      status: "active",
      startedAt: new Date(),
      endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      usedQuota: "{}",
      activeKey: `${userId}:${planId}`,
    },
  });
}

// =====================================================================
// H-07 — epoch monotonicity
// =====================================================================
describe("V5 H-07 — bumpSettingsEpoch is CAS-monotonic", () => {
  beforeAll(async () => { await ensureDbConnected(); });
  beforeEach(async () => { await resetDb(); });

  test("two quick bumps produce strictly increasing values (no same-ms collision)", async () => {
    await bumpSettingsEpoch();
    const v1 = await readEpochRow();
    expect(v1).not.toBe("");
    await bumpSettingsEpoch();
    const v2 = await readEpochRow();
    expect(BigInt(v2) > BigInt(v1)).toBe(true); // strict numeric increase
    await bumpSettingsEpoch();
    const v3 = await readEpochRow();
    expect(BigInt(v3) > BigInt(v2)).toBe(true);
  });

  test("huge stored epoch (beyond double precision) still advances strictly upward", async () => {
    const huge = "9999999999999999999";
    await db.systemSetting.create({ data: { key: SETTINGS_EPOCH_KEY, value: huge } });
    await bumpSettingsEpoch();
    const next = await readEpochRow();
    // Strictly greater than the stored value as exact integers — a
    // Number()-only implementation would stall at the same double.
    expect(BigInt(next) > BigInt(huge)).toBe(true);
  });

  test("legacy non-numeric epoch ('abc') falls back sanely (no throw, numeric value)", async () => {
    await db.systemSetting.create({ data: { key: SETTINGS_EPOCH_KEY, value: "abc" } });
    await expect(bumpSettingsEpoch()).resolves.toBeUndefined();
    const v = await readEpochRow();
    expect(/^\d+$/.test(v)).toBe(true);
    expect(BigInt(v) > BigInt(1_000_000_000_000)).toBe(true); // at least Date.now()-scale
  });

  test("concurrent bumps never regress the epoch", async () => {
    await bumpSettingsEpoch();
    const before = await readEpochRow();
    const results = await Promise.allSettled([
      bumpSettingsEpoch(),
      bumpSettingsEpoch(),
      bumpSettingsEpoch(),
    ]);
    for (const r of results) expect(r.status).toBe("fulfilled");
    const after = await readEpochRow();
    expect(BigInt(after) >= BigInt(before)).toBe(true);
    // A subsequent sequential bump is still strictly greater.
    await bumpSettingsEpoch();
    expect(BigInt(await readEpochRow()) > BigInt(after)).toBe(true);
  });
});

// =====================================================================
// M-05 — adminAdjustWallet idempotent replay writes ONE audit row
// =====================================================================
describe("V5 M-05 — admin adjust audit is inside the mutation-only branch", () => {
  let userId: string;
  let adminId: string;

  beforeAll(async () => { await ensureDbConnected(); });
  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "v5-adj@test.local", mobile: "09120000901" });
    const a = await seedUser({ email: "v5-adj-admin@test.local", mobile: "09120000902", role: "admin" });
    userId = u.id;
    adminId = a.id;
  });

  test("adjust + replay with the same key → exactly 1 txn AND exactly 1 audit row", async () => {
    const input = {
      userId,
      amount: 250_000 as number,
      reason: "v5 replay check",
      idempotencyKey: "v5-adj-K",
      adminId,
    };
    const r1 = await adminAdjustWallet(input);
    expect(r1.balanceRials).toBe(250_000);
    const r2 = await adminAdjustWallet(input); // idempotent replay
    expect(r2.balanceRials).toBe(250_000);     // no double credit

    expect(await db.walletTxn.count({ where: { userId, reason: "admin_adjust" } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { userId, eventType: "admin_adjust" } })).toBe(1);
    // The pre-fix bug: the audit was written OUTSIDE the idempotency guard,
    // so the replay produced a SECOND audit row with no money movement.
    expect(
      await db.auditLog.count({ where: { action: "wallet_adjust", targetId: userId } }),
    ).toBe(1);
    expect(await db.notification.count({ where: { userId, category: "payment" } })).toBe(1);
  });

  test("a DIFFERENT key is a real new mutation with its own audit row", async () => {
    await adminAdjustWallet({ userId, amount: 100_000, reason: "a", idempotencyKey: "k1", adminId });
    await adminAdjustWallet({ userId, amount: 50_000, reason: "b", idempotencyKey: "k2", adminId });
    expect(await db.walletTxn.count({ where: { userId, reason: "admin_adjust" } })).toBe(2);
    expect(
      await db.auditLog.count({ where: { action: "wallet_adjust", targetId: userId } }),
    ).toBe(2);
  });
});

// =====================================================================
// Ordering — admin reject: CAS first, metadata after
// =====================================================================
describe("V5 — admin order reject ordering (CAS before metadata)", () => {
  let adminId: string;

  beforeAll(async () => { await ensureDbConnected(); });
  beforeEach(async () => {
    await resetDb();
    _cookieValue = undefined;
    const a = await seedUser({ email: "v5-reject-admin@test.local", mobile: "09120000911", role: "admin" });
    adminId = a.id;
    await createSession(adminId, "127.0.0.1", "v5-reject-agent");
  });

  test("plain reject on a pending order: 200, status rejected, metadata note present", async () => {
    const user = await seedUser({ email: "v5-reject-u1@test.local", mobile: "09120000912" });
    const order = await seedOrder({ userId: user.id, amountRials: 300_000, status: "pending" });
    const res = await rejectRoute.POST(
      jsonRequest(`http://localhost/api/admin/orders/${order.id}/reject`, { reason: "مدارک ناقص" }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(res.status).toBe(200);
    const fresh = await db.order.findUnique({ where: { id: order.id } });
    expect(fresh?.status).toBe("rejected");
    const meta = JSON.parse(fresh?.metadata ?? "{}") as Record<string, unknown>;
    expect(Array.isArray(meta.rejections) && (meta.rejections as unknown[]).length === 1).toBe(true);
    expect(meta.rejectionReason).toBe("مدارک ناقص");
    expect(await db.notification.count({ where: { userId: user.id, category: "payment" } })).toBe(1);
    expect(
      await db.auditLog.count({ where: { action: "order_reject", targetId: order.id } }),
    ).toBe(1);
  });

  test("idempotent replay of a rejected order updates the reason without a second note", async () => {
    const user = await seedUser({ email: "v5-reject-u2@test.local", mobile: "09120000913" });
    const order = await seedOrder({ userId: user.id, amountRials: 120_000, status: "pending" });
    const r1 = await rejectRoute.POST(
      jsonRequest(`http://localhost/api/admin/orders/${order.id}/reject`, { reason: "اول" }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(r1.status).toBe(200);
    const r2 = await rejectRoute.POST(
      jsonRequest(`http://localhost/api/admin/orders/${order.id}/reject`, { reason: "دوم" }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(r2.status).toBe(200);
    const fresh = await db.order.findUnique({ where: { id: order.id } });
    const meta = JSON.parse(fresh?.metadata ?? "{}") as Record<string, unknown>;
    expect((meta.rejections as unknown[]).length).toBe(1);
    expect(meta.rejectionReason).toBe("دوم");
    expect(await db.notification.count({ where: { userId: user.id, category: "payment" } })).toBe(1);
  });

  test("already-paid order is refused with NO rejection note in metadata", async () => {
    const user = await seedUser({ email: "v5-reject-u3@test.local", mobile: "09120000914" });
    const order = await seedOrder({ userId: user.id, amountRials: 200_000, status: "paid" });
    const res = await rejectRoute.POST(
      jsonRequest(`http://localhost/api/admin/orders/${order.id}/reject`, { reason: "بدون اثر" }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(res.status).toBe(400);
    const fresh = await db.order.findUnique({ where: { id: order.id } });
    expect(fresh?.status).toBe("paid");
    const meta = JSON.parse(fresh?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta.rejections).toBeUndefined();
    expect(meta.rejectionReason).toBeUndefined();
  });

  test("contended race (reject vs paid-transition): a PAID order never carries the note", async () => {
    for (let i = 0; i < 8; i++) {
      const user = await seedUser({ email: `v5-race-u${i}@test.local` });
      const order = await seedOrder({ userId: user.id, amountRials: 100_000, status: "pending" });
      const [rejectRes] = await Promise.all([
        rejectRoute.POST(
          jsonRequest(`http://localhost/api/admin/orders/${order.id}/reject`, { reason: `race-${i}` }),
          { params: Promise.resolve({ id: order.id }) },
        ),
        // The paid-transition races the reject's CAS (PAYABLE → paid).
        db.order.updateMany({
          where: { id: order.id, status: { in: PAYABLE_STATUSES } },
          data: { status: "paid" },
        }),
      ]);
      const fresh = await db.order.findUnique({ where: { id: order.id } });
      expect(fresh).not.toBeNull();
      const meta = JSON.parse(fresh?.metadata ?? "{}") as Record<string, unknown>;
      const hasNote = Array.isArray(meta.rejections) || meta.rejectionReason != null;
      if (rejectRes.status === 200) {
        // Reject won the CAS → order must be rejected WITH its note.
        expect(fresh?.status).toBe("rejected");
        expect(hasNote).toBe(true);
      } else {
        // Reject lost → order must be paid and the metadata must be clean.
        expect(rejectRes.status).toBe(400);
        expect(fresh?.status).toBe("paid");
        expect(hasNote).toBe(false); // THE forbidden outcome (pre-fix bug)
      }
    }
  });
});

// =====================================================================
// M-02 — merged feature/quota combination check
// =====================================================================
describe("V5 M-02 — validatePlanQuotaFeatureConsistency (merged surfaces)", () => {
  test("feature ON with legacy quota 0 is rejected", () => {
    expect(validatePlanQuotaFeatureConsistency({ publish: true }, { publishPerMonth: 0 }))
      .toEqual(["publish+publishPerMonth"]);
    expect(validatePlanQuotaFeatureConsistency({ multiChannel: true }, { channels: 0 }))
      .toEqual(["multiChannel+channels"]);
    expect(validatePlanQuotaFeatureConsistency({ workflow: true, glassButtons: true }, { workflowSteps: 0, glassButtonsPerDest: 0 }).sort())
      .toEqual(["glassButtons+glassButtonsPerDest", "workflow+workflowSteps"]);
  });

  test("a 0 in quota OVERRIDES a positive value in features (the gap this closes)", () => {
    const out = validatePlanQuotaFeatureConsistency(
      { publish: true, publishPerMonth: 100 },
      { publishPerMonth: 0 },
    );
    expect(out).toEqual(["publish+publishPerMonth"]);
  });

  test("consistent maps pass; unlimited sentinel (-1) never flags", () => {
    expect(validatePlanQuotaFeatureConsistency({ publish: true }, { publishPerMonth: 100 })).toEqual([]);
    expect(validatePlanQuotaFeatureConsistency({ publish: true }, { publishPerMonth: -1 })).toEqual([]);
    expect(validatePlanQuotaFeatureConsistency({ publish: true, publishPerMonth: -1 }, {})).toEqual([]);
    expect(validatePlanQuotaFeatureConsistency({ bot: true, bots: 5 }, { channels: 3 })).toEqual([]);
  });

  test("features-only payload keeps the original V4 behavior (null quota)", () => {
    expect(validatePlanQuotaFeatureConsistency({ publish: true, publishPerMonth: 0 }, null))
      .toEqual(["publish+publishPerMonth"]);
    expect(validatePlanQuotaFeatureConsistency({ publish: true }, null)).toEqual([]);
  });

  test("numeric-string quota values are honored; non-finite values never override", () => {
    expect(validatePlanQuotaFeatureConsistency({ publish: true }, { publishPerMonth: "0" }))
      .toEqual(["publish+publishPerMonth"]);
    expect(validatePlanQuotaFeatureConsistency({ publish: true }, { publishPerMonth: "50" }))
      .toEqual([]);
    expect(validatePlanQuotaFeatureConsistency({ publish: true }, { publishPerMonth: Number.NaN }))
      .toEqual([]);
  });
});

// =====================================================================
// referral — clamped env parsers end-to-end through activation
// =====================================================================
describe("V5 — referral reward uses clamped env parsers (malformed env → defaults)", () => {
  let referrerId: string;

  beforeAll(async () => { await ensureDbConnected(); });
  beforeEach(async () => {
    await resetDb();
    const ref = await seedUser({ email: "v5-ref-ref@test.local", mobile: "09120000921" });
    referrerId = ref.id;
  });

  test("paid subscription order pays 20% capped at 100k with the documented defaults", async () => {
    const referred = await seedUser({ email: "v5-ref-new1@test.local", mobile: "09120000922", referredById: referrerId });
    const plan = await seedPlan({ code: "v5-ref-plan-1" });
    const order = await seedOrder({
      userId: referred.id, kind: "subscription", planId: plan.id,
      amountRials: 1_000_000, status: "pending",
    });
    const res = await activateSubscription({ orderId: order.id, paidRials: 1_000_000, idempotencyKey: "v5-ref-defaults" });
    // 20% of 1M = 200k → capped at 100k (preload env: percent=20, cap=100000)
    expect(res.referralRewardRials).toBe(100_000);
    const txn = await db.walletTxn.findFirst({ where: { userId: referrerId, reason: "referral_reward" } });
    expect(txn?.amountRials).toBe(100_000);
  });

  test("malformed env values degrade to the clamped defaults — reward NOT NaN/0", async () => {
    const savedPercent = process.env.POSTYAR_REFERRAL_PERCENT;
    const savedCap = process.env.POSTYAR_REFERRAL_CAP_RIALS;
    try {
      process.env.POSTYAR_REFERRAL_PERCENT = "abc";
      process.env.POSTYAR_REFERRAL_CAP_RIALS = "not-a-number";
      // Clamp semantics of referral.ts: non-finite → documented defaults.
      expect(rewardPercent()).toBe(20);
      expect(rewardCapRials()).toBe(100_000);

      const referred = await seedUser({ email: "v5-ref-new2@test.local", mobile: "09120000923", referredById: referrerId });
      const plan = await seedPlan({ code: "v5-ref-plan-2" });
      const order = await seedOrder({
        userId: referred.id, kind: "subscription", planId: plan.id,
        amountRials: 300_000, status: "pending",
      });
      const res = await activateSubscription({ orderId: order.id, paidRials: 300_000, idempotencyKey: "v5-ref-garbage" });
      // min(round(300k * 20 / 100), 100k) = 60k — the pre-fix NaN would
      // have silently dropped this reward entirely.
      expect(res.referralRewardRials).toBe(60_000);
      expect(Number.isFinite(res.referralRewardRials)).toBe(true);
      const txn = await db.walletTxn.findFirst({ where: { userId: referrerId, reason: "referral_reward" } });
      expect(txn?.amountRials).toBe(60_000);
      expect(await db.referralReward.count({ where: { referrerId } })).toBe(1);
    } finally {
      // Restore the preload's hermetic values for the rest of the suite.
      process.env.POSTYAR_REFERRAL_PERCENT = savedPercent;
      process.env.POSTYAR_REFERRAL_CAP_RIALS = savedCap;
    }
  });

  test("out-of-range percent (>100 / negative) also clamps to the default", () => {
    const saved = process.env.POSTYAR_REFERRAL_PERCENT;
    try {
      process.env.POSTYAR_REFERRAL_PERCENT = "500";
      expect(rewardPercent()).toBe(20);
      process.env.POSTYAR_REFERRAL_PERCENT = "-3";
      expect(rewardPercent()).toBe(20);
    } finally {
      process.env.POSTYAR_REFERRAL_PERCENT = saved;
    }
  });
});

// =====================================================================
// H-12 — POST /api/tickets enforces the `tickets` plan-feature gate
// =====================================================================
describe("V5 H-12 — tickets POST plan-feature gate (route-level)", () => {
  beforeAll(async () => { await ensureDbConnected(); });
  beforeEach(async () => {
    await resetDb();
    _cookieValue = undefined;
  });

  test("user on a tickets:false plan → 403 bounded Persian, no ticket row", async () => {
    const user = await seedUser({ email: "v5-gate-u1@test.local", mobile: "09120000931" });
    const plan = await seedPlan({ code: "v5-gate-notickets" });
    // Minimal features JSON in the SEED_PLANS shape (tickets disabled).
    await db.plan.update({
      where: { id: plan.id },
      data: { features: JSON.stringify({ publish: true, tickets: false, publishPerMonth: 5 }) },
    });
    await seedSubscription(user.id, plan.id);
    await createSession(user.id, "127.0.0.1", "v5-gate-agent");

    const res = await ticketsRoute.POST(
      jsonRequest("http://localhost/api/tickets", { subject: "مشکل آزمایشی", body: "متن تیکت آزمایشی" }),
    );
    expect(res.status).toBe(403);
    const payload = (await res.json()) as { errorFa?: string };
    expect(typeof payload.errorFa).toBe("string");
    expect((payload.errorFa ?? "").length).toBeGreaterThan(0);
    expect((payload.errorFa ?? "").length).toBeLessThanOrEqual(200); // bounded
    expect(await db.ticket.count({ where: { userId: user.id } })).toBe(0);
  });

  test("user on the free plan (tickets:true) → ticket created (no regression)", async () => {
    const user = await seedUser({ email: "v5-gate-u2@test.local", mobile: "09120000932" });
    await createSession(user.id, "127.0.0.1", "v5-gate-agent");
    // No subscription → the effective plan is the seeded free plan, whose
    // SEED_PLANS features carry tickets: true.
    const res = await ticketsRoute.POST(
      jsonRequest("http://localhost/api/tickets", { subject: "مشکل آزمایشی", body: "متن تیکت آزمایشی" }),
    );
    expect(res.status).toBe(201);
    const payload = (await res.json()) as { ok?: boolean; ticket?: { id: string } };
    expect(payload.ok).toBe(true);
    expect(await db.ticket.count({ where: { userId: user.id } })).toBe(1);
  });
});
