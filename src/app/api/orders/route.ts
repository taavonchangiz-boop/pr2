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
    let created = false;
    if (kind === "subscription") {
      const r = await createOrderForSubscription({
        userId: user.id,
        planId: planId!,
        idempotencyKey: idemKey,
        provider,
      });
      order = r.order;
      created = r.created;
    } else if (kind === "wallet_credit") {
      const r = await createWalletCreditOrder({
        userId: user.id,
        amountRials: amount!,
        idempotencyKey: idemKey,
        provider,
      });
      order = r.order;
      created = r.created;
    } else {
      // ad_campaign — handled by /api/ads endpoints (price = amount)
      return NextResponse.json(
        { errorFa: "سفارش کمپین تبلیغاتی از طریق /api/ads ثبت می‌شود." },
        { status: 400 },
      );
    }

    // If a discount code is provided, validate it and APPLY the server-
    // computed discounted amount to the order (audit §12/§16: preview and
    // final charge must not have separate trusted amounts).
    //
    // P1.8 ROOT-CAUSE FIX: the discount path runs ONLY when this request
    // actually CREATED the order. The previous code ran it on idempotent
    // replays too — the replay re-applied the discount on the already-
    // discounted amount, and when the per-user usage row rejected the
    // second insert, the route DELETED the (possibly already paid!) order
    // via the stray-order cleanup. Replay of an order-creation request is
    // now a pure no-op for discounts.
    //
    // The discounted amount and the usage row now commit in ONE
    // transaction (recordUsage accepts the caller's tx), so a crash can
    // never leave an order charged at the wrong amount relative to the
    // consumed usage.
    let discountPreview: { amountOff: number; newAmount: number } | null = null;
    if (discountCode && created && order.amountRials > 0) {
      const v = await validateAndApply({
        code: discountCode,
        userId: user.id,
        planId: planId,
        orderAmount: order.amountRials,
      });
      if (!v.ok) {
        // Invalid code ⇒ refuse order creation (never create a stray
        // pending order with a bad code).
        return NextResponse.json({ errorFa: v.errorFa }, { status: 400 });
      }
      if (v.ok && v.discountId && v.amountOff !== undefined && v.newAmount !== undefined) {
        const used = await db.$transaction(async (tx) => {
          const u = await recordUsage({
            discountId: v.discountId!,
            userId: user.id,
            orderId: order.id,
            ip,
            tx,
          });
          if (!u.ok) return u;
          const updatedOrder = await tx.order.update({
            where: { id: order.id },
            data: {
              amountRials: v.newAmount!,
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
          return { ok: true } as const;
        });
        if (!used.ok) {
          // Race lost (cap reached concurrently / per-user limit / replay)
          // → remove only the order THIS request created.
          await db.order.delete({ where: { id: order.id } }).catch(() => undefined);
          return NextResponse.json({ errorFa: used.errorFa }, { status: 400 });
        }
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
