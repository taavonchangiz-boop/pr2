// =====================================================================
// POSTYAR — Bot Workflow Engine
// ---------------------------------------------------------------------
// A Workflow is a JSON-serialized array of typed Steps persisted on
// BotWorkflow.steps. The engine walks steps starting from the first
// `start` step, evaluates conditions against the current user state
// (linked POSTYAR user, subscription, wallet, referral), and performs
// actions (send_message, show_menu, create_ticket, show_subscription,
// show_wallet, initiate_payment, show_gold, invoke_ai, show_order,
// send_content, create_notification).
//
// Hardening:
//   - Idempotent on incoming update_id (Telegram/Bale) or provider
//     message id (Rubika) via cache 24h + BotHistory.raw JSON-embedded
//     `update_id` for forensic recovery.
//   - Respects plan quota (requireQuota for aiPerMonth, automation).
//   - Loop protection on invoke_ai (no recursion beyond 1 step).
//   - All user-facing strings Persian.
//   - Tokens NEVER logged; raw payloads sanitized before persistence.
//
// This file is the canonical workflow interpreter. The webhook
// handlers in src/app/api/bots/incoming/* call `executeWorkflow` after
// authenticating the inbound request.
// =====================================================================
import { db } from "@/lib/db";
import { cache, rateLimit } from "@/lib/security/cache";
import { decryptString, hashToken } from "@/lib/security/crypto";
import { audit, safeJsonParse, AuthError } from "@/lib/server/auth";
import { sanitizeRaw } from "@/lib/providers/util";
import { getDestinationProvider, isValidProviderName } from "@/lib/providers";
import type { GlassButton } from "@/lib/types/glass-button";
import { formatRials, toPersianDigits, formatJalaliDateTime } from "@/lib/persian";
import { getActiveSubscription, getQuotaState, createOrderForSubscription, getEffectiveFeatures, getFeatureBoolean, type PlanBooleanFeatureKey } from "@/lib/payments/plans";
import { getBalance } from "@/lib/payments/wallet";
import { processBaleUpdate, baleCreatePaymentRequest } from "@/lib/payments/bale";
import { dispatchAi } from "@/lib/ai/dispatch";
import type { WorkflowResumeContext } from "@/lib/bots/event-dedup";
import { notify, type NotificationCategory } from "@/lib/notifications";
import { createTicket, type TicketCategory, type TicketPriority } from "@/lib/tickets";
import { getGoldPrice, type GoldInstrument } from "@/lib/providers/gold";
import { AI_PROVIDER_IDS } from "@/lib/providers/ai";
import type { Bot, BotWorkflow } from "@prisma/client";

// ---------------------------------------------------------------------
// Workflow step schema (typed; serialized as JSON in DB)
// ---------------------------------------------------------------------
export type WorkflowStepType = "start" | "message" | "condition" | "action" | "end";

export type ConditionKind =
  | "subscription_active"
  | "plan"
  | "referral"
  | "keyword"
  | "order_status"
  | "provider_context"
  | "user_state";

export type ActionKind =
  | "send_message"
  | "show_menu"
  | "create_ticket"
  | "show_subscription"
  | "show_wallet"
  | "initiate_payment"
  | "show_gold"
  | "invoke_ai"
  | "show_order"
  | "send_content"
  | "create_notification";

export interface WorkflowCondition {
  kind: ConditionKind;
  /** Semantic value: keyword text, plan code, state key, etc. */
  value?: string;
  /** Branch target step id when condition is TRUE. */
  thenStepId?: string;
  /** Branch target step id when condition is FALSE. */
  elseStepId?: string;
}

export interface WorkflowAction {
  kind: ActionKind;
  /** Free-form config: message text, menu buttons, AI prompt, etc. */
  config?: Record<string, unknown>;
  /** Next step to walk to after this action completes. */
  nextStepId?: string;
}

export interface WorkflowStep {
  id: string;
  type: WorkflowStepType;
  /** For type="message": the text to send outbound. */
  text?: string;
  /** For type="condition": */
  condition?: WorkflowCondition;
  /** For type="action": */
  action?: WorkflowAction;
  /** Default next step (linear flows). */
  nextStepId?: string;
  config?: Record<string, unknown>;
}

export interface WorkflowDef {
  steps: WorkflowStep[];
}

// ---------------------------------------------------------------------
// Execution context
// ---------------------------------------------------------------------
export interface WorkflowContext {
  /** Bot triggering this execution. */
  bot: Bot;
  /** Provider-specific user id of the sender (chat id). */
  providerUserId: string;
  /** The full inbound update object (raw, sanitized before persist). */
  rawUpdate?: unknown;
  /** Optional inbound text (message or callback_query.data). */
  incomingMessage?: string;
  /** Optional inbound callback_query id (for answer). */
  callbackQueryId?: string;
  /** Telegram/Bale update_id (idempotency key); Rubika uses providerMessageId. */
  updateId?: string | number;
  /** Provider message id (Rubika). */
  providerMessageId?: string | number;
  /** Workflow to execute (loaded by caller). */
  workflow: BotWorkflow;
}

export interface WorkflowResult {
  ok: boolean;
  /** true if a workflow actually matched and produced output. */
  matched: boolean;
  /** Outbound messages persisted (count). */
  outboundCount: number;
  errorFa?: string;
  /** V5 H-04 — per-step resume cursor (persisted by the run layer on
   *  failure so a retry resumes from the interrupted step). */
  cursor?: WorkflowResumeCursor;
}

/** V5 H-04 — durable per-step progress (stored on BotWorkflowRun). */
export interface WorkflowResumeCursor {
  /** stepId → next step id chosen on the previous attempt. */
  completedNext: Record<string, string>;
  /** stepId → durable outbound history id recorded on a previous attempt. */
  outboundHistory: Record<string, string>;
}

// ---------------------------------------------------------------------
// Linked user lookup
// ---------------------------------------------------------------------
export async function findLinkedUser(botId: string, providerUserId: string): Promise<{ id: string } | null> {
  // Find a consumed link code for this bot + providerUserId; that's
  // the linked POSTYAR user.
  const link = await db.botLinkCode.findFirst({
    where: {
      botId,
      consumedByProviderUserId: providerUserId,
      consumedAt: { not: null },
    },
    orderBy: { consumedAt: "desc" },
    select: { userId: true },
  });
  if (!link || !link.userId) return null;
  return { id: link.userId };
}

// ---------------------------------------------------------------------
// C-11/C-12 — DEDUPLICATION OWNERSHIP
// ---------------------------------------------------------------------
// The inbound-update deduplication has exactly ONE authoritative owner:
// the DURABLE DB inbox in src/lib/bots/event-dedup.ts —
// BotInboundEvent (UNIQUE bot+provider+externalEventId, lease,
// received→processing→completed/failed/dead) + per-workflow
// BotWorkflowRun (UNIQUE eventId+workflowId). It replaced the volatile
// cache-INCR claim, which was at-most-once: a crash after the claim
// permanently suppressed the provider's retry, and without REDIS_URL
// it degraded to a per-process Map. Payment-bearing Bale events keep
// their dedicated durable path (BalePaymentRef UNIQUE constraints).
//
// executeWorkflow() deliberately performs NO update-level dedup of its
// own. The previous second layer (cache get-then-set on the same update
// key) suppressed every workflow AFTER the first one matched the same
// event — one event with multiple intended workflows executed only the
// first (self-suppression), the exact C-11/C-12 defect. With the single
// durable owner the required semantics hold:
//
//   one inbound event → EACH intended workflow executes exactly once
//   (across crashes/retries), and a failed workflow never suppresses
//   its siblings.
//
// Side-effecting actions keep their own deterministic idempotency keys
// (AI: AiJob.idempotencyKey UNIQUE; payments: Order.idempotencyKey), so
// action-level replays converge even across process crashes.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// C-13/C-14 — EXECUTION-TIME ENTITLEMENT GATE (single reusable boundary)
// ---------------------------------------------------------------------
// A workflow created under a premium plan must not keep invoking
// premium-only capabilities after the owner's plan downgrades/expires.
// Gating at creation/UI time is NOT authorization — the gate below is
// evaluated at every execution, against the bot OWNER's CURRENT
// effective plan.
// ---------------------------------------------------------------------
const ACTION_FEATURE_GATE: Partial<Record<ActionKind, PlanBooleanFeatureKey>> = {
  create_ticket: "tickets",
  show_gold: "goldMonitor",
  invoke_ai: "smartReply",
};

