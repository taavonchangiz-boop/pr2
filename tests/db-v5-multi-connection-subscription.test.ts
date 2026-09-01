// =====================================================================
// POSTYAR — V5 H-10 subscription one-live-row invariant under REAL
// multi-connection SQLite (WAL)
// ---------------------------------------------------------------------
// Mirrors the harness of tests/db-multi-connection-concurrency.test.ts:
// TWO separate PrismaClient instances (connection_limit=4) race against
// the SAME WAL database file, so DB-level races are genuine file-level
// races rather than pool-serialized operations on the shared client.
//
// The (user, plan) one-live-row invariant is enforced by
// Subscription.activeKey @unique (schema:262-268) and the per-order
// extension-once guarantee by LedgerEntry.idempotencyKey = "sub:fulfil:<orderId>"
// UNIQUE (H-1). activateSubscription (plans.ts) is the single owner of
// these mutations; because it binds to the shared test client
// (connection_limit=1 via preload), the function-level scenarios below run
// through it CONCURRENTLY via Promise.allSettled, while the genuine
// cross-connection collapse of each race is proven directly against the
// exact DB arbiters (activeKey UNIQUE create / fulfil-key UNIQUE create)
// from clientA + clientB — the same statements the transaction bodies
// issue.
//
// Scenarios (the 5 previously-uncovered gaps):
//   1. same-plan concurrent purchase → exactly ONE live row; both orders
//      paid; endsAt extended exactly one interval PER order (two total);
//      + genuine cross-connection activeKey create race collapses to 1 row.
//   2. concurrent renewal of an ALREADY-active near-expiry subscription →
//      single live row, endsAt extended EXACTLY ONCE (no double extension);
//      + genuine cross-connection fulfil-key race collapses to 1 marker.
//   3. expiry + repurchase race → expired row is renewed by the new
//      purchase; two concurrent activations still yield ONE live row
//      extended exactly one interval from `now`.
//   4. different plans, same user, concurrently → both rows coexist (the
//      invariant is per (user, plan)); effective-feature resolution picks
//      the plan of the most-recently-created active row (documented
//      getActiveSubscription orderBy createdAt desc semantics).
//   5. reconciliation: the schema FORBIDS a legacy duplicate — creating a
//      second live row for the same (user, plan) throws P2002, state is
//      unchanged and the wallet ledger stays consistent.
// =====================================================================
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { resetDb, seedUser, seedPlan, seedOrder, ensureDbConnected, db } from "./_db-helpers";
import { activateSubscription, getActiveSubscription, getEffectiveFeatures, getFeatureNumber, parsePlanFeatures } from "../src/lib/payments/plans";
import { verifyWalletIntegrity } from "../src/lib/payments/wallet";

// Two INDEPENDENT clients (own pools) on the same file — the shared `db`
// singleton is pinned to connection_limit=1 by tests/preload.ts, so a
// second client with a larger pool is REQUIRED for genuine races.
const DB_PATH = path.join(process.cwd(), "db", "test.db");
const MULTI_URL = `file:${DB_PATH}?socket_timeout=30000&busy_timeout=30000&connection_limit=4`;

const clientA = new PrismaClient({ datasources: { db: { url: MULTI_URL } } });
const clientB = new PrismaClient({ datasources: { db: { url: MULTI_URL } } });

async function enableWal(client: PrismaClient): Promise<void> {
  await client.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
}

function addMonths(from: Date, months: number): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() + months);
  return d;
}

const DAY = 24 * 60 * 60 * 1000;

function isUniqueViolation(reason: unknown): boolean {
  const code = (reason as { code?: string })?.code;
  if (code === "P2002") return true;
  const msg = reason instanceof Error ? reason.message : String(reason);
  return /unique|UNIQUE|constraint/i.test(msg);
}

/** Seed a (user, plan) pair + a pending subscription order, ready to activate. */
async function seedPurchase(emailTag: string, planCode: string, priceRials: number) {
  const user = await seedUser({ email: `v5sub-${emailTag}@test.local`, mobile: `0913000${emailTag.replace(/\D/g, "").padStart(4, "0").slice(0, 4)}`.slice(0, 11) });
  const plan = await seedPlan({ code: `v5sub-${planCode}`, nameFa: `پلن ${planCode}`, priceRials });
  const order = await seedOrder({
    userId: user.id,
    planId: plan.id,
    kind: "subscription",
    amountRials: priceRials,
    status: "pending",
    provider: "card",
  });
  return { user, plan, order };
}

