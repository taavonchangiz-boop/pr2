// POSTYAR — /api/admin/ads/placements (admin only)
//   GET  — list all ad placements, ordered by sortOrder asc then createdAt asc.
//   POST — create a new placement (key is the stable PK; FK target for AdCampaign).
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole, clientIp, audit, AuthError } from "@/lib/server/auth";

const KINDS = ["sticky_bar", "banner_inline", "sidebar_card", "fullscreen", "slider"] as const;
type AdKind = (typeof KINDS)[number];

export interface AdPlacementRow {
  key: string;
  labelFa: string;
  descriptionFa: string;
  kind: AdKind | string;
  active: boolean;
  sortOrder: number;
  recommendedWidth: number;
  recommendedHeight: number;
  maxFileBytes: number;
  createdAt: string;
  updatedAt: string;
  campaignCount: number;
}

function toRow(p: {
  key: string;
  labelFa: string;
  descriptionFa: string;
  kind: string;
  active: boolean;
  sortOrder: number;
  recommendedWidth: number;
  recommendedHeight: number;
  maxFileBytes: number;
  createdAt: Date;
  updatedAt: Date;
}, campaignCount: number): AdPlacementRow {
  return {
    key: p.key,
    labelFa: p.labelFa,
    descriptionFa: p.descriptionFa,
    kind: p.kind,
    active: p.active,
    sortOrder: p.sortOrder,
    recommendedWidth: p.recommendedWidth,
    recommendedHeight: p.recommendedHeight,
    maxFileBytes: p.maxFileBytes,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    campaignCount,
  };
}

export async function GET() {
  let user;
  try { user = await requireRole(["admin"]); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  void user;
  const rows = await db.adPlacement.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  // Count campaigns per placement (any status) for the admin table badge.
  const counts = await db.adCampaign.groupBy({
    by: ["placement"],
    _count: { _all: true },
  });
  const countMap = new Map<string, number>();
  for (const c of counts) countMap.set(c.placement, c._count._all);
  return NextResponse.json({ items: rows.map((r) => toRow(r, countMap.get(r.key) ?? 0)) });
}

const CreateSchema = z.object({
  key: z.string()
    .min(2, "کلید جایگاه حداقل ۲ نویسه باشد.")
    .max(60, "کلید جایگاه حداکثر ۶۰ نویسه باشد.")
    .regex(/^[a-z0-9_]+$/, "کلید فقط شامل حروف کوچک انگلیسی، عدد و زیرخط باشد."),
  labelFa: z.string().min(1, "برچسب فارسی الزامی است.").max(120),
  descriptionFa: z.string().max(500).optional(),
  kind: z.enum(KINDS).default("banner_inline"),
  recommendedWidth: z.number().int().min(0).max(8000).default(0),
  recommendedHeight: z.number().int().min(0).max(8000).default(0),
  maxFileBytes: z.number().int().min(0).max(20 * 1024 * 1024).default(0),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
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
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }
  // Unique-key check (Prisma would 400 anyway, but we want a Persian message).
  const existing = await db.adPlacement.findUnique({ where: { key: parsed.data.key } });
  if (existing) {
    return NextResponse.json({ errorFa: "این کلید جایگاه قبلاً ثبت شده است." }, { status: 409 });
  }
  try {
    const created = await db.adPlacement.create({
      data: {
        key: parsed.data.key,
        labelFa: parsed.data.labelFa,
        descriptionFa: (parsed.data.descriptionFa ?? "").slice(0, 500),
        kind: parsed.data.kind,
        recommendedWidth: parsed.data.recommendedWidth,
        recommendedHeight: parsed.data.recommendedHeight,
        maxFileBytes: parsed.data.maxFileBytes,
        active: parsed.data.active,
        sortOrder: parsed.data.sortOrder,
      },
    });
    await audit({
      userId: user.id,
      actor: "admin",
      action: "ad_placement_created",
      targetType: "ad_placement",
      targetId: created.key,
      ip,
      meta: { key: created.key, kind: created.kind },
    });
    return NextResponse.json({ ok: true, placement: toRow(created, 0) }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ errorFa: "خطای داخلی سرور." }, { status: 500 });
  }
}
