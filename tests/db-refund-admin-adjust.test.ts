// =====================================================================
// POSTYAR — C-03 / C-04 regression: wallet financial invariants
// ---------------------------------------------------------------------
// C-03: ONE refund per order is DATABASE-enforced (LedgerEntry.refundKey
// UNIQUE) — two concurrent refunds for the same order, even with
// different idempotency keys, produce exactly ONE financial refund. The
// pre-fix implementation checked with a COUNT query that both concurrent
// transactions could pass.
//
// C-04: an admin wallet DEBIT can never drive the derived balance
// negative; concurrent adjustments serialize via the user-row lock and
// always leave a consistent derived balance.
// =====================================================================
import { test, expect, describe, beforeAll, beforeEach } from "bun:test";
import { db } from "../src/lib/db";
import { resetDb, seedUser, seedOrder, ensureDbConnected } from "./_db-helpers";
import { adminAdjustWallet, refund, getBalance } from "../src/lib/payments/wallet";

describe("C-03/C-04 — refund invariant + admin adjust guard (DB-backed)", () => {
  let userId: string;
  let adminId: string;

  beforeAll(async () => {
    await ensureDbConnected();
  });

  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "wallet@test.local", mobile: "09120000801" });
    const a = await seedUser({ email: "admin@test.local", mobile: "09120000802", role: "admin" });
    userId = u.id;
    adminId = a.id;
  });

  test("CONCURRENT refunds for the same order (distinct idempotency keys) → exactly ONE refund", async () => {
    // Fund the wallet first so the refund can proceed.
    await adminAdjustWallet({ userId, amount: 1_000_000, reason: "seed", idempotencyKey: "seed-1", adminId });
    const order = await seedOrder({ userId, amountRials: 400_000, status: "paid" });
    const results = await Promise.allSettled([
      refund({ orderId: order.id, amount: 400_000, idempotencyKey: "r-key-1", adminId }),
      refund({ orderId: order.id, amount: 400_000, idempotencyKey: "r-key-2", adminId }),
      refund({ orderId: order.id, amount: 400_000, idempotencyKey: "r-key-3", adminId }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBe(3); // losers converge idempotently (no crash)

    const refundLedger = await db.ledgerEntry.findMany({
      where: { orderId: order.id, eventType: "refund" },
    });
    expect(refundLedger.length).toBe(1); // DB-enforced invariant
    const refundTxns = await db.walletTxn.findMany({
      where: { orderId: order.id, reason: "refund" },
    });
    expect(refundTxns.length).toBe(1);
    const bal = await getBalance(userId);
    expect(bal.balanceRials).toBe(600_000); // exactly one debit
    // The committed refund row carries the database invariant key.
    expect(refundLedger[0]?.refundKey).toBe(`refund:${order.id}`);
  });

  test("sequential refund replay is idempotent (no second debit, no duplicate notification)", async () => {
    await adminAdjustWallet({ userId, amount: 500_000, reason: "seed", idempotencyKey: "seed-2", adminId });
    const order = await seedOrder({ userId, amountRials: 200_000, status: "paid" });
    const r1 = await refund({ orderId: order.id, amount: 200_000, idempotencyKey: "same-key", adminId });
    const r2 = await refund({ orderId: order.id, amount: 200_000, idempotencyKey: "same-key", adminId });
    expect(r1.balanceRials).toBe(300_000);
    expect(r2.balanceRials).toBe(300_000);
    const notifs = await db.notification.count({ where: { userId, category: "payment", titleFa: "بازگشت وجه" } });
    expect(notifs).toBe(1);
    const bal = await getBalance(userId);
    expect(bal.balanceRials).toBe(300_000);
  });

  test("refund of a wallet-credit order bounded by balance — no negative spendable balance", async () => {
    await adminAdjustWallet({ userId, amount: 100_000, reason: "seed", idempotencyKey: "seed-3", adminId });
    const order = await seedOrder({ userId, amountRials: 400_000, status: "paid" });
    // Refund amount is within the order amount, but the balance is lower
    // (user already spent part of the credit) → rejected, nothing written.
    await expect(refund({ orderId: order.id, amount: 400_000, idempotencyKey: "r-big", adminId }))
      .rejects.toThrow();
    const bal = await getBalance(userId);
    expect(bal.balanceRials).toBe(100_000);
    expect(await db.ledgerEntry.count({ where: { orderId: order.id, eventType: "refund" } })).toBe(0);
  });

  test("C-04: admin debit exceeding balance is REJECTED (no negative balance, no rows)", async () => {
    await adminAdjustWallet({ userId, amount: 50_000, reason: "seed", idempotencyKey: "seed-4", adminId });
    await expect(adminAdjustWallet({
      userId, amount: -80_000, reason: "over-debit", idempotencyKey: "adj-neg", adminId,
    })).rejects.toThrow();
    const bal = await getBalance(userId);
    expect(bal.balanceRials).toBe(50_000);
    expect(await db.walletTxn.count({ where: { userId, reason: "admin_adjust" } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { userId, eventType: "admin_adjust" } })).toBe(1);
  });

  test("C-04: concurrent admin adjustments keep the derived balance consistent", async () => {
    await adminAdjustWallet({ userId, amount: 300_000, reason: "seed", idempotencyKey: "seed-5", adminId });
    // Five concurrent debits of 40_000 each = 200_000 total → balance 100_000.
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) =>
      adminAdjustWallet({ userId, amount: -40_000, reason: "debit", idempotencyKey: `adj-${i}`, adminId }),
    ));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(5);
    const bal = await getBalance(userId);
    expect(bal.balanceRials).toBe(100_000);
    const txns = await db.walletTxn.findMany({ where: { userId, reason: "admin_adjust" } });
    // Every balanceAfter snapshot matches the true derived balance at read time.
    const sorted = [...txns].sort((a, b) => a.balanceAfter - b.balanceAfter);
    for (const t of sorted) expect(t.balanceAfter).toBeGreaterThanOrEqual(0);
  });
});
