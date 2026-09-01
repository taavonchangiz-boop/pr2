// =====================================================================
// POSTYAR — C-08 / C-09 / H-1 regression: plan configuration integrity
// ---------------------------------------------------------------------
// C-08: non-public (hidden) plans CANNOT be purchased through the
// ordinary public purchase path (createOrderForSubscription without the
// explicit privileged bypass).
//
// C-09: seeding is CREATE-ONLY — a restart / re-import must never revert
// administrator-modified quota/features/prices; missing seed plans are
// still provisioned; the legacy 0-as-unlimited shape migrates once via
// the explicit operator migration.
//
// H-1: activateSubscription on an ALREADY-paid subscription order never
// extends the subscription a second time (per-order fulfillment marker).
// =====================================================================
import { test, expect, describe, beforeAll, beforeEach } from "bun:test";
import { db } from "../src/lib/db";
import { resetDb, seedUser, ensureDbConnected } from "./_db-helpers";
import {
  ensurePlansSeeded,
  migrateLegacyPlanQuotaShape,
  createOrderForSubscription,
  activateSubscription,
} from "../src/lib/payments/plans";

async function seedPlan(opts: { code: string; priceRials?: number; isPublic: boolean; active?: boolean; features?: Record<string, unknown> }) {
  return db.plan.create({
    data: {
      code: opts.code,
      nameFa: "طرح آزمایشی",
      priceRials: opts.priceRials ?? 100_000,
      intervalMonths: 1,
      quota: JSON.stringify({ publishPerMonth: 10, aiPerMonth: 20, channels: 1, automation: 1 }),
      features: JSON.stringify(opts.features ?? {}),
      isPublic: opts.isPublic,
      active: opts.active ?? true,
    },
  });
}

async function seedPaidSubscriptionOrder(userId: string, planId: string, idem: string) {
  return db.order.create({
    data: {
      userId,
      kind: "subscription",
      amountRials: 100_000,
      planId,
      status: "paid",
      idempotencyKey: idem,
    },
  });
}

describe("C-08 — hidden plans are not purchasable", () => {
  beforeAll(async () => { await ensureDbConnected(); });
  beforeEach(async () => { await resetDb(); });

  test("non-public active plan → 403 for the ordinary purchase path", async () => {
    const user = await seedUser({});
    const hidden = await seedPlan({ code: "hidden-vip", isPublic: false });
    await expect(createOrderForSubscription({
      userId: user.id, planId: hidden.id, idempotencyKey: `o-${random8()}`,
    })).rejects.toMatchObject({ name: "AuthError", status: 403 });
    expect(await db.order.count({ where: { userId: user.id } })).toBe(0);
  });

  test("public active plan is purchasable; privileged path may buy hidden plans", async () => {
    const user = await seedUser({});
    const pub = await seedPlan({ code: "open-plan", isPublic: true });
    const r1 = await createOrderForSubscription({ userId: user.id, planId: pub.id, idempotencyKey: `o-${random8()}` });
    expect(r1.created).toBe(true);
    const hidden = await seedPlan({ code: "hidden-2", isPublic: false });
    const r2 = await createOrderForSubscription({
      userId: user.id, planId: hidden.id, idempotencyKey: `o-${random8()}`, allowNonPublicPlan: true,
    });
    expect(r2.created).toBe(true);
  });

  test("inactive plan is not purchasable either", async () => {
    const user = await seedUser({});
    const off = await seedPlan({ code: "off-plan", isPublic: true, active: false });
    await expect(createOrderForSubscription({
      userId: user.id, planId: off.id, idempotencyKey: `o-${random8()}`,
    })).rejects.toMatchObject({ name: "AuthError", status: 400 });
  });
});

