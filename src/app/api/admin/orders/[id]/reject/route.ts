// POSTYAR — POST /api/admin/orders/[id]/reject (admin only)
// ---------------------------------------------------------------------
// Manual admin rejection for ANY order (card / bank / bale). Marks the
// order `rejected`, stores the reason (and any admin notes) inside the
// order's `metadata` JSON column under the `rejection` key, marks the
// card receipt as rejected when present, notifies the user, and writes
// an audit log.
//
// Idempotency:
//   - Refuses to reject an already-`paid` order (cannot undo fulfillment).
//   - If the order is already `rejected`, returns success idempotently
//     (no duplicate notification/audit) but updates the reason if a new
//     reason is provided.
//
// Required role: admin (enforced via `requireRole(["admin"])`).
// ---------------------------------------------------------------------
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole, clientIp, audit, AuthError, safeJsonParse } from "@/lib/server/auth";
import { formatRials } from "@/lib/persian";

type Params = { params: Promise<{ id: string }> };

const BodySchema = z.object({
  reason: z.string().max(500).optional(),
  notes: z.string().max(500).optional(),
});

export async function POST(req: Request, { params }: Params) {
  let user;
  try {
    user = await requireRole(["admin"]);
  } catch (e) {
    return NextResponse.json(
      { errorFa: (e as AuthError).message },
      { status: (e as AuthError).status },
    );
  }
  const ip = clientIp(req);
  const { id } = await params;

  let body: unknown = {};
  try { body = await req.json(); } catch { /* allow empty */ }
  const parsed = BodySchema.safeParse(body);
  // Accept either `reason` (preferred) or legacy `notes`.
  const reason = parsed.success
    ? (parsed.data.reason?.trim() || parsed.data.notes?.trim() || "")
    : "";

  try {
    const order = await db.order.findUnique({
      where: { id },
      include: { cardReceipt: true },
    });
    if (!order) {
      return NextResponse.json({ errorFa: "سفارش یافت نشد." }, { status: 404 });
    }

    // Refuse to reject an already-paid order.
    if (order.status === "paid") {
      return NextResponse.json(
        { errorFa: "سفارش قبلاً پرداخت شده و قابل رد نیست." },
        { status: 400 },
      );
    }

    // Idempotent: already rejected → update reason if provided, return ok.
    const alreadyRejected = order.status === "rejected";

    // ROOT-CAUSE FIX (audit TOCTOU): the paid-check above is a plain read;
    // an approve completing between that read and this write used to flip a
    // fully-fulfilled order to rejected. The conditional update re-checks
    // atomically and refuses to touch paid orders.
    //
    // V5 ordering fix — the CAS status write happens FIRST. The previous
    // order wrote the rejection metadata BEFORE the CAS, so a lost race
    // (the CAS returning count === 0 because the order had just been paid)
    // left a rejection note appended to a now-PAID order's metadata. Now
    // metadata/audit are written ONLY after a won CAS.
    const rejected = await db.order.updateMany({
      where: { id: order.id, status: { not: "paid" } },
      data: { status: "rejected" },
    });
    if (rejected.count === 0) {
      return NextResponse.json(
        { errorFa: "سفارش قبلاً پرداخت شده و قابل رد نیست." },
        { status: 400 },
      );
    }

    // Persist rejection details in the order metadata JSON (CAS won — the
    // order is now `rejected`, never `paid`).
    const existingMeta = safeJsonParse<Record<string, unknown>>(order.metadata, {});
    const rejection = {
      at: new Date().toISOString(),
      by: user.id,
      reason: reason || null,
    };
    const prevRejections = Array.isArray(existingMeta.rejections)
      ? (existingMeta.rejections as Array<unknown>)
      : [];
    const nextMeta = {
      ...existingMeta,
      // The "current" reason for the UI to surface quickly.
      rejectionReason: reason || (existingMeta.rejectionReason ?? null),
      rejections: alreadyRejected ? prevRejections : [...prevRejections, rejection],
    };
    await db.order.update({
      where: { id: order.id },
      data: {
        metadata: JSON.stringify(nextMeta),
      },
    });

    // Mark the card receipt rejected, if present.
    if (order.cardReceipt) {
      await db.cardTransferReceipt.update({
        where: { id: order.cardReceipt.id },
        data: {
          status: "rejected",
          reviewedBy: user.id,
          reviewedAt: new Date(),
          adminNotes: reason || null,
        },
      });
    }

    // Notify + audit only on the first rejection (idempotency).
    if (!alreadyRejected) {
      await db.notification.create({
        data: {
          userId: order.userId,
          category: "payment",
          titleFa: "رد سفارش",
          bodyFa:
            `سفارش شما به مبلغ ${formatRials(order.amountRials)} توسط مدیر رد شد.` +
            (reason ? ` دلیل: ${reason}` : " در صورت نیاز، با پشتیبانی تماس بگیرید."),
        },
      });
      await audit({
        userId: order.userId,
        actor: "admin",
        action: "order_reject",
        targetType: "order",
        targetId: order.id,
        ip,
        meta: {
          adminId: user.id,
          amountRials: order.amountRials,
          kind: order.kind,
          provider: order.provider,
          reason: reason || null,
        },
      });
    }

    return NextResponse.json({ ok: true, orderId: order.id, status: "rejected" });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ errorFa: e.message }, { status: e.status });
    }
    console.error("admin order reject failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ errorFa: "خطای داخلی در رد سفارش." }, { status: 500 });
  }
}
