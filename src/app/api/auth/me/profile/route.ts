// POSTYAR — GET/PATCH /api/auth/me/profile
// GET    — returns the 7 persisted profile fields + bio + notify prefs
// PATCH  — updates ONLY the fields below. role/status are NEVER acceptible.
//          email/mobile/referralCode changes are rejected here — they require
//          a separate verified-change flow (OTP-confirmed new contact info).
//          This closes the mass-assignment vector flagged in the security audit.
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser, clientIp, audit, AuthError } from "@/lib/server/auth";
import { maskMobile } from "@/lib/persian";

const ALLOWED_ACTIVITY_TYPES = ["personal", "business", "marketer", "service", "media", "other"] as const;

const PatchSchema = z
  .object({
    firstName: z.string().min(1, "نام را وارد کنید.").max(80).optional(),
    lastName: z.string().min(1, "نام خانوادگی را وارد کنید.").max(120).optional(),
    activityType: z.enum(ALLOWED_ACTIVITY_TYPES).optional(),
    businessName: z.string().max(200).optional(),
    bio: z.string().max(500).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "حداقل یک فیلد ارسال شود." });

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  try {
    const u = await db.user.findUnique({
      where: { id: user.id },
      select: {
        firstName: true,
        lastName: true,
        email: true,
        mobile: true,
        activityType: true,
        businessName: true,
        referralCode: true,
      },
    });
    if (!u) return NextResponse.json({ errorFa: "کاربر یافت نشد." }, { status: 404 });
    const profileRow = await db.profile.findUnique({ where: { userId: user.id }, select: { bio: true } });
    return NextResponse.json({
      profile: {
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        mobile: maskMobile(u.mobile),
        activityType: u.activityType,
        businessName: u.businessName,
        referralCode: u.referralCode,
        bio: profileRow?.bio ?? "",
      },
    });
  } catch (e) {
    return NextResponse.json({ errorFa: "خطای داخلی سرور." }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }
  const patch = parsed.data;

  try {
    const data: Record<string, string> = {};
    if (patch.firstName !== undefined) data.firstName = patch.firstName.trim();
    if (patch.lastName !== undefined) data.lastName = patch.lastName.trim();
    if (patch.activityType !== undefined) data.activityType = patch.activityType;
    if (patch.businessName !== undefined) data.businessName = patch.businessName.trim();

    const updated = await db.user.update({
      where: { id: user.id },
      data,
      select: {
        firstName: true,
        lastName: true,
        email: true,
        mobile: true,
        activityType: true,
        businessName: true,
        referralCode: true,
      },
    });

    if (patch.bio !== undefined) {
      await db.profile.upsert({
        where: { userId: user.id },
        create: { userId: user.id, bio: patch.bio },
        update: { bio: patch.bio },
      });
    }

    await audit({
      userId: user.id,
      actor: "user",
      action: "profile_updated",
      targetType: "user",
      targetId: user.id,
      ip,
      meta: { fields: Object.keys(data) },
    });

    const profileRow = await db.profile.findUnique({ where: { userId: user.id }, select: { bio: true } });
    return NextResponse.json({
      profile: {
        firstName: updated.firstName,
        lastName: updated.lastName,
        email: updated.email,
        mobile: maskMobile(updated.mobile),
        activityType: updated.activityType,
        businessName: updated.businessName,
        referralCode: updated.referralCode,
        bio: profileRow?.bio ?? "",
      },
    });
  } catch (e) {
    return NextResponse.json({ errorFa: "خطای داخلی سرور." }, { status: 500 });
  }
}
