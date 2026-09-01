// POSTYAR registration API — all 7 fields required.
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { hashPassword, newReferralCode, clientIp, audit, createSession, claimFirstAdmin } from "@/lib/server/auth";
import { isValidEmail, isValidIranMobile, normalizeMobile } from "@/lib/persian";
import { rateLimit } from "@/lib/security/cache";
import { ensurePlansSeeded } from "@/lib/payments/plans";

const Schema = z.object({
  firstName: z.string().min(2, "نام باید حداقل ۲ نویسه باشد.").max(60),
  lastName: z.string().min(2, "نام خانوادگی باید حداقل ۲ نویسه باشد.").max(80),
  email: z.string().email("ایمیل نامعتبر است."),
  mobile: z.string(),
  password: z.string().min(8, "رمز عبور باید حداقل ۸ نویسه باشد.").max(128),
  activityType: z.enum(["personal", "business", "marketer", "service", "media", "other"]),
  businessName: z.string().max(120).optional().default(""),
  referralCode: z.string().max(12).optional(),
});

export async function POST(req: Request) {
  const ip = clientIp(req);
  const rl = await rateLimit({ key: `register:${ip}`, limit: 5, windowMs: 60 * 60 * 1000, critical: true });
  if (!rl.ok) {
    return NextResponse.json({ errorFa: "تعداد تلاش‌ها بیش از حد مجاز بود. یک ساعت بعد امتحان کنید." }, { status: 429 });
  }
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." }, { status: 400 });
  }
  const { firstName, lastName, email, mobile, password, activityType, businessName, referralCode } = parsed.data;
  const normMobile = normalizeMobile(mobile);
  if (!isValidIranMobile(normMobile)) {
    return NextResponse.json({ errorFa: "شماره موبایل ایرانی وارد کنید (۰۹XXXXXXXXX)." }, { status: 400 });
  }
  if (!isValidEmail(email)) {
    return NextResponse.json({ errorFa: "ایمیل نامعتبر است." }, { status: 400 });
  }
  const dupEmail = await db.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true } });
  if (dupEmail) return NextResponse.json({ errorFa: "این ایمیل قبلاً ثبت شده است." }, { status: 409 });
  const dupMobile = await db.user.findUnique({ where: { mobile: normMobile }, select: { id: true } });
  if (dupMobile) return NextResponse.json({ errorFa: "این موبایل قبلاً ثبت شده است." }, { status: 409 });

  let referredById: string | undefined;
  if (referralCode) {
    const ref = await db.user.findUnique({ where: { referralCode: referralCode.toUpperCase() }, select: { id: true } });
    if (!ref) return NextResponse.json({ errorFa: "کد معرف نامعتبر است." }, { status: 400 });
    referredById = ref.id;
  }

  const passwordHash = await hashPassword(password);
  const code = await newReferralCode();
  // FIRST-ADMIN RULE (audit §8 — race-safe): the user is ALWAYS created
  // unprivileged first. The first registration to win the atomic
  // SystemSetting bootstrap claim (database-level UNIQUE, safe across
  // concurrent requests AND multiple app instances) is promoted to
  // admin+superAdmin afterwards. The previous count-then-create pattern
  // allowed two parallel registrations to BOTH become super-admin.
  const userCount = await db.user.count();
  const possiblyFirst = userCount === 0;

  // Make sure the FREE plan exists before we try to attach a subscription to it.
  // (plans.ts auto-seeds on import, but we call explicitly to be safe.)
  await ensurePlansSeeded();
  const freePlan = await db.plan.findUnique({ where: { code: "free" } });

  const endsAt = new Date();
  endsAt.setMonth(endsAt.getMonth() + 1); // 1-month rolling free subscription.

  const created = await db.user.create({
    data: {
      firstName, lastName,
      email: email.toLowerCase(),
      mobile: normMobile,
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
  const user = { ...created, role };
  await db.profile.create({ data: { userId: created.id } });

  // AUTO-ACTIVATE FREE PLAN on signup — the user gets the free plan
  // IMMEDIATELY, NO checkout step. The free plan is "locked-by-default":
  // a user gets exactly ONE free subscription at signup; they cannot re-grant
  // it later via the plans page (the plans page will show "اشتراک فعال" and
  // hide the checkout button for the free plan while a free subscription is
  // still active or even expired-and-renewable).
  if (freePlan) {
    // V4 M-14 — the auto-activated FREE row must carry the SAME UNIQUE
    // activeKey (`${userId}:${planId}`) identity used by
    // activateSubscription/ensureQuotaTarget, so it lives INSIDE the
    // one-live-row-per-plan invariant instead of as an invisible zombie
    // row that expiry reconciliation cannot see or renew.
    await db.subscription.create({
      data: {
        userId: user.id,
        planId: freePlan.id,
        status: "active",
        activeKey: `${user.id}:${freePlan.id}`,
        startedAt: new Date(),
        endsAt,
        usedQuota: "{}",
      },
    });
  }

  await audit({ actor: "user", action: role === "admin" ? "register_first_admin" : "register", targetType: "user", targetId: user.id, ip, meta: { email, mobile: normMobile, role, freePlanActivated: Boolean(freePlan) } });
  // Create a session so the freshly-registered user is immediately logged in.
  await createSession(user.id, ip, req.headers.get("user-agent"));
  return NextResponse.json({ ok: true, userId: user.id, user: { id: user.id, firstName, role: user.role } });
}
