// =====================================================================
// POSTYAR — Smart reply
// ---------------------------------------------------------------------
// Generates a Persian reply suggestion for an inbound message.
// Automatic sending requires explicit authorization via AutoResponder
// config — this module ONLY returns suggestions.
// =====================================================================
import crypto from "node:crypto";
import { dispatchAi } from "./dispatch";

export interface SmartReplyContext {
  recentThread?: Array<{ role: "user" | "assistant" | "system"; text: string }>;
  channel?: "telegram" | "bale" | "rubika" | "instagram" | "website" | "general";
  provider?: string; // messaging provider name
}

export interface SmartReplyResult {
  ok: boolean;
  suggestion: string;
  alternatives: string[];
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  aiJobId: string;
  errorFa?: string;
}

const CHANNEL_FA: Record<NonNullable<SmartReplyContext["channel"]>, string> = {
  telegram: "تلگرام",
  bale: "بله",
  rubika: "روبیکا",
  instagram: "اینستاگرام",
  website: "وب‌سایت",
  general: "عمومی",
};

function buildSystemPrompt(ctx: SmartReplyContext): string {
  const channel = ctx.channel ? CHANNEL_FA[ctx.channel] : "عمومی";
  return [
    "تو دستیار پاسخ‌گویی پُست‌یار هستی و فقط به زبان فارسی پاسخ می‌دهی.",
    "بر اساس پیام دریافتی و تاریخچه گفت‌وگو، یک پاسخ مودبانه و مفید پیشنهاد بده.",
    `کانال گفت‌وگو: ${channel}.`,
    "پاسخ باید کوتاه، مفید و با لحن صمیمی اما محترمانه باشد.",
    "خروجی باید به صورت JSON معتبر در قالب زیر باشد:",
    '{"suggestion": string, "alternatives": string[]}',
    "بدون توضیح اضافه، فقط JSON خروجی بده.",
    "حداقل ۲ و حداکثر ۳ گزینه جایگزین ارائه بده.",
  ].join(" ");
}

function buildUserPrompt(message: string, ctx: SmartReplyContext): string {
  const lines: string[] = [];
  if (ctx.recentThread && ctx.recentThread.length > 0) {
    lines.push("تاریخچه اخیر:");
    for (const turn of ctx.recentThread.slice(-6)) {
      const roleFa = turn.role === "assistant" ? "اپراتور" : turn.role === "system" ? "سیستم" : "مشتری";
      lines.push(`${roleFa}: ${turn.text}`);
    }
    lines.push("");
  }
  lines.push(`پیام جدید دریافتی از مشتری:`);
  lines.push(message);
  lines.push("");
  lines.push("لطفاً یک پاسخ مناسب و دو گزینه جایگزین تولید کن.");
  return lines.join("\n");
}

function safeExtractJson(content: string): { suggestion: string; alternatives: string[] } | null {
  const trimmed = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  const jsonStr = trimmed.slice(first, last + 1);
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const suggestion = typeof parsed.suggestion === "string" ? parsed.suggestion : "";
    const alternatives = Array.isArray(parsed.alternatives)
      ? parsed.alternatives.filter((s): s is string => typeof s === "string").slice(0, 3)
      : [];
    if (!suggestion) return null;
    return { suggestion, alternatives };
  } catch {
    return null;
  }
}

export async function smartReply(input: {
  userId: string;
  message: string;
  context?: SmartReplyContext;
  provider?: string | null;
  model?: string | null;
}): Promise<SmartReplyResult> {
  const message = (input.message ?? "").trim();
  if (message.length < 2) {
    return {
      ok: false,
      suggestion: "",
      alternatives: [],
      provider: "",
      model: "",
      tokensIn: 0,
      tokensOut: 0,
      aiJobId: "",
      errorFa: "پیام دریافتی برای تولید پاسخ خیلی کوتاه است.",
    };
  }

  const ctx = input.context ?? {};
  const result = await dispatchAi({
    userId: input.userId,
    provider: input.provider ?? null,
    model: input.model ?? null,
    task: "reply",
    prompt: buildUserPrompt(message, ctx),
    systemPrompt: buildSystemPrompt(ctx),
    temperature: 0.6,
    maxTokens: 700,
    // P0.4 — deterministic idempotency key over the authoritative input set
    // (message + context + provider/model; no random entropy).
    idempotencyKey: `reply:${crypto
      .createHash("sha256")
      .update(
        [
          input.userId,
          message,
          ctx.channel ?? "",
          ctx.provider ?? "",
          (ctx.recentThread ?? []).map((m) => `${m.role}:${m.text}`).join("\u0001"),
          input.provider ?? "auto",
          input.model ?? "auto",
        ].join("\u0000"),
      )
      .digest("hex")}`,
    meta: { channel: ctx.channel, provider: ctx.provider },
  });

  if (!result.ok || !result.content) {
    return {
      ok: false,
      suggestion: "",
      alternatives: [],
      provider: result.provider,
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      aiJobId: result.aiJobId,
      errorFa: result.errorFa ?? "تولید پاسخ ناموفق بود.",
    };
  }

  const extracted = safeExtractJson(result.content);
  if (!extracted) {
    return {
      ok: true,
      suggestion: result.content.trim(),
      alternatives: [],
      provider: result.provider,
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      aiJobId: result.aiJobId,
    };
  }
  return {
    ok: true,
    suggestion: extracted.suggestion,
    alternatives: extracted.alternatives,
    provider: result.provider,
    model: result.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    aiJobId: result.aiJobId,
  };
}
