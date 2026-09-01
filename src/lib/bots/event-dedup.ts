// =====================================================================
// POSTYAR — C-04/H-03 Durable bot inbound-event inbox
// ---------------------------------------------------------------------
// The single AUTHORITATIVE event-level dedup owner for bot webhook
// processing. The previous mechanism (cache.incr claim with a 24h TTL,
// webhook-guard.claimUpdateOnce) was volatile and at-most-once:
//   * a crash after the claim but before workflow completion made the
//     provider's redelivery land on the existing claim and be dropped
//     forever — the event's workflows never ran;
//   * without REDIS_URL the claim degraded to a per-process Map, so a
//     multi-process deployment could execute the same update twice;
//   * cache eviction could not be distinguished from "never seen".
//
// The DB row (BotInboundEvent + BotWorkflowRun) is now the owner:
//   * UNIQUE (botId, provider, externalEventId) collapses duplicate
//     deliveries atomically in every deployment topology;
//   * status: received → processing → completed | failed → dead;
//   * a 5-minute lease with CAS takeover recovers crashed/abandoned
//     processing (a live lease is never stolen);
//   * failed events with attempts < BOT_EVENT_MAX_ATTEMPTS are
//     retryable — via provider redelivery or the bounded recovery scan
//     the webhook layer runs on every inbound request for the bot;
//   * per-workflow runs are UNIQUE (eventId, workflowId): one event
//     matching N workflows executes each intended workflow exactly
//     once across crashes/retries, and a failed workflow never
//     suppresses its siblings.
// Payment-bearing Bale updates keep their dedicated durable path
// (BalePaymentRef UNIQUE + orderId-keyed CAS + healing re-entry); the
// event row is still recorded for observability but financial
// correctness stays owned by BalePaymentRef.
// =====================================================================
import { db } from "@/lib/db";
import { sanitizeRaw } from "@/lib/providers/util";
import type { Bot, BotInboundEvent } from "@prisma/client";

export const BOT_EVENT_LEASE_MS = 5 * 60 * 1000;
export const BOT_EVENT_MAX_ATTEMPTS = 5;
export const BOT_EVENT_RECOVER_LIMIT = 3;
export const BOT_EVENT_RECOVER_MIN_AGE_MS = 60 * 1000;
const PAYLOAD_MAX_CHARS = 8000;

/** Sanitized, size-capped payload persisted for crash recovery. */
function sanitizePayload(raw: unknown): string | null {
  try {
    const s = JSON.stringify(sanitizeRaw(raw) ?? null);
    if (!s || s === "null") return null;
    return s.length > PAYLOAD_MAX_CHARS ? s.slice(0, PAYLOAD_MAX_CHARS) + "...[truncated]" : s;
  } catch {
    return null;
  }
}

/**
 * Create-or-fetch the durable event row (UNIQUE per bot+provider+event).
 * Safe under concurrency: the UNIQUE constraint collapses races; the
 * loser's upsert degenerates to a no-op refresh of the payload.
 */
export async function ensureBotEvent(
  bot: Pick<Bot, "id">,
  provider: string,
  externalEventId: string,
  rawUpdate: unknown,
): Promise<BotInboundEvent> {
  const payload = sanitizePayload(rawUpdate);
  return db.botInboundEvent.upsert({
    where: {
      botId_provider_externalEventId: {
        botId: bot.id,
        provider,
        externalEventId,
      },
    },
    create: { botId: bot.id, provider, externalEventId, payload },
    update: payload ? { payload } : {},
  });
}

/**
 * CAS claim of the event for processing. Returns true when THIS caller
 * owns the execution. Claimable states:
 *   received (first delivery or abandoned before any claim);
 *   failed with attempts < max (retryable);
 *   processing with an EXPIRED lease (crash/stale takeover).
 * A live lease or a completed/dead event is never claimable.
 */
export async function claimBotEvent(eventId: string): Promise<boolean> {
  const now = new Date();
  const res = await db.botInboundEvent.updateMany({
    where: {
      id: eventId,
      OR: [
        { status: "received" },
        { status: "failed", attempts: { lt: BOT_EVENT_MAX_ATTEMPTS } },
        { status: "processing", leaseUntil: { lt: now } },
      ],
    },
    data: {
      status: "processing",
      attempts: { increment: 1 },
      leaseUntil: new Date(now.getTime() + BOT_EVENT_LEASE_MS),
      lastError: null,
    },
  });
  return res.count === 1;
}

