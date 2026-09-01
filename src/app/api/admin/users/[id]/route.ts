// POSTYAR — /api/admin/users/[id] (GET single, PATCH { status, role } admin only)
// Never patches financial fields. Always audits.
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole, clientIp, audit, AuthError } from "@/lib/server/auth";
import { db } from "@/lib/db";
import { formatJalaliDateTime, maskMobile } from "@/lib/persian";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try { user = await requireRole(["admin"]); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  void user; void req;
  const { id } = await params;
  const u = await db.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      mobile: true,
      firstName: true,
      lastName: true,
      businessName: true,
      activityType: true,
      role: true,
      status: true,
      referralCode: true,
      referredById: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!u) return NextResponse.json({ errorFa: "کاربر یافت نشد." }, { status: 404 });
  // Read isSuperAdmin via raw SQL so the route keeps working even while
  // a long-lived dev server still has the pre-migration @prisma/client
  // singleton in its require cache.
  const saRows = await db.$queryRawUnsafe<Array<{ isSuperAdmin: number }>>(
    `SELECT isSuperAdmin FROM User WHERE id = ?`,
    id,
  );
  const isSuperAdmin = saRows[0] ? !!saRows[0].isSuperAdmin : false;
  return NextResponse.json({
    user: {
      id: u.id,
      email: u.email,
      mobileMasked: maskMobile(u.mobile),
      firstName: u.firstName,
      lastName: u.lastName,
      businessName: u.businessName,
      activityType: u.activityType,
      role: u.role,
      status: u.status,
      referralCode: u.referralCode,
      referredById: u.referredById,
      createdAt: u.createdAt.toISOString(),
      createdAtFa: formatJalaliDateTime(u.createdAt, { withTime: true }),
      updatedAt: u.updatedAt.toISOString(),
      isSuperAdmin,
    },
  });
}

const PatchSchema = z.object({
  status: z.enum(["active", "suspended"]).optional(),
  role: z.enum(["user", "support", "admin"]).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try { user = await requireRole(["admin"]); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  const { id } = await params;
  // Prevent self-suspension / self-demotion to avoid lockout
  if (id === user.id) {
    return NextResponse.json({ errorFa: "نمی‌توانید حساب خود را ویرایش کنید." }, { status: 400 });
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
  if (!parsed.data.status && !parsed.data.role) {
    return NextResponse.json({ errorFa: "هیچ فیلدی برای ویرایش ارسال نشد." }, { status: 400 });
  }
  // Only patch allowed fields (status, role). NEVER financial fields.
  const existing = await db.user.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ errorFa: "کاربر یافت نشد." }, { status: 404 });
  // SUPER-ADMIN LOCK: the bootstrap admin's account is immutable from this
  // route (and from the reset-password sibling). Even other admins cannot
  // change its role or status. The only way to remove a super-admin is to
  // demote them first via direct DB access (which is itself audited).
  // We read isSuperAdmin via raw SQL so the lock still holds even while
  // a long-lived dev server keeps the pre-migration @prisma/client cache.
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
  const data: Record<string, string> = {};
  if (parsed.data.status) data.status = parsed.data.status;
  if (parsed.data.role) data.role = parsed.data.role;
  // M-11: a status change (suspension) and the revocation of the user's
  // live sessions commit ATOMICALLY — the account is locked out at the
  // same instant its sessions die (previously the suspension relied
  // solely on lazy per-request revocation, leaving live session rows
  // valid until each happened to be used again).
  // V4 H-9 — the state change + session revocation + its critical audit
  // commit as ONE unit: a suspension can never exist without its audit
  // trail, and an audit failure rolls the whole operation back.
  const updated = await db.$transaction(async (tx) => {
    const u = await tx.user.update({ where: { id }, data });
    if (data.status) {
      await tx.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await audit({
      userId: user.id,
      actor: "admin",
      action: "user_updated",
      targetType: "user",
      targetId: id,
      ip,
      tx,
      critical: true,
      meta: { from: { status: existing.status, role: existing.role }, to: data },
    });
    return u;
  });
  return NextResponse.json({
    ok: true,
    user: {
      id: updated.id,
      status: updated.status,
      role: updated.role,
    },
  });
}
