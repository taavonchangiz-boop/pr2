// =====================================================================
// POSTYAR — AI dispatch
// ---------------------------------------------------------------------
// Centralizes AI provider invocation: rate-limited per user (per plan
// quota), idempotent on key, persists an AiJob row with status
// queued → processing → completed/failed, records tokensIn/tokensOut.
// Uses the quota engine from Task 6-A (requireQuota + incrementQuotaUsage).
// =====================================================================
import { db } from "@/lib/db";
import { cache, idempotency } from "@/lib/security/cache";
import { AuthError, audit } from "@/lib/server/auth";
import {
  getAiProvider,
  pickProvider,
  sanitizePrompt,
  validateModel,
  getValidModels,
  type AiChatMessage,
  type AiProviderId,
  type AiChatResponse,
  redactAiPayload,
} from "@/lib/providers/ai";
import { consumeQuota } from "@/lib/payments/plans";
import { toPersianDigits } from "@/lib/persian";

// ---------------------------------------------------------------------
// Public input shape
// ---------------------------------------------------------------------
export type AiTaskKind = "caption" | "text" | "reply" | "custom";

export interface DispatchAiInput {
  userId: string;
  provider?: string | null; // preferred provider id
  model?: string | null;
  task: AiTaskKind;
  prompt: string;
  systemPrompt?: string;
  idempotencyKey: string;
  temperature?: number;
  maxTokens?: number;
  /** Optional caller metadata (sanitized before audit) */
  meta?: Record<string, unknown>;
}

export interface DispatchAiResult {
  ok: boolean;
  aiJobId: string;
  content: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  errorFa?: string;
}

