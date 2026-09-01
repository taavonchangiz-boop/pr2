// POSTYAR — POST /api/ai/generate-text
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, clientIp, AuthError } from "@/lib/server/auth";
import { generateText, type SmartTextMode } from "@/lib/ai/smart-text";
import { requirePlanFeature } from "@/lib/payments/plans";

const Schema = z.object({
  mode: z.enum(["generate", "rewrite", "shorten", "expand", "tone"]),
  input: z.string().max(8000).optional(),
  opts: z.object({
    tone: z.enum(["formal", "friendly", "casual", "promotional", "educational"]).optional(),
    topic: z.string().max(800).optional(),
    audience: z.string().max(200).optional(),
    maxLength: z.number().int().positive().max(8000).optional(),
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
    await requirePlanFeature(user.id, "smartText");
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
    const r = await generateText({
      userId: user.id,
      mode: parsed.data.mode as SmartTextMode,
      input: parsed.data.input ?? "",
      opts: parsed.data.opts,
      provider: parsed.data.provider ?? null,
      model: parsed.data.model ?? null,
    });
    if (!r.ok) {
      return NextResponse.json({ errorFa: r.errorFa ?? "تولید متن ناموفق بود." }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      text: r.text,
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
