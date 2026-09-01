// =====================================================================
// POSTYAR — Smart caption generator
// ---------------------------------------------------------------------
// Builds a Persian prompt and dispatches AI. Returns caption,
// alternative variations, and Persian hashtags. Output is editable;
// the frontend writes it back into a Content row.
// =====================================================================
import crypto from "node:crypto";
import { dispatchAi } from "./dispatch";

export type CaptionTone = "formal" | "friendly" | "casual" | "promotional" | "educational";
export type CaptionPlatform = "telegram" | "bale" | "rubika" | "instagram" | "website" | "general";
export type CaptionLength = "short" | "medium" | "long";
export type CaptionPurpose = "engagement" | "sale" | "awareness" | "announcement";

export interface GenerateCaptionOpts {
  topic: string;
  tone?: CaptionTone;
  audience?: string;
  length?: CaptionLength;
  platform?: CaptionPlatform;
  purpose?: CaptionPurpose;
  provider?: string | null;
  model?: string | null;
}

export interface GenerateCaptionResult {
  ok: boolean;
  caption: string;
  alternatives: string[];
  hashtags: string[];
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  aiJobId: string;
  errorFa?: string;
}

const TONE_FA: Record<CaptionTone, string> = {
  formal: "رسمی",
  friendly: "صمیمی",
  casual: "محاوره‌ای",
  promotional: "تبلیغاتی",
  educational: "آموزشی",
};

const LENGTH_FA: Record<CaptionLength, string> = {
  short: "کوتاه (حدود ۸۰ تا ۱۲۰ کلمه)",
  medium: "متوسط (حدود ۱۵۰ تا ۲۲۰ کلمه)",
  long: "طولانی (حدود ۳۰۰ تا ۴۵۰ کلمه)",
};

const PLATFORM_FA: Record<CaptionPlatform, string> = {
  telegram: "تلگرام",
  bale: "بله",
  rubika: "روبیکا",
  instagram: "اینستاگرام",
  website: "وب‌سایت",
  general: "عمومی",
};

const PURPOSE_FA: Record<CaptionPurpose, string> = {
  engagement: "تعامل و مشارکت مخاطب",
  sale: "فروش و تبدیل به مشتری",
  awareness: "آگاهی برند",
  announcement: "اطلاع‌رسانی رویداد یا محصول",
};

function buildSystemPrompt(): string {
  return [
    "تو دستیار تولید محتوای پُست‌یار هستی و فقط به زبان فارسی پاسخ می‌دهی.",
    "متن‌ها را با رعایت کامل اصول نگارشی فارسی (نیم‌فاصله، نشانه‌های نگارشی، نقطه‌گذاری صحیح) تولید کن.",
    "از کلمات بیگانه بی‌مقدار پرهیز کن و در صورت نیاز از واژگان فارسی معادل استفاده کن.",
    "خروجی باید به صورت JSON معتبر در قالب زیر باشد:",
    '{"caption": string, "alternatives": string[], "hashtags": string[]}',
    "بدون توضیح اضافه، فقط JSON خروجی بده.",
    "برچسب‌ها (هشتگ) بدون فاصله و با یک علامت # در ابتدا باشند و فارسی.",
    "حداقل ۳ و حداکثر ۶ برچسب بنویس.",
    "حداقل ۲ و حداکثر ۳ گزینه جایگزین برای کپشن اصلی ارائه بده.",
  ].join(" ");
}

function buildUserPrompt(opts: Required<GenerateCaptionOpts>): string {
  return [
    `موضوع: ${opts.topic}`,
    `لحن: ${TONE_FA[opts.tone]}`,
    `مخاطب هدف: ${opts.audience}`,
    `طول متن: ${LENGTH_FA[opts.length]}`,
    `پلتفرم: ${PLATFORM_FA[opts.platform]}`,
    `هدف: ${PURPOSE_FA[opts.purpose]}`,
    "",
    "لطفاً یک کپشن اصلی، دو تا سه گزینه جایگزین، و فهرست برچسب مناسب تولید کن.",
  ].join("\n");
}

function safeExtractJson(content: string): { caption: string; alternatives: string[]; hashtags: string[] } | null {
  // Strip code fences if present
  const trimmed = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  // Find first { ... last }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  const jsonStr = trimmed.slice(first, last + 1);
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const caption = typeof parsed.caption === "string" ? parsed.caption : "";
    const alternatives = Array.isArray(parsed.alternatives)
      ? parsed.alternatives.filter((s): s is string => typeof s === "string").slice(0, 3)
      : [];
    const hashtags = Array.isArray(parsed.hashtags)
      ? parsed.hashtags
          .filter((s): s is string => typeof s === "string")
          .map((s) => (s.startsWith("#") ? s : `#${s.replace(/\s+/g, "_")}`))
          .slice(0, 6)
      : [];
    if (!caption) return null;
    return { caption, alternatives, hashtags };
  } catch {
    return null;
  }
}

export async function generateCaption(input: {
  userId: string;
  opts: GenerateCaptionOpts;
}): Promise<GenerateCaptionResult> {
  const opts: Required<GenerateCaptionOpts> = {
    topic: input.opts.topic?.trim() ?? "",
    tone: input.opts.tone ?? "friendly",
    audience: input.opts.audience ?? "مخاطب عمومی فارسی‌زبان",
    length: input.opts.length ?? "medium",
    platform: input.opts.platform ?? "general",
    purpose: input.opts.purpose ?? "engagement",
    provider: input.opts.provider ?? null,
    model: input.opts.model ?? null,
  };

  if (!opts.topic || opts.topic.length < 3) {
    return {
      ok: false,
      caption: "",
      alternatives: [],
      hashtags: [],
      provider: "",
      model: "",
      tokensIn: 0,
      tokensOut: 0,
      aiJobId: "",
      errorFa: "موضوع کپشن حداقل باید ۳ نویسه باشد.",
    };
  }

  const result = await dispatchAi({
    userId: input.userId,
    provider: opts.provider,
    model: opts.model,
    task: "caption",
    prompt: buildUserPrompt(opts),
    systemPrompt: buildSystemPrompt(),
    temperature: 0.8,
    maxTokens: 1200,
    // P0.4 — deterministic idempotency key over the authoritative input set
    // (no random entropy; full SHA-256 digest for collision protection).
    idempotencyKey: `caption:${crypto
      .createHash("sha256")
      .update(
        [
          input.userId,
          opts.topic,
          opts.tone,
          opts.audience,
          opts.length,
          opts.platform,
          opts.purpose,
          opts.provider ?? "auto",
          opts.model ?? "auto",
        ].join("\u0000"),
      )
      .digest("hex")}`,
    meta: { tone: opts.tone, platform: opts.platform, purpose: opts.purpose, length: opts.length },
  });

  if (!result.ok || !result.content) {
    return {
      ok: false,
      caption: "",
      alternatives: [],
      hashtags: [],
      provider: result.provider,
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      aiJobId: result.aiJobId,
      errorFa: result.errorFa ?? "تولید کپشن ناموفق بود.",
    };
  }

  const extracted = safeExtractJson(result.content);
  if (!extracted) {
    // The model didn't return JSON; degrade to using raw text as caption.
    return {
      ok: true,
      caption: result.content.trim(),
      alternatives: [],
      hashtags: [],
      provider: result.provider,
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      aiJobId: result.aiJobId,
    };
  }

  return {
    ok: true,
    caption: extracted.caption,
    alternatives: extracted.alternatives,
    hashtags: extracted.hashtags,
    provider: result.provider,
    model: result.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    aiJobId: result.aiJobId,
  };
}
