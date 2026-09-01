// POSTYAR — /api/bots/[id]/link-codes
// GET: list link codes for this bot (with consumed status; never plaintext).
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, AuthError } from "@/lib/server/auth";
import { listLinkCodesForBot } from "@/lib/bots/link";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const { id } = await params;
  // Verify ownership before listing
  const bot = await db.bot.findFirst({ where: { id, ownerId: user.id }, select: { id: true } });
  if (!bot) {
    return NextResponse.json({ errorFa: "ربات یافت نشد." }, { status: 404 });
  }
  try {
    const items = await listLinkCodesForBot(id, user.id);
    return NextResponse.json({ items });
  } catch (err) {
    // V4 M-13 — only intentional AuthError messages reach the client;
    // anything else is logged server-side and answered generically.
    if (err instanceof AuthError) {
      return NextResponse.json({ errorFa: err.message }, { status: err.status });
    }
    console.error("list link codes failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ errorFa: "دریافت کدها ناموفق بود." }, { status: 500 });
  }
}
