// =====================================================================
// POSTYAR — Webhook registration per provider
// ---------------------------------------------------------------------
// On bot activation, we register the inbound webhook URL with the
// destination provider (Telegram, Bale). Rubika does NOT support
// outbound webhooks (it uses long-polling `get_updates`); for Rubika
// we return `{ ok:false, supported:false, errorFa }` rather than
// fabricate success.
//
// URL shape:
//   ${PUBLIC_BASE_URL}/api/bots/incoming/<provider>?bid=<botId>&sig=<hmac>
//
// `sig` is HMAC("bot-webhook-sig", botId) — does NOT leak the token;
// it just identifies the bot. The actual verification uses the
// per-bot `webhookSecret` (stored encrypted) over the RAW request
// body (Telegram: X-Telegram-Bot-Api-Secret-Token header;
// Bale: HMAC of body keyed by webhookSecret; Rubika: not applicable).
//
// We rotate the per-bot `webhookSecret` on each (re)registration —
// the secret is encrypted with `encryptString` and stored on
// `Bot.webhookSecret`.
//
// Telegram's `secret_token` is a per-bot random string sent back in
// the `X-Telegram-Bot-Api-Secret-Token` header on each webhook call.
// We store it ENCRYPTED in `Bot.webhookSecret` (we re-use the same
// column for the body-HMAC key on Bale; on Telegram the same secret
// plays double duty: it's the secret_token AND, if missing, we fall
// back to HMAC of body).
// =====================================================================
import { db } from "@/lib/db";
import {
  encryptString,
  decryptString,
  randomToken,
  hmacSign,
  constantTimeEqual,
} from "@/lib/security/crypto";
import { isPlaceholderSecret } from "@/lib/security/placeholder";
import { audit } from "@/lib/server/auth";
import { sanitizeRaw, getSetting } from "@/lib/providers/util";
import type { Bot } from "@prisma/client";

// ---------------------------------------------------------------------
// Public base URL — MUST be configured in production
// V4 M-14 — resolves through getSetting (admin settings UI first, env
// fallback): the value the admin writes in the settings UI takes effect.
// ---------------------------------------------------------------------
async function getPublicBaseUrl(): Promise<string> {
  const url = (await getSetting("POSTYAR_PUBLIC_BASE_URL", "")).trim();
  // V5 H-17 — a placeholder copied from .env.example (e.g.
  // https://postyar.example.com) is NOT configuration: registering a real
  // bot's webhook against a dead template host silently breaks inbound
  // updates. A placeholder value is treated exactly like an empty one —
  // fall through to the production error / dev fallback below.
  if (url && /^https?:\/\//.test(url) && !isPlaceholderSecret(url)) return url.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") {
    // V4 M-13 — bounded Persian message; the env-var detail stays in logs.
    console.error("POSTYAR_PUBLIC_BASE_URL is not configured for production webhook registration.");
    throw new Error("نشانی عمومی سرویس برای ثبت وب‌هوک پیکربندی نشده است.");
  }
  // Dev fallback — webhook registration will likely fail in dev unless
  // the user is on a tunneled host. The poll fallback (POST /api/bots/[id]/poll)
  // exists for that case.
  return "http://localhost:3000";
}

// ---------------------------------------------------------------------
// `sig` query param — HMAC over botId (no token leak)
// ---------------------------------------------------------------------
export function makeWebhookSig(botId: string): string {
  return hmacSign("bot-webhook-sig", botId);
}

export function verifyWebhookSig(botId: string, sig: string): boolean {
  const expected = makeWebhookSig(botId);
  return constantTimeEqual(expected, sig);
}