/** Mark a claimed event completed (idempotent; only from processing). */
export async function completeBotEvent(eventId: string): Promise<void> {
  await db.botInboundEvent.updateMany({
    where: { id: eventId, status: "processing" },
    data: { status: "completed", completedAt: new Date(), leaseUntil: null, lastError: null },
  });
}

/**
 * Mark a claimed event failed. Transitions to `dead` once attempts
 * reach BOT_EVENT_MAX_ATTEMPTS (bounded retry, observable terminal).
 */
export async function failBotEvent(eventId: string, errorFa: string): Promise<"failed" | "dead"> {
  const ev = await db.botInboundEvent.findUnique({
    where: { id: eventId },
    select: { attempts: true, status: true },
  });
  if (!ev || ev.status !== "processing") return "failed";
  const dead = ev.attempts >= BOT_EVENT_MAX_ATTEMPTS;
  await db.botInboundEvent.updateMany({
    where: { id: eventId, status: "processing" },
    data: {
      status: dead ? "dead" : "failed",
      lastError: errorFa.slice(0, 500),
      leaseUntil: null,
    },
  });
  return dead ? "dead" : "failed";
}

/**
 * Per-workflow execution record. Guarantees:
 *   * one run row per (event, workflow) — UNIQUE;
 *   * a completed run NEVER executes again (crash/recovery safe);
 *   * a pending/failed run executes exactly once per claim (CAS);
 *   * a failed run does not suppress sibling workflows.
 */
export async function runWorkflowOnceForEvent(
  eventId: string,
  workflowId: string,
  execute: () => Promise<void>,
): Promise<{ executed: boolean; ok: boolean }> {
  const run = await db.botWorkflowRun.upsert({
    where: { eventId_workflowId: { eventId, workflowId } },
    create: { eventId, workflowId },
    update: {},
  });
  if (run.status === "completed") return { executed: false, ok: true };
  const claimed = await db.botWorkflowRun.updateMany({
    where: { id: run.id, status: { in: ["pending", "failed"] } },
    data: { attempts: { increment: 1 }, lastError: null },
  });
  if (claimed.count === 0) return { executed: false, ok: true };
  try {
    await execute();
    await db.botWorkflowRun.updateMany({
      where: { id: run.id, status: { not: "completed" } },
      data: { status: "completed", lastError: null },
    });
    return { executed: true, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
    await db.botWorkflowRun.updateMany({
      where: { id: run.id },
      data: { status: "failed", lastError: msg.slice(0, 500) },
    });
    return { executed: true, ok: false };
  }
}

/**
 * Events eligible for recovery: retryable failures, expired leases,
 * or received rows abandoned before their first claim. Ordered oldest
 * first and bounded so the per-request scan stays O(1)-ish.
 */
export async function listRecoverableBotEvents(botId: string): Promise<BotInboundEvent[]> {
  const now = Date.now();
  return db.botInboundEvent.findMany({
    where: {
      botId,
      OR: [
        { status: "failed", attempts: { lt: BOT_EVENT_MAX_ATTEMPTS } },
        { status: "processing", leaseUntil: { lt: new Date(now) } },
        { status: "received", updatedAt: { lt: new Date(now - BOT_EVENT_RECOVER_MIN_AGE_MS) } },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: BOT_EVENT_RECOVER_LIMIT,
  });
}

/**
 * Bounded recovery pass, executed by the webhook/poller layer for the
 * bot on every inbound request: re-claims stale/retryable events and
 * re-processes them from their stored sanitized payload — crash
 * recovery does NOT depend on the provider redelivering.
 * `process` is the provider-specific handler (same code path as live
 * delivery); it must be replay-safe, which the per-workflow run rows +
 * deterministic action idempotency keys guarantee.
 */
export async function recoverBotEvents(
  bot: Pick<Bot, "id">,
  process: (
    bot: Bot,
    payload: unknown,
    opts: { isRetry: boolean; eventId: string },
  ) => Promise<void>,
): Promise<void> {
  // `process` closes over the full Bot — callers pass it through.
  const events = await listRecoverableBotEvents(bot.id);
  for (const ev of events) {
    if (!(await claimBotEvent(ev.id))) continue;
    if (!ev.payload) {
      await failBotEvent(ev.id, "رویداد بدون payload قابل بازیابی است.");
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(ev.payload);
    } catch {
      await failBotEvent(ev.id, "payload رویداد قابل تجزیه نیست.");
      continue;
    }
    try {
      await process(bot as Bot, parsed, { isRetry: true, eventId: ev.id });
      await completeBotEvent(ev.id);
    } catch (err) {
      await failBotEvent(ev.id, err instanceof Error ? err.message : "خطای بازیابی رویداد.");
    }
  }
}
