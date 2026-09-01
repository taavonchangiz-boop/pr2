// =====================================================================
// POSTYAR — Smart text (generate / rewrite / shorten / expand / tone)
// ---------------------------------------------------------------------
// Single endpoint for free-form text generation/editing. Returns a
// single text blob. The frontend can drop it into a Content body.
// =====================================================================
import crypto from "node:crypto";
import { dispatchAi } from "./dispatch";

export type SmartTextMode = "generate" | "rewrite" | "shorten" | "expand" | "tone";

export interface SmartTextToneOpts {
  tone?: "formal" | "friendly" | "casual" | "promotional" | "educational";
}

export interface SmartTextOpts extends SmartTextToneOpts {
  topic?: string;
  audience?: string;
  maxLength?: number;
}

export interface SmartTextInput {
  mode: SmartTextMode;
  input: string;
  opts?: SmartTextOpts;
}

export interface SmartTextResult {
  ok: boolean;
  text: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  aiJobId: string;
  errorFa?: string;
}

const TONE_FA: Record<NonNullable<SmartTextOpts["tone"]>, string> = {
  formal: "رسمی",
  friendly: "صمیمی",
  casual: "محاوره‌ای",
  promotional: "تبلیغاتی",
  educational: "آموزشی",
};

function buildSystemPrompt(mode: SmartTextMode, opts: SmartTextOpts): string {
  const base = [
    "تو دستیار ویرایش متن پُست‌یار هستی و فقط به زبان فارسی پاسخ می‌دهی.",
    "قواعد نگارشی فارسی (نیم‌فاصله، نشانه‌های نگارشی صحیح، رعایت نقطه و ویرگول) را رعایت کن.",
    "از کلمات بیگانه بی‌مقدار پرهیز کن.",
  ];
  switch (mode) {
    case "generate":
      base.push("یک متن یکپارچه و مفید به فارسی تولید کن. فقط متن خروجی بده، بدون توضیح اضافه یا پیشوند.");
      if (opts.topic) base.push(`موضوع متن: ${opts.topic}.`);
      if (opts.audience) base.push(`مخاطب هدف: ${opts.audience}.`);
      if (opts.maxLength) base.push(`حداکثر طول متن: ${opts.maxLength} کاراکتر.`);
      break;
    case "rewrite":
      base.push("متن ورودی را با حفظ معنی و همان مفهوم، به فارسی روان بازنویسی کن. فقط متن نهایی را بده.");
      break;
    case "shorten":
      base.push("متن ورودی را کوتاه‌تر کن؛ معنی و نکات اصلی را حفظ کن. فقط متن نهایی را بده.");
      break;
    case "expand":
      base.push("متن ورودی را با توضیح بیشتر و مثال‌های مرتبط گسترش بده. فقط متن نهایی را بده.");
      break;
    case "tone":
      base.push("متن ورودی را با لحن مشخص‌شده بازنویسی کن. فقط متن نهایی را بده.");
      if (opts.tone) base.push(`لحن هدف: ${TONE_FA[opts.tone]}.`);
      break;
  }
  return base.join(" ");
}

function buildUserPrompt(mode: SmartTextMode, input: string, opts: SmartTextOpts): string {
  switch (mode) {
    case "generate":
      return [
        `درباره‌ی موضوع «${opts.topic ?? input}» یک متن فارسی بنویس.`,
        "",
        input ? `راهنمایی تکمیلی: ${input}` : "",
      ].filter(Boolean).join("\n");
    case "rewrite":
      return `متن زیر را بازنویسی کن:\n\n${input}`;
    case "shorten":
      return `متن زیر را کوتاه‌تر کن:\n\n${input}`;
    case "expand":
      return `متن زیر را گسترش بده:\n\n${input}`;
    case "tone":
      return `متن زیر را با لحن ${opts.tone ? TONE_FA[opts.tone] : "صمیمی"} بازنویسی کن:\n\n${input}`;
  }
}

export async function generateText(input: {
  userId: string;
  mode: SmartTextMode;
  input: string;
  opts?: SmartTextOpts;
  provider?: string | null;
  model?: string | null;
}): Promise<SmartTextResult> {
  const opts = input.opts ?? {};
  const inp = (input.input ?? "").trim();

  if (input.mode !== "generate" && inp.length < 3) {
    return {
      ok: false,
      text: "",
      provider: "",
      model: "",
      tokensIn: 0,
      tokensOut: 0,
      aiJobId: "",
      errorFa: "متن ورودی حداقل باید ۳ نویسه باشد.",
    };
  }
  if (input.mode === "generate" && !opts.topic && inp.length < 3) {
    return {
      ok: false,
      text: "",
      provider: "",
      model: "",
      tokensIn: 0,
      tokensOut: 0,
      aiJobId: "",
      errorFa: "برای تولید متن، موضوع یا متن راهنما الزامی است.",
    };
  }

  const prompt = buildUserPrompt(input.mode, inp, opts);
  const systemPrompt = buildSystemPrompt(input.mode, opts);

  // P0.4 ROOT-CAUSE FIX — deterministic idempotency key. The previous key
  // embedded `randomToken(8)`, so logically IDENTICAL requests were never
  // idempotent: every retry/replay burned a fresh AI quota unit and
  // produced a new job. The key is now a cryptographic digest (SHA-256,
  // full width — collision protection) over the authoritative input set:
  //   userId | mode | normalized input | canonicalized opts | provider | model
  // Random entropy is never part of a logical idempotency key.
  const canonicalOpts = JSON.stringify({
    tone: opts.tone ?? null,
    topic: opts.topic ? opts.topic.trim() : null,
    audience: opts.audience ? opts.audience.trim() : null,
    maxLength: opts.maxLength ?? null,
  });
  const digest = crypto
    .createHash("sha256")
    .update(
      [
        input.userId,
        input.mode,
        inp,
        canonicalOpts,
        input.provider ?? "auto",
        input.model ?? "auto",
      ].join("\u0000"),
    )
    .digest("hex");
  const idempotencyKey = `text:${digest}`;

  const result = await dispatchAi({
    userId: input.userId,
    provider: input.provider ?? null,
    model: input.model ?? null,
    task: "text",
    prompt,
    systemPrompt,
    temperature: input.mode === "generate" || input.mode === "expand" ? 0.7 : 0.5,
    maxTokens: opts.maxLength ? Math.max(256, Math.min(2048, Math.ceil(opts.maxLength / 4))) : 1024,
    idempotencyKey,
    meta: { mode: input.mode, tone: opts.tone, audience: opts.audience },
  });

  if (!result.ok || !result.content) {
    return {
      ok: false,
      text: "",
      provider: result.provider,
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      aiJobId: result.aiJobId,
      errorFa: result.errorFa ?? "تولید متن ناموفق بود.",
    };
  }

  let text = result.content.trim();
  if (opts.maxLength && text.length > opts.maxLength) {
    text = text.slice(0, opts.maxLength).trim();
  }
  return {
    ok: true,
    text,
    provider: result.provider,
    model: result.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    aiJobId: result.aiJobId,
  };
}
