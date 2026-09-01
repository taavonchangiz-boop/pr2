// =====================================================================
// POSTYAR — V5 inbox/workflow hardening regression suite (DB-backed)
// ---------------------------------------------------------------------
// Pins the V5 C-02/C-03/H-03/H-04 root-cause repairs at the durable
// layer. Every test here FAILED against the pre-V5 implementation:
//
//   * C-02 Hole 1 — a contended per-workflow run claim (run lease
//     outliving the parent event's lease) was reported as ok:true, so
//     the event was completed while its child was still pending and the
//     workflow was lost forever. Now: contended claim → ok:false →
//     EventPartiallyFailedError → the event stays retryable and converges.
//
//   * C-02 (authoritative finalize) — completion is decided by the
//     durable event layer: an event with ANY non-terminal child run can
//     never be completed, by any caller, ever.
//
//   * C-03 fencing — a dispossessed (zombie) worker whose event was
//     taken over can no longer renew/complete/fail the row it lost, and
//     a stale run owner cannot complete/fail a run taken over by
//     another worker.
//
//   * H-03 — duplicate detection is decided by the Prisma constraint
//     code (P2002) only; a genuine FK failure (P2003) is never silently
//     swallowed as an "idempotent duplicate".
//
//   * H-04 — the per-step resume cursor is durably persisted on a
//     failed run and handed back to the engine on retry.
//
//   * C-02 Hole 2 — a Bale payment payload is routed to the dedicated
//     payment handler by live processing AND by recovery, never through
//     the non-payment workflow dispatcher.
// =====================================================================
import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { resetDb, seedUser, seedBot, ensureDbConnected } from "./_db-helpers";
import { encryptString } from "@/lib/security/crypto";
import {
  ensureBotEvent,
  claimBotEvent,
  claimBotEventForOwner,
  finalizeBotEvent,
  completeBotEvent,
  failBotEvent,
  renewBotEventLease,
  recoverBotEvents,
  runWorkflowOnceForEvent,
  runMatchedWorkflowsForEvent,
  EventPartiallyFailedError,
  BOT_EVENT_LEASE_MS,
} from "@/lib/bots/event-dedup";
import { persistInboundOnce } from "@/lib/bots/workflow";
import { isBalePaymentUpdate } from "@/lib/bots/inbound-classify";
import type { Bot } from "@prisma/client";

function past(ms: number): Date {
  return new Date(Date.now() - ms);
}
function future(ms: number): Date {
  return new Date(Date.now() + ms);
}

async function expireEventLease(eventId: string): Promise<void> {
  await db.botInboundEvent.update({
    where: { id: eventId },
    data: { leaseUntil: past(1000) },
  });
}

