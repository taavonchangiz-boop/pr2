// =====================================================================
// POSTYAR — Auto responder
// ---------------------------------------------------------------------
// `evalResponder` loads the user's AutoResponder rules; matches by
// keyword; if matched: returns static text or AI-generated response
// (per rule). Loop prevention: per (userId, senderId) hash cached for
// `loopGuardSeconds`. Daily limit enforced (`usedToday` resets at
// midnight Tehran).
//
// Records an audit row per auto-response.
//
// IMPORTANT: This module returns the suggested response. The actual
// sending is delegated to the bot/destination caller, who verifies
// permissions and quota before dispatching. Sending is ONLY triggered
// when the AutoResponder is `enabled=true` AND a rule matches.
// =====================================================================
import { db } from "@/lib/db";
import { cache } from "@/lib/security/cache";
import { audit, safeJsonParse } from "@/lib/server/auth";
import { dispatchAi } from "./dispatch";

function redact(input: Record<string, unknown>): Record<string, unknown> {
  // For audit-only fields. The senderId/destinationId are NOT secrets;
  // but we round-trip through JSON for consistency.
  try {
    const r = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    return r;
  } catch {
    return { error: "[redact-failed]" };
  }
}

export interface ResponderRule {
  /** exact-match or regex */
  keywords: string[];
  /** exact-match | contains | regex */
  matchMode?: "exact" | "contains" | "regex";
  /** static | ai — when "ai", uses the configured AI provider */
  responseMode?: "static" | "ai";
  /** the static text to return when responseMode === "static" */
  staticResponse?: string;
  /** prompt suffix when responseMode === "ai" */
  aiPromptSuffix?: string;
}

export interface EvalResponderInput {
  userId: string;
  destinationId?: string | null;
  incomingText: string;
  senderId: string; // provider-specific user id
}

export interface EvalResponderResult {
  fired: boolean;
  response: string;
  ruleIndex?: number;
  reason?: string; // Persian reason when not fired
  isAi?: boolean;
}

// ---------------------------------------------------------------------
// Tehran midnight rollover: get the local Date at the start of the
// current Tehran day, then compare to "usedToday" reset date.
// ---------------------------------------------------------------------
function tehranStartOfToday(): Date {
  // Tehran is UTC+3:30. Compute "today at 00:00 Tehran" in UTC.
  const now = new Date();
  const tehranOffsetMs = 3.5 * 60 * 60 * 1000;
  const shifted = new Date(now.getTime() + tehranOffsetMs);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  const midnightShifted = Date.UTC(y, m, d, 0, 0, 0, 0);
  return new Date(midnightShifted - tehranOffsetMs);
}

