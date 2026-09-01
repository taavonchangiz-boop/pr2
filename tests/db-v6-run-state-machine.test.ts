// =====================================================================
// POSTYAR — V6 run-state-machine / canonical-payload regression suite
// ---------------------------------------------------------------------
// Pins the V6 root-cause repairs. Every test here FAILED against the
// pre-V6 implementation:
//
//   * C-01 — the child-run claim did NOT set status="processing": the
//     row stayed `pending` while actively executing, contradicting the
//     documented state machine, the heartbeat predicate and recovery.
//     Now: the atomic claim IS the transition
//       pending/failed → processing → completed | failed → dead
//     with an owner fencing token, a processing-only owner-fenced
//     heartbeat, expired-lease-only takeover, immutable `completed`,
//     bounded retryable failures and a terminal `dead` state.
//
//   * C-02 — finalizeBotEvent stays the ONLY authoritative completion;
//     with the fixed child machine, processing/pending/failed children
//     all block completion and recovery re-drives only non-terminal
//     children.
//
//   * C-03 — ensureBotEvent used to OVERWRITE the canonical payload on
//     duplicate delivery (the upsert's update branch). Now the first
//     persisted payload is authoritative and immutable; a differing
//     duplicate is recorded as an anomaly and never replaces it.
//
//   * C-04 — the replay envelope used to run through the lossy forensic
//     sanitizer (4KB string slices, 32-element array slices, depth cap)
//     so recovery silently executed on corrupted data, and a truncated
//     payload burned its whole retry budget before dying. Now the
//     envelope is complete (tokenish keys only), and non-replayable
//     events go DEAD immediately.
//
//   * C-05 — a just-failed event is never recoverable inside the same
//     request window: the durable nextRetryAt backoff is honored.
// =====================================================================
import { test, expect, describe, beforeAll, beforeEach } from "bun:test";
import { db } from "@/lib/db";
import { resetDb, seedUser, seedBot, ensureDbConnected } from "./_db-helpers";
import {
  ensureBotEvent,
  claimBotEventForOwner,
  finalizeBotEvent,
  failBotEvent,
  recoverBotEvents,
  renewBotEventLease,
  runWorkflowOnceForEvent,
  runMatchedWorkflowsForEvent,
  claimBotWorkflowRunForOwner,
  renewBotWorkflowRunLease,
  completeBotWorkflowRun,
  failBotWorkflowRun,
  listRecoverableBotEvents,
  BOT_RUN_MAX_ATTEMPTS,
} from "@/lib/bots/event-dedup";
import type { Bot } from "@prisma/client";

function past(ms: number): Date {
  return new Date(Date.now() - ms);
}
function future(ms: number): Date {
  return new Date(Date.now() + ms);
}

async function createRun(eventId: string, workflowId: string): Promise<string> {
  const run = await db.botWorkflowRun.upsert({
    where: { eventId_workflowId: { eventId, workflowId } },
    create: { eventId, workflowId },
    update: {},
  });
  return run.id;
}

