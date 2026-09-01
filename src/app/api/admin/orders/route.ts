// POSTYAR — GET /api/admin/orders — list all orders (admin only)
// ---------------------------------------------------------------------
// Full-text indexed + filterable + paginated admin orders endpoint.
//
// Supported query params:
//   status    "pending" | "awaiting_review" | "awaiting_payment" | "paid"
//             | "rejected" | "failed" | "cancelled" | "expired"
//   kind      "subscription" | "wallet_credit" | "ad_campaign"
//   provider  "card" | "bank" | "bale"
//   q         free-text search across order id, user email, user mobile
//   from      Jalali date "YYYY-MM-DD" or "YYYY/MM/DD" (Persian digits
//             accepted) — inclusive lower bound on `createdAt`
//   to        Jalali date — inclusive upper bound on `createdAt`
//   page      1-based page number
//   pageSize  page size (clamped to [1..100])
//
// Response shape:
//   { orders: [...], total, page, pageSize }
// where each row carries the same fields as the existing
// `AdminOrderRow` shape used by the admin UI (user, kindFa, amountFa,
// providerFa, status, createdAtFa, etc.).
//
// Required role: admin (enforced via `requireRole(["admin"])`).
// ---------------------------------------------------------------------
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/server/auth";
import {
  formatRials,
  formatJalaliDateTime,
  jalaliToUtcIso,
  fromPersianDigits,
} from "@/lib/persian";

const KIND_FA: Record<string, string> = {
  subscription: "اشتراک",
  wallet_credit: "شارژ کیف پول",
  ad_campaign: "کمپین تبلیغاتی",
};

const PROVIDER_FA: Record<string, string> = {
  card: "کارت به کارت",
  bank: "درگاه بانکی",
  bale: "پرداخت با بله",
};

const STATUS_FA: Record<string, string> = {
  pending: "در انتظار پرداخت",
  awaiting_payment: "در انتظار پرداخت",
  awaiting_review: "در انتظار بررسی",
  paid: "پرداخت‌شده",
  rejected: "رد‌شده",
  failed: "ناموفق",
  cancelled: "لغوشده",
  refunded: "بازگشت‌داده‌شده",
  expired: "منقضی",
};

/**
 * Parse a Jalali date string ("1403-05-12" or "1403/05/12", Persian digits
 * accepted) into a UTC ISO timestamp. Returns null when the input is empty
 * or malformed. `endOfDay=true` sets the time to 23:59:59 Tehran so the
 * upper bound is inclusive.
 */
function parseJalaliToUtcIso(raw: string | null | undefined, endOfDay: boolean): string | null {
  if (!raw) return null;
  const normalized = fromPersianDigits(raw).trim();
  // Accept "YYYY-MM-DD" or "YYYY/MM/DD".
  const m = normalized.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;
  const jy = Number(m[1]);
  const jm = Number(m[2]);
  const jd = Number(m[3]);
  if (!jy || !jm || !jd) return null;
  if (jm < 1 || jm > 12 || jd < 1 || jd > 31) return null;
  const hour = endOfDay ? 23 : 0;
  const minute = endOfDay ? 59 : 0;
  // `jalaliToUtcIso` interprets (jy, jm, jd, hour, minute) as Tehran time
  // and returns a UTC ISO. We additionally add 59 seconds for `endOfDay`
  // so the upper bound covers the entire last second of the day.
  try {
    const iso = jalaliToUtcIso(jy, jm, jd, hour, minute);
    if (endOfDay) {
      const d = new Date(iso);
      d.setSeconds(59, 999);
      return d.toISOString();
    }
    return iso;
  } catch {
    return null;
  }
}

function maskMobile(m: string): string {
  if (m.length < 6) return "••••••";
  return `${m.slice(0, 4)}•••••${m.slice(-2)}`;
}

export async function GET(req: Request) {
  let user;
  try {
    user = await requireRole(["admin"]);
  } catch (e) {
    return NextResponse.json(
      { errorFa: (e as AuthError).message },
      { status: (e as AuthError).status },
    );
  }
  void user;

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") ?? "20") || 20));
  const status = url.searchParams.get("status")?.trim() || undefined;
  const kind = url.searchParams.get("kind")?.trim() || undefined;
  const provider = url.searchParams.get("provider")?.trim() || undefined;
  const q = url.searchParams.get("q")?.trim() || undefined;
  const fromIso = parseJalaliToUtcIso(url.searchParams.get("from"), false);
  const toIso = parseJalaliToUtcIso(url.searchParams.get("to"), true);

  // Build a Prisma `where` with AND clauses. Each filter is AND-ed.
  const whereAnd: Array<Record<string, unknown>> = [];
  if (status) whereAnd.push({ status });
  if (kind) whereAnd.push({ kind });
  if (provider) whereAnd.push({ provider });
  if (fromIso) whereAnd.push({ createdAt: { gte: new Date(fromIso) } });
  if (toIso) {
    // Combine with an existing createdAt condition if present.
    const existing = whereAnd.find((c) => "createdAt" in c) as
      | { createdAt: Record<string, unknown> }
      | undefined;
    if (existing) {
      existing.createdAt.lte = new Date(toIso);
    } else {
      whereAnd.push({ createdAt: { lte: new Date(toIso) } });
    }
  }
  if (q) {
    // Free-text search across order id, user email, user mobile.
    // Use a case-insensitive contains (Prisma `mode: "insensitive"` works
    // for SQLite too — Prisma translates to LOWER() LIKE).
    whereAnd.push({
      OR: [
        { id: { contains: q } },
        { user: { email: { contains: q } } },
        { user: { mobile: { contains: q } } },
      ],
    });
  }

  const where = whereAnd.length > 0 ? { AND: whereAnd } : undefined;

  try {
    const [rows, total] = await Promise.all([
      db.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              mobile: true,
              firstName: true,
              lastName: true,
            },
          },
          cardReceipt: { select: { id: true, status: true, reviewedAt: true, adminNotes: true } },
        },
      }),
      db.order.count({ where }),
    ]);

    const orders = rows.map((o) => ({
      id: o.id,
      userId: o.userId,
      userEmail: o.user.email,
      userMobile: o.user.mobile,
      userFullName: `${o.user.firstName} ${o.user.lastName}`.trim(),
      kind: o.kind,
      kindFa: KIND_FA[o.kind] ?? o.kind,
      amountRials: o.amountRials,
      amountFa: formatRials(o.amountRials),
      status: o.status,
      statusFa: STATUS_FA[o.status] ?? o.status,
      provider: o.provider,
      providerFa: o.provider ? (PROVIDER_FA[o.provider] ?? o.provider) : null,
      planId: o.planId,
      descriptionFa: o.descriptionFa,
      createdAt: o.createdAt.toISOString(),
      createdAtFa: formatJalaliDateTime(o.createdAt, { withTime: true }),
      updatedAt: o.updatedAt.toISOString(),
      hasCardReceipt: !!o.cardReceipt,
      receiptStatus: o.cardReceipt?.status ?? null,
      receiptReviewedAt: o.cardReceipt?.reviewedAt?.toISOString() ?? null,
    }));

    return NextResponse.json({ orders, total, page, pageSize });
  } catch (e) {
    return NextResponse.json({ errorFa: "خطای داخلی سرور." }, { status: 500 });
  }
}
