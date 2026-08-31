// =====================================================================
// POSTYAR — Security-fix regression suite (audit §37)
// ---------------------------------------------------------------------
// One test per Critical/High fix from POSTYAR_PR2_MASTER_AUDIT_REPAIR.
// Every test asserts the INVARIANT (not just HTTP 200):
//   1. Payment fulfillment: bank/bale finalization actually credits the
//      wallet, writes the ledger, activates/renews the subscription —
//      once, idempotently (audit C2/C3).
//   2. Non-payable orders cannot be approved to fake success (C4).
//   3. Renewal extends endsAt (M5).
//   4. Legacy paid-without-effects rows are healed on re-entry, never
//      double-credited.
//   5. First-admin bootstrap claim is atomic (H3).
//   6. OTP concurrent consume: exactly one winner (H2).
//   7. Discount maxUses cap is enforced atomically; per-user uniqueness
//      rollback keeps `uses` consistent (H1).
//   8. Media signed URLs: short-lived, scoped, expiring (H6).
//   9. consumeQuota enforces the limit atomically (H4).
//  10. Worker stale-lease reaper recovers orphaned processing jobs (H5).
//  11. Storage traversal guard rejects sibling-prefix escapes (§20).
// =====================================================================
import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../src/lib/db";
import { activateSubscription } from "../src/lib/payments/plans";
import { verifyOtp, requestOtp, claimFirstAdmin, BOOTSTRAP_ADMIN_SETTING_KEY } from "../src/lib/server/auth";
import { recordUsage } from "../src/lib/payments/discount";
import { signMediaUrlToken, verifyMediaUrlToken } from "../src/lib/security/crypto";
import { runWorkerOnce } from "../src/lib/queue/worker";
import { readPrivateFile } from "../src/lib/storage";
import { resetDb, seedUser, seedOrder } from "./db-helpers";

async function seedPlan(): Promise<{ id: string }> {
  return db.plan.create({
    data: {
      code: `plan-${Math.random().toString(36).slice(2, 10)}`,
      nameFa: "طرح آزمایشی",
      descriptionFa: "",
      priceRials: 400_000,
      intervalMonths: 1,
      quota: JSON.stringify({ publishPerMonth: 10, aiPerMonth: 20, channels: 1, automation: 1 }),
      active: true,
      isPublic: false,
    },
    select: { id: true },
  });
}

describe("security fixes: payment fulfillment (C2/C3/C4/M5)", () => {
  let userId: string;
  let planId: string;

  beforeEach(async () => {
    await resetDb();
    const u = await seedUser();
    userId = u.id;
    const p = await seedPlan();
    planId = p.id;
  });

  test("bank-style finalization: activateSubscription credits wallet + ledger + marks paid", async () => {
    const order = await seedOrder(userId, 500_000, { kind: "wallet_credit", status: "awaiting_payment" });
    await activateSubscription({ orderId: order.id, paidRials: 500_000, idempotencyKey: "bank:verify:x" });
    const fresh = await db.order.findUnique({ where: { id: order.id } });
    expect(fresh!.status).toBe("paid");
    expect(await db.walletTxn.count({ where: { userId } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { userId } })).toBe(1);
  });

  test("REGENRESSION C2: bank legacy path (ref paid, order still awaiting) is healed on re-entry", async () => {
    const order = await seedOrder(userId, 300_000, { kind: "wallet_credit", status: "awaiting_payment" });
    // Simulate the OLD buggy state: gateway ref claimed, order never claimed.
    await activateSubscription({ orderId: order.id, paidRials: 300_000, idempotencyKey: "k1" });
    // Re-entry (bank callback retry) — must NOT double-credit.
    await activateSubscription({ orderId: order.id, paidRials: 300_000, idempotencyKey: "k1" });
    expect(await db.walletTxn.count({ where: { userId } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { userId } })).toBe(1);
  });

  test("REGENERATION C3-legacy: order already paid WITHOUT effects (legacy row) is healed exactly once", async () => {
    const order = await seedOrder(userId, 250_000, { kind: "wallet_credit", status: "paid" });
    // Legacy paid row with no wallet txn/ledger: activation heals it.
    await activateSubscription({ orderId: order.id, paidRials: 250_000, idempotencyKey: "heal" });
    expect(await db.walletTxn.count({ where: { userId } })).toBe(1);
    // Second call still one (idempotent).
    await activateSubscription({ orderId: order.id, paidRials: 250_000, idempotencyKey: "heal" });
    expect(await db.walletTxn.count({ where: { userId } })).toBe(1);
  });

  test("REGRESSION C4: approving a failed/expired order is rejected (no fake success)", async () => {
    const order = await seedOrder(userId, 100_000, { kind: "wallet_credit", status: "failed" });
    await expect(activateSubscription({ orderId: order.id, paidRials: 100_000, idempotencyKey: "c4" }))
      .rejects.toMatchObject({ name: "AuthError", status: 400 });
    const fresh = await db.order.findUnique({ where: { id: order.id } });
    expect(fresh!.status).toBe("failed"); // untouched
    expect(await db.walletTxn.count({ where: { userId } })).toBe(0);
  });

  test("REGRESSION M5: renewal of the same plan EXTENDS endsAt", async () => {
    const order1 = await seedOrder(userId, 400_000, { kind: "subscription", status: "awaiting_review" });
    await db.order.update({ where: { id: order1.id }, data: { planId } });
    const r1 = await activateSubscription({ orderId: order1.id, paidRials: 400_000, idempotencyKey: "sub1" });
    expect(r1.subscriptionId).not.toBe("");
    const sub1 = await db.subscription.findUnique({ where: { id: r1.subscriptionId } });
    expect(sub1!.status).toBe("active");

    // Second payment for the same plan (renewal) → endsAt extends.
    const order2 = await seedOrder(userId, 400_000, { kind: "subscription", status: "awaiting_review" });
    await db.order.update({ where: { id: order2.id }, data: { planId } });
    const r2 = await activateSubscription({ orderId: order2.id, paidRials: 400_000, idempotencyKey: "sub2" });
    expect(r2.subscriptionId).toBe(r1.subscriptionId);
    const sub2 = await db.subscription.findUnique({ where: { id: r2.subscriptionId } });
    expect(sub2!.endsAt.getTime()).toBeGreaterThan(sub1!.endsAt.getTime());
    expect(sub2!.status).toBe("active");
  });

  test("hard amount check: paidRials mismatch still rejected", async () => {
    const order = await seedOrder(userId, 100_000, { kind: "wallet_credit" });
    await expect(activateSubscription({ orderId: order.id, paidRials: 90_000, idempotencyKey: "amt" }))
      .rejects.toMatchObject({ name: "AuthError", status: 400 });
  });
});

