// =====================================================================
// POSTYAR — Wallet + Ledger (append-only, derived balance)
// ---------------------------------------------------------------------
// Money: INTEGER Rial minor units. NO floats.
// All mutations are atomic via Prisma $transaction with deterministic
// idempotency keys. Balance is DERIVED from WalletTxn sum — never a
// mutable balance column.
// Persian error strings only.
// =====================================================================
import { db } from "@/lib/db";
import { audit } from "@/lib/server/auth";
import { formatRials } from "@/lib/persian";
import type { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------
// Read-side: balance + history
// ---------------------------------------------------------------------
export async function getBalance(userId: string): Promise<{ balanceRials: number; balanceFa: string }> {
  const txns = await db.walletTxn.findMany({
    where: { userId },
    select: { amountRials: true, direction: true },
  });
  let bal = 0;
  for (const t of txns) bal += t.direction === "credit" ? t.amountRials : -t.amountRials;
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
    // Idempotency check first: an existing row for this exact key means
    // this adjustment was already applied — do NOT create anything and
    // do NOT re-send the notification.
    const existing = await tx.walletTxn.findUnique({
      where: { idempotencyKey: walletIdemKey },
      select: { id: true },
    });
    if (!existing) {
      // Serialize concurrent wallet mutations for this user (C-04): the
      // row write on User takes the DB row lock (MariaDB InnoDB) so two
      // concurrent adjustments cannot interleave their read-modify-write
      // balance computations (SQLite's single writer already serializes).
      await tx.user.update({ where: { id: input.userId }, data: { updatedAt: new Date() } });
      const prev = await tx.walletTxn.findMany({
        where: { userId: input.userId },
        select: { amountRials: true, direction: true },
      });
      let running = 0;
      for (const t of prev) running += t.direction === "credit" ? t.amountRials : -t.amountRials;
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
    }

    // Always report the TRUE derived balance (addendum §8): recomputed
    // from the WalletTxn sum inside the same transaction.
    const postTxns = await tx.walletTxn.findMany({
      where: { userId: input.userId },
      select: { amountRials: true, direction: true },
    });
    let actualBalance = 0;
    for (const t of postTxns) actualBalance += t.direction === "credit" ? t.amountRials : -t.amountRials;

    // M-04: the wallet-adjust audit JOINS the transaction (critical) —
    // the money move and its audit trail commit atomically; a failed
    // audit rolls the operation back and the idempotent retry heals.
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
        balanceAfter: actualBalance,
      },
    });

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
  const walletIdemKey = `wallet:refund:${input.idempotencyKey}`;
  const ledgerIdemKey = `ledger:refund:${input.idempotencyKey}`;

  // C-03 — the ONE-REFUND-PER-ORDER invariant is now enforced by the
  // DATABASE, not by a countable query. LedgerEntry.refundKey is a UNIQUE
  // nullable column; the refund row carries `refund:<orderId>` so two
  // concurrent refund transactions for the same order can never both
  // commit — the loser observes the UNIQUE violation and converges on the
  // winner's already-committed refund (exact idempotency on replay).
  const refundInvariantKey = `refund:${order.id}`;

  const computeBalance = async (tx: Prisma.TransactionClient): Promise<number> => {
    const txns = await tx.walletTxn.findMany({
      where: { userId: order.userId },
      select: { amountRials: true, direction: true },
    });
    let bal = 0;
    for (const t of txns) bal += t.direction === "credit" ? t.amountRials : -t.amountRials;
    return bal;
  };

  const result = await db.$transaction(async (tx) => {
    // Idempotent re-entry: an existing ledger row for this exact key means
    // this refund was already applied — report the true balance, change
    // nothing.
    const existingLedger = await tx.ledgerEntry.findUnique({
      where: { idempotencyKey: ledgerIdemKey },
      select: { id: true },
    });
    if (existingLedger) {
      return { balanceAfter: await computeBalance(tx), duplicate: true as const };
    }

    let balanceAfter = 0;
    if (isWalletKind) {
      // Serialize concurrent wallet mutations for this user, then apply the
      // balance guard BEFORE any write: derived balance must never go
      // negative; throwing rolls the whole transaction back.
      await tx.user.update({ where: { id: order.userId }, data: { updatedAt: new Date() } });
      const running = await computeBalance(tx);
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
        return { balanceAfter: await computeBalance(tx), duplicate: true as const };
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

    // Recompute the ACTUAL derived balance so callers never see a
    // hypothetical value (addendum §8).
    const postTxns = await tx.walletTxn.findMany({
      where: { userId: order.userId },
      select: { amountRials: true, direction: true },
    });
    let actualBalance = 0;
    for (const t of postTxns) actualBalance += t.direction === "credit" ? t.amountRials : -t.amountRials;

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
