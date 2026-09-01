// =====================================================================
// POSTYAR — Durable bot inbound-event inbox (single authoritative dedup
// owner for bot webhook processing)
// ---------------------------------------------------------------------
// The DB row (BotInboundEvent + BotWorkflowRun) is the owner:
//   * UNIQUE (botId, provider, externalEventId) collapses duplicate
//     deliveries atomically in every deployment topology;
//   * status: received → processing → completed | failed → dead;
//   * a 5-minute lease with CAS takeover recovers crashed/abandoned
//     processing — a LIVE lease is renewed by its worker (heartbeat) so
//     a live worker can never be stolen, and an expired lease is the
//     crash signal (V4 H-01);
//   * failed events carry a durable nextRetryAt (bounded exponential
//     backoff + jitter) — recovery NEVER hot-loops a just-failed event
//     and every instance honors the same schedule (V4 H-02);
//   * payloads are stored as a bounded sanitized representation with an
//     EXPLICIT truncation marker — a truncated payload is never replayed
//     as though it were the original update (V4 H-03);
//   * per-workflow runs are UNIQUE (eventId, workflowId) with their own
//     execution lease: one event matching N workflows executes each
//     exactly once across crashes/retries; a failed workflow never
//     suppresses its siblings; event completion NEVER implies child
//     completion — a failed child keeps the event retryable and
//     recovery re-runs ONLY the failed child (V4 C-01/C-02).
//
// Execution-result contract (V4 C-01):
//   * a run's callback returns { ok: true }  → legitimate (incl. no-op);
//   * { ok: false, errorFa } or a throw      → genuine failure: the run
//     stays `failed` (retryable) and is NEVER recorded as completed;
//   * `completed` is committed ONLY on explicit success and is immutable.
//
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

// V4 H-02 — bounded exponential backoff: attempt N waits
// min(30s * 2^(N-1), 60min) plus up to 30s of jitter.
const BACKOFF_BASE_MS = 30 * 1000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;
const BACKOFF_JITTER_MS = 30 * 1000;

// V4 H-03 — the sanitized payload is bounded but COMPLETE for realistic
// updates; anything beyond the bound is explicitly marked truncated and
// is never replayed.
const PAYLOAD_MAX_CHARS = 65536;
const LEGACY_TRUNCATION_MARKER = "...[truncated]";

export class EventPartiallyFailedError extends Error {
  readonly failedWorkflowIds: string[];
  constructor(failedWorkflowIds: string[]) {
    super("یک یا چند گردش کار این رویداد ناموفق بود.");
    this.name = "EventPartiallyFailedError";
    this.failedWorkflowIds = failedWorkflowIds;
  }
}

export interface WorkflowExecutionOutcome {
  /** true = legitimate outcome (success or non-failure no-op). */
  ok: boolean;
  /** Bounded Persian failure description when ok is false. */
  errorFa?: string;
}