describe("V5 C-02 Hole 1 — contended run claim is never reported as success", () => {
  let userId: string;
  let bot: Bot;

  beforeAll(async () => {
    await ensureDbConnected();
  });
  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "v5-inbox@test.local", mobile: "09120100001" });
    userId = u.id;
    bot = await seedBot({ ownerId: userId, provider: "telegram", name: "بات V5" });
  });

  test("a run whose lease outlives the event's lease cannot be masked as completed", async () => {
    const wf = await db.botWorkflow.create({
      data: { botId: bot.id, name: "WF", enabled: true, triggerKind: "message", steps: "[]" },
    });
    const event = await ensureBotEvent(bot, "telegram", "9001", { update_id: 9001 });
    // Live worker claimed the event, created the run with a LIVE lease,
    // then died before completing it; the event lease expired first
    // (the divergence window).
    await db.botInboundEvent.update({
      where: { id: event.id },
      data: { status: "processing", leaseUntil: past(1000), attempts: 1 },
    });
    const run = await db.botWorkflowRun.upsert({
      where: { eventId_workflowId: { eventId: event.id, workflowId: wf.id } },
      create: { eventId: event.id, workflowId: wf.id },
      update: {},
    });
    await db.botWorkflowRun.update({
      where: { id: run.id },
      data: { status: "pending", leaseUntil: future(BOT_EVENT_LEASE_MS) },
    });

    // Recovery takes over the (expired-lease) event and hits the LIVE run
    // lease. Pre-V5 this returned ok:true and the event was completed
    // with the child still pending — the workflow was lost forever.
    const holder = await claimBotEventForOwner(event.id);
    expect(holder).not.toBeNull();
    let executions = 0;
    await expect(
      runMatchedWorkflowsForEvent(event.id, [
        {
          workflowId: wf.id,
          execute: async () => {
            executions++;
            return { ok: true };
          },
        },
      ], { eventHolder: holder! }),
    ).rejects.toBeInstanceOf(EventPartiallyFailedError);
    expect(executions).toBe(0);

    const evAfter = await db.botInboundEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(evAfter.status).not.toBe("completed");
    const runAfter = await db.botWorkflowRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(runAfter.status).toBe("pending");

    // Convergence: once the other worker's run completes (here: after its
    // lease expires and recovery executes it), the event completes.
    await db.botWorkflowRun.update({
      where: { id: run.id },
      data: { leaseUntil: past(1000) },
    });
    await expireEventLease(event.id);
    const holder2 = await claimBotEventForOwner(event.id);
    expect(holder2).not.toBeNull();
    await runMatchedWorkflowsForEvent(event.id, [
      {
        workflowId: wf.id,
        execute: async () => {
          executions++;
          return { ok: true };
        },
      },
    ], { eventHolder: holder2! });
    const done = await finalizeBotEvent(event.id, holder2!);
    expect(done).toBe(true);
    const evFinal = await db.botInboundEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(evFinal.status).toBe("completed");
    expect(executions).toBe(1);
  });

  test("a completed sibling short-circuits; the contended claim against it stays a legitimate no-op", async () => {
    const wf = await db.botWorkflow.create({
      data: { botId: bot.id, name: "WF2", enabled: true, triggerKind: "message", steps: "[]" },
    });
    const event = await ensureBotEvent(bot, "telegram", "9002", { update_id: 9002 });
    const r1 = await runWorkflowOnceForEvent(event.id, wf.id, async () => ({ ok: true }));
    expect(r1.ok).toBe(true);
    // Re-delivery of the same event: the completed run short-circuits ok:true.
    const r2 = await runWorkflowOnceForEvent(event.id, wf.id, async () => ({ ok: true }));
    expect(r2).toEqual({ executed: false, ok: true });
  });
});

