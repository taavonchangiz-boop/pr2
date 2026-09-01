// =====================================================================
// POSTYAR — V5 H-04 outbound delivery state machine (DB-backed tier)
// ---------------------------------------------------------------------
// Pins the durable outbound delivery contract:
//   * the BotHistory row is written BEFORE the provider call as
//     `pending` (asserted INSIDE the fetch mock — a write-after-send
//     design fails this suite);
//   * terminal convergence: sent (+providerMessageId) / failed
//     (definitive 4xx) / uncertain (timeout/network/5xx);
//   * a DEFINITIVE failure keeps the run retryable (V5 C-01) and the
//     retry re-drives ONLY the failed step — already-delivered steps are
//     never re-sent (cursor + run-scoped fallback channel);
//   * an AMBIGUOUS outcome never auto-retries (duplicate-message risk)
//     and is durably labelled `uncertain`;
//   * a crash AFTER sends (cursor carried on the error, or even a legacy
//     NULL cursor) re-sends NOTHING thanks to the fallback channel;
//   * the engine reports ok:false only for definitive failures;
//   * save-time validation rejects oversized button graphs and
//     unknown/hidden initiate_payment plan codes (V5 H-13).
// =====================================================================
import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { resetDb, seedUser, seedBot, ensureDbConnected } from "./_db-helpers";
import { executeWorkflow, validateWorkflowDef, sendTrackedBotReply } from "../src/lib/bots/workflow";
import {
  runWorkflowOnceForEvent,
  ensureBotEvent,
} from "@/lib/bots/event-dedup";
import { encryptString } from "@/lib/security/crypto";
import type { Bot, BotWorkflow } from "@prisma/client";

// --- Provider mock harness -------------------------------------------
const _originalFetch = global.fetch;
let sendScript: Array<(idx: number) => Response> = [];
let sendCalls = 0;
// For every provider call, the number of `pending` outbound rows the
// mock observed AT CALL TIME (must be ≥1 — the pre-write contract).
let pendingRowsAtCallTime: number[] = [];
let observingBotId = "";

