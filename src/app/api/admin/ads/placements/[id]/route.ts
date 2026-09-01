// POSTYAR — /api/admin/ads/placements/[id] (admin only)
//   PATCH  — update labelFa, descriptionFa, kind, active, sortOrder.
//            The `key` is the PK and FK target — it CANNOT be renamed (would
//            break the FK from AdCampaign.placement). Reject any key change.
//   DELETE — remove the placement. Refuses if any AdCampaign still references
//            it (FK onDelete: NoAction prevents silent breakage; we want a
//            clear Persian error so the admin reassigns campaigns first).
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole, clientIp, audit, AuthError } from "@/lib/server/auth";

const KINDS = ["sticky_bar", "banner_inline", "sidebar_card", "fullscreen", "slider"] as const;

type Params = { params: Promise<{ id: string }> };

const PatchSchema = z.object({
  labelFa: z.string().min(1, "برچسب فارسی الزامی است.").max(120).optional(),
  descriptionFa: z.string().max(500).optional(),
  kind: z.enum(KINDS).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  recommendedWidth: z.number().int().min(0).max(8000).optional(),
  recommendedHeight: z.number().int().min(0).max(8000).optional(),
  maxFileBytes: z.number().int().min(0).max(20 * 1024 * 1024).optional(),
}).refine(
  (b) =>
    b.labelFa !== undefined ||
    b.descriptionFa !== undefined ||
    b.kind !== undefined ||
    b.active !== undefined ||
    b.sortOrder !== undefined ||
    b.recommendedWidth !== undefined ||
    b.recommendedHeight !== undefined ||
    b.maxFileBytes !== undefined,
  { message: "هیچ فیلدی برای به‌روزرسانی ارسال نشده است." },
);

export async function PATCH(req: Request, { params }: Params) {
  let user;
  try { user = await requireRole(["admin"]); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  const { id: key } = await params;

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
  const existing = await db.adPlacement.findUnique({ where: { key } });
  if (!existing) return NextResponse.json({ errorFa: "جایگاه یافت نشد." }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (parsed.data.labelFa !== undefined) data.labelFa = parsed.data.labelFa;
  if (parsed.data.descriptionFa !== undefined) data.descriptionFa = parsed.data.descriptionFa.slice(0, 500);
  if (parsed.data.kind !== undefined) data.kind = parsed.data.kind;
  if (parsed.data.active !== undefined) data.active = parsed.data.active;
  if (parsed.data.sortOrder !== undefined) data.sortOrder = parsed.data.sortOrder;
  if (parsed.data.recommendedWidth !== undefined) data.recommendedWidth = parsed.data.recommendedWidth;
  if (parsed.data.recommendedHeight !== undefined) data.recommendedHeight = parsed.data.recommendedHeight;
  if (parsed.data.maxFileBytes !== undefined) data.maxFileBytes = parsed.data.maxFileBytes;

  try {
    const updated = await db.adPlacement.update({ where: { key }, data });
    await audit({
      userId: user.id,
      actor: "admin",
      action: "ad_placement_updated",
      targetType: "ad_placement",
      targetId: key,
      ip,
      meta: { fields: Object.keys(data) },
    });
    return NextResponse.json({ ok: true, placement: updated });
  } catch (e) {
    return NextResponse.json({ errorFa: "خطای داخلی سرور." }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: Params) {
  let user;
  try { user = await requireRole(["admin"]); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  void req;
  const { id: key } = await params;

  const existing = await db.adPlacement.findUnique({ where: { key } });
  if (!existing) return NextResponse.json({ errorFa: "جایگاه یافت نشد." }, { status: 404 });

  // Refuse deletion while any campaign still points at this placement.
  const linked = await db.adCampaign.count({ where: { placement: key } });
  if (linked > 0) {
    return NextResponse.json(
      { errorFa: `این جایگاه به ${linked} کمپین متصل است و قابل حذف نیست. ابتدا کمپین‌ها را به جایگاه دیگری منتقل کنید.` },
      { status: 409 },
    );
  }

  try {
    await db.adPlacement.delete({ where: { key } });
    await audit({
      userId: user.id,
      actor: "admin",
      action: "ad_placement_deleted",
      targetType: "ad_placement",
      targetId: key,
      ip,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ errorFa: "خطای داخلی سرور." }, { status: 500 });
  }
}
