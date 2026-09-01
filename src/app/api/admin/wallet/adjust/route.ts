// POSTYAR — POST /api/admin/wallet/adjust — admin wallet adjustment (admin only)
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole, clientIp, AuthError } from "@/lib/server/auth";
import { adminAdjustWallet } from "@/lib/payments/wallet";
import { formatRials } from "@/lib/persian";

const BodySchema = z.object({
  userId: z.string().min(1),
  amount: z.number().int().refine((v) => v !== 0, "مبلغ باید غیر صفر باشد."),
  reason: z.string().max(500).optional(),
  idempotencyKey: z.string().min(8).max(120),
});

export async function POST(req: Request) {
  let user;
  try { user = await requireRole(["admin"]); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }
  try {
    const result = await adminAdjustWallet({
      userId: parsed.data.userId,
      amount: parsed.data.amount,
      reason: parsed.data.reason ?? "",
      idempotencyKey: parsed.data.idempotencyKey,
      adminId: user.id,
      ip,
    });
    return NextResponse.json({
      ok: true,
      balanceRials: result.balanceRials,
      balanceFa: formatRials(result.balanceRials),
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ errorFa: e.message }, { status: e.status });
    }
    const msg = e instanceof Error ? e.message : "خطای داخلی.";
    // M-10: log the raw error server-side, return a bounded generic
    // message — raw Prisma/provider/SQL text must never reach clients.
    console.error("admin wallet adjust failed:", msg);
    return NextResponse.json({ errorFa: "خطا در تعدیل کیف پول." }, { status: 500 });
  }
}
