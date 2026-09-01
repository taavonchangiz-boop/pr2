// POSTYAR — /api/admin/settings (GET + POST + PATCH + DELETE SystemSetting rows)
// Admin only. Keys are validated against an allow-list.
//
// ITEM 39/40 — the allow-list is grouped (general / sms_panel /
// email_panel / bank_gateway / gold_config / ai_config / security).
// Each group is exposed to the UI as a Card. Keys are env-var-named
// (POSTYAR_SMS_PROVIDER, POSTYAR_SMTP_HOST, ...) so the provider libs
// (`getSetting` in src/lib/providers/util.ts) can transparently override
// `process.env` from SystemSetting rows without code changes.
//
// POST  { key, value }                  — single upsert (legacy, kept for
//                                         backward compat with the previous
//                                         admin UI which used this shape).
// PATCH { items: [{key, value}, ...] } — batch upsert (used by the new
//                                         grouped UI's per-card save).
// PATCH { key, value }                 — single upsert (alternative shape;
//                                         the new UI uses the batch form).
// DELETE { key }                        — delete the row (revert to env /
//                                         built-in default).
//
// After every mutation we call `invalidateSettingsCache()` so the SMS /
// Email / AI provider libs pick up the change on the next call.
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole, clientIp, audit, AuthError } from "@/lib/server/auth";
import { db } from "@/lib/db";
import { formatJalaliDateTime } from "@/lib/persian";
import { bumpSettingsEpoch, invalidateSettingsCache } from "@/lib/providers/util";
import { encryptString } from "@/lib/security/crypto";

// ---------------------------------------------------------------------
// Allow-list — grouped. Each key appears in exactly one group. The
// `id` is what the UI uses to render the Card; `titleFa` /
// `descriptionFa` are the Persian labels; `keys` is the list of
// SystemSetting keys that belong to the group, each with its own
// Persian label + description (consumed by the UI).
// ---------------------------------------------------------------------
interface SettingDef {
  key: string;
  labelFa: string;
  descFa: string;
  sensitive?: boolean;
  /** Optional preset options to render as a Select instead of free text. */
  options?: { value: string; labelFa: string }[];
  /** Default value shown as the placeholder / used by "reset". */
  default?: string;
}
interface SettingGroup {
  id: "general" | "sms_panel" | "email_panel" | "bank_gateway" | "gold_config" | "ai_config" | "security";
  titleFa: string;
  descriptionFa: string;
  keys: SettingDef[];
}

