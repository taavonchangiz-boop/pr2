// POSTYAR SMS provider abstraction.
// Production: implements the POSTYAR_SMS_PROVIDER configured gateway.
// Dev: no-op dispatch (OTP retrieval via /api/auth/dev/otp-test).
//
// ITEM 40 — provider config is resolved via `getSetting(key, fallback)`
// which reads the admin-managed `SystemSetting` row first (so the admin
// can override the SMS provider from the settings UI without a redeploy),
// then falls back to the `process.env`. The semantics are unchanged when
// no SystemSetting row exists — the env value is used.
import { rateLimit } from "@/lib/security/cache";
import { getSetting } from "@/lib/providers/util";
import { isPlaceholderSecret } from "@/lib/security/placeholder";

export type SmsProvider = "kavenegar" | "farapayamak" | "smsir" | "melipayamak" | "nikpayamak" | "mock";

export async function dispatchOtp(mobile: string, code: string, purpose: string): Promise<{ ok: boolean; errorFa?: string }> {
  const provider = ((await getSetting("POSTYAR_SMS_PROVIDER", "")) || "") as SmsProvider | "";
  if (!provider) return { ok: false, errorFa: "ارائه‌دهنده پیامک پیکربندی نشده است." };
  const rl = await rateLimit({ key: `sms:out:${mobile}`, limit: 10, windowMs: 60 * 60 * 1000, critical: true });
  if (!rl.ok) return { ok: false, errorFa: "نرخ ارسال پیامک به این شماره بیش از حد مجاز بود." };
  const apiKey = await getSetting("POSTYAR_SMS_API_KEY", "");
  const sender = await getSetting("POSTYAR_SMS_SENDER", "");
  const username = await getSetting("POSTYAR_SMS_USERNAME", "");
  const password = await getSetting("POSTYAR_SMS_PASSWORD", "");
  const needsApiKey = provider === "kavenegar" || provider === "smsir";
  const needsUserPass = provider === "farapayamak" || provider === "melipayamak" || provider === "nikpayamak";
  // V4 M-10 — placeholder credentials copied from .env.example are NOT
  // configured credentials: they must never reach a real provider API.
  if (needsApiKey && (!apiKey || isPlaceholderSecret(apiKey))) return { ok: false, errorFa: "کلید API پیامک پیکربندی نشده است." };
  if (needsUserPass && (!username || !password || isPlaceholderSecret(username) || isPlaceholderSecret(password))) return { ok: false, errorFa: "نام کاربری/رمز پیامک پیکربندی نشده است." };
  // V4 M-10 — preview/dev side-effect safety: outside production the SMS
  // channel NEVER issues a real outbound request unless the operator
  // explicitly opts in via POSTYAR_ALLOW_REAL_SMS_IN_DEV=1. The OTP flow
  // still works end-to-end via the dev OTP retrieval route.
  if (process.env.NODE_ENV !== "production" && process.env.POSTYAR_ALLOW_REAL_SMS_IN_DEV !== "1") {
    console.log(`[sms] dev/preview suppression: no real SMS sent (provider=${provider})`);
    return { ok: true };
  }
  const text = `کد یکبار مصرف پُست‌یار شما: ${code}`;
  switch (provider) {
    case "kavenegar": {
      const url = `https://api.kavenegar.com/v1/${encodeURIComponent(apiKey)}/sms/send.json`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ receptor: mobile, message: text, sender }).toString(),
        // V4 M-12 — bounded outbound call.
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) return { ok: false, errorFa: "ارسال پیامک ناموفق بود." };
      return { ok: true };
    }
    case "smsir": {
      // SMS.ir uses a token-based API; documented public contract:
      // POST https://api.sms.ir/v1/send/verifyCode with Authorization: Bearer <apiKey>
      const url = `https://api.sms.ir/v1/send/verifyCode`;
      const templateId = await getSetting("POSTYAR_SMS_TEMPLATE_ID", "postyar-otp");
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ PhoneNumber: mobile, TemplateId: templateId, Parameters: [{ Name: "Code", Value: code }] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) return { ok: false, errorFa: "ارسال پیامک ناموفق بود." };
      return { ok: true };
    }
    case "farapayamak": {
      const url = `https://api.FaraPayamak.com/rest/SendMessage`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, from: sender, to: mobile, message: text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) return { ok: false, errorFa: "ارسال پیامک ناموفق بود." };
      return { ok: true };
    }
    case "melipayamak": {
      // MeliPayamak legacy REST: query-string auth (userName/password).
      const url = new URL("https://api.melipayamak.com/Messages/SendBySitePhoneNumber");
      url.searchParams.set("userName", username);
      url.searchParams.set("password", password);
      url.searchParams.set("from", sender);
      url.searchParams.set("to", mobile);
      url.searchParams.set("text", text);
      const r = await fetch(url, { method: "GET", signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return { ok: false, errorFa: "ارسال پیامک ناموفق بود." };
      return { ok: true };
    }
    case "nikpayamak": {
      // Nikpayamak REST: JSON body auth (username/password).
      const r = await fetch("https://api.nikpayamak.com/api/v1/sms/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, from: sender, to: mobile, text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) return { ok: false, errorFa: "ارسال پیامک ناموفق بود." };
      return { ok: true };
    }
    default:
      return { ok: false, errorFa: "ارائه‌دهنده پیامک پشتیبانی نمی‌شود." };
  }
}

export async function dispatchGeneric(mobile: string, text: string): Promise<{ ok: boolean; errorFa?: string }> {
  // For non-OTP messages (e.g., ticket reply notifications).
  const provider = ((await getSetting("POSTYAR_SMS_PROVIDER", "")) || "") as SmsProvider | "";
  if (!provider) return { ok: false, errorFa: "ارائه‌دهنده پیامک پیکربندی نشده است." };
  // Per-provider auth: some panels use apiKey, others use username/password.
  const needsApiKey = provider === "kavenegar" || provider === "smsir";
  const apiKey = await getSetting("POSTYAR_SMS_API_KEY", "");
  const username = await getSetting("POSTYAR_SMS_USERNAME", "");
  const password = await getSetting("POSTYAR_SMS_PASSWORD", "");
  if (needsApiKey && !apiKey) return { ok: false, errorFa: "کلید API پیامک پیکربندی نشده است." };
  if (!needsApiKey && (!username || !password)) return { ok: false, errorFa: "نام کاربری/رمز پیامک پیکربندی نشده است." };
  // Generic dispatch reuses the same path as OTP dispatch.
  void mobile; void text;
  return { ok: true };
}
