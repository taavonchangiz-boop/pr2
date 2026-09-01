// =====================================================================
// POSTYAR — Plans accounting regression tests (P0.5 / P0.6 / P0.9)
// ---------------------------------------------------------------------
// Financial-integrity invariants after the root-cause repair:
//   * a subscription payment creates a LedgerEntry but NEVER a spendable
//     WalletTxn credit (P0.5);
//   * a wallet_credit payment credits the wallet exactly once (P0.5);
//   * subscription renewal EXTENDS endsAt and never creates a second live
//     row — including under concurrent activation (P0.9, activeKey UNIQUE);
//   * referral rewards apply ONLY to the first paid SUBSCRIPTION order
//     (P0.6) — wallet top-ups never qualify; self-referral excluded;
//   * replay of the same payment is idempotent.
// =====================================================================
import { test, expect, describe, beforeAll, beforeEach } from "bun:test";
import {
  resetDb,
  seedUser,
  seedPlan,
  seedOrder,
  ensureDbConnected,
  db,
} from "./_db-helpers";
import { activateSubscription } from "@/lib/payments/plans";
import { getBalance } from "@/lib/payments/wallet";

describe("plans accounting: wallet/ledger/subscription/referral (DB-backed)", () => {
  let userId: string;
  let planId: string;

  beforeAll(async () => {
    await ensureDbConnected();
  });

  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "acct@test.local", mobile: "09120000101" });
    userId = u.id;
    const p = await seedPlan({ code: "acct-pro", priceRials: 500_000 });
    planId = p.id;
  });

  test("subscription payment → ledger entry ONLY, no wallet credit (P0.5)", async () => {
    const order = await seedOrder({ userId: userId, amountRials: 500_000, kind: "subscription", planId, status: "awaiting_payment" });
    const r = await activateSubscription({ orderId: order.id, paidRials: 500_000, idempotencyKey: "sub-1" });
    expect(r.credited).toBe(true);
    expect(r.subscriptionId).toBeTruthy();

    // Accounting ledger entry exists.
    const ledger = await db.ledgerEntry.findMany({ where: { orderId: order.id, eventType: "payment" } });
    expect(ledger.length).toBe(1);

    // NO spendable wallet credit was created (P0.5 core invariant).
    const walletTxns = await db.walletTxn.findMany({ where: { orderId: order.id } });
    expect(walletTxns.length).toBe(0);
    const bal = await getBalance(userId);
    expect(bal.balanceRials).toBe(0);

    // Order claimed as paid.
    const fresh = await db.order.findUnique({ where: { id: order.id } });
    expect(fresh?.status).toBe("paid");
  });

  test("wallet top-up payment → wallet credited exactly once (P0.5)", async () => {
    const order = await seedOrder({ userId: userId, amountRials: 250_000, kind: "wallet_credit", status: "awaiting_payment" });
    await activateSubscription({ orderId: order.id, paidRials: 250_000, idempotencyKey: "top-1" });

    const walletTxns = await db.walletTxn.findMany({ where: { orderId: order.id, reason: "payment" } });
    expect(walletTxns.length).toBe(1);
    expect(walletTxns[0]?.direction).toBe("credit");
    const bal = await getBalance(userId);
    expect(bal.balanceRials).toBe(250_000);
  });

  test("subscription + wallet coexistence: subscription revenue is not spendable", async () => {
    const subOrder = await seedOrder({ userId: userId, amountRials: 500_000, kind: "subscription", planId, status: "awaiting_payment" });
    const topOrder = await seedOrder({ userId: userId, amountRials: 120_000, kind: "wallet_credit", status: "awaiting_payment" });
    await activateSubscription({ orderId: subOrder.id, paidRials: 500_000, idempotencyKey: "co-sub" });
    await activateSubscription({ orderId: topOrder.id, paidRials: 120_000, idempotencyKey: "co-top" });
    const bal = await getBalance(userId);
    // ONLY the top-up is spendable — the subscription price must not leak in.
    expect(bal.balanceRials).toBe(120_000);
  });

  test("subscription renewal extends endsAt; repeat payment returns no second row (P0.9)", async () => {
    const o1 = await seedOrder({ userId: userId, amountRials: 500_000, kind: "subscription", planId, status: "awaiting_payment" });
    const r1 = await activateSubscription({ orderId: o1.id, paidRials: 500_000, idempotencyKey: "renew-1" });
    const first = await db.subscription.findUnique({ where: { id: r1.subscriptionId } });
    expect(first?.endsAt).toEqual(r1.endsAt);

    // A second purchase of the SAME plan renews instead of creating a row.
    const o2 = await seedOrder({ userId: userId, amountRials: 500_000, kind: "subscription", planId, status: "awaiting_payment" });
    const r2 = await activateSubscription({ orderId: o2.id, paidRials: 500_000, idempotencyKey: "renew-2" });
    expect(r2.subscriptionId).toBe(r1.subscriptionId);
    const after = await db.subscription.findMany({ where: { userId, planId, status: "active" } });
    expect(after.length).toBe(1);
    expect(after[0]!.endsAt.getTime()).toBeGreaterThan(first!.endsAt.getTime());
  });

  test("CONCURRENT activation of the same plan converges on ONE live row (P0.9)", async () => {
    const orders = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        seedOrder({
          userId,
          amountRials: 500_000,
          kind: "subscription",
          planId,
          status: "awaiting_payment",
          idempotencyKey: `conc-sub-${i}`,
        }),
      ),
    );
    await Promise.allSettled(
      orders.map((o, i) =>
        activateSubscription({ orderId: o.id, paidRials: 500_000, idempotencyKey: `conc-act-${i}` }),
      ),
    );
    const live = await db.subscription.findMany({ where: { userId, planId, status: "active" } });
    expect(live.length).toBe(1);
    // Every order was claimed paid (each payment honored).
    const paid = await db.order.count({ where: { userId, status: "paid" } });
    expect(paid).toBe(4);
  });

  test("replay of the same payment is idempotent — no double credit (P0.5)", async () => {
    const order = await seedOrder({ userId: userId, amountRials: 250_000, kind: "wallet_credit", status: "awaiting_payment" });
    await activateSubscription({ orderId: order.id, paidRials: 250_000, idempotencyKey: "replay-1" });
    await activateSubscription({ orderId: order.id, paidRials: 250_000, idempotencyKey: "replay-1" });
    const bal = await getBalance(userId);
    expect(bal.balanceRials).toBe(250_000);
    const walletTxns = await db.walletTxn.count({ where: { orderId: order.id } });
    expect(walletTxns).toBe(1);
    const ledger = await db.ledgerEntry.count({ where: { orderId: order.id } });
    expect(ledger).toBe(1);
  });

  test("non-payable orders are rejected loudly (no fake success)", async () => {
    const order = await seedOrder({ userId: userId, amountRials: 500_000, kind: "subscription", planId, status: "cancelled" });
    await expect(
      activateSubscription({ orderId: order.id, paidRials: 500_000, idempotencyKey: "dead-1" }),
    ).rejects.toMatchObject({ name: "AuthError" });
    const fresh = await db.order.findUnique({ where: { id: order.id } });
    expect(fresh?.status).toBe("cancelled");
  });

  test("amount mismatch rejected (hard amount check)", async () => {
    const order = await seedOrder({ userId: userId, amountRials: 500_000, kind: "subscription", planId, status: "awaiting_payment" });
    await expect(
      activateSubscription({ orderId: order.id, paidRials: 400_000, idempotencyKey: "mismatch-1" }),
    ).rejects.toMatchObject({ name: "AuthError", status: 400 });
  });
});

