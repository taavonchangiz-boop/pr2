// =====================================================================
// POSTYAR — Rubika Bot API provider
// ---------------------------------------------------------------------
// Base: https://api.rubika.com/v1/<METHOD>
// Auth: Authorization: Bot <TOKEN>  (token NEVER in URL — Rubika contract).
//
// Methods attempted here follow the publicly-documented Rubika Bot API:
//   - getMe        → verify token
//   - send_message → text + inline keyboard
//   - send_file    → media (callback URL)
//   - set_my_commands
//   - answer_callback
//
// Rubika's keyboard shape differs from Telegram's: buttons use
// `callback_id` instead of `callback_data`. Each button cell is:
//   { text: string, url?: string, callback_id?: string }
//
// IMPORTANT: The Rubika public API contract is less well-documented than
// Telegram/Bale. Where the contract is uncertain, we return a clearly
// marked { ok: false, supported: false } result instead of fabricating
// success.
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

const API_BASE = "https://api.rubika.com/v1";
const TIMEOUT_MS = 15_000;
// Rubika tokens are long alphanumerics — permissive format check only.
const TOKEN_REGEX = /^[A-Za-z0-9_-]{16,}$/;

interface RubikaButton {
  text: string;
  url?: string;
  callback_id?: string;
}
interface RubikaInlineKeyboard {
  inline_keyboard: RubikaButton[][];
}

function buildRubikaKeyboard(buttons: GlassButton[]): RubikaInlineKeyboard | undefined {
  const enabled = buttons.filter((b) => b.enabled).sort((a, b) => a.rowOrder - b.rowOrder);
  if (enabled.length === 0) return undefined;
  const rows: RubikaButton[][] = [];
  let currentRow: RubikaButton[] = [];
  let currentOrder: number | null = null;
  for (const b of enabled) {
    if (currentOrder === null || b.rowOrder !== currentOrder) {
      if (currentRow.length) rows.push(currentRow);
      currentRow = [];
      currentOrder = b.rowOrder;
    }
    const cell: RubikaButton = { text: b.label.slice(0, 64) };
    if (b.url) cell.url = b.url;
    else if (b.callbackData) cell.callback_id = b.callbackData.slice(0, 64);
    else cell.url = "https://postyar.app"; // Rubika requires url OR callback_id
    currentRow.push(cell);
  }
  if (currentRow.length) rows.push(currentRow);
  return { inline_keyboard: rows };
}

