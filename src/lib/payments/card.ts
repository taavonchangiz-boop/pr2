// =====================================================================
// POSTYAR — Card-to-card payment provider
// ---------------------------------------------------------------------
// Card-to-card = manual receipt upload + admin approve/reject flow.
// Sensitive: receipt files MUST live in private storage (Task 4-A).
// Admin downloads via auth-gated /api/media/[id] (already provided by Task 4-A).
// Card-to-card receipts NEVER served from public web root.
// Money: INTEGER Rial. NO floats.
// =====================================================================
import { db } from "@/lib/db";
import { audit, AuthError } from "@/lib/server/auth";
import { formatRials } from "@/lib/persian";
import type {
  PaymentProvider,
  CreatePaymentRequestResult,
  VerifyAndFinalizeResult,
  OrderLike,
} from "@/lib/payments/engine";
import { activateSubscription } from "@/lib/payments/plans";

// ---------------------------------------------------------------------
// createPaymentRequest — for card-to-card, we show the available bank cards
// ---------------------------------------------------------------------
export async function cardCreatePaymentRequest(input: {
  order: OrderLike;
}): Promise<CreatePaymentRequestResult> {
  // Mark the order as awaiting_payment and link destination cards.
  await db.order.update({
    where: { id: input.order.id },
    data: { status: "awaiting_payment", provider: "card" },
  });
  // Get all active admin-configured destination bank cards (shared across users)
  const cards = await db.bankCard.findMany({
    where: { active: true },
    orderBy: { createdAt: "desc" },
  });
  return {
    providerRef: `card:${input.order.id}`,
    view: {
      bankCards: cards.map((c) => ({
        id: c.id,
        cardNumberMask: c.cardNumberMask,
        holderName: c.holderName,
        bankName: c.bankName,
      })),
      amountRials: input.order.amountRials,
      amountFa: formatRials(input.order.amountRials),
      descriptionFa: input.order.descriptionFa,
    },
  };
}

// ---------------------------------------------------------------------
// Submit a receipt — user uploads via /api/media-upload then posts mediaId
// ---------------------------------------------------------------------
export async function submitCardReceipt(input: {
  orderId: string;
  mediaId: string;
  userId: string;
  ip?: string;
}): Promise<{ receiptId: string; status: string }> {
  const order = await db.order.findUnique({ where: { id: input.orderId } });
  if (!order) throw new AuthError("سفارش یافت نشد.", 404);
  if (order.userId !== input.userId) throw new AuthError("دسترسی غیرمجاز.", 403);
  if (order.provider && order.provider !== "card") {
    throw new AuthError("این سفارش برای پرداخت کارت‌به‌کارت نیست.", 400);
  }
  if (order.status === "paid") {
    throw new AuthError("این سفارش قبلاً پرداخت شده است.", 400);
  }
  if (order.status === "rejected") {
    throw new AuthError("این سفارش رد شده است. سفارش جدید ثبت کنید.", 400);
  }
  // Restrict receipt submission to genuinely payable states — a
  // failed/expired/cancelled order must not be resurrected into
  // awaiting_review.
  if (order.status !== "pending" && order.status !== "awaiting_payment" && order.status !== "awaiting_review") {
    throw new AuthError("این سفارش در وضعیت قابل پرداختی نیست.", 400);
  }
  const media = await db.media.findUnique({ where: { id: input.mediaId } });
  if (!media) throw new AuthError("فایل رسید یافت نشد.", 404);
  if (media.ownerId !== input.userId) throw new AuthError("دسترسی غیرمجاز به فایل.", 403);

  // Each order has at most ONE CardTransferReceipt row (UNIQUE orderId)
  const existing = await db.cardTransferReceipt.findUnique({
    where: { orderId: order.id },
  });
  if (existing && existing.status === "approved") {
    throw new AuthError("رسید این سفارش قبلاً تأیید شده است.", 400);
  }
  let receipt;
  if (existing) {
    // Update with new media path (replace previous receipt)
    receipt = await db.cardTransferReceipt.update({
      where: { id: existing.id },
      data: {
        storagePath: media.storagePath,
        publicId: media.publicId,
        status: "pending",
        reviewedBy: null,
        reviewedAt: null,
        adminNotes: null,
      },
    });
    // Move order back to awaiting_review
    await db.order.update({
      where: { id: order.id },
      data: { status: "awaiting_review" },
    });
  } else {
    receipt = await db.cardTransferReceipt.create({
      data: {
        orderId: order.id,
        storagePath: media.storagePath,
        publicId: media.publicId,
        status: "pending",
      },
    });
    await db.order.update({
      where: { id: order.id },
      data: { status: "awaiting_review" },
    });
  }
  await audit({
    userId: input.userId,
    actor: "user",
    action: "card_receipt_submitted",
    targetType: "order",
    targetId: order.id,
    ip: input.ip,
    meta: { mediaId: input.mediaId, receiptId: receipt.id },
  });
  return { receiptId: receipt.id, status: receipt.status };
}

