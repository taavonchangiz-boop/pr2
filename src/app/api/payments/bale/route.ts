// POSTYAR — POST /api/payments/bale — create a Bale wallet invoice
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser, clientIp, audit, AuthError } from "@/lib/server/auth";
import { getBaleProvider } from "@/lib/payments/bale";

const BodySchema = z.object({
  orderId: z.string().min(1),
  botId: z.string().min(1),
  chatId: z.string().min(1),
});

export async function POST(req: Request) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }
  const { orderId, botId, chatId } = parsed.data;

  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) {
    return NextResponse.json({ errorFa: "سفارش یافت نشد." }, { status: 404 });
  }
  if (order.userId !== user.id) {
    return NextResponse.json({ errorFa: "دسترسی غیرمجاز." }, { status: 403 });
  }
  if (order.status === "paid" || order.status === "awaiting_review") {
    return NextResponse.json({ errorFa: "این سفارش قابل پرداخت نیست." }, { status: 400 });
  }
  // Verify the bot belongs to the user (or admin)
  const bot = await db.bot.findUnique({ where: { id: botId } });
  if (!bot) {
    return NextResponse.json({ errorFa: "ربات یافت نشد." }, { status: 404 });
  }
  if (bot.ownerId !== user.id && user.role !== "admin") {
    return NextResponse.json({ errorFa: "دسترسی غیرمجاز به ربات." }, { status: 403 });
  }
  if (bot.provider !== "bale" || bot.status !== "active") {
    return NextResponse.json({ errorFa: "ربات بله فعال نیست." }, { status: 400 });
  }

  try {
    const r = await getBaleProvider().baleCreatePaymentRequest({
      order: {
        id: order.id,
        userId: order.userId,
        kind: order.kind,
        amountRials: order.amountRials,
        descriptionFa: order.descriptionFa,
        status: order.status,
      },
      botId,
      chatId,
    });
    if (!r.ok) {
      return NextResponse.json({ errorFa: r.errorFa }, { status: 422 });
    }
    await audit({
      userId: user.id,
      actor: "user",
      action: "bale_payment_request_created",
      targetType: "order",
      targetId: order.id,
      ip,
      meta: { botId, chatId, providerRef: r.providerRef },
    });
    return NextResponse.json({
      ok: true,
      invoicePayload: r.invoicePayload,
      botInvoiceUrl: r.botInvoiceUrl,
      providerRef: r.providerRef,
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ errorFa: e.message }, { status: e.status });
    }
    return NextResponse.json({ errorFa: "خطای داخلی سرور." }, { status: 500 });
  }
}