/** Sanitized, size-capped payload + explicit truncation flag (H-03). */
function sanitizePayload(raw: unknown): { payload: string | null; truncated: boolean } {
  try {
    const s = JSON.stringify(sanitizeRaw(raw) ?? null);
    if (!s || s === "null") return { payload: null, truncated: false };
    if (s.length > PAYLOAD_MAX_CHARS) {
      // Deliberately NOT valid JSON — combined with the flag and the
      // recovery gate below, a truncated payload can never be replayed
      // as though it were the original update.
      return { payload: s.slice(0, PAYLOAD_MAX_CHARS), truncated: true };
    }
    return { payload: s, truncated: false };
  } catch {
    return { payload: null, truncated: false };
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
  const { payload, truncated } = sanitizePayload(rawUpdate);
  return db.botInboundEvent.upsert({
    where: {
      botId_provider_externalEventId: {
        botId: bot.id,
        provider,
        externalEventId,
      },
    },
    create: { botId: bot.id, provider, externalEventId, payload, payloadTruncated: truncated },
    update: payload ? { payload, payloadTruncated: truncated } : {},
  });
}

/**
 * CAS claim of the event for processing. Returns true when THIS caller
 * owns the execution. Claimable states:
 *   received (first delivery or abandoned before any claim);
 *   failed with attempts < max AND its durable backoff elapsed
 *     (nextRetryAt null = legacy/pre-schedule row → retryable now);
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
        {
          status: "failed",
          attempts: { lt: BOT_EVENT_MAX_ATTEMPTS },
          OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
        },
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

/**
 * Renew the event lease while its worker is alive (H-01 heartbeat).
 * A live worker can therefore never be stolen; only a crashed worker
 * (whose heartbeat stopped) becomes take-overable.
 */
export async function renewBotEventLease(eventId: string): Promise<void> {
  await db.botInboundEvent.updateMany({
    where: { id: eventId, status: "processing" },
    data: { leaseUntil: new Date(Date.now() + BOT_EVENT_LEASE_MS) },
  });
}

/** Mark a claimed event completed (idempotent; only from processing). */
export async function completeBotEvent(eventId: string): Promise<void> {
  await db.botInboundEvent.updateMany({
    where: { id: eventId, status: "processing" },
    data: { status: "completed", completedAt: new Date(), leaseUntil: null, lastError: null },
  });
}

function computeNextRetryAt(attempts: number): Date {
  const exp = Math.min(Math.max(attempts - 1, 0), 12);
  const base = Math.min(BACKOFF_BASE_MS * 2 ** exp, BACKOFF_CAP_MS);
  const jitter = Math.random() * BACKOFF_JITTER_MS;
  return new Date(Date.now() + base + jitter);
}

/**
 * Mark a claimed event failed. Persists a durable retry schedule
 * (exponential backoff + jitter) so neither this instance nor any other
 * instance can hot-loop the failure. Transitions to `dead` once
 * attempts reach BOT_EVENT_MAX_ATTEMPTS (bounded retry, observable
 * terminal state).
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
      nextRetryAt: dead ? null : computeNextRetryAt(ev.attempts),
    },
  });
  return dead ? "dead" : "failed";
}

/**
 * Per-workflow execution record. Guarantees (V4 C-01/H-01):
 *   * one run row per (event, workflow) — UNIQUE;
 *   * a completed run NEVER executes again and is IMMUTABLE (a late
 *     failure cannot regress it);
 *   * the run carries its own lease: a claimed run whose worker is
 *     alive is renewed by a heartbeat and can never be stolen; a
 *     crashed run's lease expires and the run becomes claimable again
 *     (stale takeover); concurrent workers converge on the CAS;
 *   * `completed` is committed ONLY when the callback returns
 *     ok:true — an ok:false result or a thrown error keeps the run
 *     `failed` (retryable), never recorded as success;
 *   * the parent event's lease is renewed by the same heartbeat so the
 *     event lease and the child run lease can never contradict.
 */
export async function runWorkflowOnceForEvent(
  eventId: string,
  workflowId: string,
  execute: () => Promise<WorkflowExecutionOutcome>,
): Promise<{ executed: boolean; ok: boolean }> {
  const run = await db.botWorkflowRun.upsert({
    where: { eventId_workflowId: { eventId, workflowId } },
    create: { eventId, workflowId },
    update: {},
  });
  if (run.status === "completed") return { executed: false, ok: true };

  const now = new Date();
  const claimed = await db.botWorkflowRun.updateMany({
    where: {
      id: run.id,
      status: { in: ["pending", "failed"] },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: {
      attempts: { increment: 1 },
      leaseUntil: new Date(now.getTime() + BOT_EVENT_LEASE_MS),
      lastError: null,
    },
  });
  if (claimed.count === 0) return { executed: false, ok: true };

  // H-01 heartbeat: keep BOTH this run's lease and the parent event's
  // lease alive while the worker is alive. The timer is always cleared
  // (finally) and failures inside a tick are logged, never unhandled.
  const heartbeat = setInterval(() => {
    Promise.all([
      db.botWorkflowRun.updateMany({
        where: { id: run.id, status: "pending" },
        data: { leaseUntil: new Date(Date.now() + BOT_EVENT_LEASE_MS) },
      }),
      renewBotEventLease(eventId),
    ]).catch((err: unknown) => {
      console.error(
        "bot workflow run lease renewal failed:",
        err instanceof Error ? err.message : err,
      );
    });
  }, Math.floor(BOT_EVENT_LEASE_MS / 3));
  heartbeat.unref?.();

  try {
    const outcome = await execute();
    if (outcome && outcome.ok === true) {
      await db.botWorkflowRun.updateMany({
        where: { id: run.id, status: { not: "completed" } },
        data: { status: "completed", lastError: null, leaseUntil: null },
      });
      return { executed: true, ok: true };
    }
    // C-01: an explicit ok:false is a GENUINE failure — the run stays
    // retryable and is never recorded as completed.
    const errorFa = (outcome && outcome.errorFa ? outcome.errorFa : "اجرای گردش کار ناموفق بود.").slice(0, 500);
    await db.botWorkflowRun.updateMany({
      where: { id: run.id, status: { not: "completed" } },
      data: { status: "failed", lastError: errorFa, leaseUntil: null },
    });
    return { executed: true, ok: false };
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
    await db.botWorkflowRun.updateMany({
      where: { id: run.id, status: { not: "completed" } },
      data: { status: "failed", lastError: msg.slice(0, 500), leaseUntil: null },
    });
    return { executed: true, ok: false };
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * C-02 — event-level aggregation. Runs each matched workflow at most
 * once (via {@link runWorkflowOnceForEvent}) and THROWS
 * {@link EventPartiallyFailedError} when ANY child failed, so the
 * caller marks the EVENT failed/retryable instead of completed. On a
 * later recovery pass, completed children short-circuit (never repeat)
 * and only failed children re-execute.
 */
export async function runMatchedWorkflowsForEvent(
  eventId: string,
  jobs: Array<{ workflowId: string; execute: () => Promise<WorkflowExecutionOutcome> }>,
): Promise<void> {
  const failedWorkflowIds: string[] = [];
  for (const job of jobs) {
    const r = await runWorkflowOnceForEvent(eventId, job.workflowId, job.execute);
    if (!r.ok) failedWorkflowIds.push(job.workflowId);
  }
  if (failedWorkflowIds.length > 0) {
    throw new EventPartiallyFailedError(failedWorkflowIds);
  }
}

/**
 * Events eligible for recovery: retryable failures whose durable
 * backoff has elapsed, expired leases, or received rows abandoned
 * before their first claim. Ordered oldest first and bounded so the
 * per-request scan stays O(1)-ish.
 */
export async function listRecoverableBotEvents(botId: string): Promise<BotInboundEvent[]> {
  const now = Date.now();
  return db.botInboundEvent.findMany({
    where: {
      botId,
      OR: [
        {
          status: "failed",
          attempts: { lt: BOT_EVENT_MAX_ATTEMPTS },
          OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date(now) } }],
        },
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
 * delivery); it must throw when any intended workflow failed (the
 * routes do this via runMatchedWorkflowsForEvent), so the event is NOT
 * completed while a child remains failed.
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
    // V4 H-03 — a deliberately truncated payload is NEVER replayed as
    // though it were the original update. Both the explicit flag and
    // the legacy byte-slice marker gate here; the event fails with a
    // clear diagnostic instead of executing on corrupt input.
    if (
      ev.payloadTruncated ||
      (ev.payload != null && ev.payload.endsWith(LEGACY_TRUNCATION_MARKER))
    ) {
      await failBotEvent(ev.id, "payload رویداد بیش از حد مجاز بزرگ است و برای بازیابی امن قابل استفاده نیست.");
      continue;
    }
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
