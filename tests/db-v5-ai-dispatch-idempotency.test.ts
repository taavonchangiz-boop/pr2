// =====================================================================
// POSTYAR — V5 dispatchAi regression suite (first coverage of src/lib/ai/dispatch.ts)
// ---------------------------------------------------------------------
// dispatchAi is the single AI invocation entry point: per-user rate
// limit → ATOMIC idempotency claim (critical:true) → provider resolution
// → model validation → quota reservation → AiJob persistence → provider
// call → AiJob completion/failure. These tests pin the money-adjacent
// invariants that were previously completely uncovered:
//
//   (a) happy path: ONE provider call, ONE completed AiJob row with the
//       output + token counts, quota reservation CONSUMED;
//   (b) same userId + idempotencyKey twice → ONE AiJob row, ONE provider
//       call, both callers receive the SAME result, ONE quota consumption;
//   (c) durable-duplicate path (P2002 on AiJob.idempotencyKey UNIQUE):
//       dispatchAi returns the PRIOR result, the provider is NOT called,
//       and THIS execution's quota reservation is REFUNDED (used-count
//       unchanged — exactly one reservation per logical AI operation);
//   (d) provider failure → AiJob failed, generic bounded Persian error to
//       the client (raw provider text stays server-side only), the quota
//       reservation is KEPT (documented fail-closed semantics: it can
//       never allow quota overrun), and an ai_dispatch_failed audit row
//       is written.
//
// PROVIDER MOCKING APPROACH (documented per task): dispatchAi resolves
// the provider through the REAL registry (pickProvider →
// isProviderAvailableAsync → getAiProvider) and the postyar-zai provider
// dynamically imports "z-ai-web-dev-sdk" inside chat(). We therefore mock
// ONLY that SDK boundary with bun's mock.module (the same mechanism
// tests/db-authorization.test.ts uses for next/headers) and drive the
// dispatch through provider:"postyar-zai" (always available, no key).
// The entire dispatch pipeline + registry + model validation stays under
// test; a mutable closure flag switches the fake between success and
// failure, and a call counter pins "exactly one provider call".
// =====================================================================
import { describe, test, expect, beforeEach, mock } from "bun:test";

let zaiCalls = 0;
let zaiBehavior: "ok" | "fail" = "ok";

mock.module("z-ai-web-dev-sdk", () => ({
  default: {
    create: async () => ({
      chat: {
        completions: {
          create: async () => {
            zaiCalls += 1;
            if (zaiBehavior === "fail") throw new Error("simulated provider outage");
            return {
              choices: [{ message: { content: "پاسخ آزمایشی هوش مصنوعی" } }],
              usage: { prompt_tokens: 11, completion_tokens: 7 },
            };
          },
        },
      },
    }),
  },
}));

// Import AFTER the mock is set up (bun hoists mock.module before imports).
import { dispatchAi } from "@/lib/ai/dispatch";
import { db } from "@/lib/db";
import { resetDb, seedUser } from "./_db-helpers";
import { getQuotaState } from "@/lib/payments/plans";

beforeEach(async () => {
  await resetDb();
  zaiCalls = 0;
  zaiBehavior = "ok";
});

