// POSTYAR complete mobile registration. After OTP verify (purpose=register),
// the client must supply the remaining required fields to create the user.
// This enforces: even mobile-first registrants provide all 7 fields.
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { hashPassword, newReferralCode, clientIp, audit, createSession, claimFirstAdmin } from "@/lib/server/auth";
import { hashToken } from "@/lib/security/crypto";
import { isValidEmail, isValidIranMobile, normalizeMobile } from "@/lib/persian";
import { rateLimit } from "@/lib/security/cache";
import { cache } from "@/lib/security/cache";

const Schema = z.object({
  mobile: z.string(),
  verifyToken: z.string().min(16),
  firstName: z.string().min(2, "نام باید حداقل ۲ نویسه باشد.").max(60),
  lastName: z.string().min(2, "نام خانوادگی باید حداقل ۲ نویسه باشد.").max(80),
  email: z.string().email("ایمیل نامعتبر است."),
  password: z.string().min(8, "رمز عبور باید حداقل ۸ نویسه باشد.").max(128),
  activityType: z.enum(["personal", "business", "marketer", "service", "media", "other"]),
  businessName: z.string().max(120).optional().default(""),
  referralCode: z.string().max(12).optional(),
});

export async function POST(req: Request) {
  const ip = clientIp(req);
  const rl = await rateLimit({ key: `register:${ip}`, limit: 5, windowMs: 60 * 60 * 1000 });
  if (!rl.ok) return NextResponse.json({ errorFa: "تعداد تلاش‌ها بیش از حد مجاز بود." }, { status: 429 });

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." }, { status: 400 });
  }
  const { mobile: m, verifyToken, firstName, lastName, email, password, activityType, businessName, referralCode } = parsed.data;
  const mobile = normalizeMobile(m);
  if (!isValidIranMobile(mobile)) return NextResponse.json({ errorFa: "موبایل نامعتبر است." }, { status: 400 });
  if (!isValidEmail(email)) return NextResponse.json({ errorFa: "ایمیل نامعتبر است." }, { status: 400 });

  // Verify the OTP token
  const stored = await cache.get<string>(`verify:register:${mobile}`);
  if (!stored || stored !== hashToken(verifyToken)) {
    return NextResponse.json({ errorFa: "توکن تأیید نامعتبر یا منقضی است." }, { status: 403 });
  }
  await cache.del(`verify:register:${mobile}`);

  const dupEmail = await db.user.findUnique({ where: { email: email.toLowerCase() } });
  if (dupEmail) return NextResponse.json({ errorFa: "این ایمیل قبلاً ثبت شده است." }, { status: 409 });
  const dupMobile = await db.user.findUnique({ where: { mobile } });
  if (dupMobile) return NextResponse.json({ errorFa: "این موبایل قبلاً ثبت شده است." }, { status: 409 });

  let referredById: string | undefined;
  if (referralCode) {
    const ref = await db.user.findUnique({ where: { referralCode: referralCode.toUpperCase() }, select: { id: true } });
    if (!ref) return NextResponse.json({ errorFa: "کد معرف نامعتبر است." }, { status: 400 });
    referredById = ref.id;
  }

  const passwordHash = await hashPassword(password);
  const code = await newReferralCode();
  // FIRST-ADMIN RULE (audit §8 — race-safe, unified with /api/auth/register):
  // the user is always created unprivileged; the atomic SystemSetting
  // bootstrap claim decides who becomes admin. Previously this route used
  // an unsafe count-then-create AND set role=admin WITHOUT isSuperAdmin,
  // diverging from the email register route.
  const userCount = await db.user.count();
  const possiblyFirst = userCount === 0;
  const created = await db.user.create({
    data: {
      firstName, lastName,
      email: email.toLowerCase(),
      mobile,
      passwordHash,
      activityType,
      businessName,
      referralCode: code,
      referredById: referredById ?? null,
      role: "user",
      isSuperAdmin: false,
    },
  });
  let role = "user";
  if (possiblyFirst && (await claimFirstAdmin(created.id))) {
    const promoted = await db.user.update({
      where: { id: created.id },
      data: { role: "admin", isSuperAdmin: true },
    });
    role = promoted.role;
  }
  await db.profile.create({ data: { userId: created.id } });
  await createSession(created.id, ip, req.headers.get("user-agent"));
  await audit({ actor: "user", action: role === "admin" ? "register_first_admin" : "register_otp", targetType: "user", targetId: created.id, ip, meta: { email, mobile, role } });
  return NextResponse.json({ ok: true, user: { id: created.id, firstName, role } });
}