function okSend(idx: number): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 7000 + idx } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function definitiveRefusal(): Response {
  return new Response(
    JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}
function serverError(): Response {
  return new Response(JSON.stringify({ ok: false, error_code: 500, description: "Internal" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}
function mockFetch(): void {
  global.fetch = (async () => {
    const pending = observingBotId
      ? await db.botHistory.count({
          where: { botId: observingBotId, direction: "outbound", deliveryStatus: "pending" },
        })
      : 0;
    pendingRowsAtCallTime.push(pending);
    const idx = sendCalls;
    sendCalls++;
    // Unscripted calls default to a successful send (mirrors a healthy
    // provider); scripted outcomes override per call index.
    const step = sendScript[idx] ?? okSend;
    return step(idx);
  }) as unknown as typeof global.fetch;
}
function restoreFetch(): void {
  global.fetch = _originalFetch;
}

// --- Seeding ----------------------------------------------------------
let owner: { id: string };
let bot: Bot;

async function seedOwnerWithWorkflowFeature(): Promise<void> {
  owner = await seedUser({ email: "v5-outbound@test.local", mobile: "09120200001" });
  bot = await seedBot({ ownerId: owner.id, provider: "telegram", name: "بات تحویل" });
  // seedBot's placeholder token fails the provider's TOKEN_REGEX (a
  // definitive pre-fetch refusal) — use a regex-compliant token so the
  // mock fetch is actually reached.
  bot = await db.bot.update({
    where: { id: bot.id },
    data: { botTokenEnc: encryptString(`1234567890:${"A".repeat(35)}`) },
  });
  observingBotId = bot.id;
  const plan = await db.plan.create({
    data: {
      code: "outbound-pro",
      nameFa: "پلن تحویل",
      priceRials: 1_000_000,
      intervalMonths: 1,
      quota: "{}",
      features: JSON.stringify({ workflow: true }),
      isPublic: true,
      active: true,
    },
  });
  await db.subscription.create({
    data: {
      userId: owner.id,
      planId: plan.id,
      status: "active",
      endsAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      usedQuota: "{}",
      activeKey: `${owner.id}:${plan.id}`,
    },
  });
}

/** start (no behavior) → N message steps. */
async function seedMessageChain(texts: string[]): Promise<BotWorkflow> {
  const steps: Array<Record<string, unknown>> = [
    { id: "s0", type: "start", nextStepId: "m1" },
  ];
  texts.forEach((t, i) => {
    const id = `m${i + 1}`;
    steps.push({ id, type: "message", text: t, ...(i < texts.length - 1 ? { nextStepId: `m${i + 2}` } : {}) });
  });
  return db.botWorkflow.create({
    data: {
      botId: bot.id,
      name: `زنجیره ${texts.length}`,
      enabled: true,
      triggerKind: "message",
      steps: JSON.stringify(steps),
    },
  });
}

async function runThroughInbox(
  event: Awaited<ReturnType<typeof ensureBotEvent>>,
  wf: BotWorkflow,
): Promise<{ ok: boolean; errorFa?: string }> {
  const updateId = Number(event.externalEventId);
  const r = await runWorkflowOnceForEvent(event.id, wf.id, async (resume) => {
    const out = await executeWorkflow(
      {
        bot,
        providerUserId: "tg-777",
        rawUpdate: { update_id: updateId },
        incomingMessage: "سلام",
        updateId,
        workflow: wf,
      },
      resume,
    );
    return { ok: out.ok, errorFa: out.errorFa, cursor: out.cursor };
  });
  // Surface the durable failure reason exactly as the route layer sees it.
  let errorFa: string | undefined;
  if (!r.ok) {
    const run = await db.botWorkflowRun.findUniqueOrThrow({
      where: { eventId_workflowId: { eventId: event.id, workflowId: wf.id } },
    });
    errorFa = run.lastError ?? undefined;
  }
  return { ok: r.ok, errorFa };
}

async function stepRows(stepId: string) {
  return db.botHistory.findMany({
    where: { botId: bot.id, direction: "outbound", stepId },
    orderBy: { createdAt: "asc" },
  });
}

beforeAll(async () => {
  await ensureDbConnected();
});

beforeEach(async () => {
  await resetDb();
  sendScript = [];
  sendCalls = 0;
  pendingRowsAtCallTime = [];
  observingBotId = "";
  mockFetch();
  await seedOwnerWithWorkflowFeature();
});

afterAll(() => {
  restoreFetch();
});

describe("V5 H-04 — the durable pending row exists BEFORE the provider call", () => {
  test("write-before-send is observable inside the fetch mock", async () => {
    const wf = await seedMessageChain(["سلام"]);
    const event = await ensureBotEvent(bot, "telegram", "7001", { update_id: 7001 });
    sendScript = [okSend];
    const r = await runThroughInbox(event, wf);
    expect(r.ok).toBe(true);
    // THE ordering proof: at the moment the provider call executed, the
    // durable pending row already existed (write-after-send = 0 here).
    expect(pendingRowsAtCallTime).toEqual([1]);
    const rows = await stepRows("m1");
    expect(rows.length).toBe(1);
    expect(rows[0].deliveryStatus).toBe("sent");
    expect(rows[0].providerMessageId).toBe("7000");
    expect(sendCalls).toBe(1);
  });
});

describe("V5 H-04/C-01 — definitive failure is retryable; retry re-drives ONLY the failed step", () => {
  test("3 message steps, middle step refuses once: 4 sends total across 2 attempts", async () => {
    const wf = await seedMessageChain(["گام یک", "گام دو", "گام سه"]);
    const event = await ensureBotEvent(bot, "telegram", "7002", { update_id: 7002 });

    sendScript = [okSend, definitiveRefusal, okSend];
    const r1 = await runThroughInbox(event, wf);
    expect(r1.ok).toBe(false);
    expect(r1.errorFa).toContain("ناموفق");
    expect(sendCalls).toBe(3);
    expect(pendingRowsAtCallTime).toEqual([1, 1, 1]);
    expect((await stepRows("m1"))[0].deliveryStatus).toBe("sent");
    expect((await stepRows("m2"))[0].deliveryStatus).toBe("failed");
    expect((await stepRows("m3"))[0].deliveryStatus).toBe("sent");

    const run = await db.botWorkflowRun.findUniqueOrThrow({
      where: { eventId_workflowId: { eventId: event.id, workflowId: wf.id } },
    });
    expect(run.status).toBe("failed");
    const cursor = JSON.parse(run.cursorJson!) as {
      completedNext: Record<string, string>;
      outboundHistory: Record<string, string>;
    };
    // m1 completed (its send succeeded) → cursor progress; m2 (failed)
    // carries NO completedNext and NO outboundHistory; m3 completed after
    // the failed m2 (the walk continues) and keeps its history binding.
    expect(cursor.completedNext.m1).toBe("m2");
    expect(cursor.completedNext.m2).toBeUndefined();
    expect(cursor.outboundHistory.m1).toBeDefined();
    expect(cursor.outboundHistory.m2).toBeUndefined();
    expect(cursor.outboundHistory.m3).toBeDefined();

    // Attempt 2: ONLY m2 re-sends; m1 is cursor-skipped; m3 (terminal,
    // no completedNext entry) is skipped by the run-scoped `sent` fallback.
    sendScript = [okSend];
    const r2 = await runThroughInbox(event, wf);
    expect(r2.ok).toBe(true);
    expect(sendCalls).toBe(4); // 3 + 1 re-send — NOT 6 (old full-replay)
    expect((await stepRows("m2"))[0].deliveryStatus).toBe("sent");
    expect((await stepRows("m1")).length).toBe(1);
    expect((await stepRows("m2")).length).toBe(1);
    expect((await stepRows("m3")).length).toBe(1);
    const runDone = await db.botWorkflowRun.findUniqueOrThrow({
      where: { eventId_workflowId: { eventId: event.id, workflowId: wf.id } },
    });
    expect(runDone.status).toBe("completed");
  });
});

describe("V5 H-04 — ambiguous outcomes are uncertain and never auto-retried", () => {
  test("a 5xx refusal records `uncertain` and the run completes (no retry loop)", async () => {
    const wf = await seedMessageChain(["سلام", "گام مبهم"]);
    const event = await ensureBotEvent(bot, "telegram", "7003", { update_id: 7003 });
    sendScript = [okSend, serverError];
    const r = await runThroughInbox(event, wf);
    expect(r.ok).toBe(true);
    const rows = await stepRows("m2");
    expect(rows.length).toBe(1);
    expect(rows[0].deliveryStatus).toBe("uncertain");
    expect(rows[0].providerMessageId).toBeNull();
    const run = await db.botWorkflowRun.findUniqueOrThrow({
      where: { eventId_workflowId: { eventId: event.id, workflowId: wf.id } },
    });
    expect(run.status).toBe("completed");
  });

  test("a crash AFTER successful sends re-sends NOTHING (fallback channel, even with a lost cursor)", async () => {
    const wf = await seedMessageChain(["یک", "دو", "سه"]);
    const event = await ensureBotEvent(bot, "telegram", "7004", { update_id: 7004 });

    // Attempt 1: the walk fully succeeds, then the "process crashes"
    // before the outcome is returned (the callback throws afterwards).
    sendScript = [okSend, okSend, okSend];
    const r1 = await runWorkflowOnceForEvent(event.id, wf.id, async () => {
      const out = await executeWorkflow({
        bot,
        providerUserId: "tg-777",
        rawUpdate: { update_id: 7004 },
        incomingMessage: "سلام",
        updateId: 7004,
        workflow: wf,
      });
      expect(out.ok).toBe(true);
      throw new Error("simulated crash after sends");
    });
    expect(r1.ok).toBe(false);
    expect(sendCalls).toBe(3);
    const run = await db.botWorkflowRun.findUniqueOrThrow({
      where: { eventId_workflowId: { eventId: event.id, workflowId: wf.id } },
    });
    expect(run.status).toBe("failed");

    // Attempt 2 — pre-V5 replayed the whole walk (6 sends total). V5:
    // every step's durable row from THIS run is `sent`, so the cursor /
    // run-scoped fallback forbids any re-send.
    const r2 = await runThroughInbox(event, wf);
    expect(r2.ok).toBe(true);
    expect(sendCalls).toBe(3); // unchanged — zero duplicate sends
    expect((await stepRows("m1")).length).toBe(1);
    expect((await stepRows("m2")).length).toBe(1);
    expect((await stepRows("m3")).length).toBe(1);

    // Even a LEGACY run with a NULL cursor (progress fully lost) is safe:
    // the run-scoped `sent` fallback channel alone forbids re-sends.
    const run2 = await db.botWorkflowRun.findUniqueOrThrow({
      where: { eventId_workflowId: { eventId: event.id, workflowId: wf.id } },
    });
    await db.botWorkflowRun.update({
      where: { id: run2.id },
      data: { status: "failed", cursorJson: null, leaseUntil: null },
    });
    const r3 = await runThroughInbox(event, wf);
    expect(r3.ok).toBe(true);
    expect(sendCalls).toBe(3);
  });

  test("a pending row with delivery unknown converges to `uncertain` and is NEVER replayed", async () => {
    const wf = await seedMessageChain(["یک", "دو"]);
    const event = await ensureBotEvent(bot, "telegram", "7005", { update_id: 7005 });
    // Simulate a crashed earlier attempt: m1 delivered (sent row), m2's
    // send went out but the crash left its row `pending` (delivery
    // unknown, no cursor entry).
    const run = await db.botWorkflowRun.create({
      data: { eventId: event.id, workflowId: wf.id, status: "failed", attempts: 1 },
    });
    await db.botHistory.create({
      data: {
        botId: bot.id,
        direction: "outbound",
        providerUserId: "tg-777",
        text: "یک",
        workflowId: wf.id,
        stepId: "m1",
        deliveryStatus: "sent",
      },
    });
    await db.botHistory.create({
      data: {
        botId: bot.id,
        direction: "outbound",
        providerUserId: "tg-777",
        text: "دو",
        workflowId: wf.id,
        stepId: "m2",
        deliveryStatus: "pending",
      },
    });
    void run;
    const r2 = await runThroughInbox(event, wf);
    expect(r2.ok).toBe(true);
    // The pending row converged to `uncertain` — never replayed; no new
    // rows were created for either step; the provider was never called.
    const m1 = await stepRows("m1");
    const m2 = await stepRows("m2");
    expect(m1.length).toBe(1);
    expect(m1[0].deliveryStatus).toBe("sent");
    expect(m2.length).toBe(1);
    expect(m2[0].deliveryStatus).toBe("uncertain");
    expect(sendCalls).toBe(0);
  });
});

describe("V5 H-04 — tracked one-shot replies (link-code path)", () => {
  test("reply rows are pending-first and converge to sent with providerMessageId", async () => {
    sendScript = [okSend];
    await sendTrackedBotReply(bot, "tg-888", "پاسخ آزمایشی", null);
    const rows = await db.botHistory.findMany({
      where: { botId: bot.id, direction: "outbound", text: "پاسخ آزمایشی" },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].deliveryStatus).toBe("sent");
    expect(rows[0].providerMessageId).toBe("7000");
  });

  test("a definitive refusal converges to failed — the row is never silently lost", async () => {
    sendScript = [definitiveRefusal];
    await sendTrackedBotReply(bot, "tg-889", "پاسخ شکست", null);
    const rows = await db.botHistory.findMany({
      where: { botId: bot.id, direction: "outbound", text: "پاسخ شکست" },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].deliveryStatus).toBe("failed");
  });
});

describe("V5 H-13 — save-time validation tightening", () => {
  const start = { id: "s0", type: "start" as const };

  test("more than 20 buttons is rejected at save", async () => {
    const buttons = Array.from({ length: 21 }, (_, i) => ({
      label: `دکمه ${i}`,
      callbackData: `cb-${i}`,
    }));
    const res = await validateWorkflowDef([
      start,
      {
        id: "a1",
        type: "action",
        nextStepId: undefined,
        action: { kind: "send_message", config: { text: "سلام", buttons } },
      } as never,
    ]);
    expect(res.ok).toBe(false);
    expect(res.errorFa).toContain("دکمه");
  });

  test("exactly 20 buttons passes", async () => {
    const buttons = Array.from({ length: 20 }, (_, i) => ({
      label: `دکمه ${i}`,
      callbackData: `cb-${i}`,
    }));
    const res = await validateWorkflowDef([
      start,
      {
        id: "a1",
        type: "action",
        action: { kind: "send_message", config: { text: "سلام", buttons } },
      } as never,
    ]);
    expect(res.ok).toBe(true);
  });

  test("a button label over 64 characters is rejected at save", async () => {
    const res = await validateWorkflowDef([
      start,
      {
        id: "a2",
        type: "action",
        action: {
          kind: "send_message",
          config: { text: "سلام", buttons: [{ label: "x".repeat(65), callbackData: "cb" }] },
        },
      } as never,
    ]);
    expect(res.ok).toBe(false);
    expect(res.errorFa).toContain("برچسب");
  });

  test("initiate_payment with unknown/non-public/inactive planCode is rejected at save", async () => {
    await db.plan.create({
      data: {
        code: "hidden-plan",
        nameFa: "مخفی",
        priceRials: 1,
        intervalMonths: 1,
        quota: "{}",
        features: "{}",
        isPublic: false,
        active: true,
      },
    });
    const unknown = await validateWorkflowDef([
      start,
      { id: "p1", type: "action", action: { kind: "initiate_payment", config: { planCode: "no-such-plan" } } } as never,
    ]);
    expect(unknown.ok).toBe(false);
    const hidden = await validateWorkflowDef([
      start,
      { id: "p2", type: "action", action: { kind: "initiate_payment", config: { planCode: "hidden-plan" } } } as never,
    ]);
    expect(hidden.ok).toBe(false);
    await db.plan.create({
      data: {
        code: "inactive-plan",
        nameFa: "غیرفعال",
        priceRials: 1,
        intervalMonths: 1,
        quota: "{}",
        features: "{}",
        isPublic: true,
        active: false,
      },
    });
    const off = await validateWorkflowDef([
      start,
      { id: "p3", type: "action", action: { kind: "initiate_payment", config: { planCode: "inactive-plan" } } } as never,
    ]);
    expect(off.ok).toBe(false);
    await db.plan.create({
      data: {
        code: "public-plan",
        nameFa: "عمومی",
        priceRials: 1,
        intervalMonths: 1,
        quota: "{}",
        features: "{}",
        isPublic: true,
        active: true,
      },
    });
    const okRes = await validateWorkflowDef([
      start,
      { id: "p4", type: "action", action: { kind: "initiate_payment", config: { planCode: "public-plan" } } } as never,
    ]);
    expect(okRes.ok).toBe(true);
  });
});