// ---------------------------------------------------------------------
// C-01 — the child-run state machine
// ---------------------------------------------------------------------
describe("V6 C-01 — the run claim IS the transition to processing", () => {
  let userId: string;
  let bot: Bot;

  beforeAll(async () => {
    await ensureDbConnected();
  });
  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "v6-run@test.local", mobile: "09120200001" });
    userId = u.id;
    bot = await seedBot({ ownerId: userId, provider: "telegram", name: "بات V6" });
  });

  test("1. a pending run claim enters processing BEFORE execution; success → completed", async () => {
    const wf = await db.botWorkflow.create({
      data: { botId: bot.id, name: "WF", enabled: true, triggerKind: "message", steps: "[]" },
    });
    const event = await ensureBotEvent(bot, "telegram", "6001", { update_id: 6001 });
    const runId = await createRun(event.id, wf.id);

    let observedDuringExecution: { status: string; attempts: number; locked: boolean } | null = null;
    const r = await runWorkflowOnceForEvent(event.id, wf.id, async () => {
      const row = await db.botWorkflowRun.findUniqueOrThrow({ where: { id: runId } });
      observedDuringExecution = {
        status: row.status,
        attempts: row.attempts,
        locked: row.lockedBy !== null && row.leaseUntil !== null && row.leaseUntil > new Date(),
      };
      return { ok: true };
    });
    // Pre-V6 the row read `pending` here — the claim never transitioned it.
    expect(observedDuringExecution as unknown).toEqual({ status: "processing", attempts: 1, locked: true });
    expect(r).toMatchObject({ executed: true, ok: true });
    const after = await db.botWorkflowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(after.status).toBe("completed");
    expect(after.leaseUntil).toBeNull();
    expect(after.attempts).toBe(1);
  });

  test("2. the heartbeat renews ONLY processing rows owned by the token", async () => {
    const wf = await db.botWorkflow.create({
      data: { botId: bot.id, name: "WF2", enabled: true, triggerKind: "message", steps: "[]" },
    });
    const event = await ensureBotEvent(bot, "telegram", "6002", { update_id: 6002 });
    const runId = await createRun(event.id, wf.id);

    // A pending row — even with an owner stamped — is NOT renewable.
    await db.botWorkflowRun.update({
      where: { id: runId },
      data: { lockedBy: "pending-holder", leaseUntil: past(1000) },
    });
    expect(await renewBotWorkflowRunLease(runId, "pending-holder")).toBe(false);
    expect((await db.botWorkflowRun.findUniqueOrThrow({ where: { id: runId } })).leaseUntil! < new Date()).toBe(true);

    // Claim → processing, owned: renewal lands.
    const holder = (await claimBotWorkflowRunForOwner(runId))!;
    expect(holder).not.toBeNull();
    const before = await db.botWorkflowRun.findUniqueOrThrow({ where: { id: runId } });
    await new Promise((r) => setTimeout(r, 20));
    expect(await renewBotWorkflowRunLease(runId, holder)).toBe(true);
    const after = await db.botWorkflowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(after.leaseUntil!.getTime()).toBeGreaterThan(before.leaseUntil!.getTime());
    expect(after.status).toBe("processing");
  });

  test("3. a live-lease processing run is never stealable; stale takeover requires an expired lease", async () => {
    const wf = await db.botWorkflow.create({
      data: { botId: bot.id, name: "WF3", enabled: true, triggerKind: "message", steps: "[]" },
    });
    const event = await ensureBotEvent(bot, "telegram", "6003", { update_id: 6003 });
    const runId = await createRun(event.id, wf.id);

    const h1 = (await claimBotWorkflowRunForOwner(runId))!;
    // Live lease → second claim loses.
    expect(await claimBotWorkflowRunForOwner(runId)).toBeNull();
    // Lease expires (crash) → takeover wins and re-enters processing.
    await db.botWorkflowRun.update({ where: { id: runId }, data: { leaseUntil: past(1000) } });
    const h2 = (await claimBotWorkflowRunForOwner(runId))!;
    expect(h2).not.toBeNull();
    expect(h2).not.toBe(h1);
    const row = await db.botWorkflowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe("processing");
    expect(row.lockedBy).toBe(h2);
    expect(row.attempts).toBe(2); // exactly one increment per successful claim
  });

  test("4. concurrent claims converge on exactly one owner; the loser never executes", async () => {
    const wf = await db.botWorkflow.create({
      data: { botId: bot.id, name: "WF4", enabled: true, triggerKind: "message", steps: "[]" },
    });
    const event = await ensureBotEvent(bot, "telegram", "6004", { update_id: 6004 });
    const runId = await createRun(event.id, wf.id);

    // Real concurrent primitive-level claims.
    const [a, b] = await Promise.all([
      claimBotWorkflowRunForOwner(runId),
      claimBotWorkflowRunForOwner(runId),
    ]);
    const winners = [a, b].filter((h) => h !== null);
    expect(winners).toHaveLength(1);
    expect((await db.botWorkflowRun.findUniqueOrThrow({ where: { id: runId } })).attempts).toBe(1);

    // Caller-level concurrency on a fresh run: exactly one execution.
    await db.botWorkflowRun.update({
      where: { id: runId },
      data: { status: "pending", lockedBy: null, leaseUntil: null, attempts: 0 },
    });
    let executions = 0;
    const [r1, r2] = await Promise.all([
      runWorkflowOnceForEvent(event.id, wf.id, async () => {
        executions++;
        await new Promise((r) => setTimeout(r, 150));
        return { ok: true };
      }),
      runWorkflowOnceForEvent(event.id, wf.id, async () => {
        executions++;
        return { ok: true };
      }),
    ]);
    const results = [r1, r2].sort((x, y) => Number(y.executed) - Number(x.executed));
    // THE invariant: exactly ONE caller executes, the loser never does.
    // (The loser honestly reports either contended:ok:false when it loses
    // the live-lease race, or the completed short-circuit when the winner
    // already finished — both are pinned in the deterministic suites.)
    expect(results[0]).toMatchObject({ executed: true, ok: true });
    expect(results[1].executed).toBe(false);
    expect(executions).toBe(1);
  });

  test("5. a zombie worker cannot complete a run taken over by another worker", async () => {
    const wf = await db.botWorkflow.create({
      data: { botId: bot.id, name: "WF5", enabled: true, triggerKind: "message", steps: "[]" },
    });
    const event = await ensureBotEvent(bot, "telegram", "6005", { update_id: 6005 });
    const runId = await createRun(event.id, wf.id);
    const zombie = (await claimBotWorkflowRunForOwner(runId))!;
    // Takeover.
    await db.botWorkflowRun.update({
      where: { id: runId },
      data: { leaseUntil: past(1000) },
    });
    const owner = (await claimBotWorkflowRunForOwner(runId))!;
    // Zombie's late completion is fenced out.
    expect(await completeBotWorkflowRun(runId, zombie)).toBe(false);
    const row = await db.botWorkflowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe("processing");
    expect(row.lockedBy).toBe(owner);
    // The real owner CAN complete it — exactly once, immutably.
    expect(await completeBotWorkflowRun(runId, owner)).toBe(true);
    expect(await completeBotWorkflowRun(runId, owner)).toBe(false); // no regression from completed
  });

  test("6. a zombie worker cannot fail a run taken over by another worker", async () => {
    const wf = await db.botWorkflow.create({
      data: { botId: bot.id, name: "WF6", enabled: true, triggerKind: "message", steps: "[]" },
    });
    const event = await ensureBotEvent(bot, "telegram", "6006", { update_id: 6006 });
    const runId = await createRun(event.id, wf.id);
    const zombie = (await claimBotWorkflowRunForOwner(runId))!;
    await db.botWorkflowRun.update({ where: { id: runId }, data: { leaseUntil: past(1000) } });
    const owner = (await claimBotWorkflowRunForOwner(runId))!;
    expect(await failBotWorkflowRun(runId, zombie, "زامبی")).toBe("failed");
    const row = await db.botWorkflowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe("processing"); // untouched by the zombie
    expect(row.lockedBy).toBe(owner);
    expect(row.lastError).toBeNull();
    // The real owner's failure lands and clears the lease for retry.
    expect(await failBotWorkflowRun(runId, owner, "شکست واقعی")).toBe("failed");
    const failed = await db.botWorkflowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(failed.status).toBe("failed");
    expect(failed.leaseUntil).toBeNull();
    expect(failed.lastError).toBe("شکست واقعی");
  });

  test("7. a zombie worker cannot renew (heartbeat) a lease it lost", async () => {
    const wf = await db.botWorkflow.create({
      data: { botId: bot.id, name: "WF7", enabled: true, triggerKind: "message", steps: "[]" },
    });
    const event = await ensureBotEvent(bot, "telegram", "6007", { update_id: 6007 });
    const runId = await createRun(event.id, wf.id);
    const zombie = (await claimBotWorkflowRunForOwner(runId))!;
    await db.botWorkflowRun.update({ where: { id: runId }, data: { leaseUntil: past(1000) } });
    await claimBotWorkflowRunForOwner(runId);
    const row = await db.botWorkflowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(await renewBotWorkflowRunLease(runId, zombie)).toBe(false);
    const after = await db.botWorkflowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(after.leaseUntil!.getTime()).toBe(row.leaseUntil!.getTime());
  });

  test("8. a completed run is immutable: never re-claimed, never re-executed", async () => {
    const wf = await db.botWorkflow.create({
      data: { botId: bot.id, name: "WF8", enabled: true, triggerKind: "message", steps: "[]" },
    });
    const event = await ensureBotEvent(bot, "telegram", "6008", { update_id: 6008 });
    const runId = await createRun(event.id, wf.id);
    const holder = (await claimBotWorkflowRunForOwner(runId))!;
    expect(await completeBotWorkflowRun(runId, holder)).toBe(true);

    expect(await claimBotWorkflowRunForOwner(runId)).toBeNull();
    let executions = 0;
    const r = await runWorkflowOnceForEvent(event.id, wf.id, async () => {
      executions++;
      return { ok: true };
    });
    expect(r).toMatchObject({ executed: false, ok: true });
    expect(executions).toBe(0);
    const row = await db.botWorkflowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe("completed");
    expect(row.attempts).toBe(1);
  });

  test("9. an ok:false outcome leaves the run failed (never completed) and retryable", async () => {
    const wf = await db.botWorkflow.create({
      data: { botId: bot.id, name: "WF9", enabled: true, triggerKind: "message", steps: "[]" },
    });
    const event = await ensureBotEvent(bot, "telegram", "6009", { update_id: 6009 });
    const runId = await createRun(event.id, wf.id);
    const r = await runWorkflowOnceForEvent(event.id, wf.id, async () => ({
      ok: false,
      errorFa: "شبکه قطع شد",
    }));
    expect(r).toMatchObject({ executed: true, ok: false });
    const row = await db.botWorkflowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe("failed");
    expect(row.leaseUntil).toBeNull();
    expect(row.lastError).toBe("شبکه قطع شد");
  });

  test("10. a failed run retries: failed → processing → completed", async () => {
    const wf = await db.botWorkflow.create({
      data: { botId: bot.id, name: "WF10", enabled: true, triggerKind: "message", steps: "[]" },
    });
    const event = await ensureBotEvent(bot, "telegram", "6010", { update_id: 6010 });
    const runId = await createRun(event.id, wf.id);
    await runWorkflowOnceForEvent(event.id, wf.id, async () => ({ ok: false, errorFa: "اول" }));
    const r2 = await runWorkflowOnceForEvent(event.id, wf.id, async () => ({ ok: true }));
    expect(r2).toMatchObject({ executed: true, ok: true });
    const row = await db.botWorkflowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe("completed");
    expect(row.attempts).toBe(2);
    expect(row.lastError).toBeNull();
  });

  test("11. attempts reach the cap → terminal dead; dead is never claimable and the parent event stays un-completed", async () => {
    const wf = await db.botWorkflow.create({
      data: { botId: bot.id, name: "WF11", enabled: true, triggerKind: "message", steps: "[]" },
    });
    const event = await ensureBotEvent(bot, "telegram", "6011", { update_id: 6011 });
    await db.botInboundEvent.update({
      where: { id: event.id },
      data: { status: "processing", attempts: 1, leaseUntil: past(1000), lockedBy: "seed" },
    });
    const runId = await createRun(event.id, wf.id);
    for (let i = 0; i < BOT_RUN_MAX_ATTEMPTS; i++) {
      const holder = (await claimBotWorkflowRunForOwner(runId))!;
      expect(holder).not.toBeNull();
      const result = await failBotWorkflowRun(runId, holder, `شکست ${i + 1}`);
      expect(result).toBe(i === BOT_RUN_MAX_ATTEMPTS - 1 ? "dead" : "failed");
    }
    const dead = await db.botWorkflowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(dead.status).toBe("dead");
    expect(dead.attempts).toBe(BOT_RUN_MAX_ATTEMPTS);
    // dead is terminal: no claim, no execution, contended honesty.
    expect(await claimBotWorkflowRunForOwner(runId)).toBeNull();
    const r = await runWorkflowOnceForEvent(event.id, wf.id, async () => ({ ok: true }));
    expect(r).toMatchObject({ executed: false, ok: false, contended: true });
    // A dead child blocks event completion (C-02) — the event never lies.
    const eventHolder = (await claimBotEventForOwner(event.id))!;
    expect(await finalizeBotEvent(event.id, eventHolder)).toBe(false);
  });

  test("12. parent event lease and child run lease stay coherent through the run", async () => {
    const wf = await db.botWorkflow.create({
      data: { botId: bot.id, name: "WF12", enabled: true, triggerKind: "message", steps: "[]" },
    });
    const event = await ensureBotEvent(bot, "telegram", "6012", { update_id: 6012 });
    const eventHolder = (await claimBotEventForOwner(event.id))!;
    let coherence: { eventLive: boolean; runLive: boolean; eventRenewed: boolean } | null = null;
    const r = await runWorkflowOnceForEvent(
      event.id,
      wf.id,
      async () => {
        const ev = await db.botInboundEvent.findUniqueOrThrow({ where: { id: event.id } });
        const runRow = await db.botWorkflowRun.findFirstOrThrow({
          where: { eventId: event.id, workflowId: wf.id },
        });
        coherence = {
          eventLive: ev.status === "processing" && ev.leaseUntil !== null && ev.leaseUntil > new Date() && ev.lockedBy === eventHolder,
          runLive: runRow.status === "processing" && runRow.leaseUntil !== null && runRow.leaseUntil > new Date(),
          eventRenewed: await renewBotEventLease(event.id, eventHolder).then(() => true),
        };
        return { ok: true };
      },
      { eventHolder },
    );
    expect(r).toMatchObject({ executed: true, ok: true });
    expect(coherence as unknown).toEqual({ eventLive: true, runLive: true, eventRenewed: true });
    // All children terminal-success → the authoritative finalize completes.
    expect(await finalizeBotEvent(event.id, eventHolder)).toBe(true);
  });

  test("an abandoned processing run past the attempt cap converges to dead (contended cleanup)", async () => {
    const wf = await db.botWorkflow.create({
      data: { botId: bot.id, name: "WF13", enabled: true, triggerKind: "message", steps: "[]" },
    });
    const event = await ensureBotEvent(bot, "telegram", "6013", { update_id: 6013 });
    const runId = await createRun(event.id, wf.id);
    await db.botWorkflowRun.update({
      where: { id: runId },
      data: { status: "processing", attempts: BOT_RUN_MAX_ATTEMPTS, leaseUntil: past(1000), lockedBy: "crashed" },
    });
    const r = await runWorkflowOnceForEvent(event.id, wf.id, async () => ({ ok: true }));
    expect(r).toMatchObject({ executed: false, ok: false, contended: true });
    const row = await db.botWorkflowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe("dead");
  });
});

