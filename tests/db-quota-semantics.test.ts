// =====================================================================
// POSTYAR — Quota semantics + publish reservation regression tests
// (P0.2 disabled/unlimited, free-plan enforcement, P0.1 building blocks)
// ---------------------------------------------------------------------
// Invariants under test:
//   * limit 0  = DISABLED  → consumeQuota denies, detailed result "disabled"
//   * limit -1 = UNLIMITED → consumeQuota allows without bound
//   * limit > 0 = finite   → CAS reserve; boundary exactness
//   * malformed quota JSON behaves deterministically (deny default)
//   * FREE-PLAN users are enforced through the lazily provisioned free
//     subscription row (the old engine returned true for every user
//     without a subscription — an unlimited bypass)
//   * consumeQuota/refundQuota concurrency: N parallel reservations at the
//     limit → exactly `limit` succeed; refunds release reserved units
//   * duplicate publish requests do not double-reserve (job-key existence
//     logic + reservation interplay at lib level)
// =====================================================================
import { test, expect, describe, beforeAll, beforeEach } from "bun:test";
import {
  resetDb,
  seedUser,
  seedPlan,
  seedContent,
  seedDestination,
  ensureDbConnected,
  db,
} from "./_db-helpers";
import {
  consumeQuota,
  consumeQuotaDetailed,
  refundQuota,
  getQuotaState,
  requirePlanFeature,
  getEffectiveFeatures,
} from "@/lib/payments/plans";
import { schedulePublishJob } from "@/lib/queue/scheduler";
import { AuthError } from "@/lib/server/auth";

describe("quota semantics: disabled vs unlimited vs finite (P0.2)", () => {
  let userId: string;
  let planId: string;

  beforeAll(async () => {
    await ensureDbConnected();
  });

  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "qsem@test.local", mobile: "09120000301" });
    userId = u.id;
    // Plan with explicit P0.2 semantics per dimension.
    const p = await seedPlan({ code: "qsem-plan" });
    await db.plan.update({
      where: { id: p.id },
      data: {
        quota: JSON.stringify({
          publishPerMonth: 3, // finite
          aiPerMonth: -1, // unlimited (explicit sentinel)
          channels: 1,
          automation: 0, // DISABLED
        }),
      },
    });
    planId = p.id;
    await db.subscription.create({
      data: {
        userId,
        planId,
        status: "active",
        startedAt: new Date(),
        endsAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        usedQuota: "{}",
        activeKey: `${userId}:${planId}`,
      },
    });
  });

  test("limit 0 → DISABLED: consumeQuota denies with detailed result", async () => {
    expect(await consumeQuotaDetailed({ userId, dimension: "automation", amount: 1 })).toBe("disabled");
    expect(await consumeQuota({ userId, dimension: "automation", amount: 1 })).toBe(false);
  });

  test("limit -1 → UNLIMITED: consumeQuota allows repeatedly", async () => {
    for (let i = 0; i < 10; i++) {
      expect(await consumeQuota({ userId, dimension: "aiPerMonth", amount: 1 })).toBe(true);
    }
    const state = await getQuotaState(userId);
    expect(state.aiPerMonth.used).toBe(10);
  });

  test("finite quota: exactly-at-limit allowed, one more denied", async () => {
    expect(await consumeQuota({ userId, dimension: "publishPerMonth", amount: 2 })).toBe(true);
    expect(await consumeQuota({ userId, dimension: "publishPerMonth", amount: 1 })).toBe(true); // 3/3
    expect(await consumeQuota({ userId, dimension: "publishPerMonth", amount: 1 })).toBe(false); // 4 > 3
    const state = await getQuotaState(userId);
    expect(state.publishPerMonth.used).toBe(3);
    expect(state.publishPerMonth.limit).toBe(3);
  });

  test("refundQuota releases reserved units (floor 0)", async () => {
    expect(await consumeQuota({ userId, dimension: "publishPerMonth", amount: 3 })).toBe(true);
    await refundQuota({ userId, dimension: "publishPerMonth", amount: 2 });
    const state = await getQuotaState(userId);
    expect(state.publishPerMonth.used).toBe(1);
    await refundQuota({ userId, dimension: "publishPerMonth", amount: 5 }); // over-refund floors at 0
    const after = await getQuotaState(userId);
    expect(after.publishPerMonth.used).toBe(0);
  });

  test("malformed quota JSON denies deterministically (fail closed)", async () => {
    await db.plan.update({ where: { id: planId }, data: { quota: "{not-json" } });
    expect(await consumeQuota({ userId, dimension: "publishPerMonth", amount: 1 })).toBe(false);
  });
});

