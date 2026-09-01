// POSTYAR — /api/bots/incoming/rubika
// Rubika does NOT support outbound webhooks. This endpoint is invoked
// by a CRON POLLER that calls Rubika's `get_updates` long-poll, then
// pushes each update here for processing. Cron-protected via
// `requireCronSecret` from `@/lib/server/cron-secret`.
//
// Body:
//   { botId: string, lastUpdateId?: number }
//
// Behavior:
//   1. Verify cron secret header.
//   2. Load the bot. Verify owner-less (cron owns this) — but verify the
//      bot exists and is active.
//   3. Call Rubika `get_updates` (offset = lastUpdateId + 1).
//   4. For each update: durable BotInboundEvent claim (C-04/H-03), then
//      dispatch to the workflow engine (matching message/callback) — or
//      persist inbound for inbox forensics.
//   5. Return { processed: N, lastUpdateId }.
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { decryptString } from "@/lib/security/crypto";
import { requireCronSecret } from "@/lib/server/cron-secret";
import { audit } from "@/lib/server/auth";
import {
  ensureBotEvent,
  claimBotEvent,
  completeBotEvent,
  failBotEvent,
  recoverBotEvents,
  runWorkflowOnceForEvent,
} from "@/lib/bots/event-dedup";
import { executeWorkflow, persistInboundOnce } from "@/lib/bots/workflow";
import type { Bot, BotWorkflow } from "@prisma/client";

const PollSchema = z.object({
  botId: z.string().min(1),
  lastUpdateId: z.number().int().optional(),
});

interface RubikaUpdate {
  update_id?: number | string;
  message?: {
    message_id?: number | string;
    chat_id?: string;
    object_id?: string;
    text?: string;
    caption?: string;
    from?: { id?: string };
  };
  callback_query?: {
    callback_id?: string;
    from?: { id?: string };
    data?: string;
    message?: { message_id?: number | string; chat_id?: string };
  };
}

const RUBIKA_API_BASE = "https://api.rubika.com/v1";
const TIMEOUT_MS = 30_000; // long-poll

