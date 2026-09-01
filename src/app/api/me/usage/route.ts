// POSTYAR — GET /api/me/usage
// Plan usage snapshot for the signed-in user: the active plan's quotas vs.
// consumed amounts + remaining days + the parsed `planFeatures` map (so the
// dashboard can gate nav items by the active subscription's plan features).
// Powers the dashboard "consumption counter" widget + the
// subscription-gated menu (Item 9 of the dashboard redesign integration).
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, AuthError } from "@/lib/server/auth";
import {
  getQuotaState,
  getActiveSubscription,
  parsePlanFeatures,
  getEffectiveFeatures,
  type PlanFeatures,
} from "@/lib/payments/plans";

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }

  try {
    const now = Date.now();
    // P2.2 — single source of truth: the dashboard usage snapshot comes
    // from the quota engine (publishPerMonth/aiPerMonth CAS counters), NOT
    // from the legacy best-effort `publishUsed` key that the old schedule
    // route wrote non-atomically.
    const [state, sub, destinationsCount] = await Promise.all([
      getQuotaState(user.id),
      getActiveSubscription(user.id),
      db.destination.count({ where: { ownerId: user.id, status: { not: "deleted" } } }),
    ]);
    const planFeatures = await getEffectiveFeatures(user.id);

    if (!sub || !sub.plan) {
      return NextResponse.json({
        hasActivePlan: false,
        planName: state.planNameFa ?? null,
        remainingDays: 0,
        publishUsed: state.publishPerMonth.used,
        publishQuota: state.publishPerMonth.limit,
        aiUsed: state.aiPerMonth.used,
        aiQuota: state.aiPerMonth.limit,
        channelsUsed: destinationsCount,
        channelsQuota: state.channels.limit,
        endsAt: null,
        // Free-plan features still gate the dashboard nav.
        planFeatures: planFeatures as PlanFeatures,
        planCode: "free",
      });
    }

    const remainingDays = Math.max(0, Math.ceil((sub.endsAt.getTime() - now) / (24 * 60 * 60 * 1000)));

    return NextResponse.json({
      hasActivePlan: true,
      planName: sub.plan.nameFa,
      planCode: sub.plan.code,
      intervalMonths: sub.plan.intervalMonths,
      remainingDays,
      publishUsed: state.publishPerMonth.used,
      publishQuota: state.publishPerMonth.limit,
      aiUsed: state.aiPerMonth.used,
      aiQuota: state.aiPerMonth.limit,
      channelsUsed: destinationsCount,
      channelsQuota: state.channels.limit,
      endsAt: sub.endsAt.toISOString(),
      planFeatures: parsePlanFeatures(sub.plan.features) as PlanFeatures,
    });
    } catch (e) {
    console.error("usage failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ errorFa: "خطا در خواندن مصرف پلن." }, { status: 500 });
  }
}