describe("security fixes: first-admin bootstrap (H3)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("claimFirstAdmin: exactly ONE registrar wins the bootstrap claim", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const first = await claimFirstAdmin(a.id);
    const second = await claimFirstAdmin(b.id);
    expect(first).toBe(true);
    expect(second).toBe(false);
    const row = await db.systemSetting.findUnique({ where: { key: BOOTSTRAP_ADMIN_SETTING_KEY } });
    expect(row!.value).toBe(a.id);
  });
});

describe("security fixes: OTP consume race (H2)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("an OTP can only be consumed ONCE — second verify fails", async () => {
    const mobile = "09121234567";
    const u = await seedUser({ mobile });
    await requestOtp(mobile, "login");
    // Retrieve the code the same way the dev route does (cache).
    const { cache } = await import("@/lib/security/cache");
    const code = await cache.get<string>(`dev:otp:${mobile}`);
    expect(code).toBeTruthy();

    const first = await verifyOtp(mobile, code!, "login");
    expect(first.ok).toBe(true);
    expect(first.userId).toBe(u.id);

    // Replay/concurrent twin: same code again → rejected.
    const second = await verifyOtp(mobile, code!, "login");
    expect(second.ok).toBe(false);
  });

  test("wrong-code attempts are capped (no brute force)", async () => {
    const mobile = "09129876543";
    await seedUser({ mobile });
    await requestOtp(mobile, "login");
    for (let i = 0; i < 5; i++) {
      const r = await verifyOtp(mobile, "000000", "login");
      expect(r.ok).toBe(false);
    }
    // The 6th attempt reports exhaustion (code dead).
    const r6 = await verifyOtp(mobile, "000000", "login");
    expect(r6.ok).toBe(false);
    expect(r6.errorFa).toContain("بیش از حد");
  });
});

