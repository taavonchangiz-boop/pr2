// =====================================================================
// POSTYAR — Bale Bot API provider (MESSAGING, NOT payment)
// ---------------------------------------------------------------------
// Base: https://api.bale.ai/bot<TOKEN>/<METHOD>
// Bale's Bot API is API-compatible with Telegram's Bot API for the
// messaging methods we use here (getMe, sendMessage, sendPhoto,
// answerCallbackQuery, setMyCommands). Inline keyboards are supported.
//
// Note: The Bale PAYMENT provider is owned by a different agent and
// lives under src/lib/payments/bale*. Do not implement payment here.
//
// Same hardening rules as the Telegram provider:
//   - TLS verified (Node fetch default)
//   - token NEVER logged (raw payload sanitized)
//   - Persian error strings everywhere
// =====================================================================
import type {
  DestinationProvider,
  DeliveryResult,
  ProviderCapabilities,
  PublishArgs,
  VerifyArgs,
  VerifyResult,
} from "@/lib/providers/index";
import { sanitizeRaw } from "@/lib/providers/util";
import type { GlassButton } from "@/lib/types/glass-button";

const API_BASE = "https://api.bale.ai/bot";
const TOKEN_REGEX = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
const TIMEOUT_MS = 15_000;

interface BaleInlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}
interface BaleInlineKeyboard {
  inline_keyboard: BaleInlineKeyboardButton[][];
}

function buildBaleKeyboard(buttons: GlassButton[]): BaleInlineKeyboard | undefined {
  const enabled = buttons.filter((b) => b.enabled).sort((a, b) => a.rowOrder - b.rowOrder);
  if (enabled.length === 0) return undefined;
  const rows: BaleInlineKeyboardButton[][] = [];
  let currentRow: BaleInlineKeyboardButton[] = [];
  let currentOrder: number | null = null;
  for (const b of enabled) {
    if (currentOrder === null || b.rowOrder !== currentOrder) {
      if (currentRow.length) rows.push(currentRow);
      currentRow = [];
      currentOrder = b.rowOrder;
    }
    const cell: BaleInlineKeyboardButton = { text: b.label.slice(0, 64) };
    if (b.url) cell.url = b.url;
    else if (b.callbackData) cell.callback_data = b.callbackData.slice(0, 64);
    else cell.url = "https://postyar.app";
    currentRow.push(cell);
  }
  if (currentRow.length) rows.push(currentRow);
  return { inline_keyboard: rows };
}

async function baleFetch<T>(botToken: string, method: string, body: Record<string, unknown>): Promise<T | null> {
  const url = `${API_BASE}${botToken}/${method}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 404) return null;
    const json = (await res.json()) as { ok?: boolean; description?: string; result?: T; error_code?: number };
    if (!json.ok) return null;
    return json.result ?? null;
  } catch {
    return null;
  }
}

interface BaleGetMe {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}
interface BaleMessage {
  message_id: number;
  chat?: { id: number };
  date?: number;
}

export const baleProvider: DestinationProvider = {
  name: () => "bale",

  capabilities(): ProviderCapabilities {
    return { inlineButtons: true, replyButtons: false, webPreview: true, media: true };
  },

  formatButtons(buttons: GlassButton[]): unknown {
    return buildBaleKeyboard(buttons);
  },

  async verifyCredentials({ botToken, chatId }: VerifyArgs): Promise<VerifyResult> {
    if (!botToken || !TOKEN_REGEX.test(botToken)) {
      return { ok: false, errorFa: "قالب توکن نامعتبر است." };
    }
    try {
      const me = await baleFetch<BaleGetMe>(botToken, "getMe", {});
      if (!me || !me.is_bot) {
        return { ok: false, errorFa: "توکن نامعتبر است یا ربات یافت نشد." };
      }
      if (chatId) {
        const res = await fetch(`${API_BASE}${botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId.trim(),
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
    const keyboard = buildBaleKeyboard(buttons ?? []);
    const url = `${API_BASE}${botToken}/${mediaUrl ? "sendPhoto" : "sendMessage"}`;
    const payload: Record<string, unknown> = {
      chat_id: chatId.trim(),
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
      const j = (await res.json()) as { ok?: boolean; description?: string; result?: BaleMessage; error_code?: number };
      if (!j.ok || !j.result) {
        const err = j.description ?? "";
        // V5 H-04 — ambiguity classification (same contract as Telegram):
        // definite HTTP 4xx refusals are NOT ambiguous; HTTP 5xx is UNKNOWN.
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
      return {
        ok: true,
        providerMessageId: String(j.result.message_id ?? ""),
        raw: sanitizeRaw({ message_id: j.result.message_id }),
      };
    } catch (err) {
      // V5 H-04 — thrown fetch (AbortError/timeout, TypeError/network) or an
      // unparseable response leaves the delivery outcome UNKNOWN. Never
      // report false certainty about a possibly-delivered message.
      return {
        ok: false,
        ambiguous: true,
        errorFa: "اتصال به سرویس ناموفق بود.",
        raw: sanitizeRaw({ name: err instanceof Error ? err.name : "Error" }),
      };
    }
  },
};

export async function answerCallbackQuery(botToken: string, callbackQueryId: string, text?: string): Promise<void> {
  try {
    await baleFetch(botToken, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: text?.slice(0, 200),
    });
  } catch { /* best-effort */ }
}

export async function setMyCommands(botToken: string, commands: Array<{ command: string; description: string }>): Promise<void> {
  try {
    await baleFetch(botToken, "setMyCommands", { commands });
  } catch { /* ignore */ }
}