const GROUPS: SettingGroup[] = [
  {
    id: "general",
    titleFa: "تنظیمات عمومی",
    descriptionFa: "نام سامانه، اطلاعات تماس و قواعد کلی پلتفرم.",
    keys: [
      { key: "site.nameFa", labelFa: "نام فارسی سامانه", descFa: "نمایشی در سربرگ و قدم‌ها. مثال: «پُست‌یار».", default: "پُست‌یار" },
      { key: "site.defaultLocale", labelFa: "زبان پیش‌فرض", descFa: "زبان پیش‌فرض سامانه (fa یا en).", default: "fa", options: [{ value: "fa", labelFa: "فارسی" }, { value: "en", labelFa: "انگلیسی" }] },
      { key: "site.supportEmail", labelFa: "ایمیل پشتیبانی", descFa: "آدرس ایمیل رسمی پشتیبانی برای نمایش در فوتر و تیکت‌ها." },
      { key: "site.supportMobile", labelFa: "موبایل پشتیبانی", descFa: "شماره موبایل پشتیبانی برای نمایش در فوتر.", sensitive: true },
      { key: "site.termsUrl", labelFa: "نشانی قوانین", descFa: "نشانی صفحه قوانین و مقررات." },
      { key: "site.privacyUrl", labelFa: "نشانی حریم خصوصی", descFa: "نشانی صفحه سیاست حریم خصوصی." },
      { key: "signup.enabled", labelFa: "فعال بودن ثبت‌نام", descFa: "اگر خاموش باشد، ثبت‌نام کاربر جدید غیرفعال می‌شود.", default: "true", options: [{ value: "true", labelFa: "فعال" }, { value: "false", labelFa: "غیرفعال" }] },
      { key: "maintenance.messageFa", labelFa: "پیام نگهداری", descFa: "در صورت فعال بودن حالت نگهداری، این پیام به کاربران نمایش داده می‌شود." },
    ],
  },
  {
    id: "sms_panel",
    titleFa: "پنل پیامکی",
    descriptionFa: "ابتدا پنل پیامکی را از فهرست کشویی انتخاب کنید؛ سپس فقط تنظیمات همان پنل نمایش داده می‌شود. مقادیر واردشده، تنظیمات محیطی (env) را بازنویسی می‌کنند.",
    keys: [
      {
        key: "POSTYAR_SMS_PROVIDER",
        labelFa: "انتخاب پنل پیامکی",
        descFa: "کدام سرویس پیامکی برای ارسال OTP استفاده شود. با انتخاب هر پنل، فقط تنظیمات همان پنل پایین نمایش داده می‌شود.",
        options: [
          { value: "", labelFa: "— خاموش (غیرفعال) —" },
          { value: "melipayamak", labelFa: "ملی پیامک (Melipayamak)" },
          { value: "kavenegar", labelFa: "کاوه‌نگار (Kavehnegar)" },
          { value: "farapayamak", labelFa: "فراز پیامک (Farapayamak)" },
          { value: "smsir", labelFa: "SMS.ir" },
          { value: "nikpayamak", labelFa: "نیکو پیامک (Nikpayamak)" },
        ],
      },
      { key: "POSTYAR_SMS_SENDER", labelFa: "شماره فرستنده", descFa: "شماره/خط فرستنده پیامک (برای ارائه‌دهنده‌هایی که نیاز دارند)." },
      { key: "POSTYAR_SMS_API_KEY", labelFa: "کلید API پیامک", descFa: "کلید احراز هویت ارائه‌دهنده پیامک (کاوه‌نگار / SMS.ir). محرمانه است و در فهرست به‌صورت ماسک نمایش داده می‌شود.", sensitive: true },
      { key: "POSTYAR_SMS_TEMPLATE_ID", labelFa: "شناسه الگو (SMS.ir)", descFa: "شناسه الگوی پیامک در SMS.ir. برای سایر ارائه‌دهنده‌ها الزامی نیست." },
      { key: "POSTYAR_SMS_USERNAME", labelFa: "نام کاربری پیامک", descFa: "نام کاربری برای پنل‌هایی که با نام کاربری/رمز احراز می‌شوند (ملی‌پیامک، فراز پیامک، نیکو پیامک).", sensitive: true },
      { key: "POSTYAR_SMS_PASSWORD", labelFa: "رمز عبور پیامک", descFa: "رمز عبور پنل پیامک. محرمانه است.", sensitive: true },
    ],
  },
  {
    id: "email_panel",
    titleFa: "پنل ایمیل",
    descriptionFa: "تنظیمات SMTP برای ایمیل‌های سیستمی. مقادیر واردشده، env را بازنویسی می‌کنند.",
    keys: [
      { key: "POSTYAR_SMTP_HOST", labelFa: "میزبان SMTP", descFa: "نشانی میزبان SMTP (مثال: smtp.example.com)." },
      { key: "POSTYAR_SMTP_PORT", labelFa: "پورت SMTP", descFa: "پورت SMTP (معمولاً 587 برای STARTTLS یا 465 برای SSL).", default: "587" },
      { key: "POSTYAR_SMTP_USER", labelFa: "نام کاربری SMTP", descFa: "نام کاربری حساب SMTP.", sensitive: true },
      { key: "POSTYAR_SMTP_PASSWORD", labelFa: "رمز عبور SMTP", descFa: "رمز عبور حساب SMTP. محرمانه است.", sensitive: true },
      { key: "POSTYAR_SMTP_SENDER_EMAIL", labelFa: "ایمیل فرستنده", descFa: "نشانی ایمیل فرستنده (مثال: no-reply@postyar.local)." },
      { key: "POSTYAR_SMTP_SENDER_NAME", labelFa: "نام فرستنده", descFa: "نام نمایشی فرستنده (مثال: پُست‌یار).", default: "پُست‌یار" },
    ],
  },
  {
    id: "bank_gateway",
    titleFa: "درگاه بانکی",
    descriptionFa: "ابتدا درگاه پرداخت را از فهرست کشویی انتخاب کنید؛ سپس فقط تنظیمات همان درگاه نمایش داده می‌شود. مقادیر واردشده، env را بازنویسی می‌کنند.",
    keys: [
      {
        key: "POSTYAR_BANK_GATEWAY_PROVIDER",
        labelFa: "انتخاب درگاه بانکی",
        descFa: "نوع درگاه پرداخت را انتخاب کنید. با انتخاب هر درگاه، فقط تنظیمات مربوط به همان درگاه پایین نمایش داده می‌شود.",
        options: [
          { value: "", labelFa: "— انتخاب کنید —" },
          { value: "direct", labelFa: "مستقیم (پرداخت مستقیم)" },
          { value: "zibal", labelFa: "زیبال (Zibal)" },
          { value: "zarinpal", labelFa: "زرین‌پال (Zarinpal)" },
          { value: "nextpay", labelFa: "نکست‌پی (NextPay)" },
          { value: "idpay", labelFa: "آیدی‌پی (IDPay)" },
          { value: "saman", labelFa: "پرداخت آنلاین (بانک سامان)" },
        ],
      },
      { key: "POSTYAR_BANK_GATEWAY_NAME", labelFa: "نام نمایشی درگاه", descFa: "نام نمایشی درگاه در صورتحساب و رابط کاربری (مثال: ملت)." },
      { key: "POSTYAR_BANK_DIRECT_URL", labelFa: "نشانی endpoint توکن (مستقیم)", descFa: "نشانی endpoint درخواست توکن درگاه مستقیم (مثال: https://bank.example.com/pg/Token)." },
      { key: "POSTYAR_BANK_DIRECT_MERCHANT", labelFa: "کد پذیرنده (MerchantId)", descFa: "کد پذیرنده (MerchantId) درگاه مستقیم. محرمانه است.", sensitive: true },
      { key: "POSTYAR_BANK_DIRECT_TERMINAL", labelFa: "کد ترمینال (TerminalId)", descFa: "کد ترمینال (TerminalId) درگاه مستقیم. محرمانه است.", sensitive: true },
      { key: "POSTYAR_BANK_DIRECT_SECRET", labelFa: "رمز امضای درگاه مستقیم", descFa: "رمز امضای (Secret) درگاه مستقیم. محرمانه است.", sensitive: true },
      { key: "POSTYAR_BANK_INTERMEDIARY_URL", labelFa: "نشانی درگاه واسط", descFa: "نشانی endpoint درگاه واسط (برخی درگاه‌های واسط نیاز دارند).", sensitive: true },
      { key: "POSTYAR_BANK_INTERMEDIARY_MERCHANT", labelFa: "کد پذیرنده / کلید واسط (MerchantCode/ApiKey)", descFa: "کد پذیرنده یا کلید API درگاه واسط (زیبال / زرین‌پال / نکست‌پی / آیدی‌پی). محرمانه است.", sensitive: true },
      { key: "POSTYAR_BANK_INTERMEDIARY_SECRET", labelFa: "رمز درگاه واسط", descFa: "رمز درگاه واسط (برخی درگاه‌های واسط نیاز دارند). محرمانه است.", sensitive: true },
      {
        key: "POSTYAR_BANK_GATEWAY_SANDBOX",
        labelFa: "حالت آزمایشی (Sandbox)",
        descFa: "برای درگاه‌های واسط که حالت آزمایشی دارند (زرین‌پال، آیدی‌پی). برای تولید خاموش کنید.",
        default: "false",
        options: [{ value: "false", labelFa: "غیرفعال (تولید)" }, { value: "true", labelFa: "فعال (آزمایشی)" }],
      },
      { key: "POSTYAR_BANK_CALLBACK_PATH", labelFa: "مسیر بازگشت (Callback)", descFa: "مسیر callback درگاه. پیش‌فرض: /api/payments/bank/callback.", default: "/api/payments/bank/callback" },
      { key: "POSTYAR_PUBLIC_BASE_URL", labelFa: "نشانی پایه عمومی سامانه", descFa: "نشانی base عمومی سامانه (برای ساخت URL بازگشت مطلق). محرمانه است.", sensitive: true },
    ],
  },
  {
    id: "gold_config",
    titleFa: "پیکربندی طلا",
    descriptionFa: "منبع داده قیمت طلا. برای پیکربندی کامل (انتخاب منبع / انتخابگرها / توکن)، به بخش «طلای سامانه» بروید.",
    keys: [
      { key: "POSTYAR_GOLD_PROVIDER_URL", labelFa: "نشانی ارائه‌دهنده طلا", descFa: "نشانی JSON ارائه‌دهنده قیمت طلا. پیشنهاد می‌شود از بخش «طلای سامانه» پیکربندی کامل بسازید.", sensitive: true },
    ],
  },
  {
    id: "ai_config",
    titleFa: "پیکربندی هوش مصنوعی",
    descriptionFa: "ارائه‌دهنده و مدل هوش مصنوعی پیش‌فرض. مقادیر واردشده، env را بازنویسی می‌کنند.",
    keys: [
      {
        key: "POSTYAR_AI_PROVIDER",
        labelFa: "ارائه‌دهنده هوش مصنوعی",
        descFa: "کدام ارائه‌دهنده به‌صورت پیش‌فرض فراخوانی شود. ارائه‌دهندهٔ داخلی postyar-zai همیشه فعال است.",
        options: [
          { value: "", labelFa: "— پیش‌فرض داخلی (postyar-zai) —" },
          { value: "openai", labelFa: "OpenAI" },
          { value: "gemini", labelFa: "Google Gemini" },
          { value: "deepseek", labelFa: "DeepSeek" },
          { value: "anthropic", labelFa: "Anthropic" },
          { value: "grok", labelFa: "Grok" },
          { value: "openrouter", labelFa: "OpenRouter" },
        ],
      },
      { key: "POSTYAR_AI_API_KEY", labelFa: "کلید API هوش مصنوعی", descFa: "کلید احراز هویت ارائه‌دهنده. محرمانه است.", sensitive: true },
      { key: "POSTYAR_AI_MODEL", labelFa: "مدل هوش مصنوعی", descFa: "شناسه مدل پیش‌فرض (مثال: gpt-4o-mini)." },
    ],
  },
  {
    id: "security",
    titleFa: "امنیت و محدودیت",
    descriptionFa: "تنظیمات امنیتی و محدودیت نرخ. محتاطانه ویرایش کنید.",
    keys: [
      { key: "POSTYAR_OTP_COOLDOWN_SEC", labelFa: "فاصلهٔ زمانی OTP (ثانیه)", descFa: "حداقل فاصلهٔ زمانی بین دو درخواست OTP برای یک شماره. پیش‌فرض: ۶۰.", default: "60" },
      { key: "POSTYAR_MAX_LOGIN_ATTEMPTS", labelFa: "حداکثر تلاش ورود", descFa: "حداکثر تلاش ناموفق قبل از موقت‌مسدود شدن نشانی IP. پیش‌فرض: ۳۰.", default: "30" },
      { key: "POSTYAR_RATE_LIMIT_PER_MIN", labelFa: "محدودیت نرخ (در دقیقه)", descFa: "حداکثر درخواست در دقیقه برای هر IP روی مسیرهای عمومی. پیش‌فرض: ۶۰.", default: "60" },
    ],
  },
];

