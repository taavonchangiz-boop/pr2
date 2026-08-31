// POSTYAR — GET /api/subscriptions — my subscription + quota state
import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/server/auth";
import { getActiveSubscription, getQuotaState } from "@/lib/payments/plans";

export async function GET() {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  try {
    const [sub, quota] = await Promise.all([
      getActiveSubscription(user.id),
      getQuotaState(user.id),
    ]);
    return NextResponse.json({
      subscription: sub
        ? {
            id: sub.id,
            planId: sub.planId,
            planNameFa: sub.plan.nameFa,
            status: sub.status,
            startedAt: sub.startedAt.toISOString(),
            endsAt: sub.endsAt.toISOString(),
          }
        : null,
      quota,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "خطا در دریافت اشتراک‌ها.";
    console.error("subscriptions failed:", msg);
    return NextResponse.json({ errorFa: "خطا در دریافت اشتراک‌ها." }, { status: 500 });
  }
}
