// POSTYAR — /api/bots
// POST create a new bot, GET list mine.
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requireUser,
  clientIp,
  audit,
  AuthError,
  safeJsonParse,
} from "@/lib/server/auth";
import { encryptString } from "@/lib/security/crypto";
import { getDestinationProvider, isValidProviderName } from "@/lib/providers";
import { maskToken } from "@/lib/persian";

const CreateSchema = z.object({
  provider: z.enum(["telegram", "bale", "rubika"]),
  name: z.string().min(2, "نام ربات حداقل ۲ نویسه باشد.").max(100),
  botToken: z.string().min(8, "توکن ربات نامعتبر است.").max(256),
  username: z.string().max(64).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export async function GET() {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const bots = await db.bot.findMany({
    where: { ownerId: user.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      provider: true,
      name: true,
      username: true,
      status: true,
      lastError: true,
      destinationId: true,
      config: true,
      createdAt: true,
      updatedAt: true,
      // NEVER expose botTokenEnc or webhookSecret
    },
  });
  const items = bots.map((b) => ({
    ...b,
    config: safeJsonParse<Record<string, unknown>>(b.config, {}),
    tokenPreview: maskTokenPreview(b.id),
  }));
  return NextResponse.json({ items });
}

// Resolve token preview by decrypting then masking — best-effort; if
// decrypt fails we just return "••••". We do this asynchronously per-row
// to keep the list endpoint responsive (10 rows × decrypt is fine).
async function maskTokenPreview(botId: string): Promise<string> {
  const row = await db.bot.findUnique({
    where: { id: botId },
    select: { botTokenEnc: true },
  });
  if (!row || !row.botTokenEnc) return "••••";
  // Import here so the list route doesn't drag decrypt into a client
  // bundle path (we are already in a server route, so this is safe).
  const { decryptString } = await import("@/lib/security/crypto");
  try {
    const token = decryptString(row.botTokenEnc);
    return maskToken(token);
  } catch {
    return "••••";
  }
}

export async function POST(req: Request) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
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
  const { provider, name, botToken, username, config } = parsed.data;
  if (!isValidProviderName(provider)) {
    return NextResponse.json({ errorFa: "پروایدر نامعتبر است." }, { status: 400 });
  }
  // Verify credentials with the destination provider
  const destProvider = getDestinationProvider(provider);
  const verifyResult = await destProvider.verifyCredentials({
    botToken,
    chatId: "", // no chat id for bot-only test
  });
  if (!verifyResult.ok) {
    return NextResponse.json(
      { errorFa: verifyResult.errorFa ?? "توکن نامعتبر است." },
      { status: 400 },
    );
  }
  // Encrypt the token (AES-256-GCM)
  const botTokenEnc = encryptString(botToken);
  try {
    const bot = await db.bot.create({
      data: {
        ownerId: user.id,
        provider,
        name,
        username: username ?? null,
        botTokenEnc,
        status: "inactive", // user must explicitly activate
        config: JSON.stringify(config ?? {}),
      },
      select: {
        id: true,
        provider: true,
        name: true,
        username: true,
        status: true,
        createdAt: true,
      },
    });
    await audit({
      userId: user.id,
      actor: "user",
      action: "bot_created",
      targetType: "bot",
      targetId: bot.id,
      ip,
      meta: { provider, name, username: username ?? null },
    });
    return NextResponse.json({ ok: true, bot: { ...bot, tokenPreview: maskToken(botToken) } }, { status: 201 });
  } catch (err) {
    // Generic client message; raw provider/Prisma text stays server-side.
    console.error("bot create failed:", err instanceof Error ? err.message : err);
    const msg = err instanceof Error && err.name === "AuthError"
      ? err.message
      : "ایجاد ربات ناموفق بود.";
    return NextResponse.json({ errorFa: msg }, { status: 400 });
  }
}
