// =====================================================================
// POSTYAR — Discount engine
// ---------------------------------------------------------------------
// Validates and applies discount codes atomically. Money: INTEGER Rial.
// Persian error strings only.
// Atomicity (P1.8): Discount.uses is incremented with a conditional UPDATE
// (row lock serializes concurrent redemptions); maxUses + perUserLimit +
// UNIQUE(orderId) are all enforced inside one transaction so failed
// redemptions leave NO writes behind.
// =====================================================================
import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { audit } from "@/lib/server/auth";
import { AuthError } from "@/lib/server/auth";
import { formatRials } from "@/lib/persian";

export interface ValidateDiscountInput {
  code: string;
  userId: string;
  planId?: string;
  orderAmount: number;
}

export interface ValidateDiscountResult {
  ok: boolean;
  discountId?: string;
  amountOff?: number;
  newAmount?: number;
  errorFa?: string;
}

export async function validateAndApply(
  input: ValidateDiscountInput,
): Promise<ValidateDiscountResult> {
  if (!input.code || typeof input.code !== "string") {
    return { ok: false, errorFa: "کد تخفیف الزامی است." };
  }
  if (!Number.isInteger(input.orderAmount) || input.orderAmount <= 0) {
    return { ok: false, errorFa: "مبلغ سفارش نامعتبر است." };
  }
  const code = input.code.trim().toUpperCase();
  const discount = await db.discount.findUnique({ where: { code } });
  if (!discount || !discount.active) {
    return { ok: false, errorFa: "کد تخفیف یافت نشد یا غیرفعال است." };
  }
  // Expiry
  if (discount.expiresAt && discount.expiresAt.getTime() < Date.now()) {
    return { ok: false, errorFa: "کد تخفیف منقضی شده است." };
  }
  // Total usage limit
  if (discount.maxUses > 0 && discount.uses >= discount.maxUses) {
    return { ok: false, errorFa: "سقف استفاده از این کد تکمیل شده است." };
  }
  // Per-user limit
  const userUsages = await db.discountUsage.count({
    where: { discountId: discount.id, userId: input.userId },
  });
  if (discount.perUserLimit > 0 && userUsages >= discount.perUserLimit) {
    return { ok: false, errorFa: "سقف استفاده از این کد برای شما تکمیل شده است." };
  }
  // Plan applicability
  if (input.planId) {
    const allowed = await db.discountPlan.findUnique({
      where: { discountId_planId: { discountId: discount.id, planId: input.planId } },
    });
    if (!allowed) {
      return { ok: false, errorFa: "این کد تخفیف برای طرح انتخاب‌شده قابل استفاده نیست." };
    }
  }
  // Compute amount off
  let amountOff = 0;
  if (discount.kind === "percent") {
    if (discount.value < 0 || discount.value > 100) {
      return { ok: false, errorFa: "درصد تخفیف نامعتبر است." };
    }
    amountOff = Math.round((input.orderAmount * discount.value) / 100);
    if (amountOff > input.orderAmount) amountOff = input.orderAmount;
  } else if (discount.kind === "fixed") {
    amountOff = Math.min(discount.value, input.orderAmount);
  } else {
    return { ok: false, errorFa: "نوع تخفیف نامعتبر است." };
  }
  const newAmount = input.orderAmount - amountOff;
  return {
    ok: true,
    discountId: discount.id,
    amountOff,
    newAmount,
  };
}

