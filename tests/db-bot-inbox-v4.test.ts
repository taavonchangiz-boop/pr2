// =====================================================================
// POSTYAR — V4 repair regression suite for the durable bot inbox
// ---------------------------------------------------------------------
// Covers Master Prompt V4 items that live in the inbox engine:
//   C-01  a run whose execution reports ok:false is NEVER recorded as
//         completed (the vulnerable engine ignored the result and
//         committed completed on normal callback resolution);
//   C-02  event completion is separated from child-workflow completion:
//         one failed child keeps the event retryable and recovery
//         retries ONLY the failed child (siblings never re-execute);
//   H-01  per-workflow execution lease: a live worker cannot be stolen,
//         a crashed run is taken over after its lease expires, completed
//         runs are immutable, concurrent workers converge;
//   H-02  durable exponential backoff: a just-failed event is neither
//         claimable nor recoverable until nextRetryAt; backoff grows
//         with attempts; terminal dead state after max attempts;
//   H-03  payload integrity: oversized payloads are explicitly marked
//         truncated and NEVER replayed; bounded payloads replay exactly;
//   H-04  persistInboundOnce is DB-idempotent (UNIQUE inboundEventId).
//
// Every test in this file failed against the pre-repair implementation.
// =====================================================================
import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { db } from "@/lib/db";
import { resetDb, seedUser, seedBot, ensureDbConnected } from "./_db-helpers";
import {
  ensureBotEvent,
  claimBotEvent,
  completeBotEvent,
  failBotEvent,
  recoverBotEvents,
  runWorkflowOnceForEvent,
  runMatchedWorkflowsForEvent,
  listRecoverableBotEvents,
  BOT_EVENT_MAX_ATTEMPTS,
  EventPartiallyFailedError,
} from "../src/lib/bots/event-dedup";
import { persistInboundOnce } from "../src/lib/bots/workflow";
import type { Bot } from "@prisma/client";

type ExecResult = { ok: boolean; errorFa?: string };