// ---------------------------------------------------------------------
// Admin approve — atomic $transaction with hard amount check
// ---------------------------------------------------------------------
export async function adminApproveCardOrder(input: {
  orderId: string;
  adminId: string;
  ip?: string;
  notes?: string;
}): Promise<{ ok: boolean; paidRials: number; subscriptionId?: string }> {
  const order = await db.order.findUnique({
    where: { id: input.orderId },
    include: { cardReceipt: true },
  });
  if (!order) throw new AuthError("سفارش یافت نشد.", 404);
  if (!order.cardReceipt) {
    throw new AuthError("رسید برای این سفارش ثبت نشده است.", 400);
  }
  if (order.cardReceipt.status === "approved") {
    return { ok: true, paidRials: order.amountRials };
  }

  // Idempotency key for the order-paid event
  const idemKey = `card:approve:${order.id}`;
  // M-3 ROOT-CAUSE FIX — FULFILLMENT BEFORE RECEIPT CAS. The previous
  // order (receipt CAS first, fulfillment second) let a rejected order be
  // flipped to receipt=approved by a concurrent approve that had passed
  // its pre-check, after which activateSubscription refused the non-
  // payable order and the retry path faked success with nothing
  // fulfilled. Now:
  //   1. activateSubscription (the single owner of order→paid + ledger +
  //      wallet + subscription + referral) runs FIRST — it is internally
  //      idempotent (orderId-keyed upserts + the per-order subscription
  //      fulfillment marker) and REJECTS non-payable orders loudly. No
  //      receipt state is touched unless fulfillment actually succeeded.
  //   2. Only then is the receipt CAS'd to approved (bounded by the same
  //      idempotency: a concurrent approve losing this CAS still reports
  //      the already-fulfilled truth).
  // A crash between the two steps leaves receipt=rejected + order=paid;
  // the retry reaches step 1 (idempotent heal) and then completes step 2.
  const result = await activateSubscription({
    orderId: order.id,
    paidRials: order.amountRials,
    idempotencyKey: idemKey,
  });
  const receiptUpdate = await db.cardTransferReceipt.updateMany({
    where: { orderId: order.id, status: { not: "approved" } },
    data: {
      status: "approved",
      reviewedBy: input.adminId,
      reviewedAt: new Date(),
      adminNotes: input.notes ?? null,
    },
  });
  const firstApprove = receiptUpdate.count === 1;

  // Notify + audit only on the first approve (no duplicate spam).
  // P0.7.7: notification/audit delivery must never invalidate the financial
  // success already committed above — failures are logged, not thrown.
  if (firstApprove) {
    try {
      await db.notification.create({
      data: {
        userId: order.userId,
        category: "payment",
        titleFa: "تأیید رسید پرداخت",
        bodyFa:
          `پرداخت سفارش شما به مبلغ ${formatRials(order.amountRials)} تأیید شد.` +
          (order.kind === "subscription" && result.subscriptionId
            ? " اشتراک شما فعال شد."
            : ""),
        link: "/dashboard/orders",
      },
    });

      await audit({
        userId: order.userId,
        actor: "admin",
        action: "order_approve",
        targetType: "order",
        targetId: order.id,
        ip: input.ip,
        meta: {
          adminId: input.adminId,
          amountRials: order.amountRials,
          receiptId: order.cardReceipt.id,
          subscriptionId: result.subscriptionId,
        },
      });
    } catch (err) {
      console.error(
        "card approve notification/audit failed (financial effects already committed):",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return {
    ok: true,
    paidRials: order.amountRials,
    subscriptionId: result.subscriptionId || undefined,
  };
}

// ---------------------------------------------------------------------
// Admin reject — atomic order.status=`rejected`
// ---------------------------------------------------------------------
export async function adminRejectCardOrder(input: {
  orderId: string;
  adminId: string;
  ip?: string;
  notes?: string;
}): Promise<{ ok: boolean }> {
  // P1.9 — approve/reject race-safety: the paid-check AND the receipt-state
  // check are re-validated INSIDE the transaction, so an approve completing
  // concurrently can never be flipped into a contradictory
  // (receipt-approved + order-rejected) state.
  await db.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      include: { cardReceipt: true },
    });
    if (!order) throw new AuthError("سفارش یافت نشد.", 404);
    if (order.status === "paid") {
      throw new AuthError("سفارش قبلاً پرداخت شده و قابل رد نیست.", 400);
    }
    if (order.cardReceipt && order.cardReceipt.status === "approved") {
      throw new AuthError("رسید این سفارش تأیید شده و قابل رد نیست.", 400);
    }
    const rejected = await tx.order.updateMany({
      where: { id: order.id, status: { not: "paid" } },
      data: { status: "rejected" },
    });
    if (rejected.count === 0) {
      throw new AuthError("سفارش قبلاً پرداخت شده و قابل رد نیست.", 400);
    }
    if (order.cardReceipt) {
      await tx.cardTransferReceipt.update({
        where: { id: order.cardReceipt.id },
        data: {
          status: "rejected",
          reviewedBy: input.adminId,
          reviewedAt: new Date(),
          adminNotes: input.notes ?? null,
        },
      });
    }
  });

  await db.notification.create({
    data: {
      userId: (
        await db.order.findUnique({ where: { id: input.orderId }, select: { userId: true } })
      )?.userId ?? "",
      category: "payment",
      titleFa: "رد رسید پرداخت",
      bodyFa:
        `رسید پرداخت شما برای سفارش رد شد.` +
        (input.notes ? ` دلیل: ${input.notes}` : ""),
      link: "/dashboard/orders",
    },
  }).catch((err: unknown) => {
    console.error("reject notification failed:", err instanceof Error ? err.message : err);
  });

  await audit({
    userId: (await db.order.findUnique({ where: { id: input.orderId }, select: { userId: true } }))?.userId ?? null,
    actor: "admin",
    action: "order_reject",
    targetType: "order",
    targetId: input.orderId,
    ip: input.ip,
    meta: { adminId: input.adminId, notes: input.notes },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------
// Provider shim — implements PaymentProvider interface
// ---------------------------------------------------------------------
export type CardProvider = PaymentProvider;

export function getCardProvider(): CardProvider {
  return {
    kind: "card",
    async createPaymentRequest({ order }) {
      return cardCreatePaymentRequest({ order });
    },
    async verifyAndFinalize() {
      // Card-to-card has no server-side webhook; admin triggers the finalization.
      return { ok: false, errorFa: "تأیید نهایی فقط از طریق مدیر انجام می‌شود." };
    },
  };
}
