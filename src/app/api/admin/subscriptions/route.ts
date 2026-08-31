// POSTYAR — GET /api/admin/subscriptions — list all subscriptions (admin only)
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/server/auth";
import { formatRials, formatJalaliDate } from "@/lib/persian";

export async function GET(req: Request) {
  let user;
  try { user = await requireRole(["admin"]); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  void user;
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get("pageSize") ?? "20") || 20));
  const status = url.searchParams.get("status") ?? undefined;
  const [rows, total] = await Promise.all([
    db.subscription.findMany({
      where: status ? { status } : undefined,
      include: { plan: true, user: { select: { id: true, email: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.subscription.count({ where: status ? { status } : undefined }),
  ]);
  return NextResponse.json({
    items: rows.map((s) => ({
      id: s.id,
      userId: s.userId,
      userEmail: s.user.email,
      userFullName: `${s.user.firstName} ${s.user.lastName}`,
      planId: s.planId,
      planName: s.plan.nameFa,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      startedAtFa: formatJalaliDate(s.startedAt),
      endsAt: s.endsAt.toISOString(),
      endsAtFa: formatJalaliDate(s.endsAt),
      priceFa: formatRials(s.plan.priceRials),
    })),
    total,
    page,
    pageSize,
  });
}
