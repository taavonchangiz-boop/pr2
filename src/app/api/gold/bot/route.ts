// POSTYAR — /api/gold/bot
// GET list mine, POST create, PATCH update, DELETE — ownership enforced.
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser, clientIp, audit, AuthError } from "@/lib/server/auth";
import { requirePlanFeature } from "@/lib/payments/plans";
import { formatJalaliDateTime } from "@/lib/persian";

function toView(b: {
  id: string;
  enabled: boolean;
  instrument: string;
  direction: string;
  thresholdPct: number;
  intervalMin: number;
  destinationId: string | null;
  lastFiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: b.id,
    enabled: b.enabled,
    instrument: b.instrument,
    direction: b.direction,
    thresholdPct: b.thresholdPct,
    intervalMin: b.intervalMin,
    destinationId: b.destinationId,
    lastFiredAt: b.lastFiredAt?.toISOString() ?? null,
    lastFiredAtFa: b.lastFiredAt ? formatJalaliDateTime(b.lastFiredAt, { withTime: true }) : null,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

export async function GET() {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const rows = await db.goldBot.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ items: rows.map(toView) });
}

const CreateSchema = z.object({
  enabled: z.boolean().optional(),
  instrument: z.enum(["18k", "emami", "bahar_azadi", "ounce"]),
  direction: z.enum(["up", "down", "both"]),
  thresholdPct: z.number().min(0.1).max(50),
  intervalMin: z.number().int().min(5).max(1440).optional(),
  destinationId: z.string().optional(),
});

export async function POST(req: Request) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  // P0.15/H-1 — gold bots are a plan feature.
  try {
    await requirePlanFeature(user.id, "goldBot");
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 403;
    const msg = e instanceof AuthError ? e.message : "امکان ربات طلا در پلن فعلی شما فعال نیست.";
    return NextResponse.json({ errorFa: msg }, { status });
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
  // Optional destinationId ownership check
  if (parsed.data.destinationId) {
    const d = await db.destination.findUnique({ where: { id: parsed.data.destinationId } });
    if (!d || d.ownerId !== user.id) {
      return NextResponse.json({ errorFa: "مقصد نامعتبر است." }, { status: 400 });
    }
  }
  const row = await db.goldBot.create({
    data: {
      userId: user.id,
      enabled: parsed.data.enabled ?? false,
      instrument: parsed.data.instrument,
      direction: parsed.data.direction,
      thresholdPct: parsed.data.thresholdPct,
      intervalMin: parsed.data.intervalMin ?? 15,
      destinationId: parsed.data.destinationId ?? null,
    },
  });
  await audit({
    userId: user.id,
    actor: "user",
    action: "gold_bot_created",
    targetType: "gold_bot",
    targetId: row.id,
    ip,
    meta: { instrument: parsed.data.instrument, direction: parsed.data.direction, thresholdPct: parsed.data.thresholdPct },
  });
  return NextResponse.json({ ok: true, bot: toView(row) }, { status: 201 });
}

const PatchSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().optional(),
  direction: z.enum(["up", "down", "both"]).optional(),
  thresholdPct: z.number().min(0.1).max(50).optional(),
  intervalMin: z.number().int().min(5).max(1440).optional(),
  destinationId: z.string().nullable().optional(),
});

export async function PATCH(req: Request) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
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
  const existing = await db.goldBot.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return NextResponse.json({ errorFa: "ربات یافت نشد." }, { status: 404 });
  if (existing.userId !== user.id) return NextResponse.json({ errorFa: "دسترسی غیرمجاز." }, { status: 403 });

  if (parsed.data.destinationId) {
    const d = await db.destination.findUnique({ where: { id: parsed.data.destinationId } });
    if (!d || d.ownerId !== user.id) {
      return NextResponse.json({ errorFa: "مقصد نامعتبر است." }, { status: 400 });
    }
  }
  const updated = await db.goldBot.update({
    where: { id: parsed.data.id },
    data: {
      ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
      ...(parsed.data.direction ? { direction: parsed.data.direction } : {}),
      ...(parsed.data.thresholdPct !== undefined ? { thresholdPct: parsed.data.thresholdPct } : {}),
      ...(parsed.data.intervalMin !== undefined ? { intervalMin: parsed.data.intervalMin } : {}),
      ...(parsed.data.destinationId !== undefined ? { destinationId: parsed.data.destinationId } : {}),
    },
  });
  await audit({
    userId: user.id,
    actor: "user",
    action: "gold_bot_updated",
    targetType: "gold_bot",
    targetId: updated.id,
    ip,
  });
  return NextResponse.json({ ok: true, bot: toView(updated) });
}

const DeleteSchema = z.object({ id: z.string().min(1) });

export async function DELETE(req: Request) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  const parsed = DeleteSchema.safeParse({ id });
  if (!parsed.success) {
    return NextResponse.json({ errorFa: "شناسه ربات الزامی است." }, { status: 400 });
  }
  const existing = await db.goldBot.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return NextResponse.json({ errorFa: "ربات یافت نشد." }, { status: 404 });
  if (existing.userId !== user.id) return NextResponse.json({ errorFa: "دسترسی غیرمجاز." }, { status: 403 });
  await db.goldBot.delete({ where: { id: parsed.data.id } });
  await audit({
    userId: user.id,
    actor: "user",
    action: "gold_bot_deleted",
    targetType: "gold_bot",
    targetId: parsed.data.id,
    ip,
  });
  return NextResponse.json({ ok: true });
}
