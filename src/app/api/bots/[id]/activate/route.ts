// POSTYAR — /api/bots/[id]/activate
// Set status=active, register webhook with the provider.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  requireUser,
  clientIp,
  audit,
  AuthError,
} from "@/lib/server/auth";
import { registerWebhook } from "@/lib/bots/register-webhook";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  const { id } = await params;
  const bot = await db.bot.findFirst({ where: { id, ownerId: user.id } });
  if (!bot) {
    return NextResponse.json({ errorFa: "ربات یافت نشد." }, { status: 404 });
  }
  if (bot.status === "active") {
    return NextResponse.json({ ok: true, alreadyActive: true });
  }
  // Flip status to active first; if webhook registration fails we revert.
  await db.bot.update({ where: { id }, data: { status: "active" } });
  let webhookResult: { ok: boolean; supported: boolean; errorFa?: string } | null = null;
  try {
    webhookResult = await registerWebhook(id);
  } catch (err) {
    // V4 M-13 — network/config internals (env var names, provider URLs,
    // raw fetch text) never reach the client; they are logged instead.
    console.error("webhook registration failed:", err instanceof Error ? err.message : err);
    webhookResult = {
      ok: false,
      supported: false,
      errorFa: "ثبت وب‌هوک ناموفق بود. تنظیمات ربات را بررسی کنید و دوباره تلاش کنید.",
    };
  }
  if (webhookResult && !webhookResult.ok && webhookResult.supported) {
    // Telegram/Bale — registration truly failed; revert to inactive.
    await db.bot.update({
      where: { id },
      data: { status: "inactive", lastError: webhookResult.errorFa ?? "ثبت وب‌هوک ناموفق بود." },
    });
    await audit({
      userId: user.id,
      actor: "user",
      action: "bot_activate_failed",
      targetType: "bot",
      targetId: id,
      ip,
      meta: { errorFa: webhookResult.errorFa },
    });
    return NextResponse.json(
      { errorFa: webhookResult.errorFa ?? "ثبت وب‌هوک ناموفق بود." },
      { status: 400 },
    );
  }
  // Rubika (supported=false) — leave active, but show the warning
  await db.bot.update({
    where: { id },
    data: {
      lastError: webhookResult && !webhookResult.supported ? (webhookResult.errorFa ?? null) : null,
    },
  });
  await audit({
    userId: user.id,
    actor: "user",
    action: "bot_activated",
    targetType: "bot",
    targetId: id,
    ip,
    meta: { provider: bot.provider, webhookRegistered: webhookResult?.ok === true },
  });
  return NextResponse.json({
    ok: true,
    webhook: webhookResult,
  });
}
