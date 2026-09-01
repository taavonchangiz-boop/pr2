// =====================================================================
// POSTYAR — Discount concurrency + per-user limit regression tests (P1.8)
// ---------------------------------------------------------------------
// Invariants after the P1.8 repair:
//   * perUserLimit > 1 is REACHABLE (the old @@unique([discountId,userId])
//     silently capped every user at one redemption forever);
//   * concurrent redemptions at the cap cannot exceed maxUses;
//   * a rejected redemption leaves NO residual increment (rollback);
//   * one usage row per (discount, orderId) — idempotent replay;
//   * maxUses=0 means unlimited.
// =====================================================================
import { test, expect, describe, beforeAll, beforeEach } from "bun:test";
import { resetDb, seedUser, ensureDbConnected, db } from "./_db-helpers";
import { recordUsage } from "@/lib/payments/discount";
import type { Prisma } from "@prisma/client";

async function seedDiscount(opts: {
  maxUses?: number;
  perUserLimit?: number;
  value?: number;
  kind?: string;
}): Promise<{ id: string; code: string }> {
  const s = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const row = await db.discount.create({
    data: {
      code: `D${s}`.toUpperCase().slice(0, 24),
      kind: opts.kind ?? "percent",
      value: opts.value ?? 10,
      maxUses: opts.maxUses ?? 0,
      perUserLimit: opts.perUserLimit ?? 1,
      active: true,
    },
  });
  return { id: row.id, code: row.code };
}

async function seedPaidOrder(userId: string, suffix: string): Promise<string> {
  const row = await db.order.create({
    data: {
      userId,
      kind: "subscription",
      amountRials: 100_000,
      descriptionFa: "تست",
      status: "paid",
      idempotencyKey: `disc-order-${suffix}`,
    },
  });
  return row.id;
}

describe("discount engine — atomic limits (DB-backed)", () => {
  let userId: string;

  beforeAll(async () => {
    await ensureDbConnected();
  });

  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "disc@test.local", mobile: "09120000501" });
    userId = u.id;
  });

  test("perUserLimit=2 allows exactly two redemptions for one user", async () => {
    const d = await seedDiscount({ perUserLimit: 2, maxUses: 0 });
    const o1 = await seedPaidOrder(userId, "pu2-a");
    const o2 = await seedPaidOrder(userId, "pu2-b");
    const o3 = await seedPaidOrder(userId, "pu2-c");
    expect((await recordUsage({ discountId: d.id, userId, orderId: o1 })).ok).toBe(true);
    expect((await recordUsage({ discountId: d.id, userId, orderId: o2 })).ok).toBe(true);
    const third = await recordUsage({ discountId: d.id, userId, orderId: o3 });
    expect(third.ok).toBe(false);
    expect(third.errorFa).toContain("برای شما");
    // uses counter: exactly 2 (the rejected third left no residual).
    const fresh = await db.discount.findUnique({ where: { id: d.id } });
    expect(fresh!.uses).toBe(2);
  });

  test("rejected redemption leaves NO residual increment (rollback)", async () => {
    const d = await seedDiscount({ perUserLimit: 1, maxUses: 0 });
    const o1 = await seedPaidOrder(userId, "rb-a");
    const o2 = await seedPaidOrder(userId, "rb-b");
    expect((await recordUsage({ discountId: d.id, userId, orderId: o1 })).ok).toBe(true);
    expect((await recordUsage({ discountId: d.id, userId, orderId: o2 })).ok).toBe(false);
    const fresh = await db.discount.findUnique({ where: { id: d.id } });
    expect(fresh!.uses).toBe(1);
    const usages = await db.discountUsage.count({ where: { discountId: d.id } });
    expect(usages).toBe(1);
  });

  test("CONCURRENT redemptions at maxUses — no overrun", async () => {
    const d = await seedDiscount({ maxUses: 3, perUserLimit: 0 }); // 0 = no per-user cap
    const users = await Promise.all([
      seedUser({ email: "disc-c1@test.local", mobile: "09120000511", referralCode: "DC1A" }),
      seedUser({ email: "disc-c2@test.local", mobile: "09120000512", referralCode: "DC2B" }),
      seedUser({ email: "disc-c3@test.local", mobile: "09120000513", referralCode: "DC3C" }),
      seedUser({ email: "disc-c4@test.local", mobile: "09120000514", referralCode: "DC4D" }),
      seedUser({ email: "disc-c5@test.local", mobile: "09120000515", referralCode: "DC5E" }),
    ]);
    const orders = await Promise.all(users.map((u, i) => seedPaidOrder(u.id, `cc-${i}`)));
    const results = await Promise.all(
      users.map((u, i) => recordUsage({ discountId: d.id, userId: u.id, orderId: orders[i]! })),
    );
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBe(3); // hard cap respected under concurrency
    const fresh = await db.discount.findUnique({ where: { id: d.id } });
    expect(fresh!.uses).toBe(3);
  });

  test("same orderId replay is idempotent (one usage row per order)", async () => {
    const d = await seedDiscount({ perUserLimit: 5 });
    const o1 = await seedPaidOrder(userId, "rp-a");
    expect((await recordUsage({ discountId: d.id, userId, orderId: o1 })).ok).toBe(true);
    const replay = await recordUsage({ discountId: d.id, userId, orderId: o1 });
    expect(replay.ok).toBe(false);
    expect(await db.discountUsage.count({ where: { discountId: d.id, orderId: o1 } })).toBe(1);
    // The replay did not consume an extra unit.
    const fresh = await db.discount.findUnique({ where: { id: d.id } });
    expect(fresh!.uses).toBe(1);
  });

  test("recordUsage joins a caller transaction (order + usage atomic)", async () => {
    const d = await seedDiscount({ perUserLimit: 1 });
    const o1 = await seedPaidOrder(userId, "tx-a");
    const o2 = await seedPaidOrder(userId, "tx-b");
    // First redemption inside a tx that ALSO updates the order → commit.
    await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const r = await recordUsage({ discountId: d.id, userId, orderId: o1, tx });
      expect(r.ok).toBe(true);
      await tx.order.update({ where: { id: o1 }, data: { amountRials: 90_000 } });
    });
    const o1row = await db.order.findUnique({ where: { id: o1 } });
    expect(o1row!.amountRials).toBe(90_000);
    // Second redemption inside a tx that THROWS → whole tx rolls back,
    // including the usage increment.
    await db.$transaction(async (tx: Prisma.TransactionClient) => {
      await recordUsage({ discountId: d.id, userId, orderId: o2, tx });
      throw new Error("boom");
    }).catch(() => undefined);
    const fresh = await db.discount.findUnique({ where: { id: d.id } });
    expect(fresh!.uses).toBe(1);
    expect(await db.discountUsage.count({ where: { discountId: d.id } })).toBe(1);
  });
});