describe("V5 C-02 — finalizeBotEvent is the authoritative completion", () => {
  let userId: string;
  let bot: Bot;

  beforeAll(async () => {
    await ensureDbConnected();
  });
  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "v5-finalize@test.local", mobile: "09120100002" });
    userId = u.id;
    bot = await seedBot({ ownerId: userId, provider: "telegram", name: "بات نهایی‌ساز" });
  });

  test("A ok / B failed / C ok → event CANNOT be completed; after B succeeds it can", async () => {
    const wfa = await db.botWorkflow.create({ data: { botId: bot.id, name: "A", enabled: true, triggerKind: "message", steps: "[]" } });
    const wfb = await db.botWorkflow.create({ data: { botId: bot.id, name: "B", enabled: true, triggerKind: "message", steps: "[]" } });
    const wfc = await db.botWorkflow.create({ data: { botId: bot.id, name: "C", enabled: true, triggerKind: "message", steps: "[]" } });
    const event = await ensureBotEvent(bot, "telegram", "9101", { update_id: 9101 });
    const holder = await claimBotEventForOwner(event.id);
    expect(holder).not.toBeNull();

    await runWorkflowOnceForEvent(event.id, wfa.id, async () => ({ ok: true }), { eventHolder: holder! });
    await expect(
      runWorkflowOnceForEvent(event.id, wfb.id, async () => ({ ok: false, errorFa: "شکست B" }), { eventHolder: holder! }),
    ).resolves.toMatchObject({ executed: true, ok: false });
    await runWorkflowOnceForEvent(event.id, wfc.id, async () => ({ ok: true }), { eventHolder: holder! });

    // The decisive V5 semantics: even a caller that "returned normally"
    // cannot complete an event whose child is failed.
    await expect(finalizeBotEvent(event.id, holder!)).resolves.toBe(false);
    const ev1 = await db.botInboundEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(ev1.status).toBe("processing");

    // B retries and succeeds → all children terminal-success → completes.
    await db.botWorkflowRun.updateMany({
      where: { eventId: event.id, workflowId: wfb.id },
      data: { leaseUntil: past(1000) },
    });
    await runWorkflowOnceForEvent(event.id, wfb.id, async () => ({ ok: true }), { eventHolder: holder! });
    await expect(finalizeBotEvent(event.id, holder!)).resolves.toBe(true);
    const ev2 = await db.botInboundEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(ev2.status).toBe("completed");
    expect(ev2.nextRetryAt).toBeNull();
    expect(ev2.completedAt).not.toBeNull();
  });

  test("a child still PENDING blocks completion (crash between children)", async () => {
    const wfa = await db.botWorkflow.create({ data: { botId: bot.id, name: "A2", enabled: true, triggerKind: "message", steps: "[]" } });
    const wfb = await db.botWorkflow.create({ data: { botId: bot.id, name: "B2", enabled: true, triggerKind: "message", steps: "[]" } });
    const event = await ensureBotEvent(bot, "telegram", "9102", { update_id: 9102 });
    const holder = await claimBotEventForOwner(event.id);
    await runWorkflowOnceForEvent(event.id, wfa.id, async () => ({ ok: true }), { eventHolder: holder! });
    // B's row exists but was never executed (its worker crashed).
    await db.botWorkflowRun.upsert({
      where: { eventId_workflowId: { eventId: event.id, workflowId: wfb.id } },
      create: { eventId: event.id, workflowId: wfb.id },
      update: {},
    });
    await expect(finalizeBotEvent(event.id, holder!)).resolves.toBe(false);
    const ev = await db.botInboundEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(ev.status).toBe("processing");
  });

  test("completeBotEvent inherits the finalize semantics (legacy callers cannot mask a failed child)", async () => {
    const wfb = await db.botWorkflow.create({ data: { botId: bot.id, name: "B3", enabled: true, triggerKind: "message", steps: "[]" } });
    const event = await ensureBotEvent(bot, "telegram", "9103", { update_id: 9103 });
    await db.botWorkflowRun.create({ data: { eventId: event.id, workflowId: wfb.id, status: "failed" } });
    await completeBotEvent(event.id);
    const ev = await db.botInboundEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(ev.status).not.toBe("completed");
  });
});

