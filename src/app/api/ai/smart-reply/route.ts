// POSTYAR — POST /api/ai/smart-reply
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, clientIp, AuthError } from "@/lib/server/auth";
import { smartReply } from "@/lib/ai/smart-reply";
import { requirePlanFeature } from "@/lib/payments/plans";

const Schema = z.object({
  message: z.string().min(2, "پیام حداقل ۲ نویسه باشد.").max(4000),
  context: z.object({
    recentThread: z.array(z.object({
      role: z.enum(["user", "assistant", "system"]),
      text: z.string().max(2000),
    })).max(12).optional(),
    channel: z.enum(["telegram", "bale", "rubika", "instagram", "website", "general"]).optional(),
    provider: z.string().max(40).optional(),
  }).optional(),
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
    await requirePlanFeature(user.id, "smartReply");
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
    const r = await smartReply({
      userId: user.id,
      message: parsed.data.message,
      context: parsed.data.context,
      provider: parsed.data.provider ?? null,
      model: parsed.data.model ?? null,
    });
    if (!r.ok) {
      return NextResponse.json({ errorFa: r.errorFa ?? "تولید پاسخ ناموفق بود." }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      suggestion: r.suggestion,
      alternatives: r.alternatives,
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
