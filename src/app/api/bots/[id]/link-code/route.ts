// POSTYAR — /api/bots/[id]/link-code
// POST: generate a fresh link code. Returns the plaintext code (one-time).
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  requireUser,
  clientIp,
  AuthError,
} from "@/lib/server/auth";
import { generateLinkCode } from "@/lib/bots/link";
import { requirePlanFeature } from "@/lib/payments/plans";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const { id } = await params;
  // Verify ownership before issuing
  const bot = await db.bot.findFirst({ where: { id, ownerId: user.id } });
  if (!bot) {
    return NextResponse.json({ errorFa: "ربات یافت نشد." }, { status: 404 });
  }
  // P0.15/H-1 — link codes are a plan feature.
  try {
    await requirePlanFeature(user.id, "linkCodes");
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 403;
    const msg = e instanceof AuthError ? e.message : "امکان کدهای اتصال در پلن فعلی شما فعال نیست.";
    return NextResponse.json({ errorFa: msg }, { status });
  }
  try {
    const r = await generateLinkCode({ botId: id, userId: user.id });
    return NextResponse.json({
      ok: true,
      code: r.code,
      expiresAt: r.expiresAt.toISOString(),
      linkCodeId: r.linkCodeId,
      // One-time display — never returned again by any other endpoint.
      instructionsFa:
        "این کد را در چت ربات وارد کنید تا حساب پُست‌یار شما به آن متصل شود. " +
        "کد تنها برای ده دقیقه معتبر است و فقط یک‌بار قابل استفاده است.",
    }, { status: 201 });
  } catch (err) {
    // V4 M-13 — only intentional AuthError messages reach the client;
    // anything else is logged server-side and answered generically.
    if (err instanceof AuthError) {
      return NextResponse.json({ errorFa: err.message }, { status: err.status });
    }
    console.error("generate link code failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ errorFa: "صدور کد اتصال ناموفق بود." }, { status: 500 });
  }
  // clientIp captured for audit inside generateLinkCode (via audit()).
  void clientIp;
}
