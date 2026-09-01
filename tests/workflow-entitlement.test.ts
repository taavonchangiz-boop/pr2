// =====================================================================
// POSTYAR — C-11/12/13/14 regression: workflow dedup ownership + runtime
// entitlement enforcement
// ---------------------------------------------------------------------
// C-11/12: ONE inbound event → EVERY intended workflow executes exactly
// once. The pre-fix engine kept a second update-level dedup layer inside
// executeWorkflow whose flag (set by the FIRST workflow) suppressed every
// subsequent workflow matching the same event.
//
// C-13/14: premium-only workflow actions are gated at EXECUTION time
// against the bot OWNER's CURRENT plan — a workflow created under a
// premium plan must stop invoking gated capabilities after downgrade.
//
// Outbound provider calls are exercised with a dummy ciphertext (the
// token cannot be decrypted, so sends fail closed without any network).
// =====================================================================
import { test, expect, describe, beforeAll, beforeEach } from "bun:test";
import { db } from "../src/lib/db";
import { resetDb, seedUser, seedBot, ensureDbConnected } from "./_db-helpers";
import { executeWorkflow, persistInboundOnce, validateWorkflowDef } from "../src/lib/bots/workflow";
import { encryptString } from "../src/lib/security/crypto";
import type { Bot } from "@prisma/client";

async function seedWorkflow(botId: string, name: string): Promise<{ id: string }> {
  const def = {
    steps: [
      { id: "s1", type: "start" as const, nextStepId: "s2" },
      { id: "s2", type: "end" as const },
    ],
  };
  const wf = await db.botWorkflow.create({
    data: { botId, name, enabled: true, steps: JSON.stringify(def.steps), triggerKind: "message" },
  });
  return { id: wf.id };
}

function ctxFor(bot: Bot, workflowId: string, updateId: number) {
  // The workflow row is loaded by the caller in the real flow.
  return db.botWorkflow.findUnique({ where: { id: workflowId } }).then((wf) => {
    if (!wf) throw new Error("workflow missing");
    return executeWorkflow({
      bot,
      providerUserId: "tg-900",
      rawUpdate: { update_id: updateId, message: { text: "سلام" } },
      incomingMessage: "سلام",
      updateId,
      workflow: wf,
    });
  });
}