// M-07 — validation-time allowlists for action configs (kept in sync
// with the runtime casts; unknown values are rejected at save time
// instead of blowing up or misbehaving at execution time).
const TICKET_CATEGORIES: readonly TicketCategory[] = [
  "general", "billing", "technical", "ai", "gold", "woo", "bot", "security",
];
const TICKET_PRIORITIES: readonly TicketPriority[] = ["low", "normal", "high", "urgent"];
// V6 C-15 — create_notification.category is persisted raw by notify();
// it must be validated against the NotificationCategory union at SAVE
// time (the runtime cast at the performAction site is not validation).
const NOTIFICATION_CATEGORIES: readonly string[] = [
  "publish", "payment", "subscription", "referral", "ad", "ticket",
  "gold", "woo", "security", "system",
];
const GOLD_INSTRUMENTS: readonly GoldInstrument[] = ["18k", "emami", "bahar_azadi", "ounce"];

async function assertActionEntitlement(
  ownerId: string,
  action: ActionKind,
  workflowId: string,
  linkedUserId: string | null,
): Promise<{ allowed: boolean; errorFa?: string }> {
  const gate = ACTION_FEATURE_GATE[action];
  if (!gate) return { allowed: true };
  const features = await getEffectiveFeatures(ownerId);
  if (getFeatureBoolean(features, gate, false)) return { allowed: true };
  await audit({
    userId: linkedUserId,
    actor: "system",
    action: "bot_workflow_action_entitlement_blocked",
    targetType: "bot_workflow",
    targetId: workflowId,
    meta: { actionKind: action, feature: gate },
  });
  return { allowed: false, errorFa: "امکان مربوط به این عملیات در پلن فعلی مالک ربات فعال نیست." };
}

// ---------------------------------------------------------------------
// Sanitization for BotHistory.raw — embeds update_id for forensic recovery
// ---------------------------------------------------------------------
function sanitizeForHistory(raw: unknown, ctx: WorkflowContext): string {
  const sanitized = sanitizeRaw(raw);
  const out: Record<string, unknown> =
    sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
      ? { ...(sanitized as Record<string, unknown>) }
      : { _payload: sanitized };
  if (ctx.updateId !== undefined) out._update_id = String(ctx.updateId);
  if (ctx.providerMessageId !== undefined) out._provider_msg_id = String(ctx.providerMessageId);
  const s = JSON.stringify(out);
  if (s.length > 8000) return s.slice(0, 8000) + "...[truncated]";
  return s;
}

/**
 * Persist the inbound history row for an event — ONCE per event, from the
 * webhook layer (not per workflow). Workflows no longer persist inbound
 * rows themselves (C-11/C-12: an event matched by N workflows previously
 * produced N duplicate inbound history rows).
 *
 * V4 H-04 — the row is tied to the durable event identity via
 * BotHistory.inboundEventId (UNIQUE): the insert is truly idempotent at
 * the DATABASE level. Duplicate deliveries, durable retries and
 * concurrent workers all converge on ONE row; a retry after a
 * crash-before-persist heals the missing row. Callers therefore invoke
 * this on EVERY delivery (no isRetry skip). Failures other than the
 * idempotent-duplicate case are logged, never silently swallowed —
 * BotHistory is forensic observability and must not fail the event.
 */