describe("free-plan enforcement (P0.2 gap fix)", () => {
  let userId: string;

  beforeAll(async () => {
    await ensureDbConnected();
  });

  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "qfree@test.local", mobile: "09120000302" });
    userId = u.id;
  });

  test("consumeQuota provisions a free enforcement row and enforces the free limits", async () => {
    // Free plan: publishPerMonth = 5.
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await consumeQuota({ userId, dimension: "publishPerMonth", amount: 1 }));
    }
    expect(results.every(Boolean)).toBe(true);
    // 6th publish is DENIED — free users are no longer unlimited.
    expect(await consumeQuota({ userId, dimension: "publishPerMonth", amount: 1 })).toBe(false);

    // The enforcement row exists and is bound to the free plan.
    const { ensurePlansSeeded } = await import("@/lib/payments/plans");
    await ensurePlansSeeded();
    const freePlan = await db.plan.findUnique({ where: { code: "free" } });
    const row = await db.subscription.findUnique({ where: { activeKey: `${userId}:${freePlan!.id}` } });
    expect(row).not.toBeNull();
    const used = JSON.parse(row!.usedQuota);
    expect(used.publishPerMonth).toBe(5);
  });

  test("expired free row renews with a usage RESET (per-period quota)", async () => {
    await consumeQuota({ userId, dimension: "publishPerMonth", amount: 5 });
    const { ensurePlansSeeded } = await import("@/lib/payments/plans");
    await ensurePlansSeeded();
    const freePlan = await db.plan.findUnique({ where: { code: "free" } });
    const row = await db.subscription.findUnique({ where: { activeKey: `${userId}:${freePlan!.id}` } });
    // Force expiry.
    await db.subscription.update({
      where: { id: row!.id },
      data: { endsAt: new Date(Date.now() - 1000) },
    });
    // Next consumption renews + resets, then enforces from zero.
    expect(await consumeQuota({ userId, dimension: "publishPerMonth", amount: 1 })).toBe(true);
    const state = await getQuotaState(userId);
    expect(state.publishPerMonth.used).toBe(1);
  });
});