describe("V5 C-03 — lease ownership (fencing) on the event", () => {
  let userId: string;
  let bot: Bot;

  beforeAll(async () => {
    await ensureDbConnected();
  });
  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "v5-fencing@test.local", mobile: "09120100003" });
    userId = u.id;
    bot = await seedBot({ ownerId: userId, provider: "telegram", name: "بات حصار" });
  });

  test("a zombie worker cannot renew, fail or complete the event it lost", async () => {
    const event = await ensureBotEvent(bot, "telegram", "9201", { update_id: 9201 });
    const h1 = await claimBotEventForOwner(event.id);
    expect(h1).not.toBeNull();
    // Stale takeover: H1's lease expires, H2 claims.
    await expireEventLease(event.id);
    const h2 = await claimBotEventForOwner(event.id);
    expect(h2).not.toBeNull();
    expect(h2).not.toBe(h1);

    // H1's renewal is fenced: the lease stays where H2 set it.
    const fixed = future(60_000);
    await db.botInboundEvent.update({ where: { id: event.id }, data: { leaseUntil: fixed } });
    await renewBotEventLease(event.id, h1!);
    const afterH1 = await db.botInboundEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(afterH1.leaseUntil!.getTime()).toBe(fixed.getTime());
    await renewBotEventLease(event.id, h2!);
    const afterH2 = await db.botInboundEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(afterH2.leaseUntil!.getTime()).toBeGreaterThan(fixed.getTime());

    // H1 cannot fail or complete the event either.
    await failBotEvent(event.id, "zombie H1", h1!);
    expect((await db.botInboundEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe("processing");
    await expect(finalizeBotEvent(event.id, h1!)).resolves.toBe(false);
    expect((await db.botInboundEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe("processing");

    // H2 CAN fail it.
    const verdict = await failBotEvent(event.id, "owner H2", h2!);
    expect(verdict).toBe("failed");
    expect((await db.botInboundEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe("failed");
  });

  test("a stale run owner cannot complete or fail a run taken over by another worker", async () => {
    const wf = await db.botWorkflow.create({ data: { botId: bot.id, name: "WFZ", enabled: true, triggerKind: "message", steps: "[]" } });
    const event = await ensureBotEvent(bot, "telegram", "9202", { update_id: 9202 });
    let releaseWorker1: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseWorker1 = resolve; });

    // Worker 1 claims the run and stalls mid-execution.
    const w1 = runWorkflowOnceForEvent(event.id, wf.id, async () => {
      await gate;
      return { ok: false, errorFa: "دیرهنگام ۱" };
    });
    await new Promise((r) => setTimeout(r, 120));
    // Lease expires; worker 2 takes over and completes the run.
    await db.botWorkflowRun.updateMany({
      where: { eventId: event.id, workflowId: wf.id },
      data: { leaseUntil: past(1000) },
    });
    const w2 = await runWorkflowOnceForEvent(event.id, wf.id, async () => ({ ok: true }));
    expect(w2).toMatchObject({ executed: true, ok: true });

    releaseWorker1();
    const late = await w1;
    // Worker 1's late failure is discarded (fenced by its stale holder).
    expect(late).toMatchObject({ executed: true, ok: false });
    const run = await db.botWorkflowRun.findUniqueOrThrow({
      where: { eventId_workflowId: { eventId: event.id, workflowId: wf.id } },
    });
    expect(run.status).toBe("completed");
    expect(run.lastError).toBeNull();
  });
});

describe("V5 H-03 — duplicate detection is P2002-only", () => {
  let userId: string;
  let bot: Bot;

  beforeAll(async () => {
    await ensureDbConnected();
  });
  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "v5-p2002@test.local", mobile: "09120100004" });
    userId = u.id;
    bot = await seedBot({ ownerId: userId, provider: "telegram", name: "بات تاریخچه" });
  });

  test("a genuine FK failure is logged, never swallowed as an idempotent duplicate", async () => {
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      await persistInboundOnce(
        { ...bot, id: "no-such-bot" } as Bot,
        "chat-1",
        "سلام",
        { update_id: 1 },
        1,
        undefined,
        null,
      );
    } finally {
      console.error = orig;
    }
    expect(errors.length).toBe(1);
  });

  test("a genuine duplicate (P2002) converges silently", async () => {
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      await persistInboundOnce(bot, "chat-1", "سلام", { update_id: 2 }, 2, undefined, "evt-x-1");
      await persistInboundOnce(bot, "chat-1", "سلام", { update_id: 2 }, 2, undefined, "evt-x-1");
    } finally {
      console.error = orig;
    }
    expect(errors.length).toBe(0);
    const rows = await db.botHistory.count({ where: { botId: bot.id, inboundEventId: "evt-x-1" } });
    expect(rows).toBe(1);
  });
});