export async function persistInboundOnce(
  bot: Bot,
  providerUserId: string,
  text: string,
  rawUpdate: unknown,
  updateId?: string | number,
  providerMessageId?: string | number,
  inboundEventId?: string | null,
): Promise<void> {
  try {
    await db.botHistory.create({
      data: {
        botId: bot.id,
        direction: "inbound",
        providerUserId,
        text: (text ?? "").slice(0, 4000),
        raw: sanitizeForHistory(rawUpdate, { bot, providerUserId, rawUpdate, workflow: {} as BotWorkflow, updateId, providerMessageId } as WorkflowContext),
        inboundEventId: inboundEventId ?? null,
      },
    });
  } catch (err) {
    // V5 H-03 — convergence is decided by the DATABASE constraint code,
    // not by a message regex: P2002 (unique violation) is the durable
    // duplicate — every OTHER failure (e.g. P2003 FK: the bot was deleted
    // mid-flight) is a genuine persistence failure and must stay visible,
    // never swallowed as an "idempotent duplicate".
    if ((err as { code?: string })?.code === "P2002") {
      return;
    }
    // Never fail the event on observability persistence — but never hide
    // the failure either.
    console.error("bot history persist failed:", err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------
// V5 H-04 — DURABLE OUTBOUND DELIVERY STATE MACHINE
// ---------------------------------------------------------------------
// Every outbound message is recorded in BotHistory BEFORE the provider
// call as `pending`, then converged to exactly one terminal state:
//   * `sent`      — provider confirmed (providerMessageId preserved);
//   * `failed`    — provider DEFINITIVELY refused (HTTP 4xx / invalid
//                   token / invalid provider) — a retry is safe;
//   * `uncertain` — the outcome is UNKNOWN (timeout/abort/network, HTTP
//                   5xx, or a crash before the post-send update) — the
//                   message may or may not exist at the provider, so it
//                   is NEVER blindly re-sent (duplicate risk).
// A crash between a successful send and the post-send update leaves the
// row `pending` — auditable evidence of a possibly-delivered message
// instead of the previous silently-lost history row (write-after-send
// inside `catch {}`).
//
// Cross-attempt recovery (workflow retries) resolves a step's durable
// fate through TWO channels:
//   1. the run cursor (resume.outboundHistory[stepId] → history row id)
//      — the authoritative channel, persisted by the run layer;
//   2. a run-scoped DB lookup fallback for steps that have NO cursor
//      entry (a definitely-failed send, or a crash that never persisted
//      a cursor): the latest pending/uncertain/failed outbound row for
//      (bot, workflow, step, chat) created at or after THIS run's
//      creation. Rows created by OTHER runs/events are never adopted
//      (their `sent` rows especially — a new event must re-send).
// ---------------------------------------------------------------------

/** Resolve the creation time of the durable run row backing this
 *  execution (via the durable event identity). Returns null for direct
 *  callers without a durable event/run — the fallback channel is then
 *  simply inactive. */
async function resolveRunStart(ctx: WorkflowContext): Promise<Date | null> {
  const externalId =
    ctx.updateId !== undefined ? String(ctx.updateId)
    : ctx.providerMessageId !== undefined ? String(ctx.providerMessageId)
    : null;
  if (!externalId || !isValidProviderName(ctx.bot.provider)) return null;
  const event = await db.botInboundEvent.findUnique({
    where: {
      botId_provider_externalEventId: {
        botId: ctx.bot.id,
        provider: ctx.bot.provider,
        externalEventId: externalId,
      },
    },
    select: { id: true },
  });
  if (!event) return null;
  const run = await db.botWorkflowRun.findUnique({
    where: { eventId_workflowId: { eventId: event.id, workflowId: ctx.workflow.id } },
    select: { createdAt: true },
  });
  return run?.createdAt ?? null;
}

async function sendViaProvider(
  bot: Bot,
  chatId: string,
  text: string,
  buttons?: GlassButton[],
): Promise<{ ok: boolean; ambiguous?: boolean; providerMessageId?: string; errorFa?: string }> {
  if (!isValidProviderName(bot.provider)) {
    // Definitive: nothing was sent and no retry can fix a bad provider.
    return { ok: false, ambiguous: false, errorFa: "پروایدر ربات نامعتبر است." };
  }
  let botToken = "";
  try { botToken = decryptString(bot.botTokenEnc); } catch {
    // Definitive: an undecryptable token can never send.
    return { ok: false, ambiguous: false, errorFa: "توکن ربات قابل رمزگشایی نیست." };
  }
  const provider = getDestinationProvider(bot.provider);
  const r = await provider.publishMessage({ botToken, chatId, text, buttons });
  if (!r.ok) {
    return { ok: false, ambiguous: r.ambiguous === true, errorFa: r.errorFa, providerMessageId: r.providerMessageId };
  }
  return { ok: true, providerMessageId: r.providerMessageId };
}

export interface TrackedSendArgs {
  workflowId: string;
  stepId: string;
  text: string;
  buttons?: GlassButton[];
  /** History row id recorded in the run cursor for this step (resume). */
  priorHistoryId?: string;
}

export interface TrackedSendResult {
  /** false ONLY on a DEFINITIVE failure (safe to re-send). */
  ok: boolean;
  /** true = no provider call was made (prior row already sent/uncertain). */
  skipped?: boolean;
  /** true = delivery outcome unknown (never re-sent automatically). */
  uncertain?: boolean;
  /** The durable BotHistory row id tracking this send. */
  historyId?: string;
  providerMessageId?: string;
  errorFa?: string;
}

/**
 * Send an outbound workflow message with durable delivery tracking.
 * Used by the engine for message steps, action outbounds and the
 * entitlement-refusal reply. See the state-machine note above.
 */
async function sendOutboundTracked(
  ctx: WorkflowContext,
  userId: string | null,
  args: TrackedSendArgs,
  getRunStart: () => Promise<Date | null>,
): Promise<TrackedSendResult> {
  const botId = ctx.bot.id;

  // --- 1. Resolve the step's prior durable row (cross-attempt channel).
  let prior: { id: string; deliveryStatus: string | null } | null = null;
  if (args.priorHistoryId) {
    const row = await db.botHistory.findUnique({ where: { id: args.priorHistoryId } });
    // Never adopt a foreign row (different bot/workflow/direction).
    if (row && row.botId === botId && row.direction === "outbound" && row.workflowId === args.workflowId) {
      prior = { id: row.id, deliveryStatus: row.deliveryStatus };
    }
  }
  if (!prior) {
    // Crash-recovery fallback: a step WITHOUT a cursor entry may still
    // have a durable row from an earlier attempt of THIS run (crash
    // before the cursor was persisted, or a definitely-failed send).
    const runStart = await getRunStart();
    if (runStart) {
      const row = await db.botHistory.findFirst({
        where: {
          botId,
          workflowId: args.workflowId,
          stepId: args.stepId,
          direction: "outbound",
          providerUserId: ctx.providerUserId,
          // "sent" rows from THIS run count too: a crash that lost the
          // cursor must never turn into a duplicate send of a step this
          // run already delivered (V5 H-04).
          deliveryStatus: { in: ["pending", "uncertain", "failed", "sent"] },
          createdAt: { gte: runStart },
        },
        orderBy: { createdAt: "desc" },
      });
      if (row) prior = { id: row.id, deliveryStatus: row.deliveryStatus };
    }
  }

  // --- 2. Prior-driven decisions (no duplicate sends, ever).
  if (prior && prior.deliveryStatus === "sent") {
    // Already delivered on an earlier attempt — do NOT re-send.
    return { ok: true, skipped: true, historyId: prior.id };
  }
  if (prior && (prior.deliveryStatus === "pending" || prior.deliveryStatus === "uncertain")) {
    // Delivery UNKNOWN — never replay (duplicate risk). Converge the row
    // on `uncertain` and audit the uncertainty ONCE (on the transition).
    if (prior.deliveryStatus !== "uncertain") {
      await db.botHistory.update({ where: { id: prior.id }, data: { deliveryStatus: "uncertain" } });
      await audit({
        userId,
        actor: "system",
        action: "bot_workflow_send_uncertain",
        targetType: "bot",
        targetId: botId,
        meta: { workflowId: args.workflowId, stepId: args.stepId, historyId: prior.id, reason: "unknown_delivery_state" },
      });
    }
    return { ok: true, skipped: true, uncertain: true, historyId: prior.id };
  }

  // --- 3. Durable pre-write: the pending row exists BEFORE the send, so
  // a crash after a successful provider call leaves an auditable record.
  const text = (args.text ?? "").slice(0, 4000);
  let historyId: string;
  if (prior && prior.deliveryStatus === "failed") {
    // Definitive failure on an earlier attempt — re-send is safe. Re-arm
    // the SAME row to pending and drive it through the machine again.
    await db.botHistory.update({ where: { id: prior.id }, data: { deliveryStatus: "pending" } });
    historyId = prior.id;
  } else {
    const row = await db.botHistory.create({
      data: {
        botId,
        userId: userId ?? null,
        direction: "outbound",
        providerUserId: ctx.providerUserId,
        text,
        workflowId: args.workflowId,
        stepId: args.stepId,
        deliveryStatus: "pending",
      },
    });
    historyId = row.id;
  }

  // --- 4. Send + converge the row to its terminal state.
  const send = await sendViaProvider(ctx.bot, ctx.providerUserId, args.text, args.buttons);
  if (send.ok) {
    await db.botHistory.update({
      where: { id: historyId },
      data: { deliveryStatus: "sent", providerMessageId: send.providerMessageId ?? null },
    });
    return { ok: true, historyId, providerMessageId: send.providerMessageId };
  }
  if (send.ambiguous) {
    // UNKNOWN outcome — record `uncertain`; the RUN must not fail for it
    // (a retry could duplicate a delivered message).
    await db.botHistory.update({ where: { id: historyId }, data: { deliveryStatus: "uncertain" } });
    await audit({
      userId,
      actor: "system",
      action: "bot_workflow_send_uncertain",
      targetType: "bot",
      targetId: botId,
      meta: { workflowId: args.workflowId, stepId: args.stepId, historyId, reason: "ambiguous_provider_result", errorFa: send.errorFa },
    });
    return { ok: true, uncertain: true, historyId };
  }
  // Definitive refusal — record `failed`; the engine treats this as a
  // step failure so the run stays retryable (V5 C-01).
  await db.botHistory.update({ where: { id: historyId }, data: { deliveryStatus: "failed" } });
  await audit({
    userId,
    actor: "system",
    action: "bot_workflow_send_failed",
    targetType: "bot",
    targetId: botId,
    meta: { workflowId: args.workflowId, stepId: args.stepId, historyId, errorFa: send.errorFa },
  });
  return { ok: false, errorFa: send.errorFa, historyId };
}

/**
 * Tracked one-shot reply used by the webhook/poller layers for
 * non-workflow replies (link-code consumption). Same pre-write pending →
 * send → converge pattern; the history write is NEVER silently swallowed.
 */
export async function sendTrackedBotReply(
  bot: Bot,
  chatId: string,
  text: string,
  userId: string | null,
): Promise<void> {
  const trimmed = (text ?? "").slice(0, 4000);
  // 1. Durable pre-write.
  let historyId: string | null = null;
  try {
    const row = await db.botHistory.create({
      data: {
        botId: bot.id,
        userId: userId ?? null,
        direction: "outbound",
        providerUserId: chatId,
        text: trimmed,
        deliveryStatus: "pending",
      },
    });
    historyId = row.id;
  } catch (err) {
    // Observability persistence must not break the reply itself — but it
    // must never be silent.
    console.error("bot reply pending history write failed:", err instanceof Error ? err.message : err);
  }
  // 2. Send with outcome classification.
  let delivery: "sent" | "failed" | "uncertain" = "uncertain";
  let providerMessageId: string | null = null;
  if (!isValidProviderName(bot.provider)) {
    delivery = "failed";
  } else {
    let botToken: string;
    try {
      botToken = decryptString(bot.botTokenEnc);
    } catch {
      botToken = "";
      delivery = "failed"; // definitive: an undecryptable token can never send
    }
    if (botToken) {
      try {
        const provider = getDestinationProvider(bot.provider);
        const r = await provider.publishMessage({ botToken, chatId, text: trimmed });
        if (r.ok) {
          delivery = "sent";
          providerMessageId = r.providerMessageId ?? null;
        } else {
          delivery = r.ambiguous ? "uncertain" : "failed";
        }
      } catch (err) {
        // publishMessage resolves failures; a throw here is delivery-UNKNOWN.
        delivery = "uncertain";
        console.error("bot reply send failed:", err instanceof Error ? err.message : err);
      }
    } else {
      console.error("bot reply send skipped: token undecryptable (botId redacted)");
    }
  }
  // 3. Converge the row (never silently swallowed).
  if (historyId) {
    try {
      await db.botHistory.update({
        where: { id: historyId },
        data: { deliveryStatus: delivery, providerMessageId },
      });
    } catch (err) {
      console.error("bot reply delivery state write failed:", err instanceof Error ? err.message : err);
    }
  }
}

// ---------------------------------------------------------------------
// Walk the workflow
// ---------------------------------------------------------------------
export async function executeWorkflow(ctx: WorkflowContext, resume?: WorkflowResumeContext): Promise<WorkflowResult> {
  if (!ctx.bot || !ctx.workflow) {
    return { ok: false, matched: false, outboundCount: 0, errorFa: "گردالشکار یا ربات نامعتبر است." };
  }
  if (ctx.workflow.enabled === false) {
    return { ok: true, matched: false, outboundCount: 0 };
  }
  // C-11/C-12: NO update-level dedup here — the webhook layer is the
  // single dedup owner (see the ownership note above). Every intended
  // workflow for the event runs.
  // SHAPE COMPATIBILITY: the creation/update routes persist the validated
  // steps as a RAW ARRAY (`JSON.stringify(def.steps)`), while older rows
  // may hold an object `{ steps: [...] }`. The engine must accept both —
  // assuming the object shape silently disabled EVERY workflow (the walk
  // early-returned on `def.steps` undefined).
  const parsedSteps = safeJsonParse<WorkflowDef | WorkflowStep[]>(ctx.workflow.steps, { steps: [] });
  const def: WorkflowDef = Array.isArray(parsedSteps)
    ? { steps: parsedSteps }
    : ((parsedSteps as WorkflowDef) ?? { steps: [] });
  if (!def.steps || def.steps.length === 0) {
    return { ok: true, matched: false, outboundCount: 0 };
  }
  const stepMap = new Map<string, WorkflowStep>();
  for (const s of def.steps) stepMap.set(s.id, s);

  // START step
  const start = def.steps.find((s) => s.type === "start") ?? def.steps[0];
  if (!start) {
    return { ok: false, matched: false, outboundCount: 0, errorFa: "هیچ گام شروع یافت نشد." };
  }

  // Persist inbound is owned by the webhook layer (persistInboundOnce) —
  // once per EVENT, not once per workflow.
  //
  // Resolve linked user once.
  const linkedUser = await findLinkedUser(ctx.bot.id, ctx.providerUserId);

  // H-04 — ENGINE-LEVEL entitlement gate. A workflow is a premium
  // automation capability ("workflow" boolean): execution requires the
  // bot OWNER's CURRENT plan to still include it. A workflow created
  // under an active subscription therefore stops executing after
  // expiry/downgrade instead of silently retaining the capability.
  // (Free plans never had bot/workflow enabled — see SEED_PLANS — and
  // bot/workflow creation is already plan-gated at the API boundary.)
  const ownerFeatures = await getEffectiveFeatures(ctx.bot.ownerId);
  if (!getFeatureBoolean(ownerFeatures, "workflow", false)) {
    await audit({
      userId: linkedUser?.id ?? null,
      actor: "system",
      action: "bot_workflow_entitlement_blocked",
      targetType: "bot_workflow",
      targetId: ctx.workflow.id,
      meta: { botId: ctx.bot.id, feature: "workflow", scope: "engine" },
    });
    return {
      ok: true,
      matched: false,
      outboundCount: 0,
      errorFa: "امکان گردش کار در پلن فعلی مالک ربات فعال نیست.",
    };
  }

  // Loop protection: cap visited steps at steps.length * 2 (DAG shouldn't
  // exceed linear traversal).
  const visited = new Set<string>();
  let current: WorkflowStep | undefined = start;
  let outboundCount = 0;
  let aiInvoked = false;
  let hops = 0;
  const MAX_HOPS = def.steps.length * 2 + 4;

  // V5 H-04 — durable per-step progress. `resume` (from the run's stored
  // cursor) lets a retry skip every step that already completed on a
  // previous attempt — including the exact condition branch taken — so
  // recovery never re-sends already-delivered messages or re-performs
  // side-effecting actions. New progress is recorded into `cursor`.
  const cursor: WorkflowResumeCursor = {
    completedNext: { ...(resume?.completedNext ?? {}) },
    outboundHistory: { ...(resume?.outboundHistory ?? {}) },
  };

  // V5 H-04/C-01 — a message step whose send was DEFINITIVELY refused
  // keeps the run retryable: the engine finishes the walk (preserving the
  // previous continue-behavior) but reports ok:false so the durable run
  // layer retries ONLY the failed step (its cursor entry is omitted while
  // every completed sibling keeps theirs).
  let hadDefiniteSendFailure = false;

  // Memoized run-start resolution for the crash-recovery fallback channel
  // (resolved at most once per execution, only when a tracked send needs it).
  let runStartCache: Date | null | undefined;
  const getRunStart = async (): Promise<Date | null> => {
    if (runStartCache === undefined) runStartCache = await resolveRunStart(ctx);
    return runStartCache;
  };

  try {
    while (current && hops < MAX_HOPS) {
    hops++;
    if (visited.has(current.id)) break; // cycle guard
    visited.add(current.id);

    if (current.type === "end") break;

    // V5 H-04 — resume fast-path: this step completed on a previous
    // attempt; jump straight to its recorded successor.
    const recordedNext = cursor.completedNext[current.id];
    if (recordedNext !== undefined) {
      current = stepMap.get(recordedNext);
      continue;
    }

    // START steps carry no behavior — advance to their next step. (The
    // previous engine fell through to the "unknown step type" break here,
    // so every workflow terminated at its first step and NEVER executed
    // any action — a second total-disabling defect alongside the steps
    // shape mismatch fixed above.)
    if (current.type === "start") {
      const next = current.nextStepId ? stepMap.get(current.nextStepId) : undefined;
      if (next) cursor.completedNext[current.id] = next.id;
      current = next;
      continue;
    }

    if (current.type === "message") {
      const text = current.text ?? "";
      let stepSendFailedDefinitively = false;
      if (text) {
        // V5 H-04 — tracked send: durable pending row → provider call →
        // terminal delivery state. A prior row (cursor or run-scoped
        // fallback) decides between skip / converge / safe re-send.
        const r = await sendOutboundTracked(ctx, linkedUser?.id ?? null, {
          workflowId: ctx.workflow.id,
          stepId: current.id,
          text,
          priorHistoryId: cursor.outboundHistory[current.id],
        }, getRunStart);
        if (r.ok) {
          outboundCount++;
          if (r.historyId) cursor.outboundHistory[current.id] = r.historyId;
        } else {
          // DEFINITIVE refusal — the run becomes retryable (C-01). No
          // cursor entry is written for THIS step, so a retry re-drives
          // exactly it; steps that completed after it keep their entries
          // and are cursor-skipped on the retry. Walk continues.
          stepSendFailedDefinitively = true;
          hadDefiniteSendFailure = true;
        }
      }
      const next = current.nextStepId ? stepMap.get(current.nextStepId) : undefined;
      if (!stepSendFailedDefinitively && next) cursor.completedNext[current.id] = next.id;
      current = next;
      continue;
    }

    if (current.type === "condition" && current.condition) {
      const c = current.condition;
      const matched = await evaluateCondition(c, {
        botId: ctx.bot.id,
        providerUserId: ctx.providerUserId,
        incomingMessage: ctx.incomingMessage,
        linkedUserId: linkedUser?.id ?? null,
      });
      const nextId = matched ? c.thenStepId : c.elseStepId;
      const next = nextId ? stepMap.get(nextId) : undefined;
      if (next) cursor.completedNext[current.id] = next.id;
      current = next;
      continue;
    }

    if (current.type === "action" && current.action) {
      const a = current.action;
      // C-13/C-14: execution-time entitlement check for gated actions
      // (tickets / gold / AI) against the bot owner's CURRENT plan.
      const entitlement = await assertActionEntitlement(
        ctx.bot.ownerId,
        a.kind,
        ctx.workflow.id,
        linkedUser?.id ?? null,
      );
      if (!entitlement.allowed) {
        if (entitlement.errorFa) {
          // V5 H-04 — the refusal reply is a tracked send attributed to the
          // gated step. Its outcome never flips the run result: the gate
          // refusal itself is the correct, terminal outcome here.
          const r = await sendOutboundTracked(ctx, linkedUser?.id ?? null, {
            workflowId: ctx.workflow.id,
            stepId: current.id,
            text: entitlement.errorFa,
            priorHistoryId: cursor.outboundHistory[current.id],
          }, getRunStart);
          if (r.ok) {
            outboundCount++;
            if (r.historyId) cursor.outboundHistory[current.id] = r.historyId;
          }
        }
        break; // gated action refused — stop the walk (fail closed)
      }
      // Loop protection on AI
      if (a.kind === "invoke_ai") {
        if (aiInvoked) {
          // Refuse recursion beyond 1 step
          await audit({
            userId: linkedUser?.id ?? null,
            actor: "system",
            action: "bot_workflow_ai_recursion_blocked",
            targetType: "bot",
            targetId: ctx.bot.id,
            meta: { workflowId: ctx.workflow.id, stepId: current.id },
          });
          break;
        }
        aiInvoked = true;
      }
      const actionResult = await performAction(a, {
        ctx,
        linkedUserId: linkedUser?.id ?? null,
      });
      if (actionResult.outboundText) {
        // V5 H-04 — action outbounds are tracked sends attributed to the
        // action step. The ACTION itself already succeeded (ticket/payment/
        // AI/notification are idempotency-guarded); a definitive refusal of
        // its confirm-message is audited and recorded but does NOT flip the
        // run result — re-running the whole action would be the riskier
        // outcome (e.g. a duplicate ticket).
        const r = await sendOutboundTracked(ctx, linkedUser?.id ?? null, {
          workflowId: ctx.workflow.id,
          stepId: current.id,
          text: actionResult.outboundText,
          buttons: actionResult.outboundButtons,
          priorHistoryId: cursor.outboundHistory[current.id],
        }, getRunStart);
        if (r.ok) {
          outboundCount++;
          if (r.historyId) cursor.outboundHistory[current.id] = r.historyId;
        }
      }
      const next = a.nextStepId ? stepMap.get(a.nextStepId) : (current.nextStepId ? stepMap.get(current.nextStepId) : undefined);
      if (next) cursor.completedNext[current.id] = next.id;
      current = next;
      continue;
    }

    // Unknown step type — break gracefully
    break;
  }
  } catch (err) {
    // V5 H-04 — a crash mid-walk must not discard durable progress: the
    // cursor rides on the error so the run layer persists it and the
    // retry resumes instead of re-sending delivered steps.
    if (err instanceof Error) {
      (err as Error & { workflowCursor?: WorkflowResumeCursor }).workflowCursor = cursor;
    }
    throw err;
  }

  // V5 H-04/C-01 — a DEFINITIVE send failure makes the run retryable: the
  // durable run layer persists the cursor and re-drives ONLY the failed
  // step on the next attempt (already-delivered steps are cursor-skipped).
  if (hadDefiniteSendFailure) {
    return {
      ok: false,
      matched: true,
      outboundCount,
      errorFa: "ارسال یک یا چند پیام در گردش کار ناموفق بود.",
      cursor,
    };
  }

  return { ok: true, matched: true, outboundCount, cursor };
}

// ---------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------
async function evaluateCondition(
  c: WorkflowCondition,
  args: {
    botId: string;
    providerUserId: string;
    incomingMessage?: string;
    linkedUserId: string | null;
  },
): Promise<boolean> {
  try {
    switch (c.kind) {
      case "subscription_active": {
        if (!args.linkedUserId) return false;
        const sub = await getActiveSubscription(args.linkedUserId);
        return !!sub;
      }
      case "plan": {
        if (!args.linkedUserId) return false;
        const sub = await getActiveSubscription(args.linkedUserId);
        if (!sub) return false;
        return sub.plan?.code === (c.value ?? "");
      }
      case "referral": {
        if (!args.linkedUserId) return false;
        const u = await db.user.findUnique({ where: { id: args.linkedUserId }, select: { referredById: true } });
        return !!u?.referredById;
      }
      case "keyword": {
        if (!args.incomingMessage) return false;
        const kw = (c.value ?? "").trim().toLowerCase();
        if (!kw) return false;
        return args.incomingMessage.toLowerCase().includes(kw);
      }
      case "order_status": {
        if (!args.linkedUserId) return false;
        // value = "<orderId>:<status>" or just "<status>"
        const [orderId, status] = (c.value ?? "").split(":");
        if (!orderId) return false;
        const order = await db.order.findUnique({ where: { id: orderId }, select: { status: true, userId: true } });
        if (!order || order.userId !== args.linkedUserId) return false;
        if (!status) return true;
        return order.status === status;
      }
      case "provider_context": {
        // value = "telegram" | "bale" | "rubika"
        // Resolved against the bot's provider — fetched by caller.
        // We resolve it here from the linked bot via the providerUserId.
        const botLink = await db.bot.findFirst({
          where: { id: args.botId },
          select: { provider: true },
        });
        return botLink?.provider === (c.value ?? "");
      }
      case "user_state": {
        if (!args.linkedUserId) return false;
        // value = "<stateKey>=<expectedValue>"; state stored in cache.
        const [key, expected] = (c.value ?? "").split("=");
        if (!key) return false;
        const stored = await cache.get<string>(`bot:state:${args.linkedUserId}:${key}`);
        return stored === (expected ?? "true");
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------
interface ActionResult {
  outboundText?: string;
  outboundButtons?: GlassButton[];
}

async function performAction(
  a: WorkflowAction,
  args: {
    ctx: WorkflowContext;
    linkedUserId: string | null;
  },
): Promise<ActionResult> {
  const cfg = a.config ?? {};
  switch (a.kind) {
    case "send_message": {
      const text = String(cfg.text ?? cfg.message ?? "");
      return { outboundText: text, outboundButtons: parseButtons(cfg.buttons) };
    }
    case "show_menu": {
      const title = String(cfg.title ?? "منوی پُست‌یار");
      const items = Array.isArray(cfg.items) ? cfg.items : [];
      const lines: string[] = [title, ""];
      let i = 1;
      for (const it of items) {
        const label = String((it as { label?: string }).label ?? (it as { text?: string }).text ?? `گزینه ${i}`);
        lines.push(`${toPersianDigits(i)}. ${label}`);
        i++;
      }
      return { outboundText: lines.join("\n"), outboundButtons: parseButtons(cfg.buttons) };
    }
    case "create_ticket": {
      if (!args.linkedUserId) {
        return { outboundText: "برای ثبت تیکت ابتدا حساب پُست‌یار خود را به این ربات متصل کنید." };
      }
      // L-6 — abuse cap: a trigger-happy workflow must not let a chat
      // identity farm unlimited support tickets.
      const ticketRl = await rateLimit({
        key: `bot:ticket:${args.linkedUserId}`,
        limit: 5,
        windowMs: 60 * 60 * 1000,
      });
      if (!ticketRl.ok) {
        return { outboundText: "تعداد تیکت‌های ثبت‌شده بیش از حد مجاز است. بعداً تلاش کنید." };
      }
      const subject = String(cfg.subject ?? "تیکت از ربات");
      const body = String(cfg.body ?? args.ctx.incomingMessage ?? "");
      if (body.length < 3) {
        return { outboundText: "متن تیکت بسیار کوتاه است." };
      }
      const ticketCategory = String(cfg.category ?? "bot") as TicketCategory;
      const ticketPriority = String(cfg.priority ?? "normal") as TicketPriority;
      const r = await createTicket({
        userId: args.linkedUserId,
        subject,
        category: ticketCategory,
        priority: ticketPriority,
        body,
        ip: undefined,
      });
      if (!r.ok || !r.ticket) {
        return { outboundText: r.errorFa ?? "ایجاد تیکت ناموفق بود." };
      }
      return { outboundText: `تیکت شما با شناسه ${toPersianDigits(r.ticket.id.slice(-8).toUpperCase())} ثبت شد.` };
    }
    case "show_subscription": {
      if (!args.linkedUserId) {
        return { outboundText: "ابتدا حساب پُست‌یار خود را متصل کنید." };
      }
      const sub = await getActiveSubscription(args.linkedUserId);
      if (!sub) {
        return { outboundText: "اشتراک فعالی ندارید. برای استفاده از امکانات پُست‌یار یک طرح تهیه کنید." };
      }
      const quota = await getQuotaState(args.linkedUserId);
      return {
        outboundText:
          `طرح: ${sub.plan.nameFa}\n` +
          `وضعیت: فعال\n` +
          `پایان: ${formatJalaliDateTime(sub.endsAt, { withTime: false })}\n` +
          `انتشار ماهانه: ${toPersianDigits(quota.publishPerMonth.used)} از ${toPersianDigits(quota.publishPerMonth.limit)}\n` +
          `هوش مصنوعی ماهانه: ${toPersianDigits(quota.aiPerMonth.used)} از ${toPersianDigits(quota.aiPerMonth.limit)}`,
      };
    }
    case "show_wallet": {
      if (!args.linkedUserId) {
        return { outboundText: "ابتدا حساب پُست‌یار خود را متصل کنید." };
      }
      const w = await getBalance(args.linkedUserId);
      return { outboundText: `موجودی کیف پول شما: ${w.balanceFa}` };
    }
    case "initiate_payment": {
      if (!args.linkedUserId) {
        return { outboundText: "ابتدا حساب پُست‌یار خود را متصل کنید." };
      }
      const planCode = String(cfg.planCode ?? "basic");
      // look up plan by code
      const plan = await db.plan.findUnique({ where: { code: planCode } });
      if (!plan || !plan.active || !plan.isPublic) {
        return { outboundText: "طرح انتخاب‌شده معتبر نیست." };
      }
      const idemKey = `bot:pay:${args.linkedUserId}:${plan.id}`;
      try {
        const { order } = await createOrderForSubscription({
          userId: args.linkedUserId,
          planId: plan.id,
          provider: "bale",
          idempotencyKey: idemKey,
        });
        // H-2 (defense in depth): an order that already reached a
        // paid/terminal state is NEVER re-invoiced — the deterministic
        // bot-payment key returns the existing order and re-issuing an
        // invoice for it could regress its financial state. Direct the
        // user to a fresh purchase instead.
        if (order.status !== "pending" && order.status !== "awaiting_payment") {
          return {
            outboundText:
              "این طرح قبلاً برای شما فاکتور شده و قابل صدور مجدد نیست. از داشبورد سفارش تازه‌ای ایجاد کنید.",
          };
        }
        // Send Bale invoice if bot is bale; otherwise just notify
        if (args.ctx.bot.provider === "bale") {
          const r = await baleCreatePaymentRequest({
            order: {
              id: order.id,
              userId: args.linkedUserId,
              kind: "subscription",
              amountRials: order.amountRials,
              descriptionFa: order.descriptionFa,
              status: order.status,
            },
            botId: args.ctx.bot.id,
            chatId: args.ctx.providerUserId,
          });
          if (!r.ok) {
            return { outboundText: r.errorFa ?? "صدور فاکتور ناموفق بود." };
          }
          return { outboundText: `فاکتور پرداخت ${formatRials(order.amountRials)} برای طرح «${plan.nameFa}» در همین چت ارسال شد. آن را تأیید و پرداخت کنید.` };
        }
        // Non-bale bot: prompt user to use the dashboard
        return {
          outboundText:
            `برای پرداخت طرح «${plan.nameFa}» به مبلغ ${formatRials(order.amountRials)} ` +
            `به داشبورد پُست‌یار مراجعه کنید.`,
        };
      } catch (err) {
        const msg = (err as AuthError)?.message ?? "خطا در صدور فاکتور.";
        return { outboundText: msg };
      }
    }
    case "show_gold": {
      const instrument = String(cfg.instrument ?? "18k") as GoldInstrument;
      const r = await getGoldPrice(instrument);
      if (!r.ok || r.priceRials == null) {
        const staleSuffix = r.stalePriceRials != null ? ` (آخرین قیمت: ${formatRials(r.stalePriceRials)})` : "";
        return {
          outboundText: (r.errorFa ?? "داده‌های طلا در دسترس نیست.") + staleSuffix,
        };
      }
      const labels: Record<string, string> = {
        "18k": "طلای ۱۸ عیار",
        emami: "سکه امامی",
        bahar_azadi: "سکه بهار آزادی",
        ounce: "انس طلا",
      };
      return {
        outboundText:
          `${labels[instrument] ?? instrument}: ${formatRials(r.priceRials)}\n` +
          `به‌روزرسانی: ${formatJalaliDateTime(r.fetchedAt ?? new Date().toISOString(), { withTime: true })}`,
      };
    }
    case "invoke_ai": {
      if (!args.linkedUserId) {
        return { outboundText: "ابتدا حساب پُست‌یار خود را متصل کنید." };
      }
      const provider = cfg.provider ? String(cfg.provider) : null;
      const model = cfg.model ? String(cfg.model) : null;
      const prompt = String(cfg.prompt ?? args.ctx.incomingMessage ?? "");
      const systemPrompt = cfg.systemPrompt ? String(cfg.systemPrompt) : undefined;
      if (!prompt) {
        return { outboundText: "پرامپت خالی است." };
      }
      // V5 H-08 — the idempotency key must cover EVERY model-shaping input:
      // the previous key hashed only the prompt, so the same prompt with a
      // different systemPrompt/provider/model collided on the UNIQUE
      // AiJob.idempotencyKey and silently returned the FIRST variant's
      // answer instead of invoking the reconfigured step.
      const idemInput = JSON.stringify({
        task: "custom",
        prompt,
        systemPrompt: systemPrompt ?? null,
        provider: provider ?? null,
        model: model ?? null,
      });
      const idemKey = `bot:ai:${args.ctx.bot.ownerId}:${args.ctx.bot.id}:${args.ctx.workflow.id}:${hashToken(idemInput).slice(0, 32)}`;
      try {
        // C-13/C-14: the AI invocation is charged to and gated by the BOT
        // OWNER's plan (the bot is the owner's automated asset consuming
        // the owner's AI quota) — the previous behavior charged whichever
        // customer happened to text the bot, letting a downgraded owner
        // keep premium automation on their customers' quota.
        const r = await dispatchAi({
          userId: args.ctx.bot.ownerId,
          provider,
          model,
          task: "custom",
          prompt,
          systemPrompt,
          idempotencyKey: idemKey,
        });
        if (!r.ok) {
          return { outboundText: r.errorFa ?? "خطا در هوش مصنوعی." };
        }
        return { outboundText: r.content || "پاسخی دریافت نشد." };
      } catch (err) {
        const msg = (err as AuthError)?.message ?? "خطا در هوش مصنوعی.";
        return { outboundText: msg };
      }
    }
    case "show_order": {
      if (!args.linkedUserId) return { outboundText: "ابتدا حساب خود را متصل کنید." };
      const orderId = String(cfg.orderId ?? "");
      if (!orderId) return { outboundText: "شناسه سفارش مشخص نشده است." };
      const order = await db.order.findUnique({
        where: { id: orderId },
        select: { id: true, userId: true, kind: true, amountRials: true, status: true, descriptionFa: true, createdAt: true },
      });
      if (!order || order.userId !== args.linkedUserId) {
        return { outboundText: "سفارش یافت نشد." };
      }
      return {
        outboundText:
          `سفارش: ${toPersianDigits(order.id.slice(-8).toUpperCase())}\n` +
          `نوع: ${order.kind}\n` +
          `مبلغ: ${formatRials(order.amountRials)}\n` +
          `وضعیت: ${order.status}\n` +
          `تاریخ: ${formatJalaliDateTime(order.createdAt, { withTime: true })}`,
      };
    }
    case "send_content": {
      if (!args.linkedUserId) return { outboundText: "ابتدا حساب خود را متصل کنید." };
      const contentId = String(cfg.contentId ?? "");
      if (!contentId) return { outboundText: "شناسه محتوا مشخص نشده است." };
      const content = await db.content.findUnique({
        where: { id: contentId },
        select: { id: true, ownerId: true, title: true, body: true, status: true },
      });
      if (!content || content.ownerId !== args.linkedUserId) {
        return { outboundText: "محتوا یافت نشد." };
      }
      const text = `${content.title ? content.title + "\n\n" : ""}${content.body}`;
      return { outboundText: text };
    }
    case "create_notification": {
      if (!args.linkedUserId) return { outboundText: "ابتدا حساب خود را متصل کنید." };
      const title = String(cfg.titleFa ?? "اعلان پُست‌یار");
      const body = String(cfg.bodyFa ?? "");
      const link = cfg.link ? String(cfg.link) : undefined;
      const category = String(cfg.category ?? "system") as NotificationCategory;
      await notify({
        userId: args.linkedUserId,
        category,
        titleFa: title,
        bodyFa: body,
        link,
      });
      return { outboundText: cfg.confirmText ? String(cfg.confirmText) : "اعلان شما ثبت شد." };
    }
    default:
      return { outboundText: "" };
  }
}

// ---------------------------------------------------------------------
// Parse workflow buttons config into GlassButton[]
// ---------------------------------------------------------------------
// P1.2 — hardened URL/callback policy:
//   * Only https: URLs are accepted (javascript:, data:, vbscript:,
//     http:, malformed and control-character tricks are rejected).
//   * callbackData is bounded (64 chars, printable, no whitespace) —
//     providers cap callback payload size and it must never smuggle
//     markup.
//   * Labels are bounded and stripped of control characters.
// ---------------------------------------------------------------------
const BUTTON_URL_MAX = 512;
const BUTTON_LABEL_MAX = 64;
const BUTTON_CALLBACK_MAX = 64;
const BUTTON_MAX_COUNT = 20;

function safeButtonUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > BUTTON_URL_MAX) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.username || parsed.password) return undefined;
  return parsed.toString();
}

function safeCallbackData(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > BUTTON_CALLBACK_MAX) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(trimmed) || /\s/.test(trimmed)) return undefined;
  return trimmed;
}

function safeButtonLabel(raw: string, index: number): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return (cleaned || `گزینه ${index + 1}`).slice(0, BUTTON_LABEL_MAX);
}

function parseButtons(raw: unknown): GlassButton[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: GlassButton[] = [];
  let i = 0;
  for (const r of raw) {
    if (out.length >= BUTTON_MAX_COUNT) break;
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const callbackData =
      typeof o.callbackData === "string" ? safeCallbackData(o.callbackData)
      : typeof o.callback_data === "string" ? safeCallbackData(o.callback_data)
      : undefined;
    const btn: GlassButton = {
      id: String(o.id ?? `btn-${i}`),
      label: safeButtonLabel(String(o.label ?? o.text ?? ""), i),
      url: safeButtonUrl(o.url),
      callbackData: callbackData ?? undefined,
      rowOrder: typeof o.rowOrder === "number" ? o.rowOrder : i,
      enabled: o.enabled !== false,
    };
    // A button without a safe URL and without callback data is useless and
    // potentially a provider-protocol violation — drop it.
    if (!btn.url && !btn.callbackData) continue;
    out.push(btn);
    i++;
  }
  return out.length ? out : undefined;
}

// ---------------------------------------------------------------------
// Workflow validation (used by the API routes)
// ---------------------------------------------------------------------
// P1.1 — structural validation beyond step IDs/types:
//   * every nextStepId / thenStepId / elseStepId MUST reference an existing
//     step (dangling references previously silently truncated the walk);
//   * the graph must be acyclic (the runtime visited-guard would otherwise
//     silently truncate execution mid-flow);
//   * start-node uniqueness;
//   * per-kind action configuration validation;
//   * button URLs/callbacks validated with the same policy as parseButtons.
// ---------------------------------------------------------------------
export async function validateWorkflowDef(steps: unknown): Promise<{ ok: boolean; errorFa?: string; def?: WorkflowDef }> {
  if (!Array.isArray(steps)) return { ok: false, errorFa: "گام‌های گردش کار باید آرایه باشند." };
  if (steps.length === 0 || steps.length > 100) return { ok: false, errorFa: "تعداد گام‌ها باید بین ۱ و ۱۰۰ باشد." };
  const ids = new Set<string>();
  for (const s of steps) {
    if (!s || typeof s !== "object") return { ok: false, errorFa: "گام نامعتبر است." };
    const step = s as WorkflowStep;
    if (!step.id || typeof step.id !== "string") return { ok: false, errorFa: "شناسه گام الزامی است." };
    // V6 C-15 — bound the step id the same way as every other persisted
    // identifier: 100 steps × unbounded ids would bloat the persisted
    // JSON and the engine's stepMap.
    if (step.id.length > 64 || /[\u0000-\u001f\u007f]/.test(step.id)) {
      return { ok: false, errorFa: "شناسه گام نامعتبر است (حداکثر ۶۴ نویسه، بدون نویسه کنترلی)." };
    }
    if (ids.has(step.id)) return { ok: false, errorFa: `شناسه گام تکراری: ${step.id}` };
    ids.add(step.id);
    if (!["start", "message", "condition", "action", "end"].includes(step.type)) {
      return { ok: false, errorFa: `نوع گام نامعتبر: ${String(step.type)}` };
    }
    if (step.type === "action" && step.action) {
      const allowed: ActionKind[] = [
        "send_message", "show_menu", "create_ticket", "show_subscription",
        "show_wallet", "initiate_payment", "show_gold", "invoke_ai",
        "show_order", "send_content", "create_notification",
      ];
      if (!allowed.includes(step.action.kind)) {
        return { ok: false, errorFa: `نوع اکشن نامعتبر: ${String(step.action.kind)}` };
      }
    }
    if (step.type === "condition" && step.condition) {
      const allowed: ConditionKind[] = [
        "subscription_active", "plan", "referral", "keyword",
        "order_status", "provider_context", "user_state",
      ];
      if (!allowed.includes(step.condition.kind)) {
        return { ok: false, errorFa: `نوع شرط نامعتبر: ${String(step.condition.kind)}` };
      }
      // M-07: bound the condition value — it is interpolated into cache
      // keys / comparisons and must never carry control characters or
      // unbounded payload.
      if (step.condition.value !== undefined) {
        const v = step.condition.value;
        if (typeof v !== "string" || v.length > 200 || /[\u0000-\u001f\u007f]/.test(v)) {
          return { ok: false, errorFa: `مقدار شرط در گام «${step.id}» نامعتبر است (حداکثر ۲۰۰ نویسه، بدون نویسه کنترلی).` };
        }
      }
    }
    // M-07: message-type steps are outbound sends — their text must obey
    // the same 4000-char bound as send_message actions (previously only
    // the action branch was bounded).
    if (step.type === "message") {
      const text = typeof step.text === "string" ? step.text : "";
      if (text.length > 4000) {
        return { ok: false, errorFa: `متن گام پیام «${step.id}» بیش از حد طولانی است (حداکثر ۴۰۰۰ نویسه).` };
      }
    }
  }
  const startSteps = steps.filter((s) => (s as WorkflowStep).type === "start");
  if (startSteps.length === 0) {
    return { ok: false, errorFa: "یک گام از نوع start الزامی است." };
  }
  if (startSteps.length > 1) {
    return { ok: false, errorFa: "تنها یک گام start مجاز است." };
  }

  // --- Reference + config validation ---
  for (const s of steps) {
    const step = s as WorkflowStep;
    const refError = (ref: unknown, label: string): string | null => {
      if (ref === undefined || ref === null) return null;
      if (typeof ref !== "string" || !ids.has(ref)) {
        return `ارجاع ${label} در گام «${step.id}» به گامی ناموجود است.`;
      }
      return null;
    };
    const e1 = refError(step.nextStepId, "nextStepId");
    if (e1) return { ok: false, errorFa: e1 };
    if (step.type === "condition" && step.condition) {
      const e2 = refError(step.condition.thenStepId, "thenStepId");
      if (e2) return { ok: false, errorFa: e2 };
      const e3 = refError(step.condition.elseStepId, "elseStepId");
      if (e3) return { ok: false, errorFa: e3 };
    }
    if (step.type === "action" && step.action) {
      const e4 = refError(step.action.nextStepId, "nextStepId");
      if (e4) return { ok: false, errorFa: e4 };

      // Per-kind action config validation.
      const cfg = (step.action.config ?? {}) as Record<string, unknown>;
      switch (step.action.kind) {
        case "send_message": {
          const text = String(cfg.text ?? cfg.message ?? "");
          if (!text.trim()) return { ok: false, errorFa: `متن پیام در گام «${step.id}» خالی است.` };
          if (text.length > 4000) return { ok: false, errorFa: `متن پیام در گام «${step.id}» بیش از حد طولانی است.` };
          const btns = cfg.buttons;
          if (btns !== undefined && !Array.isArray(btns)) {
            return { ok: false, errorFa: `دکمه‌های گام «${step.id}» باید آرایه باشند.` };
          }
          if (Array.isArray(btns)) {
            // V5 H-13 — save-time bounds (count + label length) that the
            // runtime previously clamped silently.
            const btnErr = buttonsAreSafe(btns, step.id);
            if (btnErr) return { ok: false, errorFa: btnErr };
          }
          break;
        }
        case "show_menu": {
          if (cfg.items !== undefined && !Array.isArray(cfg.items)) {
            return { ok: false, errorFa: `آیتم‌های منو در گام «${step.id}» باید آرایه باشند.` };
          }
          // M-07: bound menu size and labels (previously unbounded).
          if (Array.isArray(cfg.items)) {
            if (cfg.items.length > 20) {
              return { ok: false, errorFa: `منوی گام «${step.id}» بیش از ۲۰ آیتم دارد.` };
            }
            for (const it of cfg.items) {
              const label = String((it as { label?: string })?.label ?? (it as { text?: string })?.text ?? "");
              if (label.length > 128) {
                return { ok: false, errorFa: `برچسب آیتم منو در گام «${step.id}» بیش از حد طولانی است.` };
              }
            }
          }
          const menuBtns = cfg.buttons;
          if (menuBtns !== undefined && !Array.isArray(menuBtns)) {
            return { ok: false, errorFa: `دکمه‌های گام «${step.id}» باید آرایه باشند.` };
          }
          if (Array.isArray(menuBtns)) {
            const menuBtnErr = buttonsAreSafe(menuBtns, step.id);
            if (menuBtnErr) return { ok: false, errorFa: menuBtnErr };
          }
          break;
        }
        case "create_ticket": {
          // M-07: ticket fields were previously unvalidated blind casts.
          const subject = String(cfg.subject ?? "");
          if (subject.length > 200) {
            return { ok: false, errorFa: `موضوع تیکت در گام «${step.id}» بیش از حد طولانی است.` };
          }
          const body = String(cfg.body ?? "");
          if (body.length > 4000) {
            return { ok: false, errorFa: `متن تیکت در گام «${step.id}» بیش از حد طولانی است.` };
          }
          const cat = String(cfg.category ?? "bot");
          if (!(TICKET_CATEGORIES as readonly string[]).includes(cat)) {
            return { ok: false, errorFa: `دسته‌بندی تیکت در گام «${step.id}» نامعتبر است.` };
          }
          const prio = String(cfg.priority ?? "normal");
          if (!(TICKET_PRIORITIES as readonly string[]).includes(prio)) {
            return { ok: false, errorFa: `اولویت تیکت در گام «${step.id}» نامعتبر است.` };
          }
          break;
        }
        case "show_gold": {
          // M-07: instrument must be a known gold instrument.
          const instrument = String(cfg.instrument ?? "18k");
          if (!(GOLD_INSTRUMENTS as readonly string[]).includes(instrument)) {
            return { ok: false, errorFa: `ابزار طلا در گام «${step.id}» نامعتبر است.` };
          }
          break;
        }
        case "initiate_payment": {
          const planCode = String(cfg.planCode ?? "").trim();
          if (!planCode) return { ok: false, errorFa: `کد طرح پرداخت در گام «${step.id}» الزامی است.` };
          if (planCode.length > 64) {
            return { ok: false, errorFa: `کد طرح پرداخت در گام «${step.id}» بیش از حد طولانی است.` };
          }
          if (/[\u0000-\u001f\u007f]/.test(planCode)) {
            return { ok: false, errorFa: `کد طرح پرداخت در گام «${step.id}» شامل نویسه کنترلی است.` };
          }
          // V5 H-13 — save-time existence/visibility check: the workflow
          // editor must not be able to persist a payment step pointing at
          // an unknown, inactive or hidden (non-public) plan. The runtime
          // execution re-checks against the CURRENT plan state — this
          // validation only keeps obviously-broken definitions out of the DB.
          const plan = await db.plan.findUnique({
            where: { code: planCode },
            select: { active: true, isPublic: true },
          });
          if (!plan || !plan.active || !plan.isPublic) {
            return { ok: false, errorFa: `کد طرح پرداخت در گام «${step.id}» به طرحی فعال و عمومی اشاره ندارد.` };
          }
          break;
        }
        case "invoke_ai": {
          const prompt = String(cfg.prompt ?? "").trim();
          // prompt may fall back to the incoming message at runtime; only
          // validate length when a prompt is configured.
          if (prompt.length > 8000) return { ok: false, errorFa: `پرامپت هوش مصنوعی در گام «${step.id}» بیش از حد طولانی است.` };
          // M-07: provider/model bounds — an unknown provider id would
          // previously be passed through and only rejected at runtime.
          if (cfg.provider !== undefined) {
            const prov = String(cfg.provider);
            if (!(AI_PROVIDER_IDS as readonly string[]).includes(prov)) {
              return { ok: false, errorFa: `ارائه‌دهنده هوش مصنوعی در گام «${step.id}» نامعتبر است.` };
            }
          }
          if (cfg.model !== undefined && String(cfg.model).length > 100) {
            return { ok: false, errorFa: `نام مدل هوش مصنوعی در گام «${step.id}» بیش از حد طولانی است.` };
          }
          if (cfg.systemPrompt !== undefined && String(cfg.systemPrompt).length > 4000) {
            return { ok: false, errorFa: `پیام سیستم هوش مصنوعی در گام «${step.id}» بیش از حد طولانی است.` };
          }
          break;
        }
        case "create_notification": {
          const title = String(cfg.titleFa ?? "").trim();
          if (!title) return { ok: false, errorFa: `عنوان اعلان در گام «${step.id}» الزامی است.` };
          if (title.length > 200) {
            return { ok: false, errorFa: `عنوان اعلان در گام «${step.id}» بیش از حد طولانی است.` };
          }
          // V6 C-15 — the notification category is persisted raw by
          // notify(); validate it against the NotificationCategory union
          // at save time instead of blind-casting at execution time.
          if (cfg.category !== undefined) {
            const ncat = String(cfg.category);
            if (!NOTIFICATION_CATEGORIES.includes(ncat)) {
              return { ok: false, errorFa: `دسته اعلان در گام «${step.id}» نامعتبر است.` };
            }
          }
          // M-07: previously unbounded fields.
          const nBody = String(cfg.bodyFa ?? "");
          if (nBody.length > 4000) {
            return { ok: false, errorFa: `متن اعلان در گام «${step.id}» بیش از حد طولانی است.` };
          }
          if (cfg.confirmText !== undefined && String(cfg.confirmText).length > 200) {
            return { ok: false, errorFa: `متن تأیید اعلان در گام «${step.id}» بیش از حد طولانی است.` };
          }
          if (cfg.link !== undefined) {
            const link = String(cfg.link);
            // A notification link is a UI navigation target: either a
            // relative in-app path or an https URL — never a scheme trick.
            const okLink = (link.startsWith("/") && !link.startsWith("//") && !/[\u0000-\u001f\u007f]/.test(link))
              || safeButtonUrl(link) !== undefined;
            if (!okLink || link.length > 512) {
              return { ok: false, errorFa: `نشانی اعلان در گام «${step.id}» نامعتبر است.` };
            }
          }
          break;
        }
        case "show_order":
        case "send_content": {
          // V5 H-13 — structural bounds for the referenced id: bounded to
          // 64 chars with no control characters (the runtime checks
          // existence and OWNERSHIP; this keeps malformed ids out of the DB).
          const idField = step.action.kind === "show_order" ? cfg.orderId : cfg.contentId;
          if (idField !== undefined) {
            const v = String(idField);
            if (!v || v.length > 64 || /[\u0000-\u001f\u007f]/.test(v)) {
              const label = step.action.kind === "show_order" ? "شناسه سفارش" : "شناسه محتوا";
              return { ok: false, errorFa: `${label} در گام «${step.id}» نامعتبر است (حداکثر ۶۴ نویسه، بدون نویسه کنترلی).` };
            }
          }
          break;
        }
        default:
          break;
      }
    }
  }

  // --- Cycle detection (reachability from start) ---
  const stepMap = new Map<string, WorkflowStep>();
  for (const s of steps) stepMap.set((s as WorkflowStep).id, s as WorkflowStep);
  const start = startSteps[0] as WorkflowStep;
  const state = new Map<string, 0 | 1 | 2>(); // 0=unvisited 1=in-stack 2=done
  const dfs = (id: string): string | null => {
    const st = state.get(id) ?? 0;
    if (st === 1) return `گردش کار حلقه (cycle) دارد و از گام «${id}» به خود بازمی‌گردد.`;
    if (st === 2) return null;
    state.set(id, 1);
    const step = stepMap.get(id);
    if (step) {
      const nexts: string[] = [];
      if (step.nextStepId) nexts.push(step.nextStepId);
      if (step.action?.nextStepId) nexts.push(step.action.nextStepId);
      if (step.condition?.thenStepId) nexts.push(step.condition.thenStepId);
      if (step.condition?.elseStepId) nexts.push(step.condition.elseStepId);
      for (const n of nexts) {
        const err = dfs(n);
        if (err) return err;
      }
    }
    state.set(id, 2);
    return null;
  };
  const cycleErr = dfs(start.id);
  if (cycleErr) return { ok: false, errorFa: cycleErr };

  // Unreachable steps are allowed (authors may keep disabled branches), but
  // dangling references and cycles are hard failures.
  return { ok: true, def: { steps: steps as WorkflowStep[] } };
}

/**
 * V5 H-13 — validate button config arrays against the P1.2 URL/callback
 * policy PLUS save-time bounds that the runtime previously clamped
 * silently: at most BUTTON_MAX_COUNT buttons and labels that stay within
 * BUTTON_LABEL_MAX after the same cleaning the runtime applies.
 * Returns null when safe, otherwise a bounded Persian error message.
 */
function buttonsAreSafe(raw: unknown[], stepId: string): string | null {
  if (raw.length > BUTTON_MAX_COUNT) {
    return `دکمه‌های گام «${stepId}» بیش از ${toPersianDigits(BUTTON_MAX_COUNT)} دکمه دارد.`;
  }
  for (const r of raw) {
    if (!r || typeof r !== "object") return `دکمه‌های گام «${stepId}» نشانی یا داده نامعتبر دارند.`;
    const o = r as Record<string, unknown>;
    if (o.url !== undefined && o.url !== null && safeButtonUrl(o.url) === undefined) {
      return `دکمه‌های گام «${stepId}» نشانی یا داده نامعتبر دارند.`;
    }
    const cb = o.callbackData ?? o.callback_data;
    if (cb !== undefined && cb !== null && safeCallbackData(cb) === undefined) {
      return `دکمه‌های گام «${stepId}» نشانی یا داده نامعتبر دارند.`;
    }
    if ((o.url === undefined || o.url === null) && (cb === undefined || cb === null)) {
      return `دکمه‌های گام «${stepId}» نشانی یا داده نامعتبر دارند.`;
    }
    // Label bound — measured AFTER the same control-character cleaning the
    // runtime applies (safeButtonLabel), so the check mirrors what would
    // actually reach the provider instead of clamping silently.
    const rawLabel = o.label ?? o.text;
    if (rawLabel !== undefined && rawLabel !== null) {
      const cleaned = String(rawLabel).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
      if (cleaned.length > BUTTON_LABEL_MAX) {
        return `برچسب دکمه در گام «${stepId}» بیش از ${toPersianDigits(BUTTON_LABEL_MAX)} نویسه است.`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Re-export processBaleUpdate for webhook handlers
// ---------------------------------------------------------------------
export { processBaleUpdate };