describe("V5 H-10 — subscription one-live-row invariant under REAL multi-connection SQLite (WAL)", () => {
  beforeAll(async () => {
    await ensureDbConnected();
    await enableWal(clientA);
    await enableWal(clientB);
    await clientA.$connect();
    await clientB.$connect();
  });
  afterAll(async () => {
    await clientA.$disconnect();
    await clientB.$disconnect();
  });

  test("1. same-plan concurrent purchase collapses to ONE live row; both orders paid; extended once per order", async () => {
    await resetDb();
    const { user, plan, order: o1 } = await seedPurchase("same1", "same", 100_000);
    const o2 = await seedOrder({
      userId: user.id,
      planId: plan.id,
      kind: "subscription",
      amountRials: plan.priceRials,
      status: "pending",
      provider: "card",
    });

    const before = Date.now();
    const results = await Promise.allSettled([
      activateSubscription({ orderId: o1.id, paidRials: plan.priceRials, idempotencyKey: `bank:verify:${o1.id}` }),
      activateSubscription({ orderId: o2.id, paidRials: plan.priceRials, idempotencyKey: `bank:verify:${o2.id}` }),
    ]);
    const after = Date.now();
    // Two independent paid orders for the same (user, plan): BOTH fulfill.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    // Exactly ONE live subscription row for (user, plan).
    const live = await db.subscription.findMany({ where: { userId: user.id, planId: plan.id, status: "active" } });
    expect(live.length).toBe(1);

    // Both orders exist and both are claimed paid.
    const orders = await db.order.findMany({ where: { id: { in: [o1.id, o2.id] } } });
    expect(orders.length).toBe(2);
    expect(orders.every((o) => o.status === "paid")).toBe(true);

    // Per-order fulfillment markers: exactly one interval extension PER
    // paid order (two total) — the create-race loser converged on renewal.
    const marks = await db.ledgerEntry.findMany({
      where: { idempotencyKey: { in: [`sub:fulfil:${o1.id}`, `sub:fulfil:${o2.id}`] } },
    });
    expect(marks.length).toBe(2);

    // endsAt = start + 2 intervals. The bounds discriminate strictly:
    // 1 extension would end before (before + 56d); 3 would end after
    // (after + 62d).
    const endsAt = live[0].endsAt.getTime();
    expect(endsAt).toBeGreaterThan(before + 2 * 28 * DAY);
    expect(endsAt).toBeLessThan(after + 2 * 31 * DAY);
  });

  test("1b. the activeKey UNIQUE collapses a genuine cross-connection create race", async () => {
    await resetDb();
    const { user, plan } = await seedPurchase("race1", "race", 100_000);
    const activeKey = `${user.id}:${plan.id}`;
    const now = new Date();

    const [c1, c2] = await Promise.allSettled([
      clientA.subscription.create({
        data: { userId: user.id, planId: plan.id, status: "active", startedAt: now, endsAt: addMonths(now, 1), usedQuota: "{}", activeKey },
      }),
      clientB.subscription.create({
        data: { userId: user.id, planId: plan.id, status: "active", startedAt: now, endsAt: addMonths(now, 1), usedQuota: "{}", activeKey },
      }),
    ]);

    // Exactly one connection wins; the loser hits the UNIQUE arbiter.
    const winner = c1.status === "fulfilled" ? c1 : c2;
    const loser = c1.status === "fulfilled" ? c2 : c1;
    expect(winner.status).toBe("fulfilled");
    expect(loser.status).toBe("rejected");
    expect(isUniqueViolation((loser as PromiseRejectedResult).reason)).toBe(true);

    const live = await db.subscription.findMany({ where: { userId: user.id, planId: plan.id, status: "active" } });
    expect(live.length).toBe(1);
  });

  test("2. concurrent renewal of an ALREADY-active near-expiry subscription extends endsAt EXACTLY once", async () => {
    await resetDb();
    const { user, plan, order } = await seedPurchase("renew1", "renew", 200_000);
    // An already-active subscription from an earlier (fully fulfilled)
    // purchase, now 3 days from expiry.
    const startedAt = new Date(Date.now() - 27 * DAY);
    const nearExpiry = new Date(Date.now() + 3 * DAY);
    await db.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status: "active",
        startedAt,
        endsAt: nearExpiry,
        usedQuota: "{}",
        activeKey: `${user.id}:${plan.id}`,
      },
    });

    // The SAME order fired twice concurrently (duplicate gateway callback /
    // double-click): the H-1 per-order fulfil marker must let exactly ONE
    // extension commit.
    const results = await Promise.allSettled([
      activateSubscription({ orderId: order.id, paidRials: plan.priceRials, idempotencyKey: `bank:verify:${order.id}` }),
      activateSubscription({ orderId: order.id, paidRials: plan.priceRials, idempotencyKey: `bank:verify:${order.id}` }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const live = await db.subscription.findMany({ where: { userId: user.id, planId: plan.id, status: "active" } });
    expect(live.length).toBe(1);

    // Renewal base = max(existing.endsAt, now) = nearExpiry (still in the
    // future) → the row must end at exactly nearExpiry + 1 month: extended
    // ONCE, not twice (a double extension would land a further month out).
    expect(live[0].endsAt.getTime()).toBe(addMonths(nearExpiry, 1).getTime());

    // Exactly one per-order fulfil marker and one payment ledger row.
    expect(await db.ledgerEntry.count({ where: { idempotencyKey: `sub:fulfil:${order.id}` } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { idempotencyKey: `ledger:payment:${order.id}` } })).toBe(1);
  });

  test("2b. the fulfil-key UNIQUE collapses a genuine cross-connection renewal race", async () => {
    await resetDb();
    const { user, order } = await seedPurchase("race2", "renewrace", 200_000);
    const fulfilKey = `sub:fulfil:${order.id}`;

    const [l1, l2] = await Promise.allSettled([
      clientA.ledgerEntry.create({
        data: { userId: user.id, orderId: order.id, eventType: "subscription", amountRials: 0, currency: "IRR", idempotencyKey: fulfilKey },
      }),
      clientB.ledgerEntry.create({
        data: { userId: user.id, orderId: order.id, eventType: "subscription", amountRials: 0, currency: "IRR", idempotencyKey: fulfilKey },
      }),
    ]);

    const winner = l1.status === "fulfilled" ? l1 : l2;
    const loser = l1.status === "fulfilled" ? l2 : l1;
    expect(winner.status).toBe("fulfilled");
    expect(loser.status).toBe("rejected");
    expect(isUniqueViolation((loser as PromiseRejectedResult).reason)).toBe(true);
    expect(await db.ledgerEntry.count({ where: { idempotencyKey: fulfilKey } })).toBe(1);
  });

  test("3. expiry + repurchase race: two concurrent activations on an expired row yield ONE live row extended once", async () => {
    await resetDb();
    const { user, plan } = await seedPurchase("expire1", "expire", 100_000);
    // Previously-active row, now deliberately EXPIRED via a direct update.
    await db.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status: "active",
        startedAt: new Date(Date.now() - 60 * DAY),
        endsAt: new Date(Date.now() - 5 * DAY),
        usedQuota: "{}",
        activeKey: `${user.id}:${plan.id}`,
      },
    });

    // Repurchase: a NEW order fired twice concurrently.
    const order = await seedOrder({
      userId: user.id,
      planId: plan.id,
      kind: "subscription",
      amountRials: plan.priceRials,
      status: "pending",
      provider: "card",
    });
    const before = Date.now();
    const results = await Promise.allSettled([
      activateSubscription({ orderId: order.id, paidRials: plan.priceRials, idempotencyKey: `bank:verify:${order.id}` }),
      activateSubscription({ orderId: order.id, paidRials: plan.priceRials, idempotencyKey: `bank:verify:${order.id}` }),
    ]);
    const after = Date.now();
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    // Still exactly ONE live row (the expired row is renewed, never duplicated).
    const live = await db.subscription.findMany({ where: { userId: user.id, planId: plan.id, status: "active" } });
    expect(live.length).toBe(1);

    // Renewal base = max(expired endsAt, now) = now → exactly ONE interval
    // from the activation moment (a double extension would cross before+56d).
    const endsAt = live[0].endsAt.getTime();
    expect(endsAt).toBeGreaterThan(before + 28 * DAY);
    expect(endsAt).toBeLessThan(after + 31 * DAY);

    // The invariant is observable through the public lookup surface.
    const active = await getActiveSubscription(user.id);
    expect(active?.id).toBe(live[0].id);
  });

  test("4. different plans, same user, concurrently: both rows live; effective features resolve from the newest row", async () => {
    await resetDb();
    const user = await seedUser({ email: "v5sub-multi@test.local", mobile: "09130009911" });
    const planA = await seedPlan({ code: "v5sub-planA", nameFa: "پلن A", priceRials: 100_000 });
    const planB = await seedPlan({ code: "v5sub-planB", nameFa: "پلن B", priceRials: 200_000 });
    // Distinct feature payloads so the resolution choice is observable.
    await db.plan.update({ where: { id: planA.id }, data: { features: JSON.stringify({ bot: true, bots: 1 }) } });
    await db.plan.update({ where: { id: planB.id }, data: { features: JSON.stringify({ bot: true, bots: 5 }) } });

    const oA = await seedOrder({ userId: user.id, planId: planA.id, kind: "subscription", amountRials: planA.priceRials, status: "pending", provider: "card" });
    const oB = await seedOrder({ userId: user.id, planId: planB.id, kind: "subscription", amountRials: planB.priceRials, status: "pending", provider: "card" });

    const results = await Promise.allSettled([
      activateSubscription({ orderId: oA.id, paidRials: planA.priceRials, idempotencyKey: `bank:verify:${oA.id}` }),
      activateSubscription({ orderId: oB.id, paidRials: planB.priceRials, idempotencyKey: `bank:verify:${oB.id}` }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    // The invariant is PER (user, plan): both plans may be live concurrently.
    expect(await db.subscription.count({ where: { userId: user.id, planId: planA.id, status: "active" } })).toBe(1);
    expect(await db.subscription.count({ where: { userId: user.id, planId: planB.id, status: "active" } })).toBe(1);
    expect(await db.subscription.count({ where: { userId: user.id, status: "active" } })).toBe(2);

    // Documented resolution (getActiveSubscription orderBy createdAt desc):
    // effective features come from the most-recently-created active row.
    const resolved = await getActiveSubscription(user.id);
    expect(resolved).not.toBeNull();
    const all = await db.subscription.findMany({ where: { userId: user.id, status: "active" } });
    const newest = all.reduce((a, b) => (b.createdAt.getTime() >= a.createdAt.getTime() ? b : a));
    expect(resolved!.planId).toBe(newest.planId);

    const features = await getEffectiveFeatures(user.id);
    const newestPlan = await db.plan.findUnique({ where: { id: newest.planId } });
    expect(getFeatureNumber(features, "bots", 0)).toBe(getFeatureNumber(parsePlanFeatures(newestPlan!.features), "bots", 0));
  });

  test("5. reconciliation: the schema FORBIDS a second live row for the same (user, plan) — raw create throws P2002", async () => {
    await resetDb();
    const { user, plan, order } = await seedPurchase("recon1", "recon", 100_000);
    await activateSubscription({ orderId: order.id, paidRials: plan.priceRials, idempotencyKey: `bank:verify:${order.id}` });

    const activeKey = `${user.id}:${plan.id}`;
    expect(await db.subscription.count({ where: { activeKey } })).toBe(1);

    // The legacy duplicate state must be impossible to construct — even
    // through an independent connection with its own pool.
    let caught: unknown = null;
    try {
      await clientA.subscription.create({
        data: {
          userId: user.id,
          planId: plan.id,
          status: "active",
          startedAt: new Date(),
          endsAt: addMonths(new Date(), 1),
          usedQuota: "{}",
          activeKey,
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(isUniqueViolation(caught)).toBe(true);
    if ((caught as { code?: string })?.code !== undefined) {
      expect((caught as { code?: string }).code).toBe("P2002");
    }

    // State unchanged — still exactly one live row — and the ledger stays
    // consistent (verifyWalletIntegrity-style reconciliation check).
    expect(await db.subscription.count({ where: { userId: user.id, planId: plan.id, status: "active" } })).toBe(1);
    const integrity = await verifyWalletIntegrity(user.id);
    expect(integrity.consistent).toBe(true);
  });
});