describe("V4 — durable inbox: execution contract, lease, backoff, payload, history (DB-backed)", () => {
  let bot: Bot;

  beforeAll(async () => { await ensureDbConnected(); });

  beforeEach(async () => {
    await resetDb();
    const owner = await seedUser({ email: "v4-inbox@test.local", mobile: "09120000988" });
    bot = await seedBot({ ownerId: owner.id, provider: "telegram" });
  });

  async function newEvent(externalId: string, raw?: unknown) {
    return ensureBotEvent(
      bot,
      bot.provider,
      externalId,
      raw ?? { update_id: Number(externalId), message: { text: "سلام" } },
    );
  }

  async function seedWorkflow(name: string): Promise<string> {
    const wf = await db.botWorkflow.create({
      data: {
        botId: bot.id,
        name,
        enabled: true,
        triggerKind: "message",
        steps: JSON.stringify([
          { id: "s1", type: "start", nextStepId: "s2" },
          { id: "s2", type: "action", action: { kind: "send_message", config: { text: "سلام" } } },
        ]),
      },
    });
    return wf.id;
  }

  async function runRow(eventId: string, workflowId: string) {
    return db.botWorkflowRun.findUniqueOrThrow({
      where: { eventId_workflowId: { eventId, workflowId } },
    });
  }

  // ------------------------------------------------------------------
  // C-01 — ok:false must keep the run failed/retryable, never completed
  // ------------------------------------------------------------------
  test("C-01: a run whose execution returns ok:false stays FAILED and retryable", async () => {
    const ev = await newEvent("2001");
    await claimBotEvent(ev.id);
    const wf = await seedWorkflow("c01-fail");

    const r = await runWorkflowOnceForEvent(ev.id, wf, async () =>
      ({ ok: false, errorFa: "گردش کار نامعتبر است." }),
    );
    expect(r.executed).toBe(true);
    expect(r.ok).toBe(false);

    const row = await runRow(ev.id, wf);
    expect(row.status).toBe("failed");
    expect(row.lastError).toContain("گردش کار نامعتبر");
  });

  test("C-01: a thrown failure stays failed; a retry succeeds; a completed run never repeats", async () => {
    const ev = await newEvent("2002");
    await claimBotEvent(ev.id);
    const wf = await seedWorkflow("c01-retry");

    // thrown failure → failed
    const thrown = await runWorkflowOnceForEvent(ev.id, wf, async () => {
      throw new Error("پروایدر در دسترس نیست");
    });
    expect(thrown.ok).toBe(false);
    expect((await runRow(ev.id, wf)).status).toBe("failed");

    // retry succeeds → completed
    let executions = 0;
    const ok = await runWorkflowOnceForEvent(ev.id, wf, async () => {
      executions++;
      return { ok: true };
    });
    expect(ok.ok).toBe(true);
    expect(executions).toBe(1);
    expect((await runRow(ev.id, wf)).status).toBe("completed");

    // completed run never executes again
    const again = await runWorkflowOnceForEvent(ev.id, wf, async () => {
      executions++;
      return { ok: true };
    });
    expect(again.executed).toBe(false);
    expect(executions).toBe(1);
  });

  test("C-01: a legitimate no-op (ok:true) completes without execution-side effects", async () => {
    const ev = await newEvent("2003");
    await claimBotEvent(ev.id);
    const wf = await seedWorkflow("c01-noop");
    const r = await runWorkflowOnceForEvent(ev.id, wf, async () => ({ ok: true }));
    expect(r.ok).toBe(true);
    expect((await runRow(ev.id, wf)).status).toBe("completed");
  });

  // ------------------------------------------------------------------
  // C-02 — event completion ≠ child completion; recovery retries B only
  // ------------------------------------------------------------------
  test("C-02: A ok / B fails / C ok → event stays retryable; recovery re-runs ONLY B; A and C never duplicate", async () => {
    const ev = await newEvent("2004");
    await claimBotEvent(ev.id);
    const wfA = await seedWorkflow("c02-A");
    const wfB = await seedWorkflow("c02-B");
    const wfC = await seedWorkflow("c02-C");

    const execA = async (): Promise<ExecResult> => ({ ok: true });
    const execC = async (): Promise<ExecResult> => ({ ok: true });
    let bExecutions = 0;
    const execBFailing = async (): Promise<ExecResult> => {
      bExecutions++;
      return { ok: false, errorFa: "اجرای B ناموفق بود." };
    };

    // First pass — mirrors the route: aggregate + throw on any child failure.
    await expect(
      runMatchedWorkflowsForEvent(ev.id, [
        { workflowId: wfA, execute: execA },
        { workflowId: wfB, execute: execBFailing },
        { workflowId: wfC, execute: execC },
      ]),
    ).rejects.toBeInstanceOf(EventPartiallyFailedError);

    // A and C completed, B failed.
    expect((await runRow(ev.id, wfA)).status).toBe("completed");
    expect((await runRow(ev.id, wfB)).status).toBe("failed");
    expect((await runRow(ev.id, wfC)).status).toBe("completed");

    // The event itself must NOT be completed by the caller while a child
    // failed — routes mark it failed via the thrown error.
    await failBotEvent(ev.id, "یک یا چند گردش کار ناموفق بود.");
    expect((await db.botInboundEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe("failed");

    // Recovery pass (after the durable backoff elapses — recovery honors
    // nextRetryAt by design): A/C short-circuit, B re-executes and succeeds.
    await db.botInboundEvent.update({
      where: { id: ev.id },
      data: { nextRetryAt: new Date(Date.now() - 1) },
    });
    const execBFixed = async (): Promise<ExecResult> => {
      bExecutions++;
      return { ok: true };
    };
    const seen: string[] = [];
    await recoverBotEvents(bot, async (_b, _payload, o) => {
      seen.push(o.eventId);
      await runMatchedWorkflowsForEvent(o.eventId, [
        { workflowId: wfA, execute: execA },
        { workflowId: wfB, execute: execBFixed },
        { workflowId: wfC, execute: execC },
      ]);
    });
    expect(bExecutions).toBe(2); // failed once + retried once — never more
    expect((await runRow(ev.id, wfA)).status).toBe("completed");
    expect((await runRow(ev.id, wfC)).status).toBe("completed");
    expect((await runRow(ev.id, wfB)).status).toBe("completed");

    // The event converged to completed after all children succeeded.
    await expect(
      runMatchedWorkflowsForEvent(ev.id, [
        { workflowId: wfA, execute: execA },
        { workflowId: wfB, execute: execBFixed },
        { workflowId: wfC, execute: execC },
      ]),
    ).resolves.toBeUndefined();
    // The recovery pass itself completes the event once its process
    // callback resolves with every child successful.
    const eventRow = await db.botInboundEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(eventRow.status).toBe("completed");
    expect(eventRow.completedAt).not.toBeNull();
  });

  // ------------------------------------------------------------------
  // H-01 — per-workflow lease: no steal while live; takeover when stale
  // ------------------------------------------------------------------
  test("H-01: a live lease cannot be stolen — concurrent workers converge to ONE execution", async () => {
    const ev = await newEvent("2005");
    await claimBotEvent(ev.id);
    const wf = await seedWorkflow("h01-lease");

    let executions = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));

    const worker1 = runWorkflowOnceForEvent(ev.id, wf, async () => {
      executions++;
      await gate; // worker 1 is mid-execution, lease alive
      return { ok: true };
    });
    // Deterministic: wait until worker 1's claim has set a live lease.
    for (let i = 0; i < 100; i++) {
      const r = await db.botWorkflowRun.findUnique({ where: { eventId_workflowId: { eventId: ev.id, workflowId: wf } } });
      if (r?.leaseUntil && r.leaseUntil.getTime() > Date.now()) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    const worker2 = runWorkflowOnceForEvent(ev.id, wf, async () => {
      executions++;
      return { ok: true };
    });
    const b = await worker2; // worker 2 must be rejected by the live lease
    release();               // then let worker 1 finish
    const a = await worker1;

    const executedResults = [a, b].filter((r) => r.executed);
    expect(executedResults.length).toBe(1);
    expect(executions).toBe(1);
    expect((await runRow(ev.id, wf)).status).toBe("completed");
  });

  test("H-01: a crashed run (expired lease) is taken over; a completed run is immutable", async () => {
    const ev = await newEvent("2006");
    await claimBotEvent(ev.id);
    const wf = await seedWorkflow("h01-crash");

    // Simulate a crash mid-execution: run claimed (pending, lease set) and
    // its worker vanished — emulate by directly expiring the lease.
    const run = await db.botWorkflowRun.create({
      data: { eventId: ev.id, workflowId: wf, status: "pending", attempts: 1, leaseUntil: new Date(Date.now() - 1000) },
    });
    expect(run.status).toBe("pending");

    let executions = 0;
    const takeover = await runWorkflowOnceForEvent(ev.id, wf, async () => {
      executions++;
      return { ok: true };
    });
    expect(takeover.executed).toBe(true);
    expect(executions).toBe(1);
    expect((await runRow(ev.id, wf)).status).toBe("completed");

    // Completed runs are immutable — a late failure cannot regress them.
    await runWorkflowOnceForEvent(ev.id, wf, async () => ({ ok: false, errorFa: "دیرهنگام" }));
    const row = await runRow(ev.id, wf);
    expect(row.status).toBe("completed");
  });

  // ------------------------------------------------------------------
  // H-02 — durable backoff: no hot-loop; growth; dead state
  // ------------------------------------------------------------------
  test("H-02: a just-failed event is neither claimable nor recoverable until nextRetryAt", async () => {
    const ev = await newEvent("2007");
    await claimBotEvent(ev.id);
    await failBotEvent(ev.id, "خطای موقت");

    const row = await db.botInboundEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(row.status).toBe("failed");
    expect(row.nextRetryAt).not.toBeNull();
    expect(row.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());

    const recoverable = await listRecoverableBotEvents(bot.id);
    expect(recoverable.find((e) => e.id === ev.id)).toBeUndefined();
    expect(await claimBotEvent(ev.id)).toBe(false);

    // Honors retry time once it passes.
    await db.botInboundEvent.update({
      where: { id: ev.id },
      data: { nextRetryAt: new Date(Date.now() - 1) },
    });
    const recoverable2 = await listRecoverableBotEvents(bot.id);
    expect(recoverable2.find((e) => e.id === ev.id)).toBeDefined();
    expect(await claimBotEvent(ev.id)).toBe(true);
  });

  test("H-02: backoff grows with attempts and the event goes dead after max attempts", async () => {
    const ev = await newEvent("2008");
    const gaps: number[] = [];
    let prevDelay = -1;

    for (let i = 0; i < BOT_EVENT_MAX_ATTEMPTS; i++) {
      expect(await claimBotEvent(ev.id)).toBe(true);
      await failBotEvent(ev.id, `خطای شماره ${i + 1}`);
      const row = await db.botInboundEvent.findUniqueOrThrow({ where: { id: ev.id } });
      if (i < BOT_EVENT_MAX_ATTEMPTS - 1) {
        expect(row.status).toBe("failed");
        const delay = row.nextRetryAt!.getTime() - Date.now();
        gaps.push(delay);
        expect(delay).toBeGreaterThan(prevDelay); // monotonic growth
        prevDelay = delay;
        // Exponential backoff floor: attempt i+1 waits at least 30s * 2^i
        expect(delay).toBeGreaterThanOrEqual(30_000 * 2 ** i);
        // Honor the schedule, then expire it for the next attempt.
        expect(await claimBotEvent(ev.id)).toBe(false);
        await db.botInboundEvent.update({
          where: { id: ev.id },
          data: { nextRetryAt: new Date(Date.now() - 1) },
        });
      }
    }
    const final = await db.botInboundEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(final.status).toBe("dead");
    expect(await claimBotEvent(ev.id)).toBe(false);
    const recoverable = await listRecoverableBotEvents(bot.id);
    expect(recoverable.find((e) => e.id === ev.id)).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // H-03 — payload integrity: truncated never replayed; bounded replays
  // ------------------------------------------------------------------
  test("H-03: an oversized payload is marked truncated and recovery NEVER replays it", async () => {
    const bulky = {
      update_id: 3001,
      message: { text: "سلام" },
      extra: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`k${i}`, "x".repeat(4096)]),
      ),
    };
    const ev = await newEvent("3001", bulky);
    const row = await db.botInboundEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(row.payloadTruncated).toBe(true);

    await claimBotEvent(ev.id);
    // Simulate the crash: the claim's lease is expired so recovery takes over.
    await db.botInboundEvent.update({
      where: { id: ev.id },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });
    let processCalls = 0;
    await recoverBotEvents(bot, async () => {
      processCalls++;
    });
    // The truncated payload must never be handed to the processor.
    expect(processCalls).toBe(0);
    const after = await db.botInboundEvent.findUniqueOrThrow({ where: { id: ev.id } });
    // V6 C-04 — a non-replayable payload goes DEAD immediately: it must
    // not burn the retry budget on input that can never succeed (pre-V6
    // this was `failed` with a nextRetryAt, so recovery retried it up to
    // BOT_EVENT_MAX_ATTEMPTS times before converging on dead).
    expect(after.status).toBe("dead");
    expect(after.nextRetryAt).toBeNull();
    expect(after.lastError).toContain("بازیابی");
  });

  test("H-03: a large-but-bounded payload is stored COMPLETE and replays exactly", async () => {
    const big = {
      update_id: 3002,
      message: { text: "ی".repeat(20000) },
      meta: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}`, "د".repeat(4000)])),
    };
    const ev = await newEvent("3002", big);
    const row = await db.botInboundEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(row.payloadTruncated).toBe(false);
    expect(row.payload).not.toBeNull();
    // V6 C-04 — the stored payload is the COMPLETE replay envelope: no
    // per-string sanitize cap (the pre-V6 4096+marker slice corrupted
    // recovery input), no array slicing, no depth cap.
    const parsed = JSON.parse(row.payload!);
    expect(parsed.message.text.length).toBe(20000);
    expect(Object.keys(parsed.meta).length).toBe(6);
    expect(row.payload!.endsWith("...[truncated]")).toBe(false);

    await claimBotEvent(ev.id);
    await db.botInboundEvent.update({
      where: { id: ev.id },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });
    let replayed: unknown = null;
    await recoverBotEvents(bot, async (_b, payload) => {
      replayed = payload;
    });
    expect(replayed).not.toBeNull();
    expect((replayed as { update_id: number }).update_id).toBe(3002);
    const after = await db.botInboundEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(after.status).toBe("completed");
  });

  test("H-03: legacy rows with the old truncation marker are never replayed either", async () => {
    const ev = await newEvent("3003");
    await db.botInboundEvent.update({
      where: { id: ev.id },
      data: { payload: '{"update_id":3003,"mess' + "...[truncated]" },
    });
    await claimBotEvent(ev.id);
    await db.botInboundEvent.update({
      where: { id: ev.id },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });
    let processCalls = 0;
    await recoverBotEvents(bot, async () => {
      processCalls++;
    });
    expect(processCalls).toBe(0);
    const after = await db.botInboundEvent.findUniqueOrThrow({ where: { id: ev.id } });
    // V6 C-04 — legacy-marker rows are non-replayable: dead immediately.
    expect(after.status).toBe("dead");
    expect(after.nextRetryAt).toBeNull();
  });

  // ------------------------------------------------------------------
  // H-04 — inbound history is DB-idempotent per durable event
  // ------------------------------------------------------------------
  test("H-04: persistInboundOnce inserts exactly ONE history row per durable event", async () => {
    const ev = await newEvent("4001");
    await persistInboundOnce(bot, "chat-1", "سلام", { update_id: 4001 }, 4001, undefined, ev.id);
    await persistInboundOnce(bot, "chat-1", "سلام", { update_id: 4001 }, 4001, undefined, ev.id);
    await persistInboundOnce(bot, "chat-1", "سلام", { update_id: 4001 }, 4001, undefined, ev.id);

    const rows = await db.botHistory.findMany({
      where: { botId: bot.id, direction: "inbound" },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].inboundEventId).toBe(ev.id);
  });

  test("H-04: different events still get their own history rows (uniqueness is per-event)", async () => {
    const ev1 = await newEvent("4002");
    const ev2 = await newEvent("4003");
    await persistInboundOnce(bot, "chat-1", "اول", { update_id: 4002 }, 4002, undefined, ev1.id);
    await persistInboundOnce(bot, "chat-1", "دوم", { update_id: 4003 }, 4003, undefined, ev2.id);
    const rows = await db.botHistory.findMany({
      where: { botId: bot.id, direction: "inbound" },
    });
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.inboundEventId)).size).toBe(2);
  });

  test("H-04: a retry after a crash-before-persist heals the missing history row", async () => {
    // First delivery crashed before persisting history. The durable retry
    // path persists the row — the UNIQUE key keeps it idempotent even if
    // the retry itself races another worker.
    const ev = await newEvent("4004");
    await Promise.all([
      persistInboundOnce(bot, "chat-1", "سلام", { update_id: 4004 }, 4004, undefined, ev.id),
      persistInboundOnce(bot, "chat-1", "سلام", { update_id: 4004 }, 4004, undefined, ev.id),
    ]);
    const rows = await db.botHistory.findMany({
      where: { botId: bot.id, direction: "inbound" },
    });
    expect(rows.length).toBe(1);
  });
});
