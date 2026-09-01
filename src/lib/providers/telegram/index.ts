// =====================================================================
// POSTYAR — Telegram Bot API provider
// ---------------------------------------------------------------------
// Base: https://api.telegram.org/bot<TOKEN>/<METHOD>
// Methods used:
//   - getMe (verify credentials)
//   - sendMessage (text + inline keyboard)
//   - sendPhoto (by URL — no token-in-URL uploads; URL must be public)
//   - answerCallbackQuery (no-op ack when buttons are pressed)
//   - setMyCommands (best-effort, exposed for future admin use)
//
// Token format: <bot_id>:<35+ chars of A-Za-z0-9_->
// All calls force TLS verification (Node fetch default).
// Never logs the token. All Persian error strings.
// =====================================================================
import type {
  DestinationProvider,
  DeliveryResult,
  ProviderCapabilities,
  PublishArgs,
  VerifyArgs,
  VerifyResult,
} from "@/lib/providers/index";
import { sanitizeRaw, scrubTokenFromUrl } from "@/lib/providers/util";
import type { GlassButton } from "@/lib/types/glass-button";

const API_BASE = "https://api.telegram.org/bot";
const TOKEN_REGEX = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
const TIMEOUT_MS = 15_000;

interface TgInlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}
interface TgInlineKeyboard {
  inline_keyboard: TgInlineKeyboardButton[][];
}

function normalizeChatId(s: string): string {
  // Telegram supports numeric IDs (with optional -100 prefix for supergroups)
  return s.trim();
}

function buildTelegramKeyboard(buttons: GlassButton[]): TgInlineKeyboard | undefined {
  const enabled = buttons.filter((b) => b.enabled).sort((a, b) => a.rowOrder - b.rowOrder);
  if (enabled.length === 0) return undefined;
  // Group consecutive equal rowOrder into the same row.
  const rows: TgInlineKeyboardButton[][] = [];
  let currentRow: TgInlineKeyboardButton[] = [];
  let currentOrder: number | null = null;
  for (const b of enabled) {
    if (currentOrder === null || b.rowOrder !== currentOrder) {
      if (currentRow.length) rows.push(currentRow);
      currentRow = [];
      currentOrder = b.rowOrder;
    }
    const cell: TgInlineKeyboardButton = { text: b.label.slice(0, 64) };
    if (b.url) cell.url = b.url;
    else if (b.callbackData) cell.callback_data = b.callbackData.slice(0, 64);
    else cell.url = "https://postyar.app"; // fallback URL to satisfy TG
    currentRow.push(cell);
  }
  if (currentRow.length) rows.push(currentRow);
  return { inline_keyboard: rows };
}

