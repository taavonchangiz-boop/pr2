// POSTYAR — GET /api/orders — list the caller's orders (paginated, ownership-scoped)
// POST  /api/orders — create a subscription or wallet-credit order
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser, clientIp, audit, AuthError } from "@/lib/server/auth";
import {
  createOrderForSubscription,
  createWalletCreditOrder,
} from "@/lib/payments/plans";
import { validateAndApply, recordUsage } from "@/lib/payments/discount";
import { randomToken } from "@/lib/security/crypto";
import { formatRials } from "@/lib/persian";

const KIND_FA: Record<string, string> = {
  subscription: "اشتراک",
  wallet_credit: "شارژ کیف پول",
  ad_campaign: "تبلیغات",
};

const PROVIDER_FA: Record<string, string> = {
  card: "کارت به کارت",
  bank: "درگاه بانکی",
  bale: "پرداخت با بله",
};

export async function GET(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get("pageSize") ?? "20") || 20));
  const statusFilter = url.searchParams.get("status") ?? undefined;
  const where = statusFilter
    ? { userId: user.id, status: statusFilter }
    : { userId: user.id };
  try {
    const [rows, total] = await Promise.all([
      db.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.order.count({ where }),
    ]);
    const orders = rows.map((o) => ({
      id: o.id,
      kind: o.kind,
      kindFa: KIND_FA[o.kind] ?? o.kind,
      amountRials: o.amountRials,
      amountFa: formatRials(o.amountRials),
      status: o.status,
      provider: o.provider,
      providerFa: o.provider ? (PROVIDER_FA[o.provider] ?? o.provider) : null,
      descriptionFa: o.descriptionFa,
      createdAt: o.createdAt.toISOString(),
    }));
    return NextResponse.json({ orders, total, page, pageSize });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "خطای داخلی.";
    return NextResponse.json({ errorFa: msg }, { status: 500 });
  }
}

const BodySchema = z.object({
  kind: z.enum(["subscription", "wallet_credit", "ad_campaign"]),
  planId: z.string().optional(),
  amount: z.number().int().positive().optional(),
  provider: z.enum(["card", "bank", "bale"]).optional(),
  discountCode: z.string().optional(),
  idempotencyKey: z.string().optional(),
}).refine(
  (v) => v.kind === "subscription" ? !!v.planId : (v.amount !== undefined),
  { message: "برای اشتراک planId و برای شارژ کیف پول amount الزامی است." },
);

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
  const { kind, planId, amount, provider, discountCode, idempotencyKey } = parsed.data;

  // Idempotency key — user may provide; if not, derive deterministically.
  const idemKey = idempotencyKey?.trim() || `order:${user.id}:${kind}:${planId ?? amount ?? "x"}:${randomToken(8)}`;

  try {
    let order;
    if (kind === "subscription") {
      const r = await createOrderForSubscription({
        userId: user.id,
        planId: planId!,
        idempotencyKey: idemKey,
        provider,
      });
      order = r.order;
    } else if (kind === "wallet_credit") {
      const r = await createWalletCreditOrder({
        userId: user.id,
        amountRials: amount!,
        idempotencyKey: idemKey,
        provider,
      });
      order = r.order;
    } else {
      // ad_campaign — handled by /api/ads endpoints (price = amount)
      return NextResponse.json(
        { errorFa: "سفارش کمپین تبلیغاتی از طریق /api/ads ثبت می‌شود." },
        { status: 400 },
      );
    }

    // If a discount code is provided, validate it and APPLY the server-
    // computed discounted amount to the order (audit §12/§16: preview and
    // final charge must not have separate trusted amounts — previously the
    // preview showed a lower amount while every provider charged the FULL
    // stored amount, and discount usage was never recorded anywhere).
    // Usage is recorded transactionally HERE, tied to the order id, so a
    // concurrent redemption race can never over-consume maxUses.
    let discountPreview: { amountOff: number; newAmount: number } | null = null;
    if (discountCode && order.amountRials > 0) {
      const v = await validateAndApply({
        code: discountCode,
        userId: user.id,
        planId: planId,
        orderAmount: order.amountRials,
      });
      if (!v.ok) {
        // Invalid code ⇒ refuse order creation (previously the invalid code
        // produced 400 AFTER creating a stray pending order).
        return NextResponse.json({ errorFa: v.errorFa }, { status: 400 });
      }
      if (v.ok && v.discountId && v.amountOff !== undefined && v.newAmount !== undefined) {
        // Record usage first (atomic cap enforcement). If the race is lost
        // (cap reached concurrently / per-user limit), remove the stray
        // pending order and refuse.
        const used = await recordUsage({
          discountId: v.discountId,
          userId: user.id,
          orderId: order.id,
          ip,
        });
        if (!used.ok) {
          await db.order.delete({ where: { id: order.id } }).catch(() => undefined);
          return NextResponse.json({ errorFa: used.errorFa }, { status: 400 });
        }
        const updatedOrder = await db.order.update({
          where: { id: order.id },
          data: {
            amountRials: v.newAmount,
            metadata: JSON.stringify({
              discountCode: discountCode.trim().toUpperCase(),
              discountId: v.discountId,
              amountOffRials: v.amountOff,
              originalAmountRials: order.amountRials,
            }),
          },
        });
        order = {
          id: updatedOrder.id,
          amountRials: updatedOrder.amountRials,
          status: updatedOrder.status,
          descriptionFa: updatedOrder.descriptionFa,
        };
        discountPreview = { amountOff: v.amountOff, newAmount: v.newAmount };
      }
    }

    await audit({
      userId: user.id,
      actor: "user",
      action: "order_created",
      targetType: "order",
      targetId: order.id,
      ip,
      meta: { kind, amountRials: order.amountRials, planId, provider, discountCode },
    });
    return NextResponse.json({ ok: true, order, discount: discountPreview }, { status: 201 });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ errorFa: e.message }, { status: e.status });
    }
    const msg = e instanceof Error ? e.message : "خطای داخلی.";
    return NextResponse.json({ errorFa: msg }, { status: 500 });
  }
}
