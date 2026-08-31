// POSTYAR — GET /api/me/usage
// Plan usage snapshot for the signed-in user: the active plan's quotas vs.
// consumed amounts + remaining days + the parsed `planFeatures` map (so the
// dashboard can gate nav items by the active subscription's plan features).
// Powers the dashboard "consumption counter" widget + the
// subscription-gated menu (Item 9 of the dashboard redesign integration).
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, AuthError, safeJsonParse } from "@/lib/server/auth";
import { parsePlanFeatures, type PlanFeatures } from "@/lib/payments/plans";

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }

  try {
    const now = Date.now();
    const [sub, destinationsCount] = await Promise.all([
      db.subscription.findFirst({
        where: { userId: user.id, status: "active" },
        include: { plan: true },
        orderBy: { createdAt: "desc" },
      }),
      db.destination.count({ where: { ownerId: user.id, status: { not: "deleted" } } }),
    ]);

    if (!sub || !sub.plan) {
      return NextResponse.json({
        hasActivePlan: false,
        planName: null,
        remainingDays: 0,
        publishUsed: 0,
        publishQuota: 0,
        aiUsed: 0,
        aiQuota: 0,
        channelsUsed: destinationsCount,
        channelsQuota: 0,
        endsAt: null,
        // No active subscription → no plan features → the dashboard shows
        // only the always-on "account essentials" nav items + an upgrade
        // CTA when the user tries to reach a gated feature.
        planFeatures: {} as PlanFeatures,
        planCode: null,
      });
    }

    const used = safeJsonParse<{ publishUsed?: number; aiUsed?: number }>(sub.usedQuota, { publishUsed: 0 });
    const quota = safeJsonParse<{ publishPerMonth?: number; aiPerMonth?: number; channels?: number }>(sub.plan.quota ?? null, {});

    const remainingDays = Math.max(0, Math.ceil((sub.endsAt.getTime() - now) / (24 * 60 * 60 * 1000)));

    return NextResponse.json({
      hasActivePlan: true,
      planName: sub.plan.nameFa,
      planCode: sub.plan.code,
      intervalMonths: sub.plan.intervalMonths,
      remainingDays,
      publishUsed: used.publishUsed ?? 0,
      publishQuota: quota.publishPerMonth ?? 0,
      aiUsed: used.aiUsed ?? 0,
      aiQuota: quota.aiPerMonth ?? 0,
      channelsUsed: destinationsCount,
      channelsQuota: quota.channels ?? 0,
      endsAt: sub.endsAt.toISOString(),
      // The parsed `PlanFeatures` map (booleans + numerics) from
      // Plan.features. Used by the dashboard to gate nav items + render the
      // «ارتقای پلن» upgrade card when the user lands on a gated view.
      planFeatures: parsePlanFeatures(sub.plan.features) as PlanFeatures,
    });
  } catch (e) {
    console.error("usage failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ errorFa: "خطا در خواندن مصرف پلن." }, { status: 500 });
  }
}
