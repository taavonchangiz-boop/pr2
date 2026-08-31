// POSTYAR — POST /api/admin/orders/[id]/approve (admin only)
// ---------------------------------------------------------------------
// Manual admin approval for ANY order (card / bank / bale). Marks the
// order `paid`, runs the existing fulfillment engine (`activateSubscription`
// from `lib/payments/plans` — which atomically grants the subscription
// or credits the wallet + creates LedgerEntry + WalletTxn + referral
// reward), notifies the user, and writes an audit log.
//
// Idempotency:
//   - If the order is already `paid`, returns success WITHOUT re-running
//     fulfillment (no double-credit, no duplicate LedgerEntry/WalletTxn).
//   - If the order is `rejected`, refuses approval (admin must reject→
//     pending→ approve by re-creating the order if needed).
//   - The card-receipt path (when `CardTransferReceipt` exists) is delegated
//     to `adminApproveCardOrder` from `lib/payments/card` which itself calls
//     `activateSubscription` under a $transaction with an idempotency key.
//   - For non-card orders (bank / bale awaiting manual verification), we
//     invoke `activateSubscription` with the deterministic idempotency key
//     `admin:approve:<orderId>` so a retry is a no-op.
//
// Required role: admin (enforced via `requireRole(["admin"])`).
// ---------------------------------------------------------------------
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole, clientIp, audit, AuthError, safeJsonParse } from "@/lib/server/auth";
import { adminApproveCardOrder } from "@/lib/payments/card";
import { activateSubscription } from "@/lib/payments/plans";
import { formatRials } from "@/lib/persian";

type Params = { params: Promise<{ id: string }> };

const BodySchema = z.object({
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
  const notes = parsed.success ? parsed.data.notes : undefined;

  try {
    // Load the order with all provider refs so we can decide the path.
    const order = await db.order.findUnique({
      where: { id },
      include: { cardReceipt: true, bankRef: true, baleRef: true, user: { select: { firstName: true, lastName: true } } },
    });
    if (!order) {
      return NextResponse.json({ errorFa: "سفارش یافت نشد." }, { status: 404 });
    }

    // Idempotent: already paid → return success without double-fulfilling.
    if (order.status === "paid") {
      return NextResponse.json({
        ok: true,
        idempotent: true,
        paidRials: order.amountRials,
        orderId: order.id,
        status: order.status,
      });
    }
    // Refuse if the order was rejected.
    if (order.status === "rejected") {
      return NextResponse.json(
        { errorFa: "این سفارش رد شده است. ابتدا باید وضعیت آن به «در انتظار» بازگردد." },
        { status: 400 },
      );
    }

    // Card-to-card path: delegate to the existing helper (it handles the
    // receipt status update + activateSubscription + notification + audit
    // atomically with the right idempotency key).
    if (order.cardReceipt) {
      const r = await adminApproveCardOrder({
        orderId: order.id,
        adminId: user.id,
        ip,
        notes,
      });
      return NextResponse.json({ ...r, ok: r.ok, orderId: order.id, status: "paid" });
    }

    // Non-card path (bank / bale awaiting manual verification, or generic
    // pending order). Run the fulfillment engine directly. The helper:
    //   - conditionally updates `order.status` to `paid` (so a retry is a no-op)
    //   - creates the LedgerEntry (idempotency key `ledger:payment:<id>`)
    //   - creates the WalletTxn credit (idempotency key `wallet:payment:<id>`)
    //   - activates the Subscription when `kind === "subscription"`
    //   - applies the referral reward (one-time per referred user)
    const idemKey = `admin:approve:${order.id}`;
    const result = await activateSubscription({
      orderId: order.id,
      paidRials: order.amountRials,
      idempotencyKey: idemKey,
    });

    // Append admin notes (if provided) to the order metadata, without
    // clobbering any existing keys. Use a deterministic key per approve
    // event so re-runs do not duplicate the note.
    if (notes && notes.trim()) {
      const existingMeta = safeJsonParse<Record<string, unknown>>(order.metadata, {});
      const prevNotes = Array.isArray(existingMeta.adminNotes)
        ? (existingMeta.adminNotes as Array<unknown>)
        : [];
      const nextNotes = [...prevNotes, { at: new Date().toISOString(), by: user.id, notes: notes.trim() }];
      await db.order.update({
        where: { id: order.id },
        data: { metadata: JSON.stringify({ ...existingMeta, adminNotes: nextNotes }) },
      });
    }

    // Notify the user.
    await db.notification.create({
      data: {
        userId: order.userId,
        category: "payment",
        titleFa: "تأیید پرداخت سفارش",
        bodyFa:
          `پرداخت سفارش شما به مبلغ ${formatRials(order.amountRials)} توسط مدیر تأیید شد.` +
          (order.kind === "subscription" && result.subscriptionId
            ? " اشتراک شما فعال شد."
            : order.kind === "wallet_credit"
              ? " مبلغ به کیف پول شما افزوده شد."
              : ""),
        link: "/wallet",
      },
    });

    await audit({
      userId: order.userId,
      actor: "admin",
      action: "order_approve",
      targetType: "order",
      targetId: order.id,
      ip,
      meta: {
        adminId: user.id,
        amountRials: order.amountRials,
        kind: order.kind,
        provider: order.provider,
        subscriptionId: result.subscriptionId || undefined,
        notes: notes ?? null,
      },
    });

    return NextResponse.json({
      ok: true,
      paidRials: order.amountRials,
      orderId: order.id,
      status: "paid",
      subscriptionId: result.subscriptionId || undefined,
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ errorFa: e.message }, { status: e.status });
    }
    // Generic message — never leak Prisma/driver internals to the client.
    console.error("admin order approve failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ errorFa: "خطای داخلی در تأیید سفارش." }, { status: 500 });
  }
}