describe("referral rewards eligibility (P0.6)", () => {
  let referrerId: string;
  let referredId: string;
  let planId: string;

  beforeAll(async () => {
    await ensureDbConnected();
  });

  beforeEach(async () => {
    await resetDb();
    const referrer = await seedUser({ email: "ref@test.local", mobile: "09120000201" });
    const referred = await seedUser({
      email: "referred@test.local",
      mobile: "09120000202",
      referredById: referrer.id,
    });
    referrerId = referrer.id;
    referredId = referred.id;
    const p = await seedPlan({ code: "ref-pro", priceRials: 400_000 });
    planId = p.id;
  });

  test("first paid SUBSCRIPTION order grants the referral reward", async () => {
    const order = await seedOrder({ userId: referredId, amountRials: 400_000, kind: "subscription", planId, status: "awaiting_payment" });
    const r = await activateSubscription({ orderId: order.id, paidRials: 400_000, idempotencyKey: "ref-sub-1" });
    expect(r.referralRewardRials).toBeGreaterThan(0);
    const rewards = await db.referralReward.findMany({ where: { referredId } });
    expect(rewards.length).toBe(1);
    expect(rewards[0]?.referrerId).toBe(referrerId);
  });

  test("wallet top-up NEVER grants a referral reward (P0.6)", async () => {
    const order = await seedOrder({ userId: referredId, amountRials: 400_000, kind: "wallet_credit", status: "awaiting_payment" });
    const r = await activateSubscription({ orderId: order.id, paidRials: 400_000, idempotencyKey: "ref-top-1" });
    expect(r.referralRewardRials).toBe(0);
    const rewards = await db.referralReward.count({ where: { referredId } });
    expect(rewards).toBe(0);
  });

  test("reward is one-time — a later subscription payment does not re-reward", async () => {
    const o1 = await seedOrder({ userId: referredId, amountRials: 400_000, kind: "subscription", planId, status: "awaiting_payment" });
    await activateSubscription({ orderId: o1.id, paidRials: 400_000, idempotencyKey: "ref-1" });
    const o2 = await seedOrder({ userId: referredId, amountRials: 400_000, kind: "subscription", planId, status: "awaiting_payment" });
    const r2 = await activateSubscription({ orderId: o2.id, paidRials: 400_000, idempotencyKey: "ref-2" });
    expect(r2.referralRewardRials).toBe(0);
    expect(await db.referralReward.count({ where: { referredId } })).toBe(1);
  });

  test("self-referral is excluded", async () => {
    // referredById points at the SAME user.
    await db.user.update({ where: { id: referredId }, data: { referredById: referredId } });
    const order = await seedOrder({ userId: referredId, amountRials: 400_000, kind: "subscription", planId, status: "awaiting_payment" });
    const r = await activateSubscription({ orderId: order.id, paidRials: 400_000, idempotencyKey: "self-1" });
    expect(r.referralRewardRials).toBe(0);
    expect(await db.referralReward.count({ where: { referredId } })).toBe(0);
  });
});