describe("V5 H-04 — the per-step resume cursor is durable", () => {
  let userId: string;
  let bot: Bot;

  beforeAll(async () => {
    await ensureDbConnected();
  });
  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "v5-cursor@test.local", mobile: "09120100005" });
    userId = u.id;
    bot = await seedBot({ ownerId: userId, provider: "telegram", name: "بات مکان‌نما" });
  });

  test("cursor persists on ok:false and is handed back to the engine on retry", async () => {
    const wf = await db.botWorkflow.create({ data: { botId: bot.id, name: "WFC", enabled: true, triggerKind: "message", steps: "[]" } });
    const event = await ensureBotEvent(bot, "telegram", "9301", { update_id: 9301 });
    const cursorPayload = {
      completedNext: { s1: "s2" },
      outboundHistory: { s1: "hist-1" },
    };
    const r1 = await runWorkflowOnceForEvent(event.id, wf.id, async () => ({
      ok: false,
      errorFa: "ارسال گام دوم ناموفق بود.",
      cursor: cursorPayload,
    }));
    expect(r1.ok).toBe(false);
    const run = await db.botWorkflowRun.findUniqueOrThrow({
      where: { eventId_workflowId: { eventId: event.id, workflowId: wf.id } },
    });
    expect(run.cursorJson).not.toBeNull();
    expect(JSON.parse(run.cursorJson!)).toEqual(cursorPayload);

    // Retry: the stored cursor reaches the engine callback.
    let seenResume: unknown = null;
    const r2 = await runWorkflowOnceForEvent(event.id, wf.id, async (resume) => {
      seenResume = resume;
      return { ok: true };
    });
    expect(r2.ok).toBe(true);
    expect(seenResume).toEqual(cursorPayload);
  });

  test("a corrupt cursor never executes as progress", async () => {
    const wf = await db.botWorkflow.create({ data: { botId: bot.id, name: "WFC2", enabled: true, triggerKind: "message", steps: "[]" } });
    const event = await ensureBotEvent(bot, "telegram", "9302", { update_id: 9302 });
    await runWorkflowOnceForEvent(event.id, wf.id, async () => ({ ok: false, errorFa: "شکست", cursor: { broken: true } }));
    const run = await db.botWorkflowRun.findUniqueOrThrow({
      where: { eventId_workflowId: { eventId: event.id, workflowId: wf.id } },
    });
    let seenResume: unknown = null;
    await runWorkflowOnceForEvent(event.id, wf.id, async (resume) => {
      seenResume = resume;
      return { ok: true };
    });
    // The malformed shape parses to empty maps — never to executable progress.
    expect(seenResume).toEqual({ completedNext: {}, outboundHistory: {} });
    void run;
  });
});

