// POSTYAR — /api/auto-responder
// GET  — returns the caller's AutoResponder config (creates an empty default if none exists)
// PATCH — updates fields (enabled, destinationId, rules, fallbackFa, aiProvider, aiModel, loopGuardSeconds, dailyLimit)
// Never returns raw token values; rules are returned verbatim (they contain only text strings).
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser, clientIp, audit, safeJsonParse, AuthError } from "@/lib/server/auth";
import { requirePlanFeature } from "@/lib/payments/plans";
import { formatJalaliDateTime } from "@/lib/persian";
import type { AutoResponderConfig, AutoResponderRule } from "@/components/postyar/api";

function toConfig(row: {
  id: string;
  enabled: boolean;
  destinationId: string | null;
  rules: string;
  fallbackFa: string;
  aiProvider: string | null;
  aiModel: string | null;
  loopGuardSeconds: number;
  dailyLimit: number;
  usedToday: number;
}): AutoResponderConfig {
  return {
    id: row.id,
    enabled: row.enabled,
    destinationId: row.destinationId,
    rules: safeJsonParse<AutoResponderRule[]>(row.rules, []),
    fallbackFa: row.fallbackFa,
    aiProvider: row.aiProvider,
    aiModel: row.aiModel,
    loopGuardSeconds: row.loopGuardSeconds,
    dailyLimit: row.dailyLimit,
    usedToday: row.usedToday,
  };
}

export async function GET() {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  let row = await db.autoResponder.findUnique({ where: { userId: user.id } });
  if (!row) {
    row = await db.autoResponder.create({ data: { userId: user.id } });
  }
  return NextResponse.json(toConfig(row));
}

const RuleSchema = z.object({
  keywords: z.array(z.string().min(1).max(200)).max(20),
  matchMode: z.enum(["exact", "contains", "regex"]).optional(),
  responseMode: z.enum(["static", "ai"]).optional(),
  staticResponse: z.string().max(2000).optional(),
  aiPromptSuffix: z.string().max(1000).optional(),
});

const PatchSchema = z.object({
  enabled: z.boolean().optional(),
  destinationId: z.string().nullable().optional(),
  rules: z.array(RuleSchema).max(50).optional(),
  fallbackFa: z.string().max(2000).optional(),
  aiProvider: z.string().max(80).nullable().optional(),
  aiModel: z.string().max(120).nullable().optional(),
  loopGuardSeconds: z.number().int().min(5).max(3600).optional(),
  dailyLimit: z.number().int().min(1).max(10000).optional(),
}).strict();

export async function PATCH(req: Request) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  // P0.15/H-1 — auto-responder is a plan feature.
  try {
    await requirePlanFeature(user.id, "autoResponder");
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 403;
    const msg = e instanceof AuthError ? e.message : "امکان پاسخگوی خودکار در پلن فعلی شما فعال نیست.";
    return NextResponse.json({ errorFa: msg }, { status });
  }
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

  // Optional destinationId ownership check
  if (parsed.data.destinationId) {
    const d = await db.destination.findUnique({ where: { id: parsed.data.destinationId } });
    if (!d || d.ownerId !== user.id) {
      return NextResponse.json({ errorFa: "مقصد نامعتبر است." }, { status: 400 });
    }
  }

  let row = await db.autoResponder.findUnique({ where: { userId: user.id } });
  if (!row) {
    row = await db.autoResponder.create({ data: { userId: user.id } });
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.enabled !== undefined) data.enabled = parsed.data.enabled;
  if (parsed.data.destinationId !== undefined) data.destinationId = parsed.data.destinationId;
  if (parsed.data.rules !== undefined) data.rules = JSON.stringify(parsed.data.rules);
  if (parsed.data.fallbackFa !== undefined) data.fallbackFa = parsed.data.fallbackFa;
  if (parsed.data.aiProvider !== undefined) data.aiProvider = parsed.data.aiProvider;
  if (parsed.data.aiModel !== undefined) data.aiModel = parsed.data.aiModel;
  if (parsed.data.loopGuardSeconds !== undefined) data.loopGuardSeconds = parsed.data.loopGuardSeconds;
  if (parsed.data.dailyLimit !== undefined) data.dailyLimit = parsed.data.dailyLimit;

  const updated = await db.autoResponder.update({
    where: { userId: user.id },
    data,
  });

  await audit({
    userId: user.id,
    actor: "user",
    action: "auto_responder_updated",
    targetType: "auto_responder",
    targetId: updated.id,
    ip,
    meta: { fields: Object.keys(data), at: formatJalaliDateTime(new Date().toISOString(), { withTime: true }) },
  });

  return NextResponse.json(toConfig(updated));
}
