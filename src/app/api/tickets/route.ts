// POSTYAR — /api/tickets
// POST create, GET list mine
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, clientIp, AuthError } from "@/lib/server/auth";
import { requirePlanFeature } from "@/lib/payments/plans";
import { createTicket, listMyTickets, type TicketCategory, type TicketPriority } from "@/lib/tickets";

const CreateSchema = z.object({
  subject: z.string().min(3).max(200),
  body: z.string().min(3).max(8000),
  category: z.enum(["general", "billing", "technical", "ai", "gold", "woo", "bot", "security"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  departmentId: z.string().min(1).nullable().optional(),
});

export async function GET(req: Request) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const status = url.searchParams.get("status") ?? undefined;
  const r = await listMyTickets(user.id, {
    limit: Number.isFinite(limit) ? limit : 50,
    offset: Number.isFinite(offset) ? offset : 0,
    status: status ?? undefined,
  });
  return NextResponse.json(r);
}

export async function POST(req: Request) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  // V5 H-12 — uniformity gate: the create_ticket workflow action requires
  // the `tickets` plan feature, but this UI/API boundary did not. Every
  // privileged action boundary must call the capability check (P0.15).
  // V6 M-01 — AuthError-only response: requirePlanFeature performs DB
  // reads, so a non-AuthError failure (e.g. a Prisma driver error) must
  // NEVER be echoed to the client (raw driver text + status undefined →
  // HTTP 200). Anything else becomes a generic 500.
  try {
    await requirePlanFeature(user.id, "tickets");
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ errorFa: e.message }, { status: e.status });
    }
    console.error("tickets plan gate failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ errorFa: "خطای داخلی سرور." }, { status: 500 });
  }
  const ip = clientIp(req);
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }
  const r = await createTicket({
    userId: user.id,
    subject: parsed.data.subject,
    body: parsed.data.body,
    category: parsed.data.category as TicketCategory | undefined,
    priority: parsed.data.priority as TicketPriority | undefined,
    departmentId: parsed.data.departmentId ?? undefined,
    ip,
  });
  if (!r.ok || !r.ticket) {
    return NextResponse.json({ errorFa: r.errorFa ?? "ایجاد تیکت ناموفق بود." }, { status: 400 });
  }
  return NextResponse.json({ ok: true, ticket: r.ticket }, { status: 201 });
}
