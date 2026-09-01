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
    const msg = (err as { code?: string; message?: string })?.message ?? "";
    if (/unique|UNIQUE|constraint/i.test(msg)) {
      // Durable idempotency: the history row for this event already exists.
      return;
    }
    // Never fail the event on observability persistence — but never hide
    // the failure either.
    console.error("bot history persist failed:", err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------
// Persist outbound BotHistory rows (inbound persistence lives in
// persistInboundOnce — owned by the webhook layer, once per event).
// ---------------------------------------------------------------------
async function persistOutbound(ctx: WorkflowContext, userId: string | null, text: string): Promise<void> {
  try {
    await db.botHistory.create({
      data: {
        botId: ctx.bot.id,
        userId: userId ?? null,
        direction: "outbound",
        providerUserId: ctx.providerUserId,
        text: (text ?? "").slice(0, 4000),
      },
    });
  } catch { /* never fail the workflow on persistence */ }
}

// ---------------------------------------------------------------------
// Send an outbound message via the bot's provider
// ---------------------------------------------------------------------
async function sendOutbound(bot: Bot, chatId: string, text: string, buttons?: GlassButton[]): Promise<{ ok: boolean; errorFa?: string }> {
  if (!isValidProviderName(bot.provider)) {
    return { ok: false, errorFa: "پروایدر ربات نامعتبر است." };
  }
  let botToken = "";
  try { botToken = decryptString(bot.botTokenEnc); } catch {
    return { ok: false, errorFa: "توکن ربات قابل رمزگشایی نیست." };
  }
  const provider = getDestinationProvider(bot.provider);
  const r = await provider.publishMessage({
    botToken,
    chatId,
    text,
    buttons,
  });
  if (!r.ok) return { ok: false, errorFa: r.errorFa };
  return { ok: true };
}

// ---------------------------------------------------------------------
// Walk the workflow
// ---------------------------------------------------------------------
export async function executeWorkflow(ctx: WorkflowContext): Promise<WorkflowResult> {
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

  while (current && hops < MAX_HOPS) {
    hops++;
    if (visited.has(current.id)) break; // cycle guard
    visited.add(current.id);

    if (current.type === "end") break;

    // START steps carry no behavior — advance to their next step. (The
    // previous engine fell through to the "unknown step type" break here,
    // so every workflow terminated at its first step and NEVER executed
    // any action — a second total-disabling defect alongside the steps
    // shape mismatch fixed above.)
    if (current.type === "start") {
      current = current.nextStepId ? stepMap.get(current.nextStepId) : undefined;
      continue;
    }

    if (current.type === "message") {
      const text = current.text ?? "";
      if (text) {
        const r = await sendOutbound(ctx.bot, ctx.providerUserId, text);
        if (r.ok) {
          outboundCount++;
          await persistOutbound(ctx, linkedUser?.id ?? null, text);
        } else {
          await audit({
            userId: linkedUser?.id ?? null,
            actor: "system",
            action: "bot_workflow_send_failed",
            targetType: "bot",
            targetId: ctx.bot.id,
            meta: { workflowId: ctx.workflow.id, stepId: current.id, errorFa: r.errorFa },
          });
        }
      }
      current = current.nextStepId ? stepMap.get(current.nextStepId) : undefined;
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
      current = nextId ? stepMap.get(nextId) : undefined;
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
          const r = await sendOutbound(ctx.bot, ctx.providerUserId, entitlement.errorFa);
          if (r.ok) {
            outboundCount++;
            await persistOutbound(ctx, linkedUser?.id ?? null, entitlement.errorFa);
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
        const r = await sendOutbound(ctx.bot, ctx.providerUserId, actionResult.outboundText, actionResult.outboundButtons);
        if (r.ok) {
          outboundCount++;
          await persistOutbound(ctx, linkedUser?.id ?? null, actionResult.outboundText);
        }
      }
      current = a.nextStepId ? stepMap.get(a.nextStepId) : (current.nextStepId ? stepMap.get(current.nextStepId) : undefined);
      continue;
    }

    // Unknown step type — break gracefully
    break;
  }

  return { ok: true, matched: true, outboundCount };
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
      const idemKey = `bot:ai:${args.ctx.bot.ownerId}:${args.ctx.bot.id}:${args.ctx.workflow.id}:${hashToken(prompt).slice(0, 32)}`;
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
export function validateWorkflowDef(steps: unknown): { ok: boolean; errorFa?: string; def?: WorkflowDef } {
  if (!Array.isArray(steps)) return { ok: false, errorFa: "گام‌های گردش کار باید آرایه باشند." };
  if (steps.length === 0 || steps.length > 100) return { ok: false, errorFa: "تعداد گام‌ها باید بین ۱ و ۱۰۰ باشد." };
  const ids = new Set<string>();
  for (const s of steps) {
    if (!s || typeof s !== "object") return { ok: false, errorFa: "گام نامعتبر است." };
    const step = s as WorkflowStep;
    if (!step.id || typeof step.id !== "string") return { ok: false, errorFa: "شناسه گام الزامی است." };
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
          if (Array.isArray(btns) && !buttonsAreSafe(btns)) {
            return { ok: false, errorFa: `دکمه‌های گام «${step.id}» نشانی یا داده نامعتبر دارند.` };
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
          if (Array.isArray(menuBtns) && !buttonsAreSafe(menuBtns)) {
            return { ok: false, errorFa: `دکمه‌های گام «${step.id}» نشانی یا داده نامعتبر دارند.` };
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
          // Config validated at runtime against ownership; nothing structural.
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

/** Validate button config arrays against the P1.2 URL/callback policy. */
function buttonsAreSafe(raw: unknown[]): boolean {
  for (const r of raw) {
    if (!r || typeof r !== "object") return false;
    const o = r as Record<string, unknown>;
    if (o.url !== undefined && o.url !== null && safeButtonUrl(o.url) === undefined) return false;
    const cb = o.callbackData ?? o.callback_data;
    if (cb !== undefined && cb !== null && safeCallbackData(cb) === undefined) return false;
    if ((o.url === undefined || o.url === null) && (cb === undefined || cb === null)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------
// Re-export processBaleUpdate for webhook handlers
// ---------------------------------------------------------------------
export { processBaleUpdate };