async function rubikaCall<T>(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; result?: T; status: number; raw: unknown }> {
  const url = `${API_BASE}/${method}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bot ${botToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) return { ok: false, status: 401, raw: { status: 401 } };
    if (res.status === 404) return { ok: false, status: 404, raw: { status: 404 } };
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 256) }; }
    }
    const envelope = json as { ok?: boolean; status?: string; result?: T; status_code?: number; error?: string };
    if (envelope?.status === "OK" || envelope?.ok === true || (envelope?.status_code && envelope.status_code < 400)) {
      return { ok: true, status: res.status, result: envelope.result, raw: sanitizeRaw(envelope) };
    }
    return { ok: false, status: res.status, raw: sanitizeRaw(envelope) };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      raw: sanitizeRaw({ name: err instanceof Error ? err.name : "Error" }),
    };
  }
}

interface RubikaGetMe {
  id?: string | number;
  bot?: boolean;
  username?: string;
  first_name?: string;
}
interface RubikaMessage {
  message_id?: string | number;
  id?: string | number;
}

export const rubikaProvider: DestinationProvider = {
  name: () => "rubika",

  capabilities(): ProviderCapabilities {
    return { inlineButtons: true, replyButtons: false, webPreview: false, media: true };
  },

  formatButtons(buttons: GlassButton[]): unknown {
    return buildRubikaKeyboard(buttons);
  },

  async verifyCredentials({ botToken }: VerifyArgs): Promise<VerifyResult> {
    if (!botToken || !TOKEN_REGEX.test(botToken)) {
      return { ok: false, errorFa: "قالب توکن نامعتبر است." };
    }
    const r = await rubikaCall<RubikaGetMe>(botToken, "getMe", {});
    if (!r.ok) {
      if (r.status === 401) return { ok: false, errorFa: "توکن نامعتبر است." };
      if (r.status === 0) return { ok: false, errorFa: "اتصال به سرویس ناموفق بود.", raw: r.raw };
      return { ok: false, errorFa: "توکن نامعتبر است یا ربات یافت نشد.", raw: r.raw };
    }
    return { ok: true, raw: r.raw };
  },

  async publishMessage({ botToken, chatId, text, mediaUrl, buttons }: PublishArgs): Promise<DeliveryResult> {
    if (!botToken || !TOKEN_REGEX.test(botToken)) {
      return { ok: false, errorFa: "توکن نامعتبر است." };
    }
    if (!chatId) {
      return { ok: false, errorFa: "چت‌آیدی مشخص نشده است." };
    }
    const keyboard = buildRubikaKeyboard(buttons ?? []);

    if (mediaUrl) {
      // The exact contract for Rubika send_file is not consistently
      // documented. Rather than fabricate success, we explicitly mark
      // this as unsupported so the user sees a clear Persian error and
      // the worker treats the job as a soft-failure (will not retry).
      // V5 H-04 — a definitive refusal: nothing was sent, a retry is safe.
      return {
        ok: false,
        ambiguous: false,
        errorFa: "این قابلیت توسط روبیکا پشتیبانی نمی‌شود.",
        raw: { supported: false, reason: "rubika_send_file_undocumented" },
      };
    }

    const payload: Record<string, unknown> = {
      chat_id: chatId.trim(),
      text: text.slice(0, 4096),
    };
    if (keyboard) payload.reply_markup = keyboard;

    const r = await rubikaCall<RubikaMessage>(botToken, "send_message", payload);
    if (!r.ok) {
      // V5 H-04 — ambiguity classification: status 0 = the request never
      // completed (network error / timeout / abort) → the delivery outcome
      // is UNKNOWN. HTTP 5xx → also UNKNOWN (server may have accepted the
      // message before failing). Definite 4xx refusals are NOT ambiguous.
      const ambiguous = r.status === 0 || r.status >= 500;
      if (r.status === 401) return { ok: false, ambiguous: false, errorFa: "توکن نامعتبر است.", raw: r.raw };
      if (r.status === 0) return { ok: false, ambiguous: true, errorFa: "اتصال به سرویس ناموفق بود.", raw: r.raw };
      if (r.status === 403) return { ok: false, ambiguous: false, errorFa: "ربات دسترسی به این چت را ندارد.", raw: r.raw };
      if (r.status === 400) return { ok: false, ambiguous: false, errorFa: "چت یافت نشد.", raw: r.raw };
      if (r.status === 429) return { ok: false, ambiguous: false, errorFa: "محدودیت ارسال پیام. کمی بعد تلاش کنید.", raw: r.raw };
      return { ok: false, ambiguous, errorFa: "ارسال پیام ناموفق بود.", raw: r.raw };
    }
    const msg = r.result;
    const providerMessageId = msg
      ? String(msg.message_id ?? msg.id ?? "")
      : "";
    return { ok: true, providerMessageId, raw: r.raw };
  },
};

export async function answerCallbackQuery(botToken: string, callbackId: string, text?: string): Promise<void> {
  // Best-effort ack — Rubika uses `answer_callback` per its public docs.
  try {
    await rubikaCall(botToken, "answer_callback", { callback_id: callbackId, text: text?.slice(0, 200) });
  } catch { /* ignore */ }
}

export async function setMyCommands(botToken: string, commands: Array<{ command: string; description: string }>): Promise<void> {
  try {
    await rubikaCall(botToken, "set_my_commands", { commands });
  } catch { /* ignore */ }
}
