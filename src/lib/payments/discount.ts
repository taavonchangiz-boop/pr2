// =====================================================================
// POSTYAR — Discount engine
// ---------------------------------------------------------------------
// Validates and applies discount codes atomically. Money: INTEGER Rial.
// Persian error strings only.
// Atomicity: DiscountUsage(@@unique([discountId, userId])) enforces per-user
// limit; Discount.uses atomic increment with idempotency on orderId.
// =====================================================================
import { db } from "@/lib/db";
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
}): Promise<{ ok: boolean; errorFa?: string }> {
  try {
    const result = await db.$transaction(async (tx) => {
      // Re-validate INSIDE the transaction (audit §16): the previous
      // implementation trusted a pre-transaction validateAndApply() read,
      // so concurrent redemptions could drive `uses` past `maxUses`.
      const discount = await tx.discount.findUnique({
        where: { id: input.discountId },
      });
      if (!discount || !discount.active) {
        return { ok: false as const, errorFa: "کد تخفیف یافت نشد یا غیرفعال است." };
      }
      if (discount.expiresAt && discount.expiresAt.getTime() < Date.now()) {
        return { ok: false as const, errorFa: "کد تخفیف منقضی شده است." };
      }

      // ATOMIC maxUses enforcement (audit §16 — "unique user usage به‌تنهایی
      // سقف کلی maxUses را enforce نمی‌کند"): a conditional UPDATE whose
      // predicate re-checks the cap at the database level in the same
      // statement that increments. affected-rows 0 ⇒ the cap was reached
      // concurrently. The predicate is portable across SQLite/MariaDB.
      // Only the cuid `input.discountId` is interpolated (bound parameter)
      // — table/column identifiers are Prisma-mapped constants.
      //
      // ORDER OF CHECKS (both must leave NO writes behind on rejection):
      //   1. per-user count (read-only) — reject BEFORE any write;
      //   2. conditional uses-increment (single atomic write) — reject
      //      writes nothing;
      //   3. usage INSERT — a concurrent same-user redemption loses the
      //      UNIQUE([discountId,userId]) race and its THROWN error rolls
      //      back the whole transaction, including its increment.
      const userUsages = await tx.discountUsage.count({
        where: { discountId: input.discountId, userId: input.userId },
      });
      if (discount.perUserLimit > 0 && userUsages >= discount.perUserLimit) {
        return { ok: false as const, errorFa: "سقف استفاده از این کد برای شما تکمیل شده است." };
      }

      const incremented = await tx.$executeRawUnsafe(
        `UPDATE "Discount" SET "uses" = "uses" + 1 WHERE "id" = ? AND ("maxUses" = 0 OR "uses" < "maxUses")`,
        input.discountId,
      );
      if (incremented === 0) {
        return { ok: false as const, errorFa: "سقف استفاده از این کد تکمیل شده است." };
      }

      await tx.discountUsage.create({
        data: {
          discountId: input.discountId,
          userId: input.userId,
          orderId: input.orderId,
        },
      });
      return { ok: true as const };
    });
    if (!result.ok) return result;
    await audit({
      userId: input.userId,
      actor: input.adminId ? "admin" : "user",
      action: "discount_used",
      targetType: "discount",
      targetId: input.discountId,
      ip: input.ip,
      meta: { orderId: input.orderId, adminId: input.adminId },
    });
    return { ok: true };
  } catch (err) {
    const msg = (err as { code?: string; message?: string })?.message ?? "";
    if (/unique|constraint|UNIQUE/i.test(msg)) {
      // Race lost on the per-user usage insert — the increment above is
      // rolled back with the transaction, so `uses` stays consistent.
      return { ok: false, errorFa: "شما قبلاً از این کد تخفیف استفاده کرده‌اید." };
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
