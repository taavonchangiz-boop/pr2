// POSTYAR — /api/admin/users/[id]/reset-password (POST admin-only)
// ---------------------------------------------------------------------
// Lets an admin set a NEW password for any non-self user. The new password
// is hashed via the existing `hashPassword` (bcryptjs, 12 rounds) and stored
// on `User.passwordHash`. The action is audited. The admin CANNOT reset
// their own password through this route — they must use the regular
// "change password" flow (POST /api/auth/me/password) which verifies the
// current password first.
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole, clientIp, audit, AuthError, hashPassword } from "@/lib/server/auth";
import { db } from "@/lib/db";

const BodySchema = z.object({
  newPassword: z.string().min(8, "رمز عبور باید حداقل ۸ کاراکتر باشد.").max(128),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let admin;
  try {
    admin = await requireRole(["admin"]);
  } catch (e) {
    return NextResponse.json(
      { errorFa: (e as AuthError).message },
      { status: (e as AuthError).status },
    );
  }
  const ip = clientIp(req);
  const { id } = await params;

  // Prevent self-reset through this route — the admin must use the regular
  // "change password" flow that verifies the current password.
  if (id === admin.id) {
    return NextResponse.json(
      {
        errorFa:
          "برای تغییر رمز خود از بخش «پروفایل» استفاده کنید. این مسیر فقط برای بازنشانی رمز کاربران دیگر است.",
      },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }

  const existing = await db.user.findUnique({
    where: { id },
    select: { id: true, firstName: true, lastName: true, email: true, mobile: true },
  });
  if (!existing) {
    return NextResponse.json({ errorFa: "کاربر یافت نشد." }, { status: 404 });
  }
  // SUPER-ADMIN LOCK: even admins cannot reset the bootstrap admin's password.
  // Read via raw SQL so the lock holds even while a long-lived dev server
  // keeps the pre-migration @prisma/client cache.
  const saRows = await db.$queryRawUnsafe<Array<{ isSuperAdmin: number }>>(
    `SELECT isSuperAdmin FROM User WHERE id = ?`,
    id,
  );
  const isSuperAdmin = saRows[0] ? !!saRows[0].isSuperAdmin : false;
  if (isSuperAdmin) {
    return NextResponse.json(
      { errorFa: "حساب مدیر کل قابل تغییر نیست." },
      { status: 403 },
    );
  }

  const passwordHash = await hashPassword(parsed.data.newPassword);
  // M-11: the credential change and the mass session revocation commit
  // ATOMICALLY — there is no window where the new password is live while
  // the stolen sessions are still valid (or vice versa on rollback).
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id },
      data: { passwordHash, updatedAt: new Date() },
    });
    // ROOT-CAUSE FIX (audit §10 — privilege/state changes): a stolen live
    // session survived the password reset, so "locking the account out" by
    // resetting its password did nothing against session theft. All of the
    // target user's sessions are now revoked.
    await tx.session.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });

  await audit({
    userId: admin.id,
    actor: "admin",
    action: "user_password_reset",
    targetType: "user",
    targetId: id,
    ip,
    meta: {
      // Do NOT log the new password. Only who reset whose password, and when.
      targetEmail: existing.email,
      targetName: `${existing.firstName ?? ""} ${existing.lastName ?? ""}`.trim(),
    },
  });

  return NextResponse.json({ ok: true });
}