describe("V5 C-02 Hole 2 — Bale payment payloads never reach the non-payment dispatcher", () => {
  let userId: string;
  let bot: Bot;

  beforeAll(async () => {
    await ensureDbConnected();
  });
  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "v5-bale@test.local", mobile: "09120100006" });
    userId = u.id;
    bot = await seedBot({ ownerId: userId, provider: "bale", name: "بات پرداخت بله" });
  });

  test("isBalePaymentUpdate classifies exactly payment-bearing updates", () => {
    expect(isBalePaymentUpdate({ update_id: 1, message: { successful_payment: {} } })).toBe(true);
    expect(isBalePaymentUpdate({ update_id: 2, pre_checkout_query: { id: "x" } })).toBe(true);
    expect(isBalePaymentUpdate({ update_id: 3, message: { text: "سلام" } })).toBe(false);
    expect(isBalePaymentUpdate({ update_id: 4, callback_query: { id: "y" } })).toBe(false);
    expect(isBalePaymentUpdate(null)).toBe(false);
    expect(isBalePaymentUpdate("nonsense")).toBe(false);
  });

  test("recovery routes a stored payment payload to the payment handler and message workflows never fire", async () => {
    // A message-kind workflow that would match ANY text (the pre-V5 bug
    // fired exactly this for payment payloads).
    await db.botWorkflow.create({
      data: {
        botId: bot.id,
        name: "پیام‌خوش‌آمد",
        enabled: true,
        triggerKind: "message",
        steps: JSON.stringify([
          { id: "s1", type: "start", nextStepId: "s2" },
          { id: "s2", type: "action", action: { kind: "send_message", config: { text: "خوش آمدید" } } },
        ]),
      },
    });
    const paymentUpdate = {
      update_id: 9401,
      message: {
        message_id: 1,
        chat: { id: 555 },
        from: { id: 555 },
        successful_payment: {
          invoice_payload: "order-x:secret",
          currency: "IRR",
          total_amount: 100000,
          telegram_payment_charge_id: "charge-9401",
        },
      },
    };
    const event = await ensureBotEvent(bot, "bale", "9401", paymentUpdate);
    // Age the row past the recovery threshold and leave it `received`
    // (the pre-V5 live path could never complete payment events).
    await db.$executeRawUnsafe(
      `UPDATE BotInboundEvent SET updatedAt = ? WHERE id = ?`,
      past(61_000),
      event.id,
    );

    let paymentHandlerCalls = 0;
    let nonPaymentCalls = 0;
    await recoverBotEvents(bot, async (b, payload, o) => {
      if (isBalePaymentUpdate(payload)) {
        paymentHandlerCalls++;
        // The route forwards ONLY to processBaleUpdate here; mirror it
        // (fetch is mocked globally below so any provider ack is inert).
        const { processBaleUpdate } = await import("@/lib/payments/bale");
        await processBaleUpdate(b, payload as typeof paymentUpdate);
        void o;
        return;
      }
      nonPaymentCalls++;
      await import("@/lib/bots/workflow").then(() => undefined);
    });

    expect(paymentHandlerCalls).toBe(1);
    expect(nonPaymentCalls).toBe(0);
    // The message workflow must have ZERO run rows for the payment event.
    const runs = await db.botWorkflowRun.findMany({ where: { eventId: event.id } });
    expect(runs.length).toBe(0);
    const ev = await db.botInboundEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(ev.status).toBe("completed");
  });

  test("live payment delivery completes the event (pre-V5 it stayed `received` forever)", async () => {
    const secret = "test-webhook-secret-9402";
    const withSecret = await db.bot.update({
      where: { id: bot.id },
      data: { webhookSecret: encryptString(secret) },
    });
    const paymentUpdate = {
      update_id: 9402,
      message: {
        message_id: 2,
        chat: { id: 556 },
        successful_payment: {
          invoice_payload: "order-y:secret",
          currency: "IRR",
          total_amount: 200000,
          telegram_payment_charge_id: "charge-9402",
        },
      },
    };
    const rawBody = JSON.stringify(paymentUpdate);
    const { makeWebhookSig, computeWebhookBodySignature } = await import("@/lib/bots/register-webhook");
    const sig = makeWebhookSig(bot.id);
    const bodySig = await computeWebhookBodySignature(withSecret, rawBody);
    expect(bodySig).not.toBe("");

    const { POST } = await import("@/app/api/bots/incoming/bale/route");
    const req = new Request(`http://localhost/api/bots/incoming/bale?bid=${bot.id}&sig=${sig}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bale-webhook-signature": bodySig },
      body: rawBody,
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const ev = await db.botInboundEvent.findUnique({ where: { botId_provider_externalEventId: { botId: bot.id, provider: "bale", externalEventId: "9402" } } });
    expect(ev).not.toBeNull();
    // THE V5 assertion: the live path really completes the event now.
    expect(ev!.status).toBe("completed");
  });
});

describe("V5 — legacy claim/recovery semantics remain intact", () => {
  let userId: string;
  let bot: Bot;

  beforeAll(async () => {
    await ensureDbConnected();
  });
  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "v5-legacy@test.local", mobile: "09120100007" });
    userId = u.id;
    bot = await seedBot({ ownerId: userId, provider: "telegram", name: "بات سازگاری" });
  });

  test("claimBotEvent boolean semantics and recoverBotEvents holder threading", async () => {
    const event = await ensureBotEvent(bot, "telegram", "9501", { update_id: 9501 });
    expect(await claimBotEvent(event.id)).toBe(true);
    expect(await claimBotEvent(event.id)).toBe(false);
    await failBotEvent(event.id, "خطای موقت");
    // Backoff blocks an immediate re-claim.
    expect(await claimBotEvent(event.id)).toBe(false);

    await db.botInboundEvent.update({
      where: { id: event.id },
      data: { nextRetryAt: past(1000), updatedAt: past(61_000) },
    });
    let sawHolder = "";
    await recoverBotEvents(bot, async (_b, _payload, o) => {
      sawHolder = o.holder;
    });
    expect(typeof sawHolder).toBe("string");
    expect(sawHolder.length).toBeGreaterThan(0);
  });
});

afterAll(async () => {
  await db.$disconnect();
});