describe("V5 — dispatchAi (AI dispatch pipeline)", () => {
  test("(a) happy path: one provider call, completed AiJob, quota consumed", async () => {
    const user = await seedUser();
    const res = await dispatchAi({
      userId: user.id,
      provider: "postyar-zai",
      task: "caption",
      prompt: "یک کپشن کوتاه بنویس",
      idempotencyKey: "k-happy",
    });

    expect(res.ok).toBe(true);
    expect(res.errorFa).toBeUndefined();
    expect(res.content).toBe("پاسخ آزمایشی هوش مصنوعی");
    expect(res.provider).toBe("postyar-zai");
    expect(res.tokensIn).toBe(11);
    expect(res.tokensOut).toBe(7);
    expect(zaiCalls).toBe(1);

    const job = await db.aiJob.findUnique({ where: { idempotencyKey: "k-happy" } });
    expect(job).not.toBeNull();
    expect(job!.userId).toBe(user.id);
    expect(job!.status).toBe("completed");
    expect(job!.output).toBe("پاسخ آزمایشی هوش مصنوعی");
    expect(job!.tokensIn).toBe(11);
    expect(job!.tokensOut).toBe(7);
    expect(res.aiJobId).toBe(job!.id);

    // The successful operation consumed exactly ONE aiPerMonth reservation
    // (free-plan enforcement row provisioned lazily by the quota engine).
    const quota = await getQuotaState(user.id);
    expect(quota.aiPerMonth.used).toBe(1);
  });

  test("(b) same userId+idempotencyKey twice → ONE AiJob row, ONE provider call, identical results", async () => {
    const user = await seedUser();
    const input = {
      userId: user.id,
      provider: "postyar-zai",
      task: "text" as const,
      prompt: "سلام",
      idempotencyKey: "k-idem",
    };

    const r1 = await dispatchAi(input);
    const r2 = await dispatchAi(input);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(zaiCalls).toBe(1); // the provider executed exactly once
    expect(r2.aiJobId).toBe(r1.aiJobId);
    expect(r2.content).toBe(r1.content);
    expect(r2.tokensIn).toBe(r1.tokensIn);
    expect(r2.tokensOut).toBe(r1.tokensOut);

    expect(await db.aiJob.count({ where: { idempotencyKey: "k-idem" } })).toBe(1);

    // Exactly ONE quota consumption for the logical operation.
    const quota = await getQuotaState(user.id);
    expect(quota.aiPerMonth.used).toBe(1);
  });

  test("(c) durable duplicate (P2002): prior result returned, provider NOT called, quota reservation refunded", async () => {
    const user = await seedUser();
    // Pre-create the completed job — the durable "winner" whose row this
    // execution will collide with on AiJob.idempotencyKey UNIQUE.
    const prior = await db.aiJob.create({
      data: {
        userId: user.id,
        provider: "postyar-zai",
        model: "postyar-default",
        task: "text",
        prompt: "پرامپت قبلی",
        status: "completed",
        output: "پاسخ قبلی",
        tokensIn: 5,
        tokensOut: 3,
        idempotencyKey: "k-p2002",
      },
    });

    const res = await dispatchAi({
      userId: user.id,
      provider: "postyar-zai",
      task: "text",
      prompt: "پرامپت جدید",
      idempotencyKey: "k-p2002",
    });

    // The provider was NOT called again.
    expect(zaiCalls).toBe(0);
    // The PRIOR result is reported.
    expect(res.ok).toBe(true);
    expect(res.aiJobId).toBe(prior.id);
    expect(res.content).toBe("پاسخ قبلی");
    expect(res.tokensIn).toBe(5);
    expect(res.tokensOut).toBe(3);
    // Still exactly ONE job row for the key.
    expect(await db.aiJob.count({ where: { idempotencyKey: "k-p2002" } })).toBe(1);

    // V4 H-7 refund invariant: THIS execution's quota reservation (taken
    // inside its single idempotent execution) is refunded on the duplicate
    // path — the used-count ends exactly where it started (0).
    const quota = await getQuotaState(user.id);
    expect(quota.aiPerMonth.used).toBe(0);
  });

  test("(d) provider failure: job failed, bounded client error, quota reservation KEPT (fail-closed), audit written", async () => {
    const user = await seedUser();
    zaiBehavior = "fail";

    const res = await dispatchAi({
      userId: user.id,
      provider: "postyar-zai",
      task: "caption",
      prompt: "کپشن بنویس",
      idempotencyKey: "k-fail",
    });

    // Documented fail-closed semantics: the reservation is KEPT — a failed
    // call can never allow quota overrun.
    expect(res.ok).toBe(false);
    expect(res.content).toBe("");
    // The client-facing message is the generic bounded Persian text — the
    // raw provider exception stays server-side (AiJob + audit only).
    expect(res.errorFa).toBe("فراخوانی هوش مصنوعی ناموفق بود. لطفاً دوباره تلاش کنید.");
    expect(res.errorFa).not.toContain("simulated");

    const job = await db.aiJob.findFirst({ where: { idempotencyKey: { startsWith: "k-fail" } } });
    expect(job).not.toBeNull();
    expect(job!.status).toBe("failed");
    expect(job!.failureReason).toContain("simulated provider outage");
    // V6 C-10 — the failed job is RE-KEYED off the logical key: the logical
    // key is free again, so a genuine retry can create a fresh job instead
    // of being permanently poisoned by the dead row.
    expect(job!.idempotencyKey).not.toBe("k-fail");
    expect(await db.aiJob.count({ where: { idempotencyKey: "k-fail" } })).toBe(0);

    const quota = await getQuotaState(user.id);
    expect(quota.aiPerMonth.used).toBe(1);

    // Durable audit trail for the failure.
    const auditRow = await db.auditLog.findFirst({
      where: { action: "ai_dispatch_failed", targetType: "ai_job", targetId: job!.id },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow!.userId).toBe(user.id);
  });
});