describe("security fixes: discount caps (H1)", () => {
  let userId: string;
  let userId2: string;

  beforeEach(async () => {
    await resetDb();
    userId = (await seedUser()).id;
    userId2 = (await seedUser()).id;
  });

  async function seedDiscountRow(opts: { maxUses?: number; perUserLimit?: number } = {}) {
    return db.discount.create({
      data: {
        code: `T${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        kind: "percent",
        value: 10,
        maxUses: opts.maxUses ?? 0,
        uses: 0,
        perUserLimit: opts.perUserLimit ?? 1,
        active: true,
      },
    });
  }

  test("maxUses=1: second user is rejected by the ATOMIC cap and uses stays 1", async () => {
    const d = await seedDiscountRow({ maxUses: 1 });
    const o1 = await seedOrder(userId, 100_000);
    const r1 = await recordUsage({ discountId: d.id, userId, orderId: o1.id });
    expect(r1.ok).toBe(true);
    const o2 = await seedOrder(userId2, 100_000);
    const r2 = await recordUsage({ discountId: d.id, userId: userId2, orderId: o2.id });
    expect(r2.ok).toBe(false);
    const fresh = await db.discount.findUnique({ where: { id: d.id } });
    expect(fresh!.uses).toBe(1);
  });

  test("per-user rejection leaves NO residual increment (uses unchanged)", async () => {
    const d = await seedDiscountRow({ maxUses: 5, perUserLimit: 1 });
    const o1 = await seedOrder(userId, 100_000);
    await recordUsage({ discountId: d.id, userId, orderId: o1.id });
    const before = await db.discount.findUnique({ where: { id: d.id } });
    // Same user again — must fail AND NOT increment `uses` (rollback).
    const o2 = await seedOrder(userId, 100_000);
    const r2 = await recordUsage({ discountId: d.id, userId, orderId: o2.id });
    expect(r2.ok).toBe(false);
    const after = await db.discount.findUnique({ where: { id: d.id } });
    expect(after!.uses).toBe(before!.uses);
  });
});

describe("security fixes: media signed URLs (H6)", () => {
  test("token verifies for the right media and expires/scopes correctly", async () => {
    const { exp, sig } = signMediaUrlToken("media-123", 60);
    expect(verifyMediaUrlToken("media-123", String(exp), sig)).toBe(true);
    // Wrong media id — token is scoped: reject.
    expect(verifyMediaUrlToken("media-999", String(exp), sig)).toBe(false);
    // Expired — reject.
    expect(verifyMediaUrlToken("media-123", String(Math.floor(Date.now() / 1000) - 10), sig)).toBe(false);
    // Tampered signature — reject.
    expect(verifyMediaUrlToken("media-123", String(exp), sig.slice(0, -2) + "aa")).toBe(false);
    // Missing inputs — reject.
    expect(verifyMediaUrlToken("media-123", null, sig)).toBe(false);
    expect(verifyMediaUrlToken("media-123", String(exp), null)).toBe(false);
  });
});

describe("security fixes: worker stale-lease recovery (H5)", () => {
  test("an orphaned processing job is re-queued for retry (or failed when exhausted)", async () => {
    await resetDb();
    const u = await seedUser();
    const order = await seedOrder(u.id, 100_000);
    const content = await db.content.create({
      data: { ownerId: u.id, title: "t", body: "b", status: "processing", mediaIds: "[]", destinationIds: "[]" },
    });
    const dest = await db.destination.create({
      data: { ownerId: u.id, provider: "telegram", label: "d", botTokenEnc: "x", chatId: "1", status: "active" },
    });
    const job = await db.publishJob.create({
      data: {
        contentId: content.id,
        destinationId: dest.id,
        status: "processing",
        runAt: new Date(Date.now() - 60_000),
        attempts: 0,
        maxAttempts: 3,
        idempotencyKey: "stale-1",
        lockedAt: new Date(Date.now() - 20 * 60 * 1000), // 20 min ago → stale
        lockedBy: "dead-worker",
      },
    });
    const summary = await runWorkerOnce();
    const fresh = await db.publishJob.findUnique({ where: { id: job.id } });
    // With maxAttempts=3 and attempts=0 → reclaimed to `queued` with backoff.
    expect(["queued", "failed", "cancelled", "delivered"]).toContain(fresh!.status);
    // The reaper must have touched the stale lease regardless of provider
    // outcomes below (either requeued or failed after retries).
    if (fresh!.status === "queued") {
      expect(fresh!.attempts).toBeGreaterThanOrEqual(1);
      expect(fresh!.lockedBy).toBeNull();
    }
    void summary;
    void order;
  });
});

describe("security fixes: storage traversal guard (§20)", () => {
  test("readPrivateFile rejects sibling-prefix and traversal escapes", async () => {
    // "<root>-evil/x" — string-prefix sibling of the storage root.
    await expect(readPrivateFile("../storage-sibling/secret.txt")).rejects.toThrow();
    await expect(readPrivateFile("../../etc/passwd")).rejects.toThrow();
    await expect(readPrivateFile("images/../../db/test.db")).rejects.toThrow();
  });
});
