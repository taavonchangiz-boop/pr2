// =====================================================================
// POSTYAR — Wallet + Ledger (append-only, checkpointed derived balance)
// ---------------------------------------------------------------------
// Money: INTEGER Rial minor units. NO floats.
// All mutations are atomic via Prisma $transaction with deterministic
// idempotency keys. The balance is a DERIVED checkpoint: every WalletTxn
// row carries `balanceAfter` (the running balance at insert time), the
// write paths are serialized per-user (user-row lock as the FIRST
// statement of the transaction — this also pins the SQLite WAL read
// snapshot AFTER the write lock, so no stale checkpoint can be read),
// and the balance is read in O(1) from the latest row instead of
// scanning the whole history (V4 H-6). History stays append-only and
// the checkpoint is exactly reconcilable: sum(history) MUST always equal
// the latest row's balanceAfter — `verifyWalletIntegrity` proves it and
// `rebuildWalletCheckpoint` is the recovery path (V4 H-6).
// Persian error strings only.
// =====================================================================
import { db } from "@/lib/db";
import { audit } from "@/lib/server/auth";
import { formatRials } from "@/lib/persian";
import type { Prisma, PrismaClient } from "@prisma/client";

/** Any Prisma client that can execute queries (global or tx-bound). */
type QueryClient = Prisma.TransactionClient | PrismaClient;

// ---------------------------------------------------------------------
// Read-side: balance + history
// ---------------------------------------------------------------------
/**
 * V4 H-6 — O(1) derived balance: the LATEST WalletTxn row's
 * `balanceAfter` checkpoint IS the balance. Every write path maintains
 * the checkpoint inside a user-row-serialized transaction, so no
 * additional lock is needed for reads. `id` order == insert order
 * (cuid() is monotonic within a process and writes are serialized),
 * backed by the (userId, id) index.
 */
export async function latestBalanceFor(client: QueryClient, userId: string): Promise<number> {
  const last = await client.walletTxn.findFirst({
    where: { userId },
    orderBy: { id: "desc" },
    select: { balanceAfter: true },
  });
  return last?.balanceAfter ?? 0;
}

export async function getBalance(userId: string): Promise<{ balanceRials: number; balanceFa: string }> {
  const bal = await latestBalanceFor(db, userId);
  return { balanceRials: bal, balanceFa: formatRials(bal) };
}

export interface WalletTxnView {
  id: string;
  amountRials: number;
  amountFa: string;
  direction: "credit" | "debit";
  reason: string;
  orderId: string | null;
  balanceAfter: number;
  createdAt: string;
}

const REASON_FA: Record<string, string> = {
  payment: "پرداخت",
  refund: "بازگاشت وجه",
  referral_reward: "پاداش معرفی",
  admin_adjust: "تنظیم توسط مدیر",
  ad_campaign: "تبلیغات",
  subscription: "اشتراک",
};