// ---------------------------------------------------------------------
// C-02 — authoritative event completion with the fixed child machine
// ---------------------------------------------------------------------
describe("V6 C-02 — event completion only when every intended child is terminal-success", () => {
  let userId: string;
  let bot: Bot;

  beforeAll(async () => {
    await ensureDbConnected();
  });
  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "v6-finalize@test.local", mobile: "09120200002" });
    userId = u.id;
    bot = await seedBot({ ownerId: userId, provider: "telegram", name: "بات V6 نهایی" });
  });

  async function threeWorkflows(): Promise<string[]> {
    const ids: string[] = [];
    for (const name of ["A", "B", "C"]) {
      const wf = await db.botWorkflow.create({
        data: { botId: bot.id, name, enabled: true, triggerKind: "message", steps: "[]" },
      });
      ids.push(wf.id);
    }
    return ids;
  }

  test("A success / B processing / C success → not completed; B finishing completes it", async () => {
    const [a, b, c] = await threeWorkflows();
    const event = await ensureBotEvent(bot, "telegram", "6101", { update_id: 6101 });
    const holder = (await claimBotEventForOwner(event.id))!;
    await runWorkflowOnceForEvent(event.id, a, async () => ({ ok: true }), { eventHolder: holder });
    // B is claimed but its worker is still alive (processing).
    const runB = await createRun(event.id, b);
    const holderB = (await claimBotWorkflowRunForOwner(runB))!;
    await runWorkflowOnceForEvent(event.id, c, async () => ({ ok: true }), { eventHolder: holder });
    expect(await finalizeBotEvent(event.id, holder)).toBe(false); // processing child blocks
    expect(await completeBotWorkflowRun(runB, holderB)).toBe(true);
    expect(await finalizeBotEvent(event.id, holder)).toBe(true);
    const ev = await db.botInboundEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(ev.status).toBe("completed");
  });

  test("failed child retry: completed siblings never re-run; event completes only after the failed child succeeds", async () => {
    const [a, b, c] = await threeWorkflows();
    const event = await ensureBotEvent(bot, "telegram", "6102", { update_id: 6102 });
    const holder = (await claimBotEventForOwner(event.id))!;
    const ran = new Map<string, number>();
    const track = (id: string) => async (): Promise<{ ok: boolean; errorFa?: string }> => {
      ran.set(id, (ran.get(id) ?? 0) + 1);
      // B fails on its FIRST execution only; every later attempt succeeds.
      if (id === b && (ran.get(id) ?? 0) === 1) return { ok: false, errorFa: "B شکست" };
      return { ok: true };
    };
    await expect(
      runMatchedWorkflowsForEvent(
        event.id,
        [a, b, c].map((id) => ({ workflowId: id, execute: track(id) })),
        { eventHolder: holder },
      ),
    ).rejects.toBeInstanceOf(Error);
    // The aggregate failure keeps the event retryable — never completed.
    await failBotEvent(event.id, "B شکست", holder);
    const failed = await db.botInboundEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(failed.status).toBe("failed");
    expect(failed.nextRetryAt).not.toBeNull();

    // The backoff elapses (simulated): recovery may now claim the event.
    await db.botInboundEvent.update({ where: { id: event.id }, data: { nextRetryAt: past(1000) } });
    // Recovery pass: A and C are completed and MUST NOT re-run.
    const holder2 = (await claimBotEventForOwner(event.id))!;
    await runMatchedWorkflowsForEvent(
      event.id,
      [a, b, c].map((id) => ({ workflowId: id, execute: track(id) })),
      { eventHolder: holder2 },
    );
    expect(ran.get(a)).toBe(1);
    expect(ran.get(c)).toBe(1);
    expect(ran.get(b)).toBe(2); // only the failed child re-executed
    expect(await finalizeBotEvent(event.id, holder2)).toBe(true);
    const done = await db.botInboundEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(done.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------
// C-03 — the canonical event payload is immutable
// ---------------------------------------------------------------------
describe("V6 C-03 — first canonical payload is authoritative and immutable", () => {
  let userId: string;
  let bot: Bot;

  beforeAll(async () => {
    await ensureDbConnected();
  });
  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "v6-payload@test.local", mobile: "09120200003" });
    userId = u.id;
    bot = await seedBot({ ownerId: userId, provider: "telegram", name: "بات V6 payload" });
  });

  test("an identical duplicate returns the same row and writes nothing", async () => {
    const update = { update_id: 6201, message: { text: "سلام", chat: { id: 1 } } };
    const e1 = await ensureBotEvent(bot, "telegram", "6201", update);
    const e2 = await ensureBotEvent(bot, "telegram", "6201", update);
    expect(e2.id).toBe(e1.id);
    expect(e2.payload).toBe(e1.payload);
    expect(await db.botInboundEvent.count({ where: { botId: bot.id, externalEventId: "6201" } })).toBe(1);
    expect(
      await db.auditLog.count({ where: { action: "bot_inbound_duplicate_payload_anomaly" } }),
    ).toBe(0);
  });

  test("a different duplicate payload NEVER replaces the original and is recorded as an anomaly", async () => {
    const first = { update_id: 6202, message: { text: "نسخه اصلی", chat: { id: 1 } } };
    const second = { update_id: 6202, message: { text: "نسخه جعلی تزریق‌شده", chat: { id: 999 } } };
    const e1 = await ensureBotEvent(bot, "telegram", "6202", first);
    const e2 = await ensureBotEvent(bot, "telegram", "6202", second);
    expect(e2.id).toBe(e1.id);
    // Pre-V6 the upsert's update branch REPLACED the payload — the forgery
    // became the recovery input. The original must survive untouched.
    expect(e2.payload).toBe(e1.payload);
    expect(JSON.parse(e2.payload!).message.text).toBe("نسخه اصلی");
    const anomaly = await db.auditLog.findFirst({
      where: { action: "bot_inbound_duplicate_payload_anomaly", targetId: e1.id },
    });
    expect(anomaly).not.toBeNull();
    expect(anomaly!.actor).toBe("webhook");
  });

  test("the first payload stays authoritative across many different duplicates", async () => {
    await ensureBotEvent(bot, "telegram", "6203", { update_id: 6203, v: 1 });
    await ensureBotEvent(bot, "telegram", "6203", { update_id: 6203, v: 2 });
    const last = await ensureBotEvent(bot, "telegram", "6203", { update_id: 6203, v: 3 });
    expect(JSON.parse(last.payload!)).toEqual({ update_id: 6203, v: 1 });
  });

  test("a first delivery with no usable payload is backfilled exactly once (CAS), then immutability applies", async () => {
    const e1 = await ensureBotEvent(bot, "telegram", "6204", undefined); // payload null
    expect(e1.payload).toBeNull();
    const e2 = await ensureBotEvent(bot, "telegram", "6204", { update_id: 6204, message: { text: "واقعی" } });
    expect(JSON.parse(e2.payload!)).toEqual({ update_id: 6204, message: { text: "واقعی" } });
    // From now on the envelope is immutable, even for a "better" duplicate.
    const e3 = await ensureBotEvent(bot, "telegram", "6204", { update_id: 6204, message: { text: "دیگر" } });
    expect(JSON.parse(e3.payload!).message.text).toBe("واقعی");
  });

  test("recovery replays the ORIGINAL canonical payload (recovery equality)", async () => {
    const original = { update_id: 6205, message: { text: "پیام اصلی برای بازیابی", chat: { id: 7 } } };
    const event = await ensureBotEvent(bot, "telegram", "6205", original);
    await ensureBotEvent(bot, "telegram", "6205", { update_id: 6205, message: { text: "تزریق", chat: { id: 8 } } });
    // Make the event recoverable (expired lease, as after a crash).
    await db.botInboundEvent.update({
      where: { id: event.id },
      data: { status: "processing", leaseUntil: past(1000), attempts: 1 },
    });
    const seen: unknown[] = [];
    await recoverBotEvents(bot, async (_b, payload) => {
      seen.push(payload);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(original); // the forgery never reached the processor
  });
});

// ---------------------------------------------------------------------
// C-04 — the replay envelope is complete; non-replayable events die
// ---------------------------------------------------------------------
describe("V6 C-04 — complete replay envelope, dead-not-retry for non-replayable", () => {
  let userId: string;
  let bot: Bot;

  beforeAll(async () => {
    await ensureDbConnected();
  });
  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "v6-envelope@test.local", mobile: "09120200004" });
    userId = u.id;
    bot = await seedBot({ ownerId: userId, provider: "telegram", name: "بات V6 envelope" });
  });

  test("a large Telegram update is stored COMPLETE (deep nesting, >32-element arrays, >4KB strings)", async () => {
    const longText = "ت".repeat(5000);
    const album = Array.from({ length: 40 }, (_, i) => ({ file_id: `F${i}`, w: 100 + i }));
    const deep = { l4: { l5: { l6: { l7: { l8: { value: "عمیق" } } } } } };
    const update = {
      update_id: 6301,
      message: { message_id: 1, text: longText, photo: album, deep, chat: { id: 42 } },
    };
    const event = await ensureBotEvent(bot, "telegram", "6301", update);
    expect(event.payloadTruncated).toBe(false);
    const stored = JSON.parse(event.payload!);
    // Pre-V6 the forensic sanitizer sliced arrays to 32, strings to 4096
    // and depth to 6 — recovery executed on silently corrupted data.
    expect(stored).toEqual(update);
    expect(stored.message.photo).toHaveLength(40);
    expect(stored.message.text).toHaveLength(5000);
    expect(stored.message.deep.l4.l5.l6.l7.l8.value).toBe("عمیق");
  });

  test("large Bale and Rubika updates are stored completely", async () => {
    const balePayment = {
      update_id: 6302,
      message: {
        message_id: 2,
        successful_payment: {
          currency: "IRR",
          total_amount: 1500000,
          invoice_payload: "plan:gold:order:9",
          telegram_payment_charge_id: "chg_" + "x".repeat(6000),
          provider_payment_charge_id: "prov_" + "y".repeat(6000),
          order_items: Array.from({ length: 45 }, (_, i) => ({ sku: `SKU-${i}`, qty: i + 1 })),
        },
      },
    };
    const bale = await ensureBotEvent(bot, "bale", "6302", balePayment);
    expect(bale.payloadTruncated).toBe(false);
    expect(JSON.parse(bale.payload!)).toEqual(balePayment);

    const rubika = {
      chat_id: "6303",
      aux_data: { start: "z".repeat(7000) },
      items: Array.from({ length: 50 }, (_, i) => ({ text: `آیتم ${i}`, n: i })),
    };
    const rub = await ensureBotEvent(bot, "rubika", "6303", rubika);
    expect(rub.payloadTruncated).toBe(false);
    expect(JSON.parse(rub.payload!)).toEqual(rubika);
  });

  test("callback queries and token-ish keys: content preserved, only credential keys redacted", async () => {
    const update = {
      update_id: 6304,
      callback_query: {
        id: "cb1",
        data: "action:do:thing",
        from: { id: 5, first_name: "کاربر" },
        message: { message_id: 9, text: "متن دکمه" },
      },
      credentialish: { token: "super-secret-value", password: "hunter2", authorization: "Bearer x" },
    };
    const event = await ensureBotEvent(bot, "telegram", "6304", update);
    const stored = JSON.parse(event.payload!);
    expect(stored.callback_query).toEqual(update.callback_query);
    // M-02: no credentials at rest — but ONLY the tokenish keys are
    // redacted; everything a processor needs is byte-faithful.
    expect(stored.credentialish).toEqual({
      token: "<REDACTED>",
      password: "<REDACTED>",
      authorization: "<REDACTED>",
    });
  });

  test("an oversized payload is marked truncated and goes DEAD on recovery without burning retries", async () => {
    const big = { update_id: 6305, message: { text: "z".repeat(70 * 1024) } };
    const event = await ensureBotEvent(bot, "telegram", "6305", big);
    expect(event.payloadTruncated).toBe(true);
    // Recovery-eligible: a claimed-but-crashed event with an expired lease.
    await db.botInboundEvent.update({
      where: { id: event.id },
      data: { status: "processing", leaseUntil: past(1000), attempts: 1 },
    });
    let processorCalls = 0;
    await recoverBotEvents(bot, async () => {
      processorCalls++;
    });
    expect(processorCalls).toBe(0); // truncated data is NEVER replayed
    const dead = await db.botInboundEvent.findUniqueOrThrow({ where: { id: event.id } });
    // Pre-V6 this was `failed` with a nextRetryAt — the event burned its
    // whole retry budget (5 attempts) on input that can never succeed.
    expect(dead.status).toBe("dead");
    expect(dead.nextRetryAt).toBeNull();
  });

  test("missing and unparseable payloads go dead immediately on recovery", async () => {
    const e1 = await ensureBotEvent(bot, "telegram", "6306", undefined);
    await db.botInboundEvent.update({
      where: { id: e1.id },
      data: { status: "processing", leaseUntil: past(1000), attempts: 1 },
    });
    const e2 = await db.botInboundEvent.create({
      data: {
        botId: bot.id,
        provider: "telegram",
        externalEventId: "6307",
        payload: "{not-json",
        payloadTruncated: false,
        status: "processing",
        leaseUntil: past(1000),
        attempts: 1,
      },
    });
    let processorCalls = 0;
    await recoverBotEvents(bot, async () => {
      processorCalls++;
    });
    expect(processorCalls).toBe(0);
    expect((await db.botInboundEvent.findUniqueOrThrow({ where: { id: e1.id } })).status).toBe("dead");
    expect((await db.botInboundEvent.findUniqueOrThrow({ where: { id: e2.id } })).status).toBe("dead");
  });
});