async function rubikaGetUpdates(botToken: string, offset: number): Promise<{ ok: boolean; updates?: RubikaUpdate[]; errorFa?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(`${RUBIKA_API_BASE}/getUpdates`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bot ${botToken}`,
      },
      body: JSON.stringify({
        offset: offset > 0 ? offset : undefined,
        timeout: 25, // long-poll 25s
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!res.ok) {
      return { ok: false, errorFa: "خطا در نظرسنجی روبیکا." };
    }
    const env = (json ?? {}) as { ok?: boolean; status?: string; result?: RubikaUpdate[] };
    if (env.ok === true || env.status === "OK") {
      return { ok: true, updates: Array.isArray(env.result) ? env.result : [] };
    }
    return { ok: false, errorFa: "پاسخ نامعتبر از روبیکا." };
  } catch {
    return { ok: false, errorFa: "اتصال به سرویس روبیکا ناموفق بود." };
  }
}

export async function POST(req: Request) {
  // Cron-protected
  const cs = await requireCronSecret(req);
  if (!cs.ok) {
    return NextResponse.json({ ok: false, errorFa: cs.errorFa }, { status: 401 });
  }
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsed = PollSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }
  const bot = await db.bot.findUnique({ where: { id: parsed.data.botId } });
  if (!bot) {
    return NextResponse.json({ ok: false, errorFa: "ربات یافت نشد." }, { status: 404 });
  }
  if (bot.provider !== "rubika") {
    return NextResponse.json({ ok: false, errorFa: "پروایدر ناهماهنگ است." }, { status: 400 });
  }
  if (bot.status !== "active") {
    return NextResponse.json({ ok: false, errorFa: "ربات فعال نیست." }, { status: 400 });
  }
  let botToken = "";
  try { botToken = decryptString(bot.botTokenEnc); } catch {
    return NextResponse.json({ ok: false, errorFa: "توکن قابل رمزگشایی نیست." }, { status: 500 });
  }

  const offset = parsed.data.lastUpdateId ? parsed.data.lastUpdateId + 1 : 0;
  const r = await rubikaGetUpdates(botToken, offset);
  if (!r.ok || !r.updates) {
    return NextResponse.json({ ok: false, errorFa: r.errorFa ?? "نظرسنجی ناموفق بود." }, { status: 502 });
  }
  const updates = r.updates;
  let processed = 0;
  let lastUpdateId = parsed.data.lastUpdateId ?? 0;

  for (const update of updates) {
    const uid = typeof update.update_id === "number" ? update.update_id :
      typeof update.update_id === "string" ? Number(update.update_id) : 0;
    if (Number.isFinite(uid) && uid > lastUpdateId) lastUpdateId = uid;

    if (Number.isFinite(uid) && uid !== 0) {
      // C-04/H-03 — durable BotInboundEvent claim (replaces the volatile
      // cache.incr claim): duplicates collapse on the UNIQUE constraint,
      // a crash after the claim is retryable via lease takeover and the
      // bounded recovery pass instead of lost forever.
      const event = await ensureBotEvent(bot, "rubika", String(uid), update);
      const claimed = await claimBotEvent(event.id);
      if (!claimed) continue;
      try {
        await processRubikaUpdate(bot, update, {
          isRetry: event.attempts > 1,
          eventId: event.id,
        });
        await completeBotEvent(event.id);
      } catch (err) {
        await failBotEvent(
          event.id,
          err instanceof Error ? `${err.name}: ${err.message}` : "خطای پردازش رویداد.",
        );
      }
    } else {
      // No dedup key available — process without dedup (audit W3:
      // distinct updates must never collapse onto one shared key).
      try {
        await processRubikaUpdate(bot, update, { isRetry: false, eventId: null });
      } catch (err) {
        await audit({
          userId: bot.ownerId,
          actor: "system",
          action: "bot_workflow_execute_failed",
          targetType: "bot",
          targetId: bot.id,
          meta: { name: err instanceof Error ? err.name : "Error", unkeyed: true },
        });
      }
    }
    processed++;
  }

  // Bounded crash-recovery pass for this bot (C-04/H-03).
  await recoverBotEvents(bot, (b, payload, o) => processRubikaUpdate(b, payload as RubikaUpdate, o));

  return NextResponse.json({ ok: true, processed, lastUpdateId });
}

/**
 * Provider-specific processing for one Rubika update — shared by live
 * polling and durable recovery. `eventId` is null only for updates with
 * no usable update_id (no dedup key — audit W3); those run without
 * per-event run rows. Replay-safety otherwise: link-code consumption is
 * one-time (DB UNIQUE) and side-effecting actions carry deterministic
 * idempotency keys.
 */
async function processRubikaUpdate(
  bot: Bot,
  update: RubikaUpdate,
  opts: { isRetry: boolean; eventId: string | null },
): Promise<void> {
  const uid = typeof update.update_id === "number" ? update.update_id :
    typeof update.update_id === "string" ? Number(update.update_id) : 0;

  // Extract chat + text
  let chatId = "";
  let incomingText = "";
  let callbackQueryId: string | undefined;
  let providerMessageId: string | number | undefined;
  if (update.message) {
    chatId = String(update.message.chat_id ?? update.message.object_id ?? update.message.from?.id ?? "");
    incomingText = update.message.text ?? update.message.caption ?? "";
    providerMessageId = update.message.message_id;
  } else if (update.callback_query) {
    callbackQueryId = update.callback_query.callback_id;
    chatId = String(update.callback_query.from?.id ?? update.callback_query.message?.chat_id ?? "");
    incomingText = update.callback_query.data ?? "";
  }
  if (!chatId) return;

  // C-11/C-12: persist the inbound history row ONCE per event (owned by
  // the poller layer, not per workflow). Skipped on durable retries.
  if (!opts.isRetry) {
    await persistInboundOnce(bot, chatId, incomingText, update, uid, providerMessageId);
  }

  // Link-code consumption attempt.
  if (incomingText.startsWith("POSTYAR-")) {
    const { consumeLinkCode } = await import("@/lib/bots/link");
    const result = await consumeLinkCode({
      botId: bot.id,
      code: incomingText.trim(),
      providerUserId: chatId,
    });
    const reply = result.ok
      ? "حساب پُست‌یار شما با موفقیت به این ربات متصل شد."
      : (result.errorFa ?? "اتصال ناموفق بود.");
    try {
      const { getDestinationProvider } = await import("@/lib/providers");
      const provider = getDestinationProvider("rubika");
      await provider.publishMessage({ botToken: decryptString(bot.botTokenEnc), chatId, text: reply });
      await db.botHistory.create({
        data: {
          botId: bot.id,
          direction: "outbound",
          providerUserId: chatId,
          userId: result.userId ?? null,
          text: reply.slice(0, 4000),
        },
      });
    } catch { /* best-effort */ }
    return;
  }

  // Workflow dispatch — per-event UNIQUE run rows guarantee exactly-once
  // execution per intended workflow across retries and recovery.
  const workflows = await db.botWorkflow.findMany({
    where: { botId: bot.id, enabled: true },
    take: 50,
  });
  for (const wf of workflows) {
    if (!matchesTrigger(wf, incomingText)) continue;
    if (opts.eventId === null) {
      // No dedup key: run directly (previous semantics, never collapsed).
      try {
        await executeWorkflow({
          bot,
          providerUserId: chatId,
          rawUpdate: update,
          incomingMessage: incomingText,
          callbackQueryId,
          updateId: uid,
          providerMessageId,
          workflow: wf,
        });
      } catch (err) {
        await audit({
          userId: bot.ownerId,
          actor: "system",
          action: "bot_workflow_execute_failed",
          targetType: "bot",
          targetId: bot.id,
          meta: { workflowId: wf.id, name: err instanceof Error ? err.name : "Error", unkeyed: true },
        });
      }
      continue;
    }
    const r = await runWorkflowOnceForEvent(opts.eventId, wf.id, async () => {
      await executeWorkflow({
        bot,
        providerUserId: chatId,
        rawUpdate: update,
        incomingMessage: incomingText,
        callbackQueryId,
        updateId: uid,
        providerMessageId,
        workflow: wf,
      });
    });
    if (!r.ok) {
      await audit({
        userId: bot.ownerId,
        actor: "system",
        action: "bot_workflow_execute_failed",
        targetType: "bot",
        targetId: bot.id,
        meta: { workflowId: wf.id, eventId: opts.eventId },
      });
    }
  }
}

function matchesTrigger(wf: BotWorkflow, incomingText: string): boolean {
  if (wf.triggerKind === "command") {
    if (!incomingText) return false;
    const val = (wf.triggerValue ?? "").trim().toLowerCase();
    if (!val) return false;
    return incomingText.toLowerCase().startsWith(`/${val}`);
  }
  if (wf.triggerKind === "callback") {
    if (!incomingText) return false;
    return incomingText === (wf.triggerValue ?? "");
  }
  return true;
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "postyar-bot-cron-rubika",
    noteFa: "این نقطه پایانی توسط زمان‌بند فراخوانی می‌شود؛ روبیکا از وب‌هوک پشتیبانی نمی‌کند.",
  });
}
