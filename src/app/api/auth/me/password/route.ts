// POSTYAR — POST /api/auth/me/password — change password (verifies current first)
// Body: { currentPassword, newPassword }
// Rate-limited per user (5 attempts / 15 min) to prevent brute force.
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requireUser,
  clientIp,
  audit,
  AuthError,
  hashPassword,
  verifyPassword,
} from "@/lib/server/auth";
import { rateLimit } from "@/lib/security/cache";

const Schema = z.object({
  currentPassword: z.string().min(1, "رمز فعلی را وارد کنید.").max(128),
  newPassword: z
    .string()
    .min(8, "رمز جدید باید حداقل ۸ نویسه باشد.")
    .max(128)
    .refine((v) => v.length >= 8, "رمز کوتاه است."),
});

export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);

  const rl = await rateLimit({ key: `pw:${user.id}`, limit: 5, windowMs: 15 * 60 * 1000, critical: true });
  if (!rl.ok) {
    return NextResponse.json(
      { errorFa: "تلاش بیش از حد. ۱۵ دقیقه بعد امتحان کنید." },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }
  const { currentPassword, newPassword } = parsed.data;

  const u = await db.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
  if (!u || !u.passwordHash) {
    return NextResponse.json({ errorFa: "حساب کاربری رمز ندارد." }, { status: 400 });
  }
  const ok = await verifyPassword(currentPassword, u.passwordHash);
  if (!ok) {
    await audit({
      userId: user.id,
      actor: "user",
      action: "password_change_failed",
      targetType: "user",
      targetId: user.id,
      ip,
    });
    return NextResponse.json({ errorFa: "رمز فعلی نادرست است." }, { status: 401 });
  }
  if (currentPassword === newPassword) {
    return NextResponse.json({ errorFa: "رمز جدید باید با رمز فعلی متفاوت باشد." }, { status: 400 });
  }

  const newHash = await hashPassword(newPassword);
  // M-11: credential change + mass session revocation commit ATOMICALLY.
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });
    // Revoke ALL existing sessions for this user EXCEPT the current one so that
    // any stolen sessions elsewhere are immediately invalidated.
    const c = await import("next/headers");
    const cookiesNow = await c.cookies();
    const cookieToken = cookiesNow.get("postyar_sid")?.value;
    // The current session is identified by the JWT's sid; we need the hash.
    // Easier approach: revoke ALL sessions for the user, then re-create the
    // current one. For simplicity here, revoke every non-current session row.
    // Read the current session's id from JWT:
    const { verifyJwt } = await import("@/lib/security/crypto");
    const payload = cookieToken ? verifyJwt(cookieToken) : null;
    if (payload?.sid) {
      await tx.session.updateMany({
        where: { userId: user.id, id: { not: payload.sid }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } else {
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    // V4 H-9 — the credential change's audit JOINS the transaction
    // (critical).
    await audit({
      userId: user.id,
      actor: "user",
      action: "password_changed",
      targetType: "user",
      targetId: user.id,
      ip,
      tx,
      critical: true,
      meta: { revokedOtherSessions: true },
    });
  });
  return NextResponse.json({ ok: true });
}
