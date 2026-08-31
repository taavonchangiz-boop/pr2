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
      const prev = await tx.walletTxn.findMany({
        where: { userId: input.userId },
        select: { amountRials: true, direction: true },
      });
      let running = 0;
      for (const t of prev) running += t.direction === "credit" ? t.amountRials : -t.amountRials;
      const balanceAfter = running + (direction === "credit" ? amountAbs : -amountAbs);

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
    return { balanceAfter: actualBalance };
  });

  await audit({
    userId: input.userId,
    actor: "admin",
    action: "wallet_adjust",
    targetType: "wallet",
    targetId: input.userId,
    ip: input.ip,
    meta: {
      adminId: input.adminId,
      direction,
      amountRials: amountAbs,
      reason: input.reason,
      balanceAfter: result.balanceAfter,
    },
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

  const walletIdemKey = `wallet:refund:${input.idempotencyKey}`;
  const ledgerIdemKey = `ledger:refund:${input.idempotencyKey}`;

  const result = await db.$transaction(async (tx) => {
    // Idempotent re-entry: an existing row for this exact key means this
    // refund was already applied — report the true balance, change nothing.
    const existing = await tx.walletTxn.findUnique({
      where: { idempotencyKey: walletIdemKey },
      select: { id: true },
    });
    if (existing) {
      const txns = await tx.walletTxn.findMany({
        where: { userId: order.userId },
        select: { amountRials: true, direction: true },
      });
      let bal = 0;
      for (const t of txns) bal += t.direction === "credit" ? t.amountRials : -t.amountRials;
      return { balanceAfter: bal, duplicate: true as const };
    }

    // Create the debit FIRST: the INSERT takes the database write lock,
    // which serializes this refund against any concurrent refund/credit
    // for the remainder of the transaction (audit §14/§36 — the old
    // code ran its balance guard as a check-then-act OUTSIDE the
    // transaction, so two concurrent refunds could both pass).
    const prev = await tx.walletTxn.findMany({
      where: { userId: order.userId },
      select: { amountRials: true, direction: true },
    });
    let running = 0;
    for (const t of prev) running += t.direction === "credit" ? t.amountRials : -t.amountRials;
    const balanceAfter = running - input.amount;

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

    // Invariant (audit §14): ONE refund per order. With the write lock
    // already held, this count is serialized — a second refund for the
    // same order under a different key rolls back here.
    const refundCount = await tx.walletTxn.count({
      where: { orderId: order.id, reason: "refund" },
    });
    if (refundCount > 1) {
      throw new Error("این سفارش قبلاً یک بازگشت وجه داشته است.");
    }

    // Balance guard INSIDE the transaction: derived balance must never
    // go negative. Throwing rolls back the debit created above.
    if (balanceAfter < 0) {
      throw new Error("موجودی کیف پول برای بازگشت این مبلغ کافی نیست.");
    }

    await tx.ledgerEntry.create({
      data: {
        userId: order.userId,
        orderId: order.id,
        eventType: "refund",
        amountRials: -input.amount,
        currency: "IRR",
        idempotencyKey: ledgerIdemKey,
      },
    });
    await tx.notification.create({
      data: {
        userId: order.userId,
        category: "payment",
        titleFa: "بازگاشت وجه",
        bodyFa: `مبلغ ${formatRials(input.amount)} به کیف پول شما بازگشت داده شد.`,
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
    return { balanceAfter: actualBalance, duplicate: false as const };
  });

  if (!result.duplicate) {
    await audit({
      userId: order.userId,
      actor: "admin",
      action: "wallet_refund",
      targetType: "order",
      targetId: order.id,
      ip: input.ip,
      meta: { adminId: input.adminId, amountRials: input.amount, balanceAfter: result.balanceAfter },
    });
  }
  return { balanceRials: result.balanceAfter };
}