export async function recordUsage(input: {
  discountId: string;
  userId: string;
  orderId: string;
  adminId?: string;
  ip?: string;
  /** Optional transaction client — when supplied, usage recording joins the
   *  caller's transaction (used by order creation so the discounted amount
   *  and the usage row commit atomically). */
  tx?: Prisma.TransactionClient;
}): Promise<{ ok: boolean; errorFa?: string }> {
  /** Rejection signal — throwing forces the transaction to ROLL BACK the
   *  uses increment; returning {ok:false} would commit it. */
  class DiscountRejected extends Error {
    errorFa: string;
    constructor(errorFa: string) {
      super(errorFa);
      this.name = "DiscountRejected";
      this.errorFa = errorFa;
    }
  }

  const run = async (tx: Prisma.TransactionClient): Promise<{ ok: boolean }> => {
    // ATOMIC maxUses enforcement (audit §16): a conditional UPDATE whose
    // predicate re-checks the cap at the database level in the same
    // statement that increments. affected-rows 0 ⇒ the cap was reached
    // concurrently. Portable across SQLite/MariaDB.
    //
    // ORDER OF OPERATIONS (P1.8 — concurrency-safe per-user limits too):
    //   1. conditional uses-increment — TAKES THE DISCOUNT ROW LOCK, which
    //      serializes ALL concurrent redemptions of this code;
    //   2. per-user count check — now accurate (serialized by step 1) and
    //      works for perUserLimit > 1 (the old @@unique([discountId,userId])
    //      silently capped every user at exactly one redemption);
    //   3. usage INSERT — a rejection at step 2 or a UNIQUE(orderId)
    //      conflict here rolls back the whole transaction including the
    //      increment, leaving NO writes behind.
    const incremented = await tx.$executeRawUnsafe(
      `UPDATE "Discount" SET "uses" = "uses" + 1 WHERE "id" = ? AND ("maxUses" = 0 OR "uses" < "maxUses")`,
      input.discountId,
    );
    if (incremented === 0) {
      throw new DiscountRejected("سقف استفاده از این کد تکمیل شده است.");
    }

    const discount = await tx.discount.findUnique({
      where: { id: input.discountId },
    });
    if (!discount || !discount.active) {
      throw new DiscountRejected("کد تخفیف یافت نشد یا غیرفعال است.");
    }
    if (discount.expiresAt && discount.expiresAt.getTime() < Date.now()) {
      throw new DiscountRejected("کد تخفیف منقضی شده است.");
    }

    const userUsages = await tx.discountUsage.count({
      where: { discountId: input.discountId, userId: input.userId },
    });
    if (discount.perUserLimit > 0 && userUsages >= discount.perUserLimit) {
      throw new DiscountRejected("سقف استفاده از این کد برای شما تکمیل شده است.");
    }

    await tx.discountUsage.create({
      data: {
        discountId: input.discountId,
        userId: input.userId,
        orderId: input.orderId,
      },
    });
    return { ok: true };
  };

  try {
    if (input.tx) {
      // The audit row joins the caller's transaction (and never touches the
      // global client from inside an open tx — SQLite would deadlock).
      await run(input.tx);
      await audit({
        userId: input.userId,
        actor: input.adminId ? "admin" : "user",
        action: "discount_used",
        targetType: "discount",
        targetId: input.discountId,
        ip: input.ip,
        meta: { orderId: input.orderId, adminId: input.adminId },
        tx: input.tx,
      });
    } else {
      await db.$transaction(run);
      await audit({
        userId: input.userId,
        actor: input.adminId ? "admin" : "user",
        action: "discount_used",
        targetType: "discount",
        targetId: input.discountId,
        ip: input.ip,
        meta: { orderId: input.orderId, adminId: input.adminId },
      });
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof DiscountRejected) {
      return { ok: false, errorFa: err.errorFa };
    }
    const msg = (err as { code?: string; message?: string })?.message ?? "";
    if (/unique|constraint|UNIQUE/i.test(msg)) {
      // UNIQUE(orderId) — a usage row for this order already exists
      // (idempotent replay) or a concurrent redemption raced; the
      // increment above is rolled back with the transaction.
      return { ok: false, errorFa: "این کد تخفیف برای این سفارش قبلاً ثبت شده است." };
    }
    throw err;
  }
}

// Helper to compute a discount preview without applying it — for GET /api/discounts?code=…
export async function previewDiscount(input: {
  code: string;
  userId: string;
  planId?: string;
  amount: number;
}): Promise<ValidateDiscountResult & { code?: string; descriptionFa?: string }> {
  const res = await validateAndApply({
    code: input.code,
    userId: input.userId,
    planId: input.planId,
    orderAmount: input.amount,
  });
  if (!res.ok) return res;
  const discount = await db.discount.findUnique({ where: { id: res.discountId } });
  return {
    ...res,
    code: discount?.code,
    descriptionFa: discount
      ? (discount.kind === "percent"
          ? `تخفیف ${formatRials(res.amountOff ?? 0)} (${discount.value}٪)`
          : `تخفیف ${formatRials(res.amountOff ?? 0)}`)
      : undefined,
  };
}