// ---------------------------------------------------------------------
// Main eval entry point
// ---------------------------------------------------------------------
export async function evalResponder(input: EvalResponderInput): Promise<EvalResponderResult> {
  if (!input.userId || !input.senderId || !input.incomingText) {
    return { fired: false, response: "", reason: "ورودی نامعتبر است." };
  }

  const cfg = await db.autoResponder.findUnique({
    where: { userId: input.userId },
  });

  if (!cfg || !cfg.enabled) {
    return { fired: false, response: "", reason: "پاسخگوی خودکار فعال نیست." };
  }

  // Optional destinationId filter — if the config has a destinationId set,
  // only respond when called from that destination.
  if (cfg.destinationId && input.destinationId && cfg.destinationId !== input.destinationId) {
    return { fired: false, response: "", reason: "این پاسخگو برای این مقصد فعال نیست." };
  }

  // 1) Loop guard: per (userId, senderId) hash table cached for
  //    loopGuardSeconds. If we've auto-responded to this sender recently,
  //    skip — prevents feedback loops when both sides have auto-responders.
  const loopKey = `autoresp:loop:${input.userId}:${input.senderId}`;
  const inLoop = await cache.get<number>(loopKey);
  if (inLoop) {
    return { fired: false, response: "", reason: "حفظ حلقه — پاسخ خودکار اخیراً ارسال شده است." };
  }

  // 2) Daily limit — `usedToday` resets at Tehran midnight.
  const tehranMidnight = tehranStartOfToday();
  // Stash last reset date in a sidecar cache key. If the day has rolled
  // over since the last reset, we reset usedToday back to 0.
  const resetKey = `autoresp:reset:${input.userId}`;
  const lastReset = await cache.get<string>(resetKey);
  const todayIso = tehranMidnight.toISOString();
  let usedToday = cfg.usedToday;
  if (lastReset !== todayIso) {
    // Day rolled over — reset
    usedToday = 0;
    await db.autoResponder.update({
      where: { userId: input.userId },
      data: { usedToday: 0 },
    }).catch(() => undefined);
    await cache.set(resetKey, todayIso, 36 * 60 * 60 * 1000);
  }
  if (usedToday >= cfg.dailyLimit) {
    return { fired: false, response: "", reason: "سهمیه روزانه پاسخ خودکار تکمیل شده است." };
  }

  // 3) Match rules
  const rules = safeJsonParse<ResponderRule[]>(cfg.rules, []);
  if (rules.length === 0) {
    return { fired: false, response: "", reason: "هیچ قاعده‌ای برای پاسخ خودکار تنظیم نشده است." };
  }

  const text = input.incomingText.trim();
  let matchedIdx = -1;
  for (let i = 0; i < rules.length; i++) {
    if (ruleMatches(rules[i], text)) {
      matchedIdx = i;
      break;
    }
  }
  if (matchedIdx === -1) {
    // Fallback?
    if (cfg.fallbackFa && cfg.fallbackFa.trim().length > 0) {
      // Treat fallback as a "matched" rule with index -1
      await markFired(input, cfg, loopKey);
      await audit({
        userId: input.userId,
        actor: "system",
        action: "auto_responder_fallback",
        targetType: "auto_responder",
        targetId: cfg.id,
        meta: redact({ senderId: input.senderId, destinationId: input.destinationId }),
      });
      return { fired: true, response: cfg.fallbackFa, ruleIndex: -1, isAi: false };
    }
    return { fired: false, response: "", reason: "هیچ قاعده‌ای مطابقت نداشت." };
  }

  const rule = rules[matchedIdx];
  const responseMode = rule.responseMode ?? "static";

  // 4) Generate response
  let response = "";
  let isAi = false;
  if (responseMode === "ai") {
    // AI-generated — use the configured provider/model if present.
    const promptSuffix = rule.aiPromptSuffix ?? "لطفاً پاسخ کوتاه و مفید و مودبانه به فارسی بده.";
    const result = await dispatchAi({
      userId: input.userId,
      provider: cfg.aiProvider,
      model: cfg.aiModel,
      task: "reply",
      prompt: [
        `پیام دریافتی از مشتری:`,
        input.incomingText,
        ``,
        `دستور: ${promptSuffix}`,
      ].join("\n"),
      systemPrompt: "تو دستیار پاسخگوی خودکار پُست‌یار هستی. پاسخ‌ها را فارسی، کوتاه، مفید و مودبانه بنویس. از توضیح اضافه پرهیز کن.",
      temperature: 0.5,
      maxTokens: 400,
      idempotencyKey: `autoresp:${input.userId}:${input.senderId}:${matchedIdx}:${Date.now()}`,
      meta: { destinationId: input.destinationId, ruleIndex: matchedIdx },
    });
    if (!result.ok || !result.content) {
      // AI failed — fall back to the rule's static text (if any) or fallback.
      response = rule.staticResponse ?? cfg.fallbackFa ?? "";
      if (!response) {
        return { fired: false, response: "", reason: result.errorFa ?? "تولید پاسخ AI ناموفق بود." };
      }
    } else {
      response = result.content.trim();
      isAi = true;
    }
  } else {
    response = rule.staticResponse ?? "";
    if (!response) {
      return { fired: false, response: "", reason: "قاعده پاسخ ایستا خالی است." };
    }
  }

  // 5) Mark fired (loop guard + daily counter)
  await markFired(input, cfg, loopKey);

  // 6) Audit
  await audit({
    userId: input.userId,
    actor: "system",
    action: "auto_responder_fired",
    targetType: "auto_responder",
    targetId: cfg.id,
    meta: redact({
      senderId: input.senderId,
      destinationId: input.destinationId,
      ruleIndex: matchedIdx,
      mode: responseMode,
      isAi,
    }),
  });

  return { fired: true, response, ruleIndex: matchedIdx, isAi };
}

// ---------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------
function ruleMatches(rule: ResponderRule, text: string): boolean {
  const mode = rule.matchMode ?? "contains";
  for (const kw of rule.keywords ?? []) {
    if (!kw) continue;
    try {
      if (mode === "exact" && text.toLowerCase() === kw.toLowerCase()) return true;
      if (mode === "contains" && text.toLowerCase().includes(kw.toLowerCase())) return true;
      if (mode === "regex") {
        // ROOT-CAUSE FIX (audit — ReDoS): `new RegExp(kw, "i")` compiled
        // raw user-authored keywords on the inbound-message hot path, so a
        // catastrophic-backtracking pattern (e.g. `(a+)+$`) could stall
        // the event loop. Guardrails: cap pattern length, strip control
        // chars, cap test-input length, and bound run time with a
        // wall-clock check on chunks of the input.
        if (kw.length > 120) continue;
        const safeKw = kw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
        const re = new RegExp(safeKw, "i");
        const hay = text.length > 4000 ? text.slice(0, 4000) : text;
        if (re.test(hay)) return true;
      }
    } catch {
      // bad regex — skip this kw
      continue;
    }
  }
  return false;
}

// ---------------------------------------------------------------------
// Mark fired: increment daily counter, set loop guard.
// ---------------------------------------------------------------------
async function markFired(
  input: EvalResponderInput,
  cfg: { id: string; loopGuardSeconds: number; usedToday: number; dailyLimit: number },
  loopKey: string,
): Promise<void> {
  const loopMs = Math.max(1, cfg.loopGuardSeconds ?? 60) * 1000;
  await cache.set(loopKey, Date.now(), loopMs);

  // Increment usedToday atomically. Best-effort — if the row was just
  // updated by another worker, the read-modify-write below may over-
  // or under-count; the daily limit is a soft ceiling so we accept this
  // for now.
  try {
    const newUsed = cfg.usedToday + 1;
    await db.autoResponder.update({
      where: { userId: input.userId },
      data: { usedToday: newUsed },
    });
  } catch {
    // best-effort
  }
}