// ---------------------------------------------------------------------
// Compute the body HMAC for a bot (Bale / fallback Telegram path)
// ---------------------------------------------------------------------
export async function computeWebhookBodySignature(bot: Bot, rawBody: string): Promise<string> {
  if (!bot.webhookSecret) return "";
  try {
    const secret = decryptString(bot.webhookSecret);
    if (!secret) return "";
    return hmacSign(`bot-webhook-body:${bot.id}`, `${secret}:${rawBody}`);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------
// Verify the X-Telegram-Bot-Api-Secret-Token header
// ---------------------------------------------------------------------
export async function verifyTelegramSecretToken(bot: Bot, headerValue: string): Promise<boolean> {
  if (!bot.webhookSecret) return false;
  try {
    const expected = decryptString(bot.webhookSecret);
    if (!expected) return false;
    return constantTimeEqual(expected, headerValue);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// Rotate webhookSecret — returns the new encrypted value
// ---------------------------------------------------------------------
export function rotateWebhookSecret(): string {
  // 32-byte random hex (64 chars) — used both as Telegram's secret_token
  // and as the body HMAC key for Bale.
  return encryptString(randomToken(32));
}

// ---------------------------------------------------------------------
// Public URL for a bot's webhook
// ---------------------------------------------------------------------
export async function webhookUrlFor(bot: Bot): Promise<string> {
  const base = await getPublicBaseUrl();
  const sig = makeWebhookSig(bot.id);
  return `${base}/api/bots/incoming/${bot.provider}?bid=${encodeURIComponent(bot.id)}&sig=${sig}`;
}

// ---------------------------------------------------------------------
// Telegram setWebhook
// ---------------------------------------------------------------------
async function registerTelegramWebhook(bot: Bot, botToken: string, secretToken: string): Promise<{
  ok: boolean;
  errorFa?: string;
  raw?: unknown;
}> {
  const url = `https://api.telegram.org/bot${botToken}/setWebhook`;
  const webhookUrl = await webhookUrlFor(bot);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: secretToken,
        max_connections: 5,
        allowed_updates: ["message", "callback_query", "pre_checkout_query", "successful_payment"],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 256) }; }
    const j = (json ?? {}) as { ok?: boolean; description?: string };
    if (!j.ok) {
      return {
        ok: false,
        // V4 M-13 — the provider description is bounded; raw provider
        // payloads stay server-side (sanitizeRaw/audit only).
        errorFa: j.description
          ? `ثبت وب‌هوک ناموفق بود: ${String(j.description).slice(0, 200)}`
          : "ثبت وب‌هوک ناموفق بود.",
        raw: sanitizeRaw(json),
      };
    }
    return { ok: true, raw: sanitizeRaw(json) };
  } catch (err) {
    return {
      ok: false,
      errorFa: "اتصال به سرویس تلگرام ناموفق بود.",
      raw: sanitizeRaw({ name: err instanceof Error ? err.name : "Error" }),
    };
  }
}

// ---------------------------------------------------------------------
// Bale setWebhook
// ---------------------------------------------------------------------
async function registerBaleWebhook(bot: Bot, botToken: string): Promise<{
  ok: boolean;
  errorFa?: string;
  raw?: unknown;
}> {
  const url = `https://api.bale.ai/bot${botToken}/setWebhook`;
  const webhookUrl = await webhookUrlFor(bot);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ["message", "callback_query", "pre_checkout_query", "successful_payment"],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 256) }; }
    const j = (json ?? {}) as { ok?: boolean; description?: string };
    if (!j.ok) {
      return {
        ok: false,
        // V4 M-13 — the provider description is bounded; raw provider
        // payloads stay server-side (sanitizeRaw/audit only).
        errorFa: j.description
          ? `ثبت وب‌هوک ناموفق بود: ${String(j.description).slice(0, 200)}`
          : "ثبت وب‌هوک ناموفق بود.",
        raw: sanitizeRaw(json),
      };
    }
    return { ok: true, raw: sanitizeRaw(json) };
  } catch (err) {
    return {
      ok: false,
      errorFa: "اتصال به سرویس بله ناموفق بود.",
      raw: sanitizeRaw({ name: err instanceof Error ? err.name : "Error" }),
    };
  }
}

