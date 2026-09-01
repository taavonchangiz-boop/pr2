// POSTYAR — /api/admin/discounts — GET list / POST create (admin only)
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole, clientIp, audit, AuthError } from "@/lib/server/auth";
import { formatJalaliDate, formatRials } from "@/lib/persian";

export async function GET() {
  let user;
  try { user = await requireRole(["admin"]); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  void user;
  const rows = await db.discount.findMany({
    include: { plans: true, _count: { select: { usages: true } } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({
    items: rows.map((d) => ({
      id: d.id,
      code: d.code,
      kind: d.kind,
      value: d.value,
      maxUses: d.maxUses,
      uses: d.uses,
      perUserLimit: d.perUserLimit,
      expiresAt: d.expiresAt?.toISOString() ?? null,
      expiresAtFa: d.expiresAt ? formatJalaliDate(d.expiresAt) : null,
      active: d.active,
      planIds: d.plans.map((p) => p.planId),
      usageCount: d._count.usages,
      valueFa: d.kind === "percent" ? `${d.value}٪` : formatRials(d.value),
    })),
  });
}

const PostSchema = z.object({
  code: z.string().min(3, "کد حداقل ۳ نویسه باشد.").max(40),
  kind: z.enum(["percent", "fixed"]),
  value: z.number().int().nonnegative(),
  maxUses: z.number().int().nonnegative().optional(),
  perUserLimit: z.number().int().positive().optional(),
  expiresAt: z.string().optional(),
  active: z.boolean().optional(),
  planIds: z.array(z.string()).optional(),
});

export async function POST(req: Request) {
  let user;
  try { user = await requireRole(["admin"]); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsed = PostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }
  if (parsed.data.kind === "percent" && parsed.data.value > 100) {
    return NextResponse.json({ errorFa: "درصد تخفیف نمی‌تواند بیش از ۱۰۰ باشد." }, { status: 400 });
  }
  const code = parsed.data.code.toUpperCase().trim();
  // Reject duplicate codes
  const dup = await db.discount.findUnique({ where: { code } });
  if (dup) {
    return NextResponse.json({ errorFa: "این کد قبلاً ثبت شده است." }, { status: 409 });
  }
  try {
    const created = await db.discount.create({
      data: {
        code,
        kind: parsed.data.kind,
        value: parsed.data.value,
        maxUses: parsed.data.maxUses ?? 0,
        perUserLimit: parsed.data.perUserLimit ?? 1,
        expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
        active: parsed.data.active ?? true,
        plans: parsed.data.planIds && parsed.data.planIds.length > 0
          ? { create: parsed.data.planIds.map((planId) => ({ planId })) }
          : undefined,
      },
      include: { plans: true },
    });
    await audit({
      userId: user.id,
      actor: "admin",
      action: "discount_created",
      targetType: "discount",
      targetId: created.id,
      ip,
      meta: { code, kind: parsed.data.kind, value: parsed.data.value },
    });
    return NextResponse.json({ ok: true, discount: created }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ errorFa: "خطای داخلی سرور." }, { status: 500 });
  }
}
