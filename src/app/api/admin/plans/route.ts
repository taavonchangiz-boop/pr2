// POSTYAR — /api/admin/plans (GET, POST create plan — admin)
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole, clientIp, audit, AuthError, safeJsonParse } from "@/lib/server/auth";
import { db } from "@/lib/db";
import { formatRials, formatJalaliDate } from "@/lib/persian";
import {
  parsePlanFeatures,
  parsePlanQuota,
  findUnknownFeatureKeys,
  validatePlanQuotaFeatureConsistency,
  countEnabledFeatures,
  type PlanFeatures,
} from "@/lib/payments/plans";

export async function GET() {
  let user;
  try { user = await requireRole(["admin"]); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  void user;
  const rows = await db.plan.findMany({
    orderBy: [{ sortOrder: "asc" }, { priceRials: "asc" }],
    include: { _count: { select: { subscriptions: true } } },
  });
  return NextResponse.json({
    items: rows.map((p) => {
      const features = parsePlanFeatures(p.features);
      return {
        id: p.id,
        code: p.code,
        nameFa: p.nameFa,
        descriptionFa: p.descriptionFa,
        priceRials: p.priceRials,
        priceRialsFa: formatRials(p.priceRials),
        intervalMonths: p.intervalMonths,
        quota: safeJsonParse(p.quota || "{}", {}),
        features,
        featureCount: countEnabledFeatures(features),
        imageUrl: p.imageUrl,
        discountPct: p.discountPct ?? 0,
        renewalDiscountPct: p.renewalDiscountPct ?? 0,
        renewalDiscountWindowDays: p.renewalDiscountWindowDays ?? 0,
        sortOrder: p.sortOrder ?? 0,
        active: p.active,
        isPublic: p.isPublic,
        subscriptionCount: p._count.subscriptions,
        createdAt: p.createdAt.toISOString(),
        createdAtFa: formatJalaliDate(p.createdAt),
      };
    }),
  });
}

const PostSchema = z.object({
  code: z.string().min(2).max(40),
  nameFa: z.string().min(2).max(80),
  descriptionFa: z.string().max(800).optional(),
  priceRials: z.number().int().nonnegative(),
  intervalMonths: z.number().int().min(1).max(12),
  quota: z.record(z.string(), z.number()).optional(),
  features: z.record(z.string(), z.union([z.boolean(), z.number()])).optional(),
  imageUrl: z.string().max(2048).nullable().optional(),
  discountPct: z.number().int().min(0).max(100).optional(),
  renewalDiscountPct: z.number().int().min(0).max(100).optional(),
  renewalDiscountWindowDays: z.number().int().min(0).max(365).optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
  isPublic: z.boolean().optional(),
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
  const dup = await db.plan.findUnique({ where: { code: parsed.data.code } });
  if (dup) {
    return NextResponse.json({ errorFa: "این کد طرح قبلاً ثبت شده است." }, { status: 409 });
  }
  // M-02: reject unknown feature keys with an explicit 400.
  const unknown = findUnknownFeatureKeys((parsed.data.features ?? {}) as Record<string, unknown>);
  if (unknown.length > 0) {
    return NextResponse.json(
      { errorFa: `ویژگی(های) ناشناخته: ${unknown.join("، ")}` },
      { status: 400 },
    );
  }
  // M-02: strict quota validation/normalization.
  const quota = parsePlanQuota((parsed.data.quota ?? {}) as Record<string, unknown>);
  if (!quota.ok) return NextResponse.json({ errorFa: quota.errorFa }, { status: 400 });
  const features: PlanFeatures = parsePlanFeatures(
    parsed.data.features ? JSON.stringify(parsed.data.features) : "{}",
  );
  // V5 M-02 — MERGED combination check across BOTH write surfaces (the
  // POST path previously had NO combination check at all): a capability
  // toggled ON whose effective quota is 0 (via features OR the legacy
  // quota JSON) is rejected before any row is created.
  const impossible = validatePlanQuotaFeatureConsistency(features, quota.quota);
  if (impossible.length > 0) {
    return NextResponse.json(
      { errorFa: `ترکیب ناممکن ویژگی/سهمیه: ${impossible.join("، ")} — امکان فعال با سهمیهٔ صفر قابل ذخیره نیست.` },
      { status: 400 },
    );
  }
  const created = await db.plan.create({
    data: {
      code: parsed.data.code,
      nameFa: parsed.data.nameFa,
      descriptionFa: parsed.data.descriptionFa ?? "",
      priceRials: parsed.data.priceRials,
      intervalMonths: parsed.data.intervalMonths,
      quota: JSON.stringify(quota.quota),
      features: JSON.stringify(features),
      imageUrl: parsed.data.imageUrl ?? null,
      discountPct: parsed.data.discountPct ?? 0,
      renewalDiscountPct: parsed.data.renewalDiscountPct ?? 0,
      renewalDiscountWindowDays: parsed.data.renewalDiscountWindowDays ?? 0,
      sortOrder: parsed.data.sortOrder ?? 0,
      active: parsed.data.active ?? true,
      isPublic: parsed.data.isPublic ?? true,
    },
  });
  await audit({
    userId: user.id,
    actor: "admin",
    action: "plan_created",
    targetType: "plan",
    targetId: created.id,
    ip,
    meta: {
      code: parsed.data.code,
      priceRials: parsed.data.priceRials,
      discountPct: parsed.data.discountPct ?? 0,
      featureCount: countEnabledFeatures(features),
    },
  });
  return NextResponse.json({ ok: true, planId: created.id }, { status: 201 });
}
