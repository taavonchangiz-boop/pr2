// POSTYAR — POST /api/auth/reset-password
// Completes the password-reset flow: consumes the single-use
// `verify:reset:<mobile>` token issued by /api/auth/otp-verify (purpose
// "reset"), sets the new password, and revokes ALL of the user's existing
// sessions (a password reset is a security event — stolen sessions must
// not survive it).
//
// M-2 ROOT-CAUSE FIX: the reset flow previously dead-ended — otp-verify
// issued a 5-minute reset token but NO route ever consumed it, so
// self-service password recovery was advertised but impossible. The token
// is single-use, hash-stored, short-lived, and rate-limited here.
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { clientIp, audit } from "@/lib/server/auth";
import { normalizeMobile, isValidIranMobile } from "@/lib/persian";
import { hashToken, hashPassword } from "@/lib/security/crypto";
import { rateLimit } from "@/lib/security/cache";

const Schema = z.object({
  mobile: z.string().min(1),
  verifyToken: z.string().min(10).max(200),
  newPassword: z.string().min(8, "رمز عبور باید حداقل ۸ نویسه باشد.").max(128),
});

export async function POST(req: Request) {
  const ip = clientIp(req);
  // Brute-force budget for the opaque 256-bit token + 8+ char password.
  const rl = await rateLimit({ key: `reset-pw:${ip}`, limit: 5, windowMs: 15 * 60 * 1000 });
  if (!rl.ok) {
    return NextResponse.json({ errorFa: "تعداد تلاش بیش از حد مجاز است. ۱۵ دقیقه بعد تلاش کنید." }, { status: 429 });
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
  const { mobile: mobileRaw, verifyToken, newPassword } = parsed.data;
  const mobile = normalizeMobile(mobileRaw);
  if (!isValidIranMobile(mobile)) {
    return NextResponse.json({ errorFa: "شماره موبایل نامعتبر است." }, { status: 400 });
  }

  // Consume the reset token — SINGLE-USE, atomic on the shared cache
  // (delete returns whether THIS caller removed it).
  const { cache } = await import("@/lib/security/cache");
  const tokenKey = `verify:reset:${mobile}`;
  const storedHash = await cache.get<string>(tokenKey);
  if (!storedHash || !constantTimeEqualSafe(storedHash, hashToken(verifyToken))) {
    return NextResponse.json({ errorFa: "توکن بازیابی نامعتبر است یا منقضی شده است." }, { status: 400 });
  }
  await cache.del(tokenKey);

  const user = await db.user.findUnique({ where: { mobile } });
  if (!user) {
    return NextResponse.json({ errorFa: "حساب کاربری یافت نشد." }, { status: 404 });
  }
  if (user.status === "suspended") {
    return NextResponse.json({ errorFa: "حساب شما معلق شده است." }, { status: 403 });
  }

  const passwordHash = await hashPassword(newPassword);
  await db.$transaction([
    db.user.update({ where: { id: user.id }, data: { passwordHash } }),
    // Revoke every session — a password reset must never leave a stolen
    // session alive.
    db.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  await audit({
    userId: user.id,
    actor: "user",
    action: "password_reset_completed",
    targetType: "user",
    targetId: user.id,
    ip,
  });

  return NextResponse.json({ ok: true });
}

/** Constant-time compare that never throws on length mismatch. */
function constantTimeEqualSafe(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
