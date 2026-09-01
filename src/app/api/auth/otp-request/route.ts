// POSTYAR OTP request API (Method 2: mobile + OTP)
// Body: { mobile, purpose: "login" | "register" | "reset" }
import { NextResponse } from "next/server";
import { z } from "zod";
import { requestOtp, clientIp, audit } from "@/lib/server/auth";
import { normalizeMobile } from "@/lib/persian";
import { rateLimit } from "@/lib/security/cache";

const Schema = z.object({
  mobile: z.string(),
  purpose: z.enum(["login", "register", "reset"]).default("login"),
});

export async function POST(req: Request) {
  const ip = clientIp(req);
  const rl = await rateLimit({ key: `otp-req:${ip}`, limit: 10, windowMs: 60 * 60 * 1000, critical: true });
  if (!rl.ok) return NextResponse.json({ errorFa: "تعداد درخواست کد بیش از حد مجاز بود." }, { status: 429 });

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." }, { status: 400 });
  }
  const mobile = normalizeMobile(parsed.data.mobile);
  const result = await requestOtp(mobile, parsed.data.purpose);
  if (!result.sent) {
    return NextResponse.json({ errorFa: result.errorFa, cooldownSec: result.cooldownSec }, { status: 429 });
  }
  await audit({ actor: "user", action: "otp_request", targetType: "user", ip, meta: { mobile, purpose: parsed.data.purpose } });
  return NextResponse.json({ ok: true, cooldownSec: result.cooldownSec });
}
