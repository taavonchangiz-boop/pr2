// =====================================================================
// POSTYAR — C-04/H-03 durable bot inbound-event inbox tests (DB-backed)
// ---------------------------------------------------------------------
// Proves the durable dedup invariants against the REAL database:
//   * concurrent duplicate deliveries → exactly ONE claim wins;
//   * a COMPLETED event never re-executes (sequential + concurrent);
//   * a LIVE lease is never stolen; an EXPIRED lease is taken over;
//   * failed events are retryable until BOT_EVENT_MAX_ATTEMPTS, then
//     dead (never claimable again);
//   * per-workflow runs: one event matching N workflows executes each
//     exactly once; a failed workflow does not suppress its siblings;
//     completed runs never repeat across recovery passes;
//   * crash recovery re-processes a stale event FROM ITS STORED PAYLOAD
//     without any provider redelivery.
// Genuinely concurrent: races use Promise.all over real DB transactions.
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
  BOT_EVENT_MAX_ATTEMPTS,
} from "../src/lib/bots/event-dedup";
import type { Bot } from "@prisma/client";

describe("C-04/H-03 — durable bot event inbox (DB-backed)", () => {
  let bot: Bot;

  beforeAll(async () => { await ensureDbConnected(); });

  beforeEach(async () => {
    await resetDb();
    const owner = await seedUser({ email: "dedup@test.local", mobile: "09120000903" });
    bot = await seedBot({ ownerId: owner.id, provider: "telegram" });
  });

  async function newEvent(externalId: string) {
    return ensureBotEvent(bot, bot.provider, externalId, { update_id: Number(externalId), message: { text: "سلام" } });
  }

  // BotWorkflowRun.workflowId has a REAL FK to BotWorkflow — run-row tests
  // must reference actual workflow rows (production handlers always do).
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

  test("first claim wins; concurrent duplicate deliveries collapse to exactly ONE claim", async () => {
    const ev = await newEvent("1001");
    const results = await Promise.all([claimBotEvent(ev.id), claimBotEvent(ev.id), claimBotEvent(ev.id), claimBotEvent(ev.id)]);
    expect(results.filter(Boolean).length).toBe(1);
    const row = await db.botInboundEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(row.status).toBe("processing");
    expect(row.attempts).toBe(1);
  });

  test("a COMPLETED event is never re-claimed (sequential and concurrent)", async () => {
    const ev = await newEvent("1002");
    expect(await claimBotEvent(ev.id)).toBe(true);
    await completeBotEvent(ev.id);
    expect(await claimBotEvent(ev.id)).toBe(false);
    const concurrent = await Promise.all([claimBotEvent(ev.id), claimBotEvent(ev.id)]);
    expect(concurrent.filter(Boolean).length).toBe(0);
  });

  test("a LIVE lease is never stolen", async () => {
    const ev = await newEvent("1003");
    expect(await claimBotEvent(ev.id)).toBe(true);
    // A second worker immediately after must NOT take over.
    expect(await claimBotEvent(ev.id)).toBe(false);
  });

  test("an EXPIRED lease is taken over (crash recovery) and attempts increment", async () => {
    const ev = await newEvent("1004");
    expect(await claimBotEvent(ev.id)).toBe(true);
    // Simulate a crashed processor: its lease is in the past.
    await db.botInboundEvent.update({
      where: { id: ev.id },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });
    expect(await claimBotEvent(ev.id)).toBe(true);
    const row = await db.botInboundEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(row.attempts).toBe(2);
    expect(row.status).toBe("processing");
  });

  test("failed events retry until BOT_EVENT_MAX_ATTEMPTS, then go dead (never claimable)", async () => {
    const ev = await newEvent("1005");
    for (let i = 0; i < BOT_EVENT_MAX_ATTEMPTS; i++) {
      expect(await claimBotEvent(ev.id)).toBe(true);
      const verdict = await failBotEvent(ev.id, "خطای آزمایشی");
      expect(verdict).toBe(i === BOT_EVENT_MAX_ATTEMPTS - 1 ? "dead" : "failed");
      // V4 H-02: the durable backoff schedule must be honored between
      // attempts — expire it manually so the next loop iteration can claim.
      if (i < BOT_EVENT_MAX_ATTEMPTS - 1) {
        const row = await db.botInboundEvent.findUniqueOrThrow({ where: { id: ev.id } });
        expect(row.nextRetryAt).not.toBeNull();
        expect(row.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
        await db.botInboundEvent.update({
          where: { id: ev.id },
          data: { nextRetryAt: new Date(Date.now() - 1) },
        });
      }
    }
    expect(await claimBotEvent(ev.id)).toBe(false); // dead — not claimable
    const row = await db.botInboundEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(row.status).toBe("dead");
    expect(row.lastError).toContain("خطای آزمایشی");
  });

  test("runWorkflowOnceForEvent: executes once, duplicates skip, failure is retryable, completed never repeats", async () => {
    const ev = await newEvent("1006");
    const wf1 = await seedWorkflow("run-1");
    const wf2 = await seedWorkflow("run-2");
    let executions = 0;
    const r1 = await runWorkflowOnceForEvent(ev.id, wf1, async () => { executions++; return { ok: true }; });
    expect(r1).toEqual({ executed: true, ok: true });
    // Duplicate delivery (same event, same workflow) must NOT re-execute.
    const r2 = await runWorkflowOnceForEvent(ev.id, wf1, async () => { executions++; return { ok: true }; });
    expect(r2.executed).toBe(false);
    expect(executions).toBe(1);

    // A failing run is marked failed and IS re-executed on the next pass.
    await runWorkflowOnceForEvent(ev.id, wf2, async () => { throw new Error("boom"); /* throws stay failures */ });
    const run2 = await db.botWorkflowRun.findUniqueOrThrow({
      where: { eventId_workflowId: { eventId: ev.id, workflowId: wf2 } },
    });
    expect(run2.status).toBe("failed");
    const r3 = await runWorkflowOnceForEvent(ev.id, wf2, async () => { executions++; return { ok: true }; });
    expect(r3.executed).toBe(true);
    const run2b = await db.botWorkflowRun.findUniqueOrThrow({
      where: { eventId_workflowId: { eventId: ev.id, workflowId: wf2 } },
    });
    expect(run2b.status).toBe("completed");
    expect(executions).toBe(2);

    // The repaired run is now completed — never repeats again.
    const r4 = await runWorkflowOnceForEvent(ev.id, wf2, async () => { executions++; return { ok: true }; });
    expect(r4.executed).toBe(false);
    expect(executions).toBe(2);
  });

  test("one event matching MULTIPLE workflows: a failed workflow does not suppress its siblings", async () => {
    const ev = await newEvent("1007");
    const wfa = await seedWorkflow("sib-a");
    const wfb = await seedWorkflow("sib-b");
    const wfc = await seedWorkflow("sib-c");
    const ran: string[] = [];
    const [a, b, c] = await Promise.all([
      runWorkflowOnceForEvent(ev.id, wfa, async () => { ran.push("a"); return { ok: true }; }),
      runWorkflowOnceForEvent(ev.id, wfb, async () => { throw new Error("wf-b failed"); /* throws stay failures */ }),
      runWorkflowOnceForEvent(ev.id, wfc, async () => { ran.push("c"); return { ok: true }; }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(c.ok).toBe(true);
    expect(ran.sort()).toEqual(["a", "c"]); // sibling isolation
    const runs = await db.botWorkflowRun.findMany({ where: { eventId: ev.id } });
    expect(runs.length).toBe(3);
  });

  test("recoverBotEvents re-processes a stale event FROM ITS STORED PAYLOAD and completes it", async () => {
    const ev = await ensureBotEvent(bot, bot.provider, "1008", { update_id: 1008, message: { text: "سلام" } });
    expect(await claimBotEvent(ev.id)).toBe(true);
    // Simulate a crash: lease expired, event still processing.
    await db.botInboundEvent.update({
      where: { id: ev.id },
      data: { leaseUntil: new Date(Date.now() - 5000) },
    });
    const processed: Array<{ text?: string; isRetry: boolean }> = [];
    await recoverBotEvents(bot, async (_b, payload, opts) => {
      const p = payload as { message?: { text?: string } };
      processed.push({ text: p.message?.text, isRetry: opts.isRetry });
      void opts.eventId;
    });
    expect(processed.length).toBe(1);
    expect(processed[0].text).toBe("سلام");
    expect(processed[0].isRetry).toBe(true);
    const row = await db.botInboundEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(row.status).toBe("completed");
    expect(row.completedAt).not.toBeNull();
  });

  test("recovery is bounded and idempotent: completed events are not re-processed", async () => {
    const ev = await ensureBotEvent(bot, bot.provider, "1009", { update_id: 1009 });
    expect(await claimBotEvent(ev.id)).toBe(true);
    await completeBotEvent(ev.id);
    let calls = 0;
    await recoverBotEvents(bot, async () => { calls++; });
    expect(calls).toBe(0); // completed events never re-process
  });
});
