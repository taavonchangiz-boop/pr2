// POSTYAR — GET /api/stats/me
// Aggregated analytics for the signed-in user: per-channel views/clicks +
// growth (this week vs last week publishes), per-post views, top glass
// buttons by clicks, and a plan-usage snapshot. All values are real DB state.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, AuthError, safeJsonParse } from "@/lib/server/auth";
import { getQuotaState } from "@/lib/payments/plans";

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }

  try {
    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const thisWeekStart = new Date(now - weekMs);
    const lastWeekStart = new Date(now - 2 * weekMs);

    const [contents, destinations, publishes, buttons, sub] = await Promise.all([
      db.content.findMany({
        where: { ownerId: user.id },
        select: { id: true, title: true, status: true, views: true },
        orderBy: { views: "desc" },
        take: 50,
      }),
      db.destination.findMany({
        where: { ownerId: user.id, status: { not: "deleted" } },
        select: { id: true, label: true, provider: true, views: true, clicks: true, status: true },
        orderBy: { views: "desc" },
        take: 50,
      }),
      db.publishJob.findMany({
        where: { destination: { ownerId: user.id } },
        select: { id: true, status: true, destinationId: true, contentId: true, createdAt: true, deliveredAt: true },
      }),
      db.glassButton.findMany({
        where: { destination: { ownerId: user.id } },
        select: { id: true, label: true, clicks: true, destinationId: true },
        orderBy: { clicks: "desc" },
        take: 10,
      }),
      db.subscription.findFirst({
        where: { userId: user.id, status: "active" },
        include: { plan: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const deliveredCount = publishes.filter((p) => p.status === "delivered").length;
    const failedCount = publishes.filter((p) => p.status === "failed").length;

    // Growth: publishes created this week vs last week.
    const thisWeek = publishes.filter((p) => p.createdAt >= thisWeekStart).length;
    const lastWeek = publishes.filter((p) => p.createdAt >= lastWeekStart && p.createdAt < thisWeekStart).length;
    const growthPct = lastWeek === 0 ? (thisWeek > 0 ? 100 : 0) : Math.round(((thisWeek - lastWeek) / lastWeek) * 100);

    // Per-channel aggregate publishes
    const perChannel = destinations.map((d) => {
      const dj = publishes.filter((p) => p.destinationId === d.id);
      return {
        id: d.id,
        label: d.label,
        provider: d.provider,
        views: d.views,
        clicks: d.clicks,
        publishes: dj.length,
        delivered: dj.filter((p) => p.status === "delivered").length,
        failed: dj.filter((p) => p.status === "failed").length,
      };
    });

    // Per-post aggregate
    const perPost = contents.map((c) => {
      const cp = publishes.filter((p) => p.contentId === c.id);
      return {
        id: c.id,
        title: c.title,
        views: c.views,
        status: c.status,
        publishes: cp.length,
        delivered: cp.filter((p) => p.status === "delivered").length,
      };
    });

    const totalViews =
      contents.reduce((s, c) => s + (c.views || 0), 0) +
      destinations.reduce((s, d) => s + (d.views || 0), 0);
    const totalClicks =
      destinations.reduce((s, d) => s + (d.clicks || 0), 0) +
      buttons.reduce((s, b) => s + (b.clicks || 0), 0);

    // Plan usage snapshot
    let usage: {
      planName: string | null;
      intervalMonths: number | null;
      remainingDays: number | null;
      publishUsed: number;
      publishQuota: number | null;
      aiUsed: number;
      aiQuota: number | null;
      channelsUsed: number;
      channelsQuota: number | null;
      endsAt: string | null;
    } = {
      planName: sub?.plan?.nameFa ?? null,
      intervalMonths: sub?.plan?.intervalMonths ?? null,
      remainingDays: sub?.endsAt ? Math.max(0, Math.ceil((sub.endsAt.getTime() - now) / (24 * 60 * 60 * 1000))) : null,
      publishUsed: 0,
      publishQuota: null,
      aiUsed: 0,
      aiQuota: null,
      channelsUsed: destinations.length,
      channelsQuota: null,
      endsAt: sub?.endsAt ? sub.endsAt.toISOString() : null,
    };
    // P2.2 — the usage snapshot comes from the quota engine's authoritative
    // CAS counters (publishPerMonth/aiPerMonth), not the legacy
    // non-atomic `publishUsed` key.
    const quotaState = await getQuotaState(user.id);
    usage = {
      ...usage,
      publishUsed: quotaState.publishPerMonth.used,
      publishQuota: quotaState.publishPerMonth.limit < 0 ? null : quotaState.publishPerMonth.limit,
      aiUsed: quotaState.aiPerMonth.used,
      aiQuota: quotaState.aiPerMonth.limit < 0 ? null : quotaState.aiPerMonth.limit,
      channelsQuota: quotaState.channels.limit < 0 ? null : quotaState.channels.limit,
    };

    return NextResponse.json({
      summary: {
        totalContents: contents.length,
        totalDestinations: destinations.length,
        totalPublishes: publishes.length,
        deliveredCount,
        failedCount,
        deliveryRate: publishes.length ? Math.round((deliveredCount / publishes.length) * 100) : 0,
        totalViews,
        totalClicks,
        totalButtons: buttons.length,
      },
      growth: { thisWeek, lastWeek, pct: growthPct },
      channels: perChannel,
      posts: perPost,
      topButtons: buttons.map((b) => ({ id: b.id, label: b.label, clicks: b.clicks })),
      usage,
    });
  } catch (e) {
    console.error("stats me failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ errorFa: "خطا در محاسبهٔ آمار." }, { status: 500 });
  }
}