// ---------------------------------------------------------------------
// C-05 — recovery honors the durable backoff (no same-request hot-loop)
// ---------------------------------------------------------------------
describe("V6 C-05 — a just-failed event is never recoverable inside the same window", () => {
  let userId: string;
  let bot: Bot;

  beforeAll(async () => {
    await ensureDbConnected();
  });
  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "v6-backoff@test.local", mobile: "09120200005" });
    userId = u.id;
    bot = await seedBot({ ownerId: userId, provider: "telegram", name: "بات V6 backoff" });
  });

  test("after failBotEvent the event is not recoverable until its durable nextRetryAt elapses", async () => {
    const event = await ensureBotEvent(bot, "telegram", "6401", { update_id: 6401 });
    const holder = (await claimBotEventForOwner(event.id))!;
    const result = await failBotEvent(event.id, "شکست اولیه", holder);
    expect(result).toBe("failed");
    const row = await db.botInboundEvent.findUniqueOrThrow({ where: { id: event.id } });
    // Bounded exponential backoff: at least 30s, at most base + 30s jitter.
    const gapMs = row.nextRetryAt!.getTime() - Date.now();
    expect(gapMs).toBeGreaterThanOrEqual(29_000);
    expect(gapMs).toBeLessThanOrEqual(61_000);
    // The recovery scan MUST NOT return it (no same-request hot-loop).
    expect((await listRecoverableBotEvents(bot.id)).map((e) => e.id)).not.toContain(event.id);
    // Once the schedule elapses, recovery honors it exactly once.
    await db.botInboundEvent.update({
      where: { id: event.id },
      data: { nextRetryAt: past(1000) },
    });
    expect((await listRecoverableBotEvents(bot.id)).map((e) => e.id)).toContain(event.id);
  });
});