describe("C-09 — seeding never overwrites admin configuration", () => {
  beforeAll(async () => { await ensureDbConnected(); });
  beforeEach(async () => { await resetDb(); });

  test("admin changes to quota/features/price survive repeated seeding (process restart)", async () => {
    await ensurePlansSeeded();
    const plan = await db.plan.findUnique({ where: { code: "pro" } });
    expect(plan).not.toBeNull();
    // Administrator customizes the plan.
    await db.plan.update({
      where: { id: plan!.id },
      data: {
        priceRials: 999_999,
        quota: JSON.stringify({ publishPerMonth: 7777, aiPerMonth: 8888, channels: 9, automation: 9 }),
        features: JSON.stringify({ publish: true, publishPerMonth: 7777, woo: false }),
      },
    });
    // Simulate restarts / repeated module initialization.
    await ensurePlansSeeded();
    await ensurePlansSeeded();
    const after = await db.plan.findUnique({ where: { code: "pro" } });
    expect(after!.priceRials).toBe(999_999);
    const quota = JSON.parse(after!.quota) as Record<string, number>;
    expect(quota.publishPerMonth).toBe(7777);
    const features = JSON.parse(after!.features) as Record<string, unknown>;
    expect(features.woo).toBe(false);
  });

  test("missing seed plans are provisioned; unknown admin plans are untouched", async () => {
    const custom = await seedPlan({ code: "admin-custom", isPublic: true, priceRials: 123_456 });
    await ensurePlansSeeded();
    // Custom plan untouched.
    const customAfter = await db.plan.findUnique({ where: { id: custom.id } });
    expect(customAfter?.priceRials).toBe(123_456);
    // Seed plans present.
    for (const code of ["free", "basic", "pro", "business"]) {
      expect(await db.plan.findUnique({ where: { code } })).not.toBeNull();
    }
  });

  test("legacy 0-as-unlimited migration is explicit, one-shot and deterministic", async () => {
    await ensurePlansSeeded();
    // Corrupt the business plan to the legacy shape (0 where unlimited was meant).
    await db.plan.update({
      where: { code: "business" },
      data: { features: JSON.stringify({ publish: true, publishPerMonth: 0, aiPerMonth: 0 }) },
    });
    const first = await migrateLegacyPlanQuotaShape();
    expect(first.skipped).toBe(false);
    const after = await db.plan.findUnique({ where: { code: "business" } });
    const features = JSON.parse(after!.features) as Record<string, number>;
    expect(features.publishPerMonth).toBe(-1);
    expect(features.aiPerMonth).toBe(-1);
    // Second run: skipped (marker recorded), nothing changes.
    const second = await migrateLegacyPlanQuotaShape();
    expect(second.skipped).toBe(true);
  });
});

describe("H-1 — subscription fulfillment is once-per-order", () => {
  beforeAll(async () => { await ensureDbConnected(); });
  beforeEach(async () => { await resetDb(); });

  test("re-entry on an already-paid subscription order does NOT extend the interval", async () => {
    const user = await seedUser({});
    const plan = await seedPlan({ code: "renew-plan", isPublic: true });
    const order = await seedPaidSubscriptionOrder(user.id, plan.id, "renew-1");

    const first = await activateSubscription({ orderId: order.id, paidRials: 100_000, idempotencyKey: "act-1" });
    expect(first.endsAt.getTime()).toBeGreaterThan(Date.now());

    // Duplicate payment webhook / admin retry / crash-recovery re-entry:
    const second = await activateSubscription({ orderId: order.id, paidRials: 100_000, idempotencyKey: "act-2" });
    expect(second.endsAt.getTime()).toBe(first.endsAt.getTime());
    const third = await activateSubscription({ orderId: order.id, paidRials: 100_000, idempotencyKey: "act-3" });
    expect(third.endsAt.getTime()).toBe(first.endsAt.getTime());

    // Exactly one ledger fulfillment marker for the order.
    const markers = await db.ledgerEntry.findMany({ where: { orderId: order.id, eventType: "subscription" } });
    expect(markers.length).toBe(1);
  });

  test("a DIFFERENT paid order (genuine renewal) still extends from the current endsAt", async () => {
    const user = await seedUser({});
    const plan = await seedPlan({ code: "renew-2", isPublic: true });
    const order1 = await seedPaidSubscriptionOrder(user.id, plan.id, "renew-a");
    const order2 = await seedPaidSubscriptionOrder(user.id, plan.id, "renew-b");
    const first = await activateSubscription({ orderId: order1.id, paidRials: 100_000, idempotencyKey: "act-a" });
    const second = await activateSubscription({ orderId: order2.id, paidRials: 100_000, idempotencyKey: "act-b" });
    expect(second.endsAt.getTime()).toBeGreaterThan(first.endsAt.getTime());
  });

  test("CONCURRENT activation of two orders for the same plan creates exactly one live row and no double extension", async () => {
    const user = await seedUser({});
    const plan = await seedPlan({ code: "renew-3", isPublic: true });
    const order1 = await seedPaidSubscriptionOrder(user.id, plan.id, "renew-c");
    const order2 = await seedPaidSubscriptionOrder(user.id, plan.id, "renew-d");
    await Promise.allSettled([
      activateSubscription({ orderId: order1.id, paidRials: 100_000, idempotencyKey: "act-c" }),
      activateSubscription({ orderId: order2.id, paidRials: 100_000, idempotencyKey: "act-d" }),
    ]);
    const live = await db.subscription.findMany({ where: { userId: user.id, planId: plan.id, status: "active" } });
    expect(live.length).toBe(1);
  });
});

function random8(): string {
  return Math.random().toString(36).slice(2, 10);
}