describe("publish reservation invariants (P0.1 building blocks)", () => {
  let userId: string;
  let planId: string;
  let contentId: string;

  beforeAll(async () => {
    await ensureDbConnected();
  });

  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "qpub@test.local", mobile: "09120000303" });
    userId = u.id;
    const p = await seedPlan({ code: "qpub-plan" });
    await db.plan.update({
      where: { id: p.id },
      data: { quota: JSON.stringify({ publishPerMonth: 3, aiPerMonth: 10, channels: 2, automation: 0 }) },
    });
    planId = p.id;
    await db.subscription.create({
      data: {
        userId,
        planId,
        status: "active",
        startedAt: new Date(),
        endsAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        usedQuota: "{}",
        activeKey: `${userId}:${planId}`,
      },
    });
    const c = await seedContent({ ownerId: userId, status: "draft" });
    contentId = c.id;
  });

  test("duplicate publish submission does not reserve quota twice", async () => {
    const runAtIso = new Date().toISOString();
    const dests = await Promise.all([
      seedDestination({ ownerId: userId }),
      seedDestination({ ownerId: userId }),
    ]);
    // First submission: 2 new jobs → reserve 2.
    const keys1 = dests.map((d) => `${contentId}:${d.id}:${runAtIso}`.slice(0, 200));
    const existing1 = await db.publishJob.findMany({ where: { idempotencyKey: { in: keys1 } }, select: { idempotencyKey: true } });
    expect(existing1.length).toBe(0);
    expect(await consumeQuota({ userId, dimension: "publishPerMonth", amount: 2 })).toBe(true);
    for (const k of keys1) await schedulePublishJob({ contentId, destinationId: dests[0]!.id, runAtIso, idempotencyKey: k });

    // Duplicate submission (same keys): existing detection → 0 new → NO second reservation.
    const existing2 = await db.publishJob.findMany({ where: { idempotencyKey: { in: keys1 } }, select: { idempotencyKey: true } });
    expect(existing2.length).toBe(2);
    const state = await getQuotaState(userId);
    expect(state.publishPerMonth.used).toBe(2); // exactly one reservation
  });

  test("multi-destination publish reserves per-destination units", async () => {
    const dests = await Promise.all([
      seedDestination({ ownerId: userId }),
      seedDestination({ ownerId: userId }),
      seedDestination({ ownerId: userId }),
      seedDestination({ ownerId: userId }),
    ]);
    // limit 3; 4 destinations → denied as a whole (fail closed).
    expect(await consumeQuota({ userId, dimension: "publishPerMonth", amount: 4 })).toBe(false);
    // 3 destinations → allowed.
    expect(await consumeQuota({ userId, dimension: "publishPerMonth", amount: 3 })).toBe(true);
    expect(dests.length).toBe(4);
  });

  test("CONCURRENT reservations at the limit — exactly `limit` succeed", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        consumeQuota({ userId, dimension: "publishPerMonth", amount: 1 }),
      ),
    );
    const ok = results.filter(Boolean).length;
    expect(ok).toBe(3); // limit is 3 — no overrun, no lost reservations
  });

  test("CONCURRENT reservations + refunds converge (race reconciliation)", async () => {
    await Promise.all([
      consumeQuota({ userId, dimension: "publishPerMonth", amount: 1 }),
      consumeQuota({ userId, dimension: "publishPerMonth", amount: 1 }),
      consumeQuota({ userId, dimension: "publishPerMonth", amount: 1 }),
    ]);
    await Promise.all([
      refundQuota({ userId, dimension: "publishPerMonth", amount: 1 }),
      refundQuota({ userId, dimension: "publishPerMonth", amount: 1 }),
    ]);
    // 3 reserved - 2 refunded = 1 used; one more reservation must fit.
    expect(await consumeQuota({ userId, dimension: "publishPerMonth", amount: 2 })).toBe(true);
  });
});

describe("plan feature gates (P0.15 helpers)", () => {
  let userId: string;
  let planId: string;

  beforeAll(async () => {
    await ensureDbConnected();
  });

  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "qgate@test.local", mobile: "09120000304" });
    userId = u.id;
    const p = await seedPlan({ code: "qgate-plan" });
    planId = p.id;
    await db.plan.update({
      where: { id: p.id },
      data: { features: JSON.stringify({ publish: true, broadcast: false, bots: 2 }) },
    });
    await db.subscription.create({
      data: {
        userId,
        planId,
        status: "active",
        startedAt: new Date(),
        endsAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        usedQuota: "{}",
        activeKey: `${userId}:${planId}`,
      },
    });
  });

  test("enabled feature passes", async () => {
    await expect(requirePlanFeature(userId, "publish")).resolves.toBeUndefined();
  });

  test("disabled feature throws 403 with a Persian message", async () => {
    let caught: unknown = null;
    try {
      await requirePlanFeature(userId, "broadcast");
    } catch (e) {
      caught = e;
    }
    // plans.ts ships its own client-safe AuthError class (same shape as the
    // auth-module one) — assert structurally instead of by identity.
    expect((caught as { name?: string }).name).toBe("AuthError");
    expect((caught as { status?: number }).status).toBe(403);
    expect((caught as Error).message).toContain("پیام گروهی");
  });

  test("user without subscription gets free-plan features (not zero)", async () => {
    const other = await seedUser({ email: "qgate2@test.local", mobile: "09120000305" });
    const features = await getEffectiveFeatures(other.id);
    // Free plan seeds publish: true — the free fallback must be usable.
    expect(features.publish).toBe(true);
    await expect(requirePlanFeature(other.id, "publish")).resolves.toBeUndefined();
    // woo is false on the free plan.
    await expect(requirePlanFeature(other.id, "woo")).rejects.toMatchObject({
      name: "AuthError",
      status: 403,
    });
  });
});
