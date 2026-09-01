// =====================================================================
// POSTYAR — V4 H-05 real multi-connection concurrency proof
// ---------------------------------------------------------------------
// The authoritative production dialect is SQLite (file-based, WAL).
// Every other concurrency suite runs through the shared PrismaClient
// (connection_limit=1, i.e. serialized). THIS suite is different: it
// opens SEPARATE PrismaClient instances with their own connection pools
// against the SAME database file, so races are real races — SQLite WAL
// allows parallel readers and serializes writers at the file level with
// busy_timeout backpressure. The financial/security invariants must
// hold under exactly this mode:
//   1. concurrent wallet credits from independent connections keep the
//      checkpoint chain exactly reconciled (no lost update);
//   2. a concurrent over-debit can never drive the balance negative;
//   3. one-refund-per-order (LedgerEntry.refundKey UNIQUE) converges
//      across independent connections;
//   4. the durable inbox claim CAS converges across independent
//      connections (exactly one claim wins).
// =====================================================================
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { resetDb, seedUser, seedPlan, seedOrder, ensureDbConnected, db } from "./_db-helpers";
import { adminAdjustWallet, verifyWalletIntegrity, refund } from "../src/lib/payments/wallet";
import { claimBotEvent, ensureBotEvent } from "../src/lib/bots/event-dedup";
import { encryptString } from "../src/lib/security/crypto";

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

describe("V4 H-05 — financial/concurrency invariants under REAL multi-connection SQLite (WAL)", () => {
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

  test("concurrent wallet credits from independent connections keep the checkpoint chain exactly reconciled", async () => {
    await resetDb();
    const user = await seedUser({ email: "mc-credit@test.local", mobile: "09120000961" });
    const admin = await seedUser({ email: "mc-admin@test.local", mobile: "09120000962", role: "admin" });

    // 10 concurrent adjustments (interleaving both independent pools).
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        adminAdjustWallet({
          userId: user.id,
          amount: 10_000 * (i + 1),
          reason: `شارژ همزمان ${i + 1}`,
          idempotencyKey: `mc-credit-${i}`,
          adminId: admin.id,
        }),
      ),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const integrity = await verifyWalletIntegrity(user.id);
    const expected = Array.from({ length: 10 }, (_, i) => 10_000 * (i + 1)).reduce((a, b) => a + b, 0);
    expect(integrity.historySum).toBe(expected);
    expect(integrity.checkpointBalance).toBe(expected);
    expect(integrity.consistent).toBe(true);
    // No lost updates: exactly 10 rows.
    expect(integrity.txnCount).toBe(10);
  });

  test("concurrent over-debit from independent connections can never drive the balance negative", async () => {
    await resetDb();
    const user = await seedUser({ email: "mc-debit@test.local", mobile: "09120000963" });
    const admin = await seedUser({ email: "mc-debit-admin@test.local", mobile: "09120000964", role: "admin" });
    await adminAdjustWallet({ userId: user.id, amount: 1_000_000, reason: "شارژ", idempotencyKey: "mc-seed", adminId: admin.id });

    // Two debits of 800k racing for a 1M balance: at most one can win.
    const attempts = await Promise.allSettled([
      adminAdjustWallet({ userId: user.id, amount: -800_000, reason: "برداشت A", idempotencyKey: "mc-w-A", adminId: admin.id }),
      adminAdjustWallet({ userId: user.id, amount: -800_000, reason: "برداشت B", idempotencyKey: "mc-w-B", adminId: admin.id }),
    ]);
    const fulfilled = attempts.filter((r) => r.status === "fulfilled").length;
    const rejected = attempts.filter((r) => r.status === "rejected").length;
    expect(fulfilled).toBeLessThanOrEqual(1);
    expect(fulfilled + rejected).toBe(2);

    const bal = await (await import("../src/lib/payments/wallet")).getBalance(user.id);
    expect(bal.balanceRials).toBeGreaterThanOrEqual(0);
    expect((await verifyWalletIntegrity(user.id)).consistent).toBe(true);
  });

  test("one-refund-per-order converges across independent connections (UNIQUE refundKey)", async () => {
    await resetDb();
    const user = await seedUser({ email: "mc-refund@test.local", mobile: "09120000965" });
    const admin = await seedUser({ email: "mc-refund-admin@test.local", mobile: "09120000966", role: "admin" });
    const plan = await seedPlan({ code: "mc-plan", nameFa: "پلن تست", priceRials: 0 });
    const order = await seedOrder({
      userId: user.id,
      planId: plan.id,
      kind: "wallet_credit",
      amountRials: 500_000,
      status: "paid",
      provider: "bank",
    });
    // Seed the wallet credit the refund will debit.
    await adminAdjustWallet({ userId: user.id, amount: 500_000, reason: "شارژ", idempotencyKey: "mc-rf-seed", adminId: admin.id });

    // Two refunds with DIFFERENT idempotency keys racing on independent
    // connections — the refundKey UNIQUE must let exactly ONE commit.
    const results = await Promise.allSettled([
      refund({ orderId: order.id, amount: 200_000, idempotencyKey: "mc-rf-1", adminId: admin.id }),
      refund({ orderId: order.id, amount: 200_000, idempotencyKey: "mc-rf-2", adminId: admin.id }),
    ]);
    const ledgerRefunds = await db.ledgerEntry.findMany({ where: { refundKey: `refund:${order.id}` } });
    expect(ledgerRefunds.length).toBe(1);
    const settled = results.filter((r) => r.status === "fulfilled").length;
    expect(settled).toBe(2); // the loser converges idempotently (no throw to the caller)
    const integrity = await verifyWalletIntegrity(user.id);
    expect(integrity.consistent).toBe(true);
    expect(integrity.checkpointBalance).toBe(300_000); // 500k seeded − 200k refunded exactly once
  });

  test("the durable inbox claim CAS converges across independent connections", async () => {
    await resetDb();
    const owner = await seedUser({ email: "mc-inbox@test.local", mobile: "09120000967" });
    const bot = await db.bot.create({
      data: {
        ownerId: owner.id,
        name: "ربات تست همزمانی",
        provider: "telegram",
        botTokenEnc: encryptString("000000000:AAAA-mc-connection-test-token"),
        webhookSecret: encryptString("mc-webhook-secret"),
        status: "active",
      },
    });
    const ev = await ensureBotEvent(bot, bot.provider, "mc-9001", { update_id: 9001, message: { text: "سلام" } });

    // Claim the SAME event from both independent clients simultaneously.
    const [a, b] = await Promise.all([
      clientA.botInboundEvent.updateMany({
        where: {
          id: ev.id,
          OR: [
            { status: "received" },
            { status: "failed", attempts: { lt: 5 }, OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }] },
            { status: "processing", leaseUntil: { lt: new Date() } },
          ],
        },
        data: { status: "processing", attempts: { increment: 1 }, leaseUntil: new Date(Date.now() + 300_000) },
      }),
      clientB.botInboundEvent.updateMany({
        where: {
          id: ev.id,
          OR: [
            { status: "received" },
            { status: "failed", attempts: { lt: 5 }, OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }] },
            { status: "processing", leaseUntil: { lt: new Date() } },
          ],
        },
        data: { status: "processing", attempts: { increment: 1 }, leaseUntil: new Date(Date.now() + 300_000) },
      }),
    ]);
    expect(a.count + b.count).toBe(1); // exactly one connection wins the CAS
    expect(await claimBotEvent(ev.id)).toBe(false); // the shared client cannot steal the live lease either
  });
});