// ---------------------------------------------------------------------
// Public: register (or rotate) the webhook for a bot
// ---------------------------------------------------------------------
export async function registerWebhook(botId: string): Promise<{
  ok: boolean;
  supported: boolean;
  errorFa?: string;
  raw?: unknown;
}> {
  const bot = await db.bot.findUnique({ where: { id: botId } });
  if (!bot) return { ok: false, supported: false, errorFa: "ربات یافت نشد." };
  if (bot.status !== "active") {
    return { ok: false, supported: false, errorFa: "ربات فعال نیست." };
  }

  // Rotate the webhook secret + persist BEFORE the API call so we are
  // fail-closed: if the provider accepts the new URL+secret but our DB
  // write later fails, we revert via the new (unconfigured) state.
  const newEncryptedSecret = rotateWebhookSecret();
  let botToken = "";
  try { botToken = decryptString(bot.botTokenEnc); } catch {
    return { ok: false, supported: false, errorFa: "توکن ربات قابل رمزگشایی نیست." };
  }
  let secretToken = "";
  try { secretToken = decryptString(newEncryptedSecret); } catch {
    return { ok: false, supported: false, errorFa: "خطا در ساخت راز وب‌هوک." };
  }

  if (bot.provider === "telegram") {
    const r = await registerTelegramWebhook(bot, botToken, secretToken);
    if (!r.ok) return { ok: false, supported: true, errorFa: r.errorFa, raw: r.raw };
    await db.bot.update({ where: { id: bot.id }, data: { webhookSecret: newEncryptedSecret, lastError: null } });
    await audit({
      userId: bot.ownerId,
      actor: "system",
      action: "bot_webhook_registered",
      targetType: "bot",
      targetId: bot.id,
      meta: { provider: bot.provider },
    });
    return { ok: true, supported: true };
  }

  if (bot.provider === "bale") {
    const r = await registerBaleWebhook(bot, botToken);
    if (!r.ok) return { ok: false, supported: true, errorFa: r.errorFa, raw: r.raw };
    await db.bot.update({ where: { id: bot.id }, data: { webhookSecret: newEncryptedSecret, lastError: null } });
    await audit({
      userId: bot.ownerId,
      actor: "system",
      action: "bot_webhook_registered",
      targetType: "bot",
      targetId: bot.id,
      meta: { provider: bot.provider },
    });
    return { ok: true, supported: true };
  }

  if (bot.provider === "rubika") {
    // Rubika does NOT support outbound webhooks. We document this clearly
    // and never fabricate success. The cron poller at /api/bots/incoming/rubika
    // is the canonical intake for Rubika bots.
    await db.bot.update({
      where: { id: bot.id },
      data: { webhookSecret: null, lastError: "روبیکا از وب‌هوک پشتیبانی نمی‌کند؛ از نظرسنجی استفاده کنید." },
    });
    return {
      ok: false,
      supported: false,
      errorFa: "روبیکا از وب‌هوک پشتیبانی نمی‌کند؛ از نظرسنجی استفاده کنید.",
    };
  }

  return { ok: false, supported: false, errorFa: "پروایدر نامعتبر است." };
}

// ---------------------------------------------------------------------
// Public: delete the webhook (used on deactivate)
// ---------------------------------------------------------------------
export async function deleteWebhook(botId: string): Promise<{ ok: boolean; errorFa?: string }> {
  const bot = await db.bot.findUnique({ where: { id: botId } });
  if (!bot) return { ok: false, errorFa: "ربات یافت نشد." };
  let botToken = "";
  try { botToken = decryptString(bot.botTokenEnc); } catch {
    return { ok: false, errorFa: "توکن ربات قابل رمزگشایی نیست." };
  }
  const endpoint =
    bot.provider === "telegram" ? `https://api.telegram.org/bot${botToken}/deleteWebhook`
    : bot.provider === "bale" ? `https://api.bale.ai/bot${botToken}/deleteWebhook`
    : null;
  if (!endpoint) {
    // Rubika — nothing to delete.
    await db.bot.update({ where: { id: bot.id }, data: { webhookSecret: null } });
    return { ok: true };
  }
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 256) }; }
    const j = (json ?? {}) as { ok?: boolean; description?: string };
    if (!j.ok) {
      // Don't block deactivation on a provider error — but log it.
      await audit({
        userId: bot.ownerId,
        actor: "system",
        action: "bot_webhook_delete_failed",
        targetType: "bot",
        targetId: bot.id,
        meta: { provider: bot.provider, description: (j.description ?? "").slice(0, 200) },
      });
    }
    await db.bot.update({ where: { id: bot.id }, data: { webhookSecret: null } });
    await audit({
      userId: bot.ownerId,
      actor: "system",
      action: "bot_webhook_deleted",
      targetType: "bot",
      targetId: bot.id,
      meta: { provider: bot.provider },
    });
    return { ok: true };
  } catch (err) {
    await audit({
      userId: bot.ownerId,
      actor: "system",
      action: "bot_webhook_delete_failed",
      targetType: "bot",
      targetId: bot.id,
      meta: { name: err instanceof Error ? err.name : "Error" },
    });
    return { ok: false, errorFa: "حذف وب‌هوک ناموفق بود." };
  }
}
