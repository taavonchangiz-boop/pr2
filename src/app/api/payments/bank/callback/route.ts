// POSTYAR — GET /api/payments/bank/callback — bank gateway callback
// Verifies state HMAC; verifies amount server-side; finalizes the order.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientIp, audit } from "@/lib/server/auth";
import { getBankProvider } from "@/lib/payments/bank";

export async function GET(req: Request) {
  const ip = clientIp(req);
  const url = new URL(req.url);
  const orderId = url.searchParams.get("order") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const authority = url.searchParams.get("authority") ?? url.searchParams.get("Authority") ?? "";
  const status = url.searchParams.get("status") ?? "";

  if (!orderId || !state || !authority) {
    return NextResponse.json(
      { errorFa: "پارامترهای کالبک ناقص است." },
      { status: 400 },
    );
  }
  // Verify state HMAC (signed-token anti-forgery)
  if (!getBankProvider().verifyStateToken(orderId, state)) {
    await audit({
      actor: "webhook",
      action: "bank_callback_state_invalid",
      targetType: "order",
      targetId: orderId,
      ip,
      meta: { authority },
    });
    return NextResponse.json({ errorFa: "توکن state نامعتبر یا منقضی است." }, { status: 403 });
  }
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) {
    return NextResponse.json({ errorFa: "سفارش یافت نشد." }, { status: 404 });
  }

  // If the bank reports the user did NOT pay successfully, redirect with a failure notice.
  // The failed transition is CAS-guarded: a late failure callback must never
  // clobber an order that was already verified and marked `paid`.
  if (status && status !== "OK" && status !== "ok" && status !== "100" && status !== "1") {
    const failed = await db.order.updateMany({
      where: { id: orderId, status: { in: ["pending", "awaiting_payment", "awaiting_review"] } },
      data: { status: "failed" },
    });
    if (failed.count === 0) {
      // Already paid/fulfilled — do not downgrade; surface success path.
      return NextResponse.redirect(new URL("/dashboard/payments?status=ok", url.origin));
    }
    await audit({
      userId: order.userId,
      actor: "provider",
      action: "bank_callback_failed_status",
      targetType: "order",
      targetId: orderId,
      ip,
      meta: { status, authority },
    });
    return NextResponse.redirect(new URL("/dashboard/payments?status=failed", url.origin));
  }

  // Finalize — hard amount verification happens inside verifyAndFinalize
  const result = await getBankProvider().bankVerifyAndFinalize({
    order: {
      id: order.id,
      userId: order.userId,
      kind: order.kind,
      amountRials: order.amountRials,
      descriptionFa: order.descriptionFa,
      status: order.status,
    },
    authority,
    status,
    ip,
  });
  if (!result.ok) {
    return NextResponse.redirect(
      new URL(`/dashboard/payments?status=failed&reason=${encodeURIComponent(result.errorFa ?? "")}`, url.origin),
    );
  }
  return NextResponse.redirect(new URL("/dashboard/payments?status=ok", url.origin));
}
