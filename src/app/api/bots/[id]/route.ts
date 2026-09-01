// POSTYAR — /api/bots/[id]
// GET single, PATCH update, DELETE soft-delete
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requireUser,
  requireRole,
  clientIp,
  audit,
  AuthError,
  safeJsonParse,
} from "@/lib/server/auth";
import { encryptString, decryptString } from "@/lib/security/crypto";
import { getDestinationProvider, isValidProviderName } from "@/lib/providers";
import { maskToken } from "@/lib/persian";

const PatchSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  username: z.string().max(64).nullable().optional(),
  status: z.enum(["active", "inactive", "error"]).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  botToken: z.string().min(8).max(256).optional(),
  destinationId: z.string().nullable().optional(),
});

async function loadOwnedBot(id: string, ownerId: string, isAdmin: boolean) {
  if (isAdmin) {
    return db.bot.findUnique({ where: { id } });
  }
  return db.bot.findFirst({
    where: { id, ownerId },
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const { id } = await params;
  const isAdmin = user.role === "admin";
  const bot = await loadOwnedBot(id, user.id, isAdmin);
  if (!bot) {
    return NextResponse.json({ errorFa: "ربات یافت نشد." }, { status: 404 });
  }
  // Compute masked token preview
  let tokenPreview = "••••";
  try { tokenPreview = maskToken(decryptString(bot.botTokenEnc)); } catch { /* ignore */ }
  return NextResponse.json({
    bot: {
      id: bot.id,
      ownerId: bot.ownerId,
      provider: bot.provider,
      name: bot.name,
      username: bot.username,
      status: bot.status,
      lastError: bot.lastError,
      destinationId: bot.destinationId,
      config: safeJsonParse<Record<string, unknown>>(bot.config, {}),
      createdAt: bot.createdAt.toISOString(),
      updatedAt: bot.updatedAt.toISOString(),
      tokenPreview,
      hasWebhookSecret: !!bot.webhookSecret,
    },
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  const { id } = await params;
  const isAdmin = user.role === "admin";
  const existing = await loadOwnedBot(id, user.id, isAdmin);
  if (!existing) {
    return NextResponse.json({ errorFa: "ربات یافت نشد." }, { status: 404 });
  }
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }
  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.username !== undefined) data.username = parsed.data.username;
  if (parsed.data.status !== undefined) data.status = parsed.data.status;
  if (parsed.data.config !== undefined) data.config = JSON.stringify(parsed.data.config);
  if (parsed.data.destinationId !== undefined) {
    // L-1: the reference must exist AND belong to the bot owner (the old
    // code persisted any client-supplied id — dangling/cross-user refs).
    if (parsed.data.destinationId !== null) {
      const dest = await db.destination.findUnique({
        where: { id: parsed.data.destinationId },
        select: { ownerId: true, provider: true },
      });
      if (!dest || dest.ownerId !== user.id) {
        return NextResponse.json({ errorFa: "مقصد نامعتبر است یا متعلق به شما نیست." }, { status: 400 });
      }
    }
    data.destinationId = parsed.data.destinationId;
  }
  if (parsed.data.botToken !== undefined) {
    // Re-verify the new token
    if (!isValidProviderName(existing.provider)) {
      return NextResponse.json({ errorFa: "پروایدر ربات نامعتبر است." }, { status: 400 });
    }
    const destProvider = getDestinationProvider(existing.provider);
    const verifyResult = await destProvider.verifyCredentials({
      botToken: parsed.data.botToken,
      chatId: "",
    });
    if (!verifyResult.ok) {
      return NextResponse.json(
        { errorFa: verifyResult.errorFa ?? "توکن جدید نامعتبر است." },
        { status: 400 },
      );
    }
    data.botTokenEnc = encryptString(parsed.data.botToken);
    // Token change invalidates the existing webhook secret; force a re-register.
    data.webhookSecret = null;
  }
  const updated = await db.bot.update({
    where: { id },
    data,
    select: {
      id: true,
      provider: true,
      name: true,
      username: true,
      status: true,
      updatedAt: true,
    },
  });
  await audit({
    userId: user.id,
    actor: "user",
    action: "bot_updated",
    targetType: "bot",
    targetId: id,
    ip,
    meta: { fields: Object.keys(data) },
  });
  let tokenPreview = "••••";
  if (parsed.data.botToken) tokenPreview = maskToken(parsed.data.botToken);
  return NextResponse.json({ ok: true, bot: updated, tokenPreview });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  const { id } = await params;

  // Hard-delete requires admin role + `hard=true` query param.
  const url = new URL(req.url);
  const hard = url.searchParams.get("hard") === "true";
  if (hard) {
    let adminUser;
    try { adminUser = await requireRole(["admin"]); } catch (e) {
      return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
    }
    const bot = await db.bot.findUnique({ where: { id } });
    if (!bot) {
      return NextResponse.json({ errorFa: "ربات یافت نشد." }, { status: 404 });
    }
    await db.bot.delete({ where: { id } });
    await audit({
      userId: adminUser.id,
      actor: "admin",
      action: "bot_deleted_hard",
      targetType: "bot",
      targetId: id,
      ip,
      meta: { provider: bot.provider, name: bot.name },
    });
    return NextResponse.json({ ok: true, deleted: true });
  }

  // Soft delete for the owner: set status="inactive" + audit.
  const bot = await db.bot.findFirst({ where: { id, ownerId: user.id } });
  if (!bot) {
    return NextResponse.json({ errorFa: "ربات یافت نشد." }, { status: 404 });
  }
  await db.bot.update({
    where: { id },
    data: { status: "inactive", webhookSecret: null },
  });
  await audit({
    userId: user.id,
    actor: "user",
    action: "bot_deleted_soft",
    targetType: "bot",
    targetId: id,
    ip,
    meta: { provider: bot.provider, name: bot.name },
  });
  return NextResponse.json({ ok: true, softDeleted: true });
}