const ALLOWED_KEYS = GROUPS.flatMap((g) => g.keys.map((k) => k.key));

const PostSchema = z.object({
  key: z.string().min(1).max(80),
  value: z.string().max(8000),
});

const PatchSchema = z.object({
  items: z.array(z.object({ key: z.string().min(1).max(80), value: z.string().max(8000) })).min(1).max(64),
}).or(z.object({ key: z.string().min(1).max(80), value: z.string().max(8000) }));

const DeleteSchema = z.object({ key: z.string().min(1).max(80) });

export async function GET() {
  let user;
  try { user = await requireRole(["admin"]); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  void user;
  // L-6 — only admin-manageable keys are ever listed. Internal rows
  // (settings-cache epoch, one-shot migration markers, the first-admin
  // bootstrap claim, future bookkeeping) are NEVER serialized to clients —
  // a future secret accidentally written under a non-allowlist key cannot
  // leak through this endpoint.
  const rows = await db.systemSetting.findMany({
    where: { key: { in: ALLOWED_KEYS } },
  });
  // ROOT-CAUSE FIX (audit §28/§34 — secret disclosure): sensitive values
  // are MASKED in responses; setting a value still works (write-only
  // semantics) and the UI already renders masked previews.
  const sensitiveByKey = new Map<string, boolean>(GROUPS.flatMap((g) => g.keys.map((k) => [k.key, k.sensitive === true] as [string, boolean])));
  return NextResponse.json({
    items: rows.map((r) => {
      const isSensitive = sensitiveByKey.get(r.key) ?? false;
      const value = isSensitive ? maskSecretValue(r.value) : r.value;
      return {
        key: r.key,
        value,
        masked: isSensitive,
        updatedAt: r.updatedAt.toISOString(),
        updatedAtFa: formatJalaliDateTime(r.updatedAt, { withTime: true }),
      };
    }),
    allowedKeys: ALLOWED_KEYS,
    groups: GROUPS,
  });
}

/** Mask a secret for display: show nothing but a fixed placeholder. */
const MASK_PLACEHOLDER = "••••••••";
function maskSecretValue(v: string): string {
  if (!v) return "";
  return MASK_PLACEHOLDER;
}
function isSensitiveKey(key: string): boolean {
  return GROUPS.some((g) => g.keys.some((it) => it.key === key && it.sensitive === true));
}

/**
 * P1.5 — sensitive credentials are ENCRYPTED at rest (AES-256-GCM envelope)
 * so a DB dump/backup never exposes provider secrets in plaintext. General
 * (non-sensitive) settings remain plaintext. The masked-placeholder guard
 * (GET masking preserved) prevents writing the mask over a real secret.
 */
function prepareStoredValue(key: string, value: string): string {
  if (!isSensitiveKey(key)) return value;
  if (!value) return value;
  if (value.startsWith("v1:aes-256-gcm:")) return value; // already enveloped
  return encryptString(value);
}

export async function POST(req: Request) {
  let user;
  try { user = await requireRole(["admin"]); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsed = PostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }
  if (!ALLOWED_KEYS.includes(parsed.data.key)) {
    return NextResponse.json({ errorFa: "این کلید تنظیمات پشتیبانی نمی‌شود." }, { status: 400 });
  }
  // Guard against writing the masked placeholder back over a real secret
  // (the GET response masks sensitive values — see maskSecretValue).
  if (isSensitiveKey(parsed.data.key) && parsed.data.value === MASK_PLACEHOLDER) {
    return NextResponse.json({ ok: true, unchanged: true });
  }
  const storedValue = prepareStoredValue(parsed.data.key, parsed.data.value);
  // V4 H-9 — the settings change and its audit row commit ATOMICALLY
  // (critical, tx-bound): a committed settings change can never exist
  // without its audit trail. Cache invalidation + epoch bump happen only
  // AFTER a successful commit.
  const updated = await db.$transaction(async (tx) => {
    const row = await tx.systemSetting.upsert({
      where: { key: parsed.data.key },
      create: { key: parsed.data.key, value: storedValue },
      update: { value: storedValue },
    });
    await audit({
      userId: user.id,
      actor: "admin",
      action: "system_setting_updated",
      targetType: "system_setting",
      targetId: row.key,
      ip,
      tx,
      critical: true,
      meta: { key: row.key, mode: "single" },
    });
    return row;
  });
  invalidateSettingsCache();
  // C-05: bump the shared settings-cache epoch so EVERY app instance
  // re-reads this setting within the explicit 3s window.
  await bumpSettingsEpoch();
  return NextResponse.json({
    ok: true,
    setting: {
      key: updated.key,
      value: isSensitiveKey(updated.key) ? MASK_PLACEHOLDER : updated.value,
      masked: isSensitiveKey(updated.key),
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
}

export async function PATCH(req: Request) {
  let user;
  try { user = await requireRole(["admin"]); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
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
  const items = "items" in parsed.data ? parsed.data.items : [parsed.data];
  // Validate all keys BEFORE persisting — atomicity (no half-saved batch).
  const bad = items.find((it) => !ALLOWED_KEYS.includes(it.key));
  if (bad) {
    return NextResponse.json({ errorFa: `کلید «${bad.key}» پشتیبانی نمی‌شود.` }, { status: 400 });
  }
  // Drop masked-placeholder writes for sensitive keys (see GET masking).
  const writable = items.filter((it) => !(isSensitiveKey(it.key) && it.value === MASK_PLACEHOLDER));
  if (writable.length === 0) {
    return NextResponse.json({ ok: true, count: 0, unchanged: true });
  }
  // M-01: the WHOLE batch is ONE DB transaction — validate-all-before-
  // write only covered the key allowlist; a mid-loop DB error previously
  // committed rows 1..k-1 (partial batch) and surfaced as a 500. Now an
  // upsert failure rolls back every row of the batch (all-or-nothing),
  // the shared cache is invalidated and the epoch is bumped ONLY after a
  // successful commit, and exactly one coherent audit event is written.
  try {
    await db.$transaction(async (tx) => {
      for (const it of writable) {
        const storedValue = prepareStoredValue(it.key, it.value);
        await tx.systemSetting.upsert({
          where: { key: it.key },
          create: { key: it.key, value: storedValue },
          update: { value: storedValue },
        });
      }
      // V4 H-9 — the coherent batch audit JOINS the transaction
      // (critical): all-or-nothing persistence includes its audit trail.
      await audit({
        userId: user.id,
        actor: "admin",
        action: "system_setting_updated",
        targetType: "system_setting",
        targetId: items[0]?.key,
        ip,
        tx,
        critical: true,
        meta: { keys: items.map((i) => i.key), mode: "batch", count: items.length },
      });
    });
  } catch {
    return NextResponse.json({ errorFa: "ذخیره‌سازی تنظیمات ناموفق بود؛ هیچ تغییری اعمال نشد." }, { status: 500 });
  }
  invalidateSettingsCache();
  // C-05: one shared-epoch bump covers the whole batch.
  await bumpSettingsEpoch();
  return NextResponse.json({ ok: true, count: items.length });
}

export async function DELETE(req: Request) {
  let user;
  try { user = await requireRole(["admin"]); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsed = DeleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }
  if (!ALLOWED_KEYS.includes(parsed.data.key)) {
    return NextResponse.json({ errorFa: "این کلید تنظیمات پشتیبانی نمی‌شود." }, { status: 400 });
  }
  // V4 H-9 — delete (best-effort: a missing row is the same end-state)
  // and its critical audit commit atomically.
  await db.$transaction(async (tx) => {
    try {
      await tx.systemSetting.delete({ where: { key: parsed.data.key } });
    } catch {
      // Row doesn't exist — that's the same end-state (revert to env/default).
    }
    await audit({
      userId: user.id,
      actor: "admin",
      action: "system_setting_reset",
      targetType: "system_setting",
      targetId: parsed.data.key,
      ip,
      tx,
      critical: true,
      meta: { key: parsed.data.key },
    });
  });
  invalidateSettingsCache();
  await bumpSettingsEpoch();
  return NextResponse.json({ ok: true });
}
