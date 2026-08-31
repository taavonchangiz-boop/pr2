// POSTYAR — GET /api/stats/admin
// Detailed, segregated platform analytics for the admin: user/role breakdown,
// subscriptions, revenue (paid orders), content/destination/publish job
// statuses, bots, notifications, tickets, ads, AI jobs, audit volume, top
// publishers, and week-over-week publish growth.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/server/auth";
import { formatCompactRials, formatJalaliDateTime } from "@/lib/persian";

export async function GET() {
  let admin;
  try {
    admin = await requireRole(["admin"]);
  } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  void admin;

  try {
    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const thisWeekStart = new Date(now - weekMs);
    const lastWeekStart = new Date(now - 2 * weekMs);

    const [
      usersTotal,
      usersByRole,
      usersByStatus,
      usersNewThisWeek,
      subsActive,
      subsExpired,
      subsCancelled,
      subsTotal,
      revenueAgg,
      ordersTotal,
      ordersPaid,
      contentsTotal,
      contentsByStatus,
      destinationsTotal,
      publishJobsTotal,
      publishByStatus,
      botsTotal,
      botsActive,
      notifTotal,
      notifUnread,
      ticketsTotal,
      ticketsByStatus,
      adsTotal,
      adsApproved,
      aiJobsTotal,
      auditTotal,
      publishesRecent,
      topContentOwners,
    ] = await Promise.all([
      db.user.count(),
      db.user.groupBy({ by: ["role"], _count: true }),
      db.user.groupBy({ by: ["status"], _count: true }),
      db.user.count({ where: { createdAt: { gte: thisWeekStart } } }),
      db.subscription.count({ where: { status: "active" } }),
      db.subscription.count({ where: { status: "expired" } }),
      db.subscription.count({ where: { status: "cancelled" } }),
      db.subscription.count(),
      db.order.aggregate({ where: { status: "paid" }, _sum: { amountRials: true } }),
      db.order.count(),
      db.order.count({ where: { status: "paid" } }),
      db.content.count(),
      db.content.groupBy({ by: ["status"], _count: true }),
      db.destination.count({ where: { status: { not: "deleted" } } }),
      db.publishJob.count(),
      db.publishJob.groupBy({ by: ["status"], _count: true }),
      db.bot.count(),
      db.bot.count({ where: { status: "active" } }),
      db.notification.count(),
      db.notification.count({ where: { readAt: null } }),
      db.ticket.count(),
      db.ticket.groupBy({ by: ["status"], _count: true }),
      db.adCampaign.count(),
      db.adCampaign.count({ where: { status: "approved" } }),
      db.aiJob.count(),
      db.auditLog.count(),
      db.publishJob.findMany({ select: { createdAt: true }, take: 5000, orderBy: { createdAt: "desc" } }),
      db.content.groupBy({ by: ["ownerId"], _count: true, orderBy: { _count: { ownerId: "desc" } }, take: 8 }),
    ]);

    // Resolve top publishers' names
    const topOwnerIds = topContentOwners.map((t) => t.ownerId);
    const topOwners = topOwnerIds.length
      ? await db.user.findMany({ where: { id: { in: topOwnerIds } }, select: { id: true, firstName: true, lastName: true, email: true } })
      : [];
    const ownerMap = new Map(topOwners.map((u) => [u.id, u]));
    const topPublishers = topContentOwners.map((t) => {
      const u = ownerMap.get(t.ownerId);
      return {
        id: t.ownerId,
        name: u ? `${u.firstName} ${u.lastName}` : "—",
        email: u?.email ?? null,
        contentCount: t._count,
      };
    });

    const thisWeekP = publishesRecent.filter((p) => p.createdAt >= thisWeekStart).length;
    const lastWeekP = publishesRecent.filter((p) => p.createdAt >= lastWeekStart && p.createdAt < thisWeekStart).length;
    const growthPct = lastWeekP === 0 ? (thisWeekP > 0 ? 100 : 0) : Math.round(((thisWeekP - lastWeekP) / lastWeekP) * 100);

    const revenueRials = revenueAgg._sum.amountRials ?? 0;

    const byRole = Object.fromEntries(usersByRole.map((r) => [r.role, r._count]));
    const byStatus = Object.fromEntries(usersByStatus.map((r) => [r.status, r._count]));
    const contentByStatus = Object.fromEntries(contentsByStatus.map((r) => [r.status, r._count]));
    const publishByStatusMap = Object.fromEntries(publishByStatus.map((r) => [r.status, r._count]));
    const ticketByStatus = Object.fromEntries(ticketsByStatus.map((r) => [r.status, r._count]));

    return NextResponse.json({
      users: {
        total: usersTotal,
        byRole,
        byStatus,
        newThisWeek: usersNewThisWeek,
        admins: byRole.admin ?? 0,
      },
      subscriptions: {
        total: subsTotal,
        active: subsActive,
        expired: subsExpired,
        cancelled: subsCancelled,
      },
      revenue: {
        rials: revenueRials,
        fa: formatCompactRials(revenueRials),
      },
      orders: { total: ordersTotal, paid: ordersPaid },
      content: { total: contentsTotal, byStatus: contentByStatus },
      destinations: destinationsTotal,
      publish: {
        total: publishJobsTotal,
        byStatus: publishByStatusMap,
        delivered: publishByStatusMap.delivered ?? 0,
        failed: publishByStatusMap.failed ?? 0,
        queued: publishByStatusMap.queued ?? 0,
        scheduled: publishByStatusMap.scheduled ?? 0,
      },
      bots: { total: botsTotal, active: botsActive },
      notifications: { total: notifTotal, unread: notifUnread },
      tickets: { total: ticketsTotal, byStatus: ticketByStatus },
      ads: { total: adsTotal, approved: adsApproved },
      aiJobs: aiJobsTotal,
      audit: auditTotal,
      growth: { thisWeek: thisWeekP, lastWeek: lastWeekP, pct: growthPct },
      topPublishers,
      // Jalali-formatted generation timestamp (Tehran TZ, with HH:mm) so the
      // admin UI never shows a Gregorian date anywhere.
      generatedAtFa: formatJalaliDateTime(new Date(), { withTime: true }),
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("stats admin failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ errorFa: "خطا در محاسبهٔ آمار مدیریت." }, { status: 500 });
  }
}