// ---------------------------------------------------------------------
// Rate limit (separate from plan quota — a global safety valve).
// 30 requests per minute per user across all AI tasks.
// ---------------------------------------------------------------------
const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------
// dispatchAi
// ---------------------------------------------------------------------
export async function dispatchAi(input: DispatchAiInput): Promise<DispatchAiResult> {
  if (!input.userId) throw new AuthError("شناسه کاربر الزامی است.", 400);
  if (!input.idempotencyKey) throw new AuthError("کلید یکتا الزامی است.", 400);

  // 1) Per-user rate limit (global safety)
  const rlKey = `ai:rl:${input.userId}`;
  const rl = await cache.incr(rlKey, RL_WINDOW_MS);
  if (rl > RL_LIMIT) {
    throw new AuthError("درخواست‌های هوش مصنوعی بیش از حد مجاز در دقیقه است. اندکی بعد تلاش کنید.", 429);
  }

  // 2) Plan quota RESERVATION (audit §18 — atomic check+reserve). The old
  //    requireQuota-here / incrementQuotaUsage-later pair was a TOCTOU
  //    window: N parallel requests all passed the check then overwrote
  //    each other's JSON counters. consumeQuota CAS-loops the check+reserve
  //    atomically; a failed provider call keeps the reservation (fail-closed
  //    semantics, documented) — it can never allow quota overrun.
  const reserved = await consumeQuota({ userId: input.userId, dimension: "aiPerMonth", amount: 1 });
  if (!reserved) {
    throw new AuthError("سهمیه هوش مصنوعی ماهانه کافی نیست.", 403);
  }

  // 3) Idempotency at the dispatch layer — if we've seen this key,
  //    return the cached result.
  return idempotency<DispatchAiResult>(`ai:dispatch:${input.userId}:${input.idempotencyKey}`, async () => {
    // 4) Resolve provider: pick the configured/preferred one, fall back to
    //    postyar-zai which is always available.
    const providerId: AiProviderId = pickProvider(input.provider);
    const provider = getAiProvider(providerId);
    if (!provider.available) {
      // Should never happen for postyar-zai, but defensive.
      return persistFailed(input, providerId, "ارائه‌دهنده هوش مصنوعی پیکربندی نشده است.");
    }

    // 5) Resolve & validate model
    let model = input.model ?? null;
    const validModels = getValidModels(providerId);
    if (!model) model = validModels[0] ?? null;
    if (model) {
      try {
        validateModel(providerId, model);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "مدل نامعتبر است.";
        return persistFailed(input, providerId, msg);
      }
    }

    // 6) Sanitize prompt(s) before storing — don't trust client
    const cleanPrompt = sanitizePrompt(input.prompt);
    const cleanSystem = input.systemPrompt ? sanitizePrompt(input.systemPrompt, 2000) : undefined;
    if (!cleanPrompt) {
      return persistFailed(input, providerId, "پرامپت خالی است.");
    }

    // 7) Persist queued AiJob. A concurrent duplicate (same idempotencyKey)
    //    throws P2002 on the UNIQUE key — degrade to the duplicate path
    //    instead of a raw 500 (audit §13).
    let aiJob;
    try {
      aiJob = await db.aiJob.create({
        data: {
          userId: input.userId,
          provider: providerId,
          model: model ?? "",
          task: input.task,
          prompt: cleanPrompt,
          status: "queued",
          idempotencyKey: input.idempotencyKey,
        },
      });
    } catch (err) {
      const msg = (err as { code?: string; message?: string })?.message ?? "";
      if (/unique|UNIQUE|constraint/i.test(msg)) {
        const existing = await db.aiJob.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        return {
          ok: existing?.status === "completed",
          aiJobId: existing?.id ?? "",
          content: existing?.output ?? "",
          provider: providerId,
          model: model ?? "",
          tokensIn: existing?.tokensIn ?? 0,
          tokensOut: existing?.tokensOut ?? 0,
          errorFa: existing ? undefined : "درخواست تکراری است.",
        };
      }
      throw err;
    }

    // 8) Mark processing
    await db.aiJob.update({
      where: { id: aiJob.id },
      data: { status: "processing" },
    });

    // 9) Build messages
    const messages: AiChatMessage[] = [];
    if (cleanSystem) messages.push({ role: "system", content: cleanSystem });
    messages.push({ role: "user", content: cleanPrompt });

    // 10) Invoke provider
    let resp: AiChatResponse;
    try {
      resp = await provider.chat({
        messages,
        model: model ?? undefined,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "خطای ناشناخته ارائه‌دهنده هوش مصنوعی.";
      await db.aiJob.update({
        where: { id: aiJob.id },
        data: { status: "failed", failureReason: errMsg.slice(0, 1000) },
      });
      await audit({
        userId: input.userId,
        actor: "system",
        action: "ai_dispatch_failed",
        targetType: "ai_job",
        targetId: aiJob.id,
        meta: redactAiPayload({ provider: providerId, model, task: input.task, error: errMsg, ...input.meta }),
      });
      return {
        ok: false,
        aiJobId: aiJob.id,
        content: "",
        provider: providerId,
        model: model ?? "",
        tokensIn: 0,
        tokensOut: 0,
        // Generic client-facing message — the raw provider exception text
        // may reveal upstream endpoints/config (audit §34). Full detail
        // stays in the AiJob row + audit meta (server-side).
        errorFa: "فراخوانی هوش مصنوعی ناموفق بود. لطفاً دوباره تلاش کنید.",
      };
    }

    // 11) Persist completed AiJob
    await db.aiJob.update({
      where: { id: aiJob.id },
      data: {
        status: "completed",
        output: resp.content.slice(0, 16_000),
        tokensIn: resp.tokensIn,
        tokensOut: resp.tokensOut,
      },
    });

    // 12) Quota was ALREADY reserved atomically at dispatch entry
    //     (consumeQuota, step 2) — no further increment here (double-count).

    // 13) Audit (no provider keys ever logged — only metadata)
    await audit({
      userId: input.userId,
      actor: "system",
      action: "ai_dispatched",
      targetType: "ai_job",
      targetId: aiJob.id,
      meta: redactAiPayload({
        provider: providerId,
        model: resp.model,
        task: input.task,
        tokensIn: resp.tokensIn,
        tokensOut: resp.tokensOut,
        ...input.meta,
      }),
    });

    return {
      ok: true,
      aiJobId: aiJob.id,
      content: resp.content,
      provider: providerId,
      model: resp.model,
      tokensIn: resp.tokensIn,
      tokensOut: resp.tokensOut,
    };
  }, 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------
// Helper: persist a failed dispatch as an AiJob + return the result
// ---------------------------------------------------------------------
async function persistFailed(
  input: DispatchAiInput,
  providerId: AiProviderId,
  errMsg: string,
): Promise<DispatchAiResult> {
  let aiJobId = "";
  try {
    const job = await db.aiJob.create({
      data: {
        userId: input.userId,
        provider: providerId,
        model: input.model ?? "",
        task: input.task,
        prompt: sanitizePrompt(input.prompt),
        status: "failed",
        failureReason: errMsg.slice(0, 1000),
        idempotencyKey: input.idempotencyKey,
      },
    });
    aiJobId = job.id;
  } catch {
    // If the AiJob row can't be created (e.g., duplicate idempotencyKey),
    // we still return the error to the caller.
  }
  return {
    ok: false,
    aiJobId,
    content: "",
    provider: providerId,
    model: input.model ?? "",
    tokensIn: 0,
    tokensOut: 0,
    errorFa: errMsg,
  };
}

// ---------------------------------------------------------------------
// Helper: format tokens for UI display
// ---------------------------------------------------------------------
export function formatTokens(tokensIn: number, tokensOut: number): string {
  return `${toPersianDigits(tokensIn)} توکن ورودی، ${toPersianDigits(tokensOut)} توکن خروجی`;
}