export async function getWalletHistory(
  userId: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<{ items: WalletTxnView[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(50, Math.max(1, opts.pageSize ?? 20));
  const [rows, total] = await Promise.all([
    db.walletTxn.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.walletTxn.count({ where: { userId } }),
  ]);
  return {
    items: rows.map((t) => ({
      id: t.id,
      amountRials: t.amountRials,
      amountFa: formatRials(t.amountRials),
      direction: t.direction as "credit" | "debit",
      reason: REASON_FA[t.reason] ?? t.reason,
      orderId: t.orderId,
      balanceAfter: t.balanceAfter,
      createdAt: t.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  };
}

export interface LedgerEntryView {
  id: string;
  eventType: string;
  amountRials: number;
  amountFa: string;
  orderId: string | null;
  currency: string;
  createdAt: string;
}

const EVENT_FA: Record<string, string> = {
  payment: "پرداخت",
  credit: "افزایش اعتبار",
  debit: "کاهش اعتبار",
  refund: "بازگاشت",
  referral_reward: "پاداش معرفی",
  admin_adjust: "تنظیم مدیر",
};

export async function getLedgerEntries(
  userId: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<{ items: LedgerEntryView[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(50, Math.max(1, opts.pageSize ?? 20));
  const [rows, total] = await Promise.all([
    db.ledgerEntry.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.ledgerEntry.count({ where: { userId } }),
  ]);
  return {
    items: rows.map((t) => ({
      id: t.id,
      eventType: EVENT_FA[t.eventType] ?? t.eventType,
      amountRials: t.amountRials,
      amountFa: formatRials(t.amountRials),
      orderId: t.orderId,
      currency: t.currency,
      createdAt: t.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  };
}

// ---------------------------------------------------------------------
// Write-side: admin adjust + refund (both atomic + idempotent)
// ---------------------------------------------------------------------
export async function adminAdjustWallet(input: {
  userId: string;
  amount: number; // positive=credit, negative=debit
  reason: string;
  idempotencyKey: string;
  adminId: string;
  ip?: string;
}): Promise<{ balanceRials: number }> {
  if (!Number.isInteger(input.amount) || input.amount === 0) {
    throw new Error("مبلغ باید عدد صحیح غیر صفر باشد.");
  }
  const direction = input.amount > 0 ? "credit" : "debit";
  const amountAbs = Math.abs(input.amount);

  // ROOT-CAUSE FIX (audit §30/§13): the idempotency key is scoped by
  // adminId + userId + direction + amount, so a client-supplied key can
  // never collide with an UNRELATED prior adjustment and silently drop
  // the new mutation (the previous raw key caused exactly that). Retrying
  // the SAME adjustment (same inputs) still hits the same key → no-op.
  const scopedKey = `${input.adminId}:${input.userId}:${direction}:${amountAbs}:${input.idempotencyKey}`;
  const ledgerIdemKey = `ledger:admin_adjust:${scopedKey}`;
  const walletIdemKey = `wallet:admin_adjust:${scopedKey}`;

  const result = await db.$transaction(async (tx) => {
    // Serialize concurrent wallet mutations for this user FIRST — the row
    // write on User takes the DB write lock and (on SQLite/WAL) pins the
    // transaction snapshot AFTER the lock, so the checkpoint read below
    // can never observe a pre-lock (stale) balance (V4 H-6).
    await tx.user.update({ where: { id: input.userId }, data: { updatedAt: new Date() } });

    // Idempotency check: an existing row for this exact key means this
    // adjustment was already applied — do NOT create anything and do NOT
    // re-send the notification.
    const existing = await tx.walletTxn.findUnique({
      where: { idempotencyKey: walletIdemKey },
      select: { id: true },
    });
    if (!existing) {
      const running = await latestBalanceFor(tx, input.userId);
      const balanceAfter = running + (direction === "credit" ? amountAbs : -amountAbs);

      // C-04 — BALANCE GUARD: spendable wallet balances are defined to be
      // non-negative everywhere in the codebase (the refund path already
      // enforces this). An admin debit that would drive the derived balance
      // below zero is rejected here — inside the transaction, so no partial
      // state can exist — instead of silently writing a negative balance.
      if (direction === "debit" && balanceAfter < 0) {
        throw new Error("موجودی کیف پول کاربر برای این کاهش اعتبار کافی نیست.");
      }

      await tx.walletTxn.create({
        data: {
          userId: input.userId,
          amountRials: amountAbs,
          direction,
          reason: "admin_adjust",
          balanceAfter,
          idempotencyKey: walletIdemKey,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          userId: input.userId,
          eventType: "admin_adjust",
          amountRials: direction === "credit" ? amountAbs : -amountAbs,
          currency: "IRR",
          idempotencyKey: ledgerIdemKey,
        },
      });

      // Notify user (only when a real mutation happened — no duplicate
      // notification spam on idempotent re-entry).
      await tx.notification.create({
        data: {
          userId: input.userId,
          category: "payment",
          titleFa: direction === "credit" ? "افزایش اعتبار کیف پول" : "کاهش اعتبار کیف پول",
          bodyFa:
            (direction === "credit" ? "مبلغ " : "کسر مبلغ ") +
            formatRials(amountAbs) +
            (input.reason ? ` — دلیل: ${input.reason}` : ""),
          link: "/dashboard/wallet",
        },
      });

      // M-04 + V5 M-05 — the wallet-adjust audit JOINS the transaction
      // (critical) AND lives inside the mutation-only branch: an idempotent
      // replay (same key, no money movement) must not write a SECOND audit
      // row. A failed audit rolls the operation back and the idempotent
      // retry heals.
      await audit({
        userId: input.userId,
        actor: "admin",
        action: "wallet_adjust",
        targetType: "wallet",
        targetId: input.userId,
        ip: input.ip,
        tx,
        critical: true,
        meta: {
          adminId: input.adminId,
          direction,
          amountRials: amountAbs,
          reason: input.reason,
          balanceAfter,
        },
      });
    }

    // Always report the TRUE derived balance — the checkpoint of the
    // latest row inside the same transaction (V4 H-6).
    const actualBalance = await latestBalanceFor(tx, input.userId);

    return { balanceAfter: actualBalance };
  });

  return { balanceRials: result.balanceAfter };
}

export async function refund(input: {
  orderId: string;
  amount: number;
  idempotencyKey: string;
  adminId: string;
  ip?: string;
}): Promise<{ balanceRials: number }> {
  const order = await db.order.findUnique({ where: { id: input.orderId } });
  if (!order) throw new Error("سفارش یافت نشد.");
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error("مبلغ بازگشتی نامعتبر است.");
  }
  if (input.amount > order.amountRials) {
    throw new Error("مبلغ بازگشتی بیشتر از مبلغ سفارش است.");
  }
  // Order must be refundable: only a PAID order has captured money to return.
  if (order.status !== "paid") {
    throw new Error("تنها سفارش پرداخت‌شده قابل بازگشت است.");
  }

  // KIND-AWARE REFUND MODEL (financial-integrity, P0.5):
  //   * wallet_credit order → the payment created spendable credit, so the
  //     refund DEBITS the wallet (bounded by the derived balance).
  //   * subscription order  → the payment never touched the wallet (P0.5
  //     fix), so the refund is a LEDGER-ONLY accounting event (negative
  //     entry, one per order) — debiting the wallet here would corrupt the
  //     spendable balance with money the user never received.
  const isWalletKind = order.kind === "wallet_credit";
  // V4 H-6/M-8 — refund idempotency keys are scoped by ORDER so a reused
  // key on a different order can never silently collide (the
  // one-refund-per-order invariant itself is enforced by the refundKey
  // UNIQUE below, independently of these keys).
  const walletIdemKey = `wallet:refund:${order.id}:${input.idempotencyKey}`;
  const ledgerIdemKey = `ledger:refund:${order.id}:${input.idempotencyKey}`;

  // C-03 — the ONE-REFUND-PER-ORDER invariant is now enforced by the
  // DATABASE, not by a countable query. LedgerEntry.refundKey is a UNIQUE
  // nullable column; the refund row carries `refund:<orderId>` so two
  // concurrent refund transactions for the same order can never both
  // commit — the loser observes the UNIQUE violation and converges on the
  // winner's already-committed refund (exact idempotency on replay).
  const refundInvariantKey = `refund:${order.id}`;

  const result = await db.$transaction(async (tx) => {
    if (isWalletKind) {
      // Serialize concurrent wallet mutations for this user FIRST (see
      // adminAdjustWallet — V4 H-6 snapshot ordering), then apply the
      // balance guard BEFORE any write: derived balance must never go
      // negative; throwing rolls the whole transaction back.
      await tx.user.update({ where: { id: order.userId }, data: { updatedAt: new Date() } });
    }
    // Idempotent re-entry: an existing ledger row for this exact key means
    // this refund was already applied — report the true balance, change
    // nothing.
    const existingLedger = await tx.ledgerEntry.findUnique({
      where: { idempotencyKey: ledgerIdemKey },
      select: { id: true },
    });
    if (existingLedger) {
      return { balanceAfter: await latestBalanceFor(tx, order.userId), duplicate: true as const };
    }

    let balanceAfter = 0;
    if (isWalletKind) {
      const running = await latestBalanceFor(tx, order.userId);
      balanceAfter = running - input.amount;
      if (balanceAfter < 0) {
        throw new Error("موجودی کیف پول برای بازگشت این مبلغ کافی نیست.");
      }
    }

    // DB-enforced invariant gate: creating the refund ledger row FIRST —
    // with the UNIQUE refundKey — decides the sole winner. A concurrent
    // refund for the same order (even with a DIFFERENT idempotency key)
    // loses here and converges to "already refunded" without any writes.
    try {
      await tx.ledgerEntry.create({
        data: {
          userId: order.userId,
          orderId: order.id,
          eventType: "refund",
          amountRials: -input.amount,
          currency: "IRR",
          idempotencyKey: ledgerIdemKey,
          refundKey: refundInvariantKey,
        },
      });
    } catch (err) {
      const msg = (err as { code?: string; message?: string })?.message ?? "";
      if (/unique|UNIQUE|constraint/i.test(msg)) {
        return { balanceAfter: await latestBalanceFor(tx, order.userId), duplicate: true as const };
      }
      throw err;
    }

    if (isWalletKind) {
      await tx.walletTxn.create({
        data: {
          userId: order.userId,
          orderId: order.id,
          amountRials: input.amount,
          direction: "debit",
          reason: "refund",
          balanceAfter,
          idempotencyKey: walletIdemKey,
        },
      });
    }

    await tx.notification.create({
      data: {
        userId: order.userId,
        category: "payment",
        titleFa: "بازگشت وجه",
        bodyFa: isWalletKind
          ? `مبلغ ${formatRials(input.amount)} به کیف پول شما بازگشت داده شد.`
          : `بازگشت وجه به مبلغ ${formatRials(input.amount)} ثبت شد.`,
        link: "/dashboard/wallet",
      },
    });

    // Report the ACTUAL derived balance so callers never see a
    // hypothetical value (V4 H-6 checkpoint read).
    const actualBalance = await latestBalanceFor(tx, order.userId);

    // M-04: the refund audit JOINS the transaction (critical) — one
    // refund converges on exactly one ledger event, one wallet mutation
    // and one durable audit row. Idempotent re-entries exited earlier
    // (duplicate) and never re-audit.
    await audit({
      userId: order.userId,
      actor: "admin",
      action: "wallet_refund",
      targetType: "order",
      targetId: order.id,
      ip: input.ip,
      tx,
      critical: true,
      meta: { adminId: input.adminId, amountRials: input.amount, balanceAfter: actualBalance, kind: order.kind },
    });

    return { balanceAfter: actualBalance, duplicate: false as const };
  });

  return { balanceRials: result.balanceAfter };
}

// ---------------------------------------------------------------------
// V4 H-6 — reconciliation + recovery capability
// ---------------------------------------------------------------------
export interface WalletIntegrityReport {
  userId: string;
  /** The derived balance per the latest row's checkpoint. */
  checkpointBalance: number;
  /** The exact sum over the append-only history (source of truth). */
  historySum: number;
  consistent: boolean;
  txnCount: number;
}

/**
 * Prove exact reconciliation: sum(append-only history) MUST equal the
 * latest row's balanceAfter checkpoint. Used by tests and by operators
 * to verify the checkpoint invariant on live data.
 */
export async function verifyWalletIntegrity(userId: string): Promise<WalletIntegrityReport> {
  const [txns, checkpointBalance] = await Promise.all([
    db.walletTxn.findMany({
      where: { userId },
      select: { amountRials: true, direction: true },
      orderBy: { id: "asc" },
    }),
    latestBalanceFor(db, userId),
  ]);
  let historySum = 0;
  for (const t of txns) historySum += t.direction === "credit" ? t.amountRials : -t.amountRials;
  return { userId, checkpointBalance, historySum, consistent: historySum === checkpointBalance, txnCount: txns.length };
}

/**
 * Recovery path (V4 H-6): recompute the balance from the append-only
 * history and repair the latest row's checkpoint when it diverges.
 * Runs inside a user-row-serialized transaction and writes a critical,
 * transaction-joined audit row so a repair can never happen silently.
 */
export async function rebuildWalletCheckpoint(userId: string, opts: { actorId: string; ip?: string } = { actorId: "system" }): Promise<WalletIntegrityReport & { repaired: boolean }> {
  const report = await db.$transaction(async (tx) => {
    // Lock the user row FIRST (same serialization contract as the write
    // paths — V4 H-6 snapshot ordering).
    await tx.user.update({ where: { id: userId }, data: { updatedAt: new Date() } });
    const txns = await tx.walletTxn.findMany({
      where: { userId },
      select: { id: true, amountRials: true, direction: true },
      orderBy: { id: "asc" },
    });
    let historySum = 0;
    for (const t of txns) historySum += t.direction === "credit" ? t.amountRials : -t.amountRials;
    const latest = txns.length > 0 ? txns[txns.length - 1] : null;
    const checkpointBalance = latest ? await latestBalanceFor(tx, userId) : 0;
    const consistent = historySum === checkpointBalance;
    let repaired = false;
    if (!consistent && latest) {
      await tx.walletTxn.update({
        where: { id: latest.id },
        data: { balanceAfter: historySum },
      });
      repaired = true;
    }
    await audit({
      userId,
      actor: "admin",
      action: "wallet_checkpoint_rebuild",
      targetType: "wallet",
      targetId: userId,
      ip: opts.ip,
      tx,
      critical: true,
      meta: {
        actorId: opts.actorId,
        historySum,
        previousCheckpoint: checkpointBalance,
        repaired,
        txnCount: txns.length,
      },
    });
    // Post-state: after a repair the checkpoint equals the history sum,
    // so the report reflects the (now consistent) end state.
    const finalBalance = repaired ? historySum : checkpointBalance;
    return { userId, checkpointBalance: finalBalance, historySum, consistent: historySum === finalBalance, txnCount: txns.length, repaired };
  });
  return report;
}
