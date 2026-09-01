// POSTYAR — POST /api/ai/generate-caption
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, clientIp, AuthError } from "@/lib/server/auth";
import { generateCaption, type CaptionTone, type CaptionLength, type CaptionPlatform, type CaptionPurpose } from "@/lib/ai/smart-caption";
import { requirePlanFeature } from "@/lib/payments/plans";

const Schema = z.object({
  topic: z.string().min(3, "موضوع حداقل ۳ نویسه باشد.").max(800),
  tone: z.enum(["formal", "friendly", "casual", "promotional", "educational"]).optional(),
  audience: z.string().max(200).optional(),
  length: z.enum(["short", "medium", "long"]).optional(),
  platform: z.enum(["telegram", "bale", "rubika", "instagram", "website", "general"]).optional(),
  purpose: z.enum(["engagement", "sale", "awareness", "announcement"]).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
});

export async function POST(req: Request) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  void clientIp(req);
  // P0.15 — server-side plan feature gate (UI hiding is not authorization).
  try {
    await requirePlanFeature(user.id, "caption");
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 403;
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status });
  }
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }
  try {
    const r = await generateCaption({
      userId: user.id,
      opts: {
        topic: parsed.data.topic,
        tone: parsed.data.tone as CaptionTone | undefined,
        audience: parsed.data.audience,
        length: parsed.data.length as CaptionLength | undefined,
        platform: parsed.data.platform as CaptionPlatform | undefined,
        purpose: parsed.data.purpose as CaptionPurpose | undefined,
        provider: parsed.data.provider ?? null,
        model: parsed.data.model ?? null,
      },
    });
    if (!r.ok) {
      return NextResponse.json({ errorFa: r.errorFa ?? "تولید کپشن ناموفق بود." }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      caption: r.caption,
      alternatives: r.alternatives,
      hashtags: r.hashtags,
      provider: r.provider,
      model: r.model,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      aiJobId: r.aiJobId,
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ errorFa: e.message }, { status: e.status });
    }
    return NextResponse.json({ errorFa: "خطای داخلی." }, { status: 500 });
  }
}