describe("C-13/14 — execution-time entitlement gates", () => {
  let owner: { id: string };
  let bot: Bot;

  beforeAll(async () => { await ensureDbConnected(); });

  beforeEach(async () => {
    await resetDb();
    owner = await seedUser({ email: "wf-owner@test.local", mobile: "09120000901" });
    const b = await seedBot({ ownerId: owner.id });
    // Real (self-consistent) ciphertext so decryption succeeds; sends still
    // fail closed at the provider layer with no network in tests.
    await db.bot.update({
      where: { id: b.id },
      data: { botTokenEnc: encryptString("123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAA") },
    });
    bot = (await db.bot.findUnique({ where: { id: b.id } })) as Bot;
  });

  test("owner WITHOUT goldMonitor: show_gold action is blocked at execution + audited", async () => {
    // Free-plan owner (no goldMonitor). Give the bot a workflow with show_gold.
    const wf = await db.botWorkflow.create({
      data: {
        botId: bot.id,
        name: "gold",
        enabled: true,
        triggerKind: "message",
        steps: JSON.stringify([
          { id: "s1", type: "start", nextStepId: "s2" },
          { id: "s2", type: "action", action: { kind: "show_gold", config: { instrument: "18k" } } },
          { id: "s3", type: "end" },
        ]),
      },
    });
    const r = await ctxFor(bot, wf.id, 1001);
    expect(r.ok).toBe(true);
    expect(r.matched).toBe(true);
    const audits = await db.auditLog.findMany({
      where: { action: "bot_workflow_action_entitlement_blocked" },
    });
    expect(audits.length).toBe(1);
    expect(audits[0]?.targetId).toBe(wf.id);
  });

  test("owner WITH goldMonitor: show_gold executes (no entitlement audit)", async () => {
    // Provision a plan with goldMonitor and an active subscription.
    const plan = await db.plan.create({
      data: {
        code: "gold-plan",
        nameFa: "طلا",
        priceRials: 1_000_000,
        intervalMonths: 1,
        quota: "{}",
        features: JSON.stringify({ publish: true, goldMonitor: true }),
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
    const wf = await db.botWorkflow.create({
      data: {
        botId: bot.id,
        name: "gold2",
        enabled: true,
        triggerKind: "message",
        steps: JSON.stringify([
          { id: "s1", type: "start", nextStepId: "s2" },
          { id: "s2", type: "action", action: { kind: "show_gold", config: { instrument: "18k" } } },
          { id: "s3", type: "end" },
        ]),
      },
    });
    await ctxFor(bot, wf.id, 1002);
    const audits = await db.auditLog.findMany({
      where: { action: "bot_workflow_action_entitlement_blocked" },
    });
    expect(audits.length).toBe(0);
  });

  test("downgrade: a premium workflow stops invoking gated actions after the subscription expires", async () => {
    const plan = await db.plan.create({
      data: {
        code: "gold-exp",
        nameFa: "طلا منقضی",
        priceRials: 1_000_000,
        intervalMonths: 1,
        quota: "{}",
        features: JSON.stringify({ publish: true, goldMonitor: true }),
        isPublic: true,
        active: true,
      },
    });
    await db.subscription.create({
      data: {
        userId: owner.id,
        planId: plan.id,
        status: "active",
        endsAt: new Date(Date.now() - 1000), // EXPIRED
        usedQuota: "{}",
        activeKey: `${owner.id}:${plan.id}`,
      },
    });
    const wf = await db.botWorkflow.create({
      data: {
        botId: bot.id,
        name: "gold3",
        enabled: true,
        triggerKind: "message",
        steps: JSON.stringify([
          { id: "s1", type: "start", nextStepId: "s2" },
          { id: "s2", type: "action", action: { kind: "show_gold", config: {} } },
        ]),
      },
    });
    await ctxFor(bot, wf.id, 1003);
    const audits = await db.auditLog.findMany({
      where: { action: "bot_workflow_action_entitlement_blocked" },
    });
    expect(audits.length).toBe(1); // expired premium must NOT keep executing
  });
});

describe("C-11/12 — one event, every intended workflow executes exactly once", () => {
  let owner: { id: string };
  let bot: Bot;

  beforeAll(async () => { await ensureDbConnected(); });

  beforeEach(async () => {
    await resetDb();
    owner = await seedUser({ email: "wf-dedup@test.local", mobile: "09120000902" });
    const b = await seedBot({ ownerId: owner.id });
    await db.bot.update({
      where: { id: b.id },
      data: { botTokenEnc: "dummy-ciphertext-not-real" }, // undecryptable → sends fail closed
    });
    bot = (await db.bot.findUnique({ where: { id: b.id } })) as Bot;
  });

  test("two workflows matching ONE event both execute (no self-suppression)", async () => {
    const wf1 = await seedWorkflow(bot.id, "one");
    const wf2 = await seedWorkflow(bot.id, "two");
    const r1 = await ctxFor(bot, wf1.id, 2001);
    const r2 = await ctxFor(bot, wf2.id, 2001); // SAME update id
    expect(r1.matched).toBe(true);
    expect(r2.matched).toBe(true); // pre-fix: suppressed by the first workflow's flag
  });

  test("duplicate event delivery after execution is collapsed by the webhook layer (claim), not by the engine", async () => {
    const { claimUpdateOnce } = await import("../src/lib/bots/webhook-guard");
    const first = await claimUpdateOnce(bot.id, bot.provider, "3001");
    const second = await claimUpdateOnce(bot.id, bot.provider, "3001");
    expect(first).toBe(true);
    expect(second).toBe(false); // the single dedup owner drops the duplicate
    // The engine itself no longer maintains an update-level flag: the same
    // event can still drive a second intended workflow.
    const wf1 = await seedWorkflow(bot.id, "a");
    const wf2 = await seedWorkflow(bot.id, "b");
    const r1 = await ctxFor(bot, wf1.id, 3001);
    const r2 = await ctxFor(bot, wf2.id, 3001);
    expect(r1.matched).toBe(true);
    expect(r2.matched).toBe(true);
  });

  test("inbound history is persisted ONCE per event via persistInboundOnce", async () => {
    const wf1 = await seedWorkflow(bot.id, "x");
    const wf2 = await seedWorkflow(bot.id, "y");
    await persistInboundOnce(bot, "tg-901", "سلام", { update_id: 4001 }, 4001);
    await ctxFor(bot, wf1.id, 4001);
    await ctxFor(bot, wf2.id, 4001);
    const inbound = await db.botHistory.findMany({
      where: { botId: bot.id, direction: "inbound", providerUserId: "tg-901" },
    });
    expect(inbound.length).toBe(1); // pre-fix: one row PER matched workflow
  });

  test("workflow graph validation still rejects malformed defs (regression guard)", () => {
    expect(validateWorkflowDef([{ id: "s1", type: "start", nextStepId: "nope" }]).ok).toBe(false);
    expect(validateWorkflowDef([]).ok).toBe(false);
  });
});
