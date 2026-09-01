// POSTYAR — /api/admin/plans/[id] (PATCH, DELETE — admin)
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole, clientIp, audit, AuthError } from "@/lib/server/auth";
import { db } from "@/lib/db";
import {
  parsePlanFeatures,
  parsePlanQuota,
  findUnknownFeatureKeys,
  type PlanFeatures,
} from "@/lib/payments/plans";

const PatchSchema = z.object({
  nameFa: z.string().min(2).max(80).optional(),
  descriptionFa: z.string().max(800).optional(),
  priceRials: z.number().int().nonnegative().optional(),
  intervalMonths: z.number().int().min(1).max(12).optional(),
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

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try { user = await requireRole(["admin"]); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  const { id } = await params;
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }
  const existing = await db.plan.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ errorFa: "طرح یافت نشد." }, { status: 404 });
  const data: Record<string, unknown> = {};
  if (parsed.data.nameFa !== undefined) data.nameFa = parsed.data.nameFa;
  if (parsed.data.descriptionFa !== undefined) data.descriptionFa = parsed.data.descriptionFa;
  if (parsed.data.priceRials !== undefined) data.priceRials = parsed.data.priceRials;
  if (parsed.data.intervalMonths !== undefined) data.intervalMonths = parsed.data.intervalMonths;
  if (parsed.data.quota !== undefined) {
    // M-02: strict quota validation — unknown dimensions / non-finite
    // values are rejected instead of silently persisted.
    const q = parsePlanQuota(parsed.data.quota as Record<string, unknown>);
    if (!q.ok) return NextResponse.json({ errorFa: q.errorFa }, { status: 400 });
    data.quota = JSON.stringify(q.quota);
  }
  if (parsed.data.features !== undefined) {
    // M-02: reject unknown feature keys with an explicit 400 — the
    // previous normalization silently DROPPED typo'd keys.
    const unknown = findUnknownFeatureKeys(parsed.data.features as Record<string, unknown>);
    if (unknown.length > 0) {
      return NextResponse.json(
        { errorFa: `ویژگی(های) ناشناخته: ${unknown.join("، ")}` },
        { status: 400 },
      );
    }
    const features: PlanFeatures = parsePlanFeatures(JSON.stringify(parsed.data.features));
    data.features = JSON.stringify(features);
  }
  if (parsed.data.imageUrl !== undefined) data.imageUrl = parsed.data.imageUrl ?? null;
  if (parsed.data.discountPct !== undefined) data.discountPct = parsed.data.discountPct;
  if (parsed.data.renewalDiscountPct !== undefined) data.renewalDiscountPct = parsed.data.renewalDiscountPct;
  if (parsed.data.renewalDiscountWindowDays !== undefined) data.renewalDiscountWindowDays = parsed.data.renewalDiscountWindowDays;
  if (parsed.data.sortOrder !== undefined) data.sortOrder = parsed.data.sortOrder;
  if (parsed.data.active !== undefined) data.active = parsed.data.active;
  if (parsed.data.isPublic !== undefined) data.isPublic = parsed.data.isPublic;
  await db.plan.update({ where: { id }, data });
  await audit({
    userId: user.id,
    actor: "admin",
    action: "plan_updated",
    targetType: "plan",
    targetId: id,
    ip,
    meta: { from: existing, to: data },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try { user = await requireRole(["admin"]); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  void req;
  const { id } = await params;
  // Hard-delete is dangerous; we mark the plan as inactive+private.
  const existing = await db.plan.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ errorFa: "طرح یافت نشد." }, { status: 404 });
  // Don't allow deleting the free plan
  if (existing.code === "free") {
    return NextResponse.json({ errorFa: "طرح رایگان قابل حذف نیست." }, { status: 400 });
  }
  await db.plan.update({ where: { id }, data: { active: false, isPublic: false } });
  await audit({
    userId: user.id,
    actor: "admin",
    action: "plan_deleted",
    targetType: "plan",
    targetId: id,
    ip,
  });
  return NextResponse.json({ ok: true });
}
