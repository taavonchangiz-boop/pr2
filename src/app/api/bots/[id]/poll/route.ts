// POSTYAR — /api/bots/[id]/poll
// Admin-only polling fallback for Telegram/Bale (dev/test where webhooks
// aren't reachable). Calls `getUpdates` (Telegram/Bale) with a short
// timeout, then pushes each update into the same processing pipeline
// as the webhook handler would.
//
// Rate-limited: max 1 call / 10 sec per bot — prevents accidental
// hot-polling loops.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/security/cache";
import { decryptString, hmacSign } from "@/lib/security/crypto";
import { requireRole, AuthError, clientIp, audit } from "@/lib/server/auth";
import { executeWorkflow } from "@/lib/bots/workflow";
import { getSetting } from "@/lib/providers/util";
import type { BotWorkflow } from "@prisma/client";

const POLL_RATE_LIMIT = 1;
const POLL_RATE_WINDOW_MS = 10_000;
const TIMEOUT_MS = 5_000;

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat?: { id?: number };
    text?: string;
    caption?: string;
  };
  callback_query?: {
    id: string;
    from?: { id?: number };
    data?: string;
    message?: { message_id: number; chat?: { id?: number }; text?: string };
  };
  pre_checkout_query?: unknown;
  message_successful_payment?: unknown;
}

async function pollTelegram(botToken: string, offset: number): Promise<{ ok: boolean; updates?: TgUpdate[]; errorFa?: string }> {
  try {
    const url = `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=0&limit=100`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const j = (await r.json()) as { ok?: boolean; result?: TgUpdate[]; description?: string };
    if (!j.ok) {
      return { ok: false, errorFa: j.description ?? "نظرسنجی ناموفق بود." };
    }
    return { ok: true, updates: Array.isArray(j.result) ? j.result : [] };
  } catch {
    return { ok: false, errorFa: "اتصال به سرویس ناموفق بود." };
  }
}

async function pollBale(botToken: string, offset: number): Promise<{ ok: boolean; updates?: TgUpdate[]; errorFa?: string }> {
  try {
    const url = `https://api.bale.ai/bot${botToken}/getUpdates?offset=${offset}&timeout=0&limit=100`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const j = (await r.json()) as { ok?: boolean; result?: TgUpdate[]; description?: string };
    if (!j.ok) {
      return { ok: false, errorFa: j.description ?? "نظرسنجی ناموفق بود." };
    }
    return { ok: true, updates: Array.isArray(j.result) ? j.result : [] };
  } catch {
    return { ok: false, errorFa: "اتصال به سرویس ناموفق بود." };
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try { user = await requireRole(["admin"]); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  const { id } = await params;
  const bot = await db.bot.findUnique({ where: { id } });
  if (!bot) {
    return NextResponse.json({ errorFa: "ربات یافت نشد." }, { status: 404 });
  }
  if (bot.provider !== "telegram" && bot.provider !== "bale") {
    return NextResponse.json(
      { errorFa: "نظرسنجی تنها برای تلگرام و بله پشتیبانی می‌شود. برای روبیکا از /api/bots/incoming/rubika استفاده کنید." },
      { status: 400 },
    );
  }
  // Rate limit per bot
  const rlKey = `bot:poll:${id}`;
  const rl = await rateLimit({
    key: rlKey,
    limit: POLL_RATE_LIMIT,
    windowMs: POLL_RATE_WINDOW_MS,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { errorFa: "نظرسنجی بیش از حد مجاز است. ده ثانیه بعد تلاش کنید." },
      { status: 429 },
    );
  }
  let botToken = "";
  try { botToken = decryptString(bot.botTokenEnc); } catch {
    return NextResponse.json({ errorFa: "توکن قابل رمزگشایی نیست." }, { status: 500 });
  }

  // Compute the body HMAC key — used to populate the body-sig header
  // so the inbound handlers trust us (we are an admin).
  let webhookBodySecret = "";
  try {
    webhookBodySecret = bot.webhookSecret ? decryptString(bot.webhookSecret) : "";
  } catch { /* ignore */ }

  // Offset: caller can pass ?offset=N. Defaults to 0 (latest).
  const url = new URL(req.url);
  const offset = Number(url.searchParams.get("offset") ?? "0") || 0;

  const pollResult = bot.provider === "telegram"
    ? await pollTelegram(botToken, offset)
    : await pollBale(botToken, offset);
  if (!pollResult.ok || !pollResult.updates) {
    return NextResponse.json({ ok: false, errorFa: pollResult.errorFa }, { status: 502 });
  }
  let processed = 0;
  let lastUpdateId = offset;
  for (const update of pollResult.updates) {
    const uid = update.update_id;
    if (Number.isFinite(uid) && uid > lastUpdateId) lastUpdateId = uid;
    // Re-dispatch to the inbound webhook handler so all logic stays in one
    // place (idempotency, workflow engine, payment branch). We construct a
    // POST with the raw JSON body, the same `bid` + `sig` query, and (for
    // Bale) the `x-bale-webhook-signature` header set to the computed HMAC.
    const bodyJson = JSON.stringify(update);
    const webhookPath = `/api/bots/incoming/${bot.provider}?bid=${encodeURIComponent(bot.id)}&sig=${encodeURIComponent(hmacSign("bot-webhook-sig", bot.id))}`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (webhookBodySecret) {
      const sig = hmacSign(`bot-webhook-body:${bot.id}`, `${webhookBodySecret}:${bodyJson}`);
      if (bot.provider === "telegram") {
        // Telegram uses X-Telegram-Bot-Api-Secret-Token header (== our secret_token)
        headers["x-telegram-bot-api-secret-token"] = webhookBodySecret;
      } else {
        headers["x-bale-webhook-signature"] = sig;
      }
    }
    try {
      // Call the inbound handler directly via a fetch to the same origin.
      // Use POSTYAR_PUBLIC_BASE_URL if set, otherwise fall back to a
      // relative call to the dev server.
      // V4 M-14 — authoritative settings-aware resolver.
      const base = (await getSetting("POSTYAR_PUBLIC_BASE_URL", "")).trim().replace(/\/$/, "") || "http://localhost:3000";
      const resp = await fetch(`${base}${webhookPath}`, {
        method: "POST",
        headers,
        body: bodyJson,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (resp.ok) processed++;
    } catch (err) {
      await audit({
        userId: user.id,
        actor: "admin",
        action: "bot_poll_dispatch_failed",
        targetType: "bot",
        targetId: bot.id,
        ip,
        meta: { updateId: uid, name: err instanceof Error ? err.name : "Error" },
      });
    }
  }
  await audit({
    userId: user.id,
    actor: "admin",
    action: "bot_polled",
    targetType: "bot",
    targetId: bot.id,
    ip,
    meta: { provider: bot.provider, processed, lastUpdateId },
  });
  return NextResponse.json({ ok: true, processed, lastUpdateId });
}

// Unused; trigger the workflow engine import side-effect explicitly.
void executeWorkflow;
// Force BotWorkflow import to be referenced (used by workflow engine).
export type { BotWorkflow };