async function tgFetch<T>(botToken: string, method: string, body: Record<string, unknown>): Promise<T | null> {
  const url = `${API_BASE}${botToken}/${method}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      // No tls/agent override — Node fetch verifies by default.
    });
    if (res.status === 401 || res.status === 404) {
      return null; // token invalid — caller maps to Persian error
    }
    const json = (await res.json()) as { ok?: boolean; description?: string; result?: T; error_code?: number };
    if (!json.ok) {
      return null;
    }
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

interface TgGetMe {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}
interface TgMessage {
  message_id: number;
  chat?: { id: number };
  date?: number;
}

export const telegramProvider: DestinationProvider = {
  name: () => "telegram",

  capabilities(): ProviderCapabilities {
    return { inlineButtons: true, replyButtons: false, webPreview: true, media: true };
  },

  formatButtons(buttons: GlassButton[]): unknown {
    return buildTelegramKeyboard(buttons);
  },

  async verifyCredentials({ botToken, chatId }: VerifyArgs): Promise<VerifyResult> {
    if (!botToken || !TOKEN_REGEX.test(botToken)) {
      return { ok: false, errorFa: "قالب توکن نامعتبر است." };
    }
    try {
      const me = await tgFetch<TgGetMe>(botToken, "getMe", {});
      if (!me || !me.is_bot) {
        return { ok: false, errorFa: "توکن نامعتبر است یا ربات یافت نشد." };
      }
      if (chatId) {
        // Try to send a silent test message (no notification) — many chats
        // reject this if the bot is not a member; we treat that as "chat not found".
        const res = await fetch(`${API_BASE}${botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: normalizeChatId(chatId),
            text: "🔍 تست اتصال پست‌یار",
            disable_notification: true,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const j = (await res.json()) as { ok?: boolean; description?: string; error_code?: number };
        if (!j.ok) {
          const err = j.description ?? "";
          if (j.error_code === 403 || /forbidden/i.test(err)) {
            return { ok: false, errorFa: "ربات دسترسی به این چت را ندارد.", raw: sanitizeRaw({ description: err }) };
          }
          if (j.error_code === 400 || /chat not found/i.test(err)) {
            return { ok: false, errorFa: "چت یافت نشد.", raw: sanitizeRaw({ description: err }) };
          }
          return { ok: false, errorFa: "خطا در تست اتصال به چت.", raw: sanitizeRaw({ description: err }) };
        }
      }
      return { ok: true, raw: sanitizeRaw({ id: me.id, username: me.username }) };
    } catch (err) {
      return {
        ok: false,
        errorFa: "اتصال به سرویس ناموفق بود.",
        raw: sanitizeRaw({ name: err instanceof Error ? err.name : "Error" }),
      };
    }
  },

  async publishMessage({ botToken, chatId, text, mediaUrl, buttons, disableWebPreview }: PublishArgs): Promise<DeliveryResult> {
    if (!botToken || !TOKEN_REGEX.test(botToken)) {
      return { ok: false, errorFa: "توکن نامعتبر است." };
    }
    if (!chatId) {
      return { ok: false, errorFa: "چت‌آیدی مشخص نشده است." };
    }
    const keyboard = buildTelegramKeyboard(buttons ?? []);
    const url = `${API_BASE}${botToken}/${mediaUrl ? "sendPhoto" : "sendMessage"}`;
    const payload: Record<string, unknown> = {
      chat_id: normalizeChatId(chatId),
    };
    if (mediaUrl) {
      payload.photo = mediaUrl;
      payload.caption = text.slice(0, 1024);
    } else {
      payload.text = text.slice(0, 4096);
      if (disableWebPreview) payload.disable_web_page_preview = true;
    }
    if (keyboard) payload.reply_markup = keyboard;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const j = (await res.json()) as { ok?: boolean; description?: string; result?: TgMessage; error_code?: number };
      if (!j.ok || !j.result) {
        const err = j.description ?? "";
        // V5 H-04 — ambiguity classification: a DEFINITIVE provider refusal
        // (HTTP 4xx: bad request / unauthorized / forbidden / chat missing /
        // rate-limited) means the message was NOT sent — a retry is safe.
        // HTTP 5xx (or an unmapped status ≥500) means the server failed
        // while possibly accepting the message — the outcome is UNKNOWN.
        const is5xx = res.status >= 500 || (typeof j.error_code === "number" && j.error_code >= 500);
        const ambiguous = is5xx;
        if (j.error_code === 401) {
          return { ok: false, ambiguous: false, errorFa: "توکن نامعتبر است.", raw: sanitizeRaw({ description: err }) };
        }
        if (j.error_code === 403 || /forbidden/i.test(err)) {
          return { ok: false, ambiguous: false, errorFa: "ربات دسترسی به این چت را ندارد.", raw: sanitizeRaw({ description: err }) };
        }
        if (j.error_code === 400 || /chat not found/i.test(err)) {
          return { ok: false, ambiguous: false, errorFa: "چت یافت نشد.", raw: sanitizeRaw({ description: err }) };
        }
        if (j.error_code === 429) {
          return { ok: false, ambiguous: false, errorFa: "محدودیت ارسال پیام. کمی بعد تلاش کنید.", raw: sanitizeRaw({ description: err }) };
        }
        return { ok: false, ambiguous, errorFa: "ارسال پیام ناموفق بود.", raw: sanitizeRaw({ description: err }) };
      }
      // No token in URL — but if we ever log the URL, scrub it.
      void scrubTokenFromUrl;
      return {
        ok: true,
        providerMessageId: String(j.result.message_id ?? ""),
        raw: sanitizeRaw({ message_id: j.result.message_id }),
      };
    } catch (err) {
      // V5 H-04 — a thrown fetch (AbortError/timeout, TypeError/network) or
      // an unparseable response leaves the delivery outcome UNKNOWN: the
      // request may have reached the provider. Never report false certainty.
      return {
        ok: false,
        ambiguous: true,
        errorFa: "اتصال به سرویس ناموفق بود.",
        raw: sanitizeRaw({ name: err instanceof Error ? err.name : "Error" }),
      };
    }
  },
};

// Convenience method used by the worker when an inline-button callback
// arrives and we want to ack it (no-op from a UI perspective).
export async function answerCallbackQuery(botToken: string, callbackQueryId: string, text?: string): Promise<void> {
  try {
    await tgFetch(botToken, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: text?.slice(0, 200),
    });
  } catch { /* ignore — best-effort ack */ }
}

/** Best-effort: register bot commands (used by admin tooling later). */
export async function setMyCommands(botToken: string, commands: Array<{ command: string; description: string }>): Promise<void> {
  try {
    await tgFetch(botToken, "setMyCommands", { commands });
  } catch { /* ignore */ }
}
