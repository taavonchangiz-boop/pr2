// =====================================================================
// POSTYAR — V4 H-06 wallet checkpoint tests (DB-backed)
// ---------------------------------------------------------------------
// Proves the checkpointed derived-balance model against the REAL
// database:
//   * getBalance reads the LATEST row's balanceAfter checkpoint (not a
//     full-history sum) — a tampered checkpoint is observable in the
//     read path;
//   * the checkpoint is EXACTLY reconcilable: sum(append-only history)
//     == latest balanceAfter after mixed credit/debit/refund flows;
//   * rebuildWalletCheckpoint is the recovery path: it repairs a
//     diverged checkpoint from history inside a serialized transaction
//     and writes a critical audit row;
//   * the negative-balance invariant still holds on the checkpoint path.
// =====================================================================
import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { db } from "@/lib/db";
import { resetDb, seedUser, ensureDbConnected } from "./_db-helpers";
import {
  getBalance,
  adminAdjustWallet,
  verifyWalletIntegrity,
  rebuildWalletCheckpoint,
} from "../src/lib/payments/wallet";
import type { User } from "@prisma/client";

describe("V4 H-06 — wallet checkpoint balance + reconciliation (DB-backed)", () => {
  let user: User;
  let admin: User;

  beforeAll(async () => { await ensureDbConnected(); });

  beforeEach(async () => {
    await resetDb();
    user = await seedUser({ email: "wallet-v4@test.local", mobile: "09120000971" });
    admin = await seedUser({ email: "wallet-v4-admin@test.local", mobile: "09120000972", role: "admin" });
  });

  test("getBalance returns the checkpoint; mixed flows keep it exactly reconciled", async () => {
    await adminAdjustWallet({ userId: user.id, amount: 500_000, reason: "شارژ اولیه", idempotencyKey: "k1", adminId: admin.id });
    await adminAdjustWallet({ userId: user.id, amount: 250_000, reason: "شارژ دوم", idempotencyKey: "k2", adminId: admin.id });
    await adminAdjustWallet({ userId: user.id, amount: -100_000, reason: "کسر", idempotencyKey: "k3", adminId: admin.id });

    const bal = await getBalance(user.id);
    expect(bal.balanceRials).toBe(650_000);

    const integrity = await verifyWalletIntegrity(user.id);
    expect(integrity.consistent).toBe(true);
    expect(integrity.checkpointBalance).toBe(650_000);
    expect(integrity.historySum).toBe(650_000);
    expect(integrity.txnCount).toBe(3);
  });

  test("the read path uses the LATEST checkpoint (tampering is observable, not masked by a rescan)", async () => {
    await adminAdjustWallet({ userId: user.id, amount: 400_000, reason: "شارژ", idempotencyKey: "t1", adminId: admin.id });
    // Simulate checkpoint corruption directly on the latest row.
    const latest = await db.walletTxn.findFirst({
      where: { userId: user.id },
      orderBy: { id: "desc" },
    });
    expect(latest).not.toBeNull();
    await db.walletTxn.update({ where: { id: latest!.id }, data: { balanceAfter: 999_999 } });

    // The checkpoint read path reflects the latest row (H-6 semantics)…
    const bal = await getBalance(user.id);
    expect(bal.balanceRials).toBe(999_999);

    // …and the reconciliation proves it diverged from history.
    const integrity = await verifyWalletIntegrity(user.id);
    expect(integrity.consistent).toBe(false);
    expect(integrity.checkpointBalance).toBe(999_999);
    expect(integrity.historySum).toBe(400_000);
  });

  test("rebuildWalletCheckpoint repairs a diverged checkpoint from the append-only history (audited)", async () => {
    await adminAdjustWallet({ userId: user.id, amount: 300_000, reason: "شارژ", idempotencyKey: "r1", adminId: admin.id });
    const latest = await db.walletTxn.findFirst({ where: { userId: user.id }, orderBy: { id: "desc" } });
    await db.walletTxn.update({ where: { id: latest!.id }, data: { balanceAfter: 12345 } });

    const repaired = await rebuildWalletCheckpoint(user.id, { actorId: admin.id });
    expect(repaired.repaired).toBe(true);
    expect(repaired.historySum).toBe(300_000);
    expect(repaired.checkpointBalance).toBe(300_000);
    expect(repaired.consistent).toBe(true);

    // The repair is durable and audited.
    const bal = await getBalance(user.id);
    expect(bal.balanceRials).toBe(300_000);
    const audits = await db.auditLog.findMany({ where: { action: "wallet_checkpoint_rebuild", userId: user.id } });
    expect(audits.length).toBe(1);
  });

  test("empty wallet reads zero; negative balance stays impossible via the checkpoint guard", async () => {
    expect((await getBalance(user.id)).balanceRials).toBe(0);
    const integrity = await verifyWalletIntegrity(user.id);
    expect(integrity.consistent).toBe(true); // 0 == 0

    await adminAdjustWallet({ userId: user.id, amount: 100_000, reason: "شارژ", idempotencyKey: "n1", adminId: admin.id });
    await expect(
      adminAdjustWallet({ userId: user.id, amount: -150_000, reason: "کسر بیش از موجودی", idempotencyKey: "n2", adminId: admin.id }),
    ).rejects.toThrow("کافی نیست");
    expect((await getBalance(user.id)).balanceRials).toBe(100_000);
    expect((await verifyWalletIntegrity(user.id)).consistent).toBe(true);
  });
});
