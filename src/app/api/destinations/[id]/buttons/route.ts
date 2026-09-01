// POSTYAR — /api/destinations/[id]/buttons
// POST   create destination-scoped glass button
// GET    list buttons for the destination
//
// Buttons are STRICTLY destination-scoped. There is no "global" button
// collection — any attempt to address a button by anything other than
// destinationId + buttonId will be rejected.
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser, clientIp, audit, AuthError } from "@/lib/server/auth";
import { requirePlanFeature, requireFeatureCapacity } from "@/lib/payments/plans";
import { rateLimit } from "@/lib/security/cache";
import { toGlassButtonView, assertOwnership } from "@/lib/destinations/helpers";

const CreateSchema = z.object({
  label: z.string().min(1, "متن دکمه الزامی است.").max(64),
  url: z.string().url("نشانی اینترنتی نامعتبر است.").optional().nullable(),
  callbackData: z.string().min(1).max(64).optional().nullable(),
  rowOrder: z.number().int().min(0).max(20).default(0),
  enabled: z.boolean().default(true),
});

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const { id } = await params;
  const owns = await assertOwnership(id, user.id);
  if (!owns) {
    return NextResponse.json({ errorFa: "مقصد یافت نشد." }, { status: 404 });
  }
  const rows = await db.glassButton.findMany({
    where: { destinationId: id },
    orderBy: [{ rowOrder: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json({ items: rows.map(toGlassButtonView) });
}

export async function POST(req: Request, { params }: Params) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  const { id } = await params;

  const owns = await assertOwnership(id, user.id);
  if (!owns) {
    return NextResponse.json({ errorFa: "مقصد یافت نشد." }, { status: 404 });
  }

  // P0.15/H-1 — server-side feature gate at the action boundary: glass
  // buttons are plan-gated (free plan has glassButtonsPerDest: 0).
  try {
    await requirePlanFeature(user.id, "glassButtons");
    const perDest = await db.glassButton.count({ where: { destinationId: id } });
    await requireFeatureCapacity(user.id, "glassButtons", "glassButtonsPerDest", perDest, "دکمه شیشه‌ای");
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 403;
    const msg = e instanceof AuthError ? e.message : "امکان دکمه شیشه‌ای در پلن فعلی شما فعال نیست.";
    return NextResponse.json({ errorFa: msg }, { status });
  }

  const rl = await rateLimit({
    key: `btn:create:${user.id}`,
    limit: 60,
    windowMs: 60 * 1000,
  });
  if (!rl.ok) {
    return NextResponse.json({ errorFa: "تعداد ساخت دکمه بیش از حد مجاز است." }, { status: 429 });
  }

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
  const { label, url, callbackData, rowOrder, enabled } = parsed.data;
  // Reject buttons with neither url nor callbackData — they would be inert.
  if (!url && !callbackData) {
    return NextResponse.json(
      { errorFa: "دکمه باید نشانی یا داده کال‌بک داشته باشد." },
      { status: 400 },
    );
  }
  const created = await db.glassButton.create({
    data: {
      destinationId: id,
      label,
      url: url ?? null,
      callbackData: callbackData ?? null,
      rowOrder,
      enabled,
    },
  });
  await audit({
    userId: user.id,
    actor: "user",
    action: "button_create",
    targetType: "destination",
    targetId: id,
    ip,
    meta: { buttonId: created.id, hasUrl: !!url, hasCallback: !!callbackData },
  });
  return NextResponse.json({ ok: true, button: toGlassButtonView(created) }, { status: 201 });
}
