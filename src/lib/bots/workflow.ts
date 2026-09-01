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
import { cache } from "@/lib/security/cache";
import { decryptString, hashToken } from "@/lib/security/crypto";
import { audit, safeJsonParse, AuthError } from "@/lib/server/auth";
import { sanitizeRaw } from "@/lib/providers/util";
import { getDestinationProvider, isValidProviderName } from "@/lib/providers";
import type { GlassButton } from "@/lib/types/glass-button";
import { formatRials, toPersianDigits, formatJalaliDateTime } from "@/lib/persian";
import { getActiveSubscription, getQuotaState, createOrderForSubscription } from "@/lib/payments/plans";
import { getBalance } from "@/lib/payments/wallet";
import { processBaleUpdate, baleCreatePaymentRequest } from "@/lib/payments/bale";
import { dispatchAi } from "@/lib/ai/dispatch";
import { notify, type NotificationCategory } from "@/lib/notifications";
import { createTicket, type TicketCategory, type TicketPriority } from "@/lib/tickets";
import { getGoldPrice, type GoldInstrument } from "@/lib/providers/gold";
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
// Idempotency: dedup by (botId, provider, updateId|providerMessageId)
// ---------------------------------------------------------------------
function dedupKey(ctx: WorkflowContext): string | null {
  const id = ctx.updateId ?? ctx.providerMessageId;
  if (id === undefined || id === null || id === "") return null;
  return `bot:upd:${ctx.bot.id}:${ctx.bot.provider}:${String(id)}`;
}

async function isDuplicate(ctx: WorkflowContext): Promise<boolean> {
  const key = dedupKey(ctx);
  if (!key) return false;
  const flag = await cache.get<boolean>(key);
  if (flag === true) return true;
  await cache.set(key, true, 24 * 60 * 60 * 1000);
  return false;
}

// ---------------------------------------------------------------------
// Sanitization for BotHistory.raw — embeds update_id for forensic recovery
// ---------------------------------------------------------------------
function sanitizeForHistory(raw: unknown, ctx: WorkflowContext): string {
  const sanitized = sanitizeRaw(raw);
  // Embed update_id at the top level for forensic recovery (the cache
  // may evict; the DB row should be self-contained).
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

// ---------------------------------------------------------------------
// Persist inbound + outbound BotHistory rows
// ---------------------------------------------------------------------
async function persistInbound(ctx: WorkflowContext, text: string): Promise<void> {
  try {
    await db.botHistory.create({
      data: {
        botId: ctx.bot.id,
        direction: "inbound",
        providerUserId: ctx.providerUserId,
        text: (text ?? "").slice(0, 4000),
        raw: sanitizeForHistory(ctx.rawUpdate, ctx),
      },
    });
  } catch { /* never fail the workflow on persistence */ }
}

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
  // Idempotency check — if we've already processed this update, bail.
  if (await isDuplicate(ctx)) {
    return { ok: true, matched: false, outboundCount: 0 };
  }
  const def = safeJsonParse<WorkflowDef>(ctx.workflow.steps, { steps: [] });
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

  // Persist inbound first (always — even if no workflow matches, the
  // history row matters for inbox forensics).
  await persistInbound(ctx, ctx.incomingMessage ?? "");

  // Resolve linked user once.
  const linkedUser = await findLinkedUser(ctx.bot.id, ctx.providerUserId);

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
      if (!plan || !plan.active) {
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
      const idemKey = `bot:ai:${args.linkedUserId}:${args.ctx.bot.id}:${args.ctx.workflow.id}:${hashToken(prompt).slice(0, 32)}`;
      try {
        const r = await dispatchAi({
          userId: args.linkedUserId,
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
          break;
        }
        case "initiate_payment": {
          const planCode = String(cfg.planCode ?? "").trim();
          if (!planCode) return { ok: false, errorFa: `کد طرح پرداخت در گام «${step.id}» الزامی است.` };
          break;
        }
        case "invoke_ai": {
          const prompt = String(cfg.prompt ?? "").trim();
          // prompt may fall back to the incoming message at runtime; only
          // validate length when a prompt is configured.
          if (prompt.length > 8000) return { ok: false, errorFa: `پرامپت هوش مصنوعی در گام «${step.id}» بیش از حد طولانی است.` };
          break;
        }
        case "create_notification": {
          const title = String(cfg.titleFa ?? "").trim();
          if (!title) return { ok: false, errorFa: `عنوان اعلان در گام «${step.id}» الزامی است.` };
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
