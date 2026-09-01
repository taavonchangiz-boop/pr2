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
// Child-run state machine (V6 C-01) — enforced by the claim itself:
//
//     pending ──claim──▶ processing ──ok──▶ completed (IMMUTABLE)
//        ▲                  │  │
//        │                  │  └─failure─▶ failed (retryable)
//        └──retry───────────┘                  │ attempts ≥ max
//        failed ──claim──▶ processing          ▼
//                            │               dead (terminal)
//     processing + EXPIRED lease ──stale takeover──▶ processing
//
//   * the atomic claim SETS status="processing" — a run is never
//     executed while its row still reads pending/failed;
//   * the claim sets a unique owner (lockedBy fencing token);
//   * the heartbeat renews ONLY processing rows owned by that token;
//   * stale takeover requires an EXPIRED lease — a live worker is
//     never stealable; a zombie worker cannot complete/fail/renew a
//     run that was taken over (owner-fenced writes);
//   * completed is immutable (no claim, no completion, no failure can
//     regress it); failures stay retryable until BOT_RUN_MAX_ATTEMPTS,
//     then converge on the terminal dead state.
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
import { isTokenishKey } from "@/lib/providers/util";
import type { Bot, BotInboundEvent } from "@prisma/client";
import { randomUUID } from "node:crypto";

export const BOT_EVENT_LEASE_MS = 5 * 60 * 1000;
export const BOT_EVENT_MAX_ATTEMPTS = 5;
export const BOT_EVENT_RECOVER_LIMIT = 3;
export const BOT_EVENT_RECOVER_MIN_AGE_MS = 60 * 1000;

/** V6 C-01 — a child run retries at most this many times, then dies. */
export const BOT_RUN_MAX_ATTEMPTS = BOT_EVENT_MAX_ATTEMPTS;

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
  /** V5 H-04 — per-step resume cursor; persisted by the run layer so a
   *  retry resumes from the interrupted step (never re-sends delivered
   *  steps). Opaque to this layer. */
  cursor?: unknown;
}

/** V5 H-04 — resume input handed to the execute callback on a retry. */
export interface WorkflowResumeContext {
  /** stepId → next step id chosen on the previous attempt (completed steps). */
  completedNext: Record<string, string>;
  /** stepId → durable outbound history id recorded on a previous attempt. */
  outboundHistory: Record<string, string>;
}

/** Parse a run's stored cursor; corrupt input never executes as progress. */
export function parseRunCursor(raw: string | null | undefined): WorkflowResumeContext {
  const empty: WorkflowResumeContext = { completedNext: {}, outboundHistory: {} };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkflowResumeContext> | null;
    if (!parsed || typeof parsed !== "object") return empty;
    return {
      completedNext:
        parsed.completedNext && typeof parsed.completedNext === "object"
          ? (parsed.completedNext as Record<string, string>)
          : {},
      outboundHistory:
        parsed.outboundHistory && typeof parsed.outboundHistory === "object"
          ? (parsed.outboundHistory as Record<string, string>)
          : {},
    };
  } catch {
    return empty;
  }
}

/**
 * V6 C-04 — the canonical REPLAY envelope.
 *
 * Recovery re-executes the ORIGINAL delivery: the stored payload must be
 * a COMPLETE, faithful representation of the raw provider update. The
 * forensic sanitizer (`sanitizeRaw`) is deliberately lossy (4KB string
 * slicing, 32-element array slicing, depth capping, token-pattern text
 * masking) — running replay payloads through it made recovery execute
 * on silently corrupted data (e.g. a 40-photo album lost entries, a
 * long post text was replayed truncated WITHOUT any marker).
 *
 * The replay envelope is therefore raw JSON with exactly ONE lossy
 * transformation: object keys that are token/secret carriers get their
 * value redacted (M-02 — no credentials at rest). Real provider update
 * structures (message/callback_query/successful_payment/…) never use
 * those key names, so replay fidelity is preserved. Input arrives from
 * `request.json()` — acyclic and JSON-safe by construction; the size
 * bound is the ONLY bound, with an explicit truncation flag.
 */
function redactTokenishKeysDeep(input: unknown, depth = 0): unknown {
  if (depth > 64) return "[max depth]";
  if (input === null || input === undefined) return input;
  if (typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map((v) => redactTokenishKeysDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = isTokenishKey(k) ? "<REDACTED>" : redactTokenishKeysDeep(v, depth + 1);
  }
  return out;
}

/** Complete replay envelope (tokenish keys redacted) + truncation flag. */
function serializeReplayPayload(raw: unknown): { payload: string | null; truncated: boolean } {
  try {
    const s = JSON.stringify(redactTokenishKeysDeep(raw) ?? null);
    if (!s || s === "null") return { payload: null, truncated: false };
    if (s.length > PAYLOAD_MAX_CHARS) {
      // Deliberately NOT valid JSON — combined with the flag and the
      // recovery gate below, a truncated payload can never be replayed
      // as though it were the original update (V6 C-04: it goes DEAD,
      // it does not burn retry attempts).
      return { payload: s.slice(0, PAYLOAD_MAX_CHARS), truncated: true };
    }
    return { payload: s, truncated: false };
  } catch {
    return { payload: null, truncated: false };
  }
}

/**
 * Create-or-fetch the durable event row (UNIQUE per bot+provider+event).
 *
 * V6 C-03 — the FIRST persisted canonical replay payload for an event
 * identity is AUTHORITATIVE and IMMUTABLE: a duplicate delivery (same
 * bot+provider+externalEventId) can never overwrite it, never reset its
 * truncation state. A duplicate whose payload DIFFERS from the canonical
 * one is recorded as an anomaly (AuditLog, best-effort) while the
 * original payload is preserved for recovery. The only permitted
 * write-back is backfilling a first delivery that stored NO valid
 * payload at all (null) — done as a CAS on `payload: null` so two
 * concurrent duplicates can never clobber each other.
 */
export async function ensureBotEvent(
  bot: Pick<Bot, "id">,
  provider: string,
  externalEventId: string,
  rawUpdate: unknown,
): Promise<BotInboundEvent> {
  const { payload, truncated } = serializeReplayPayload(rawUpdate);
  try {
    return await db.botInboundEvent.create({
      data: { botId: bot.id, provider, externalEventId, payload, payloadTruncated: truncated },
    });
  } catch (err) {
    if ((err as { code?: string })?.code !== "P2002") throw err;
    // Duplicate delivery — converge on the EXISTING row, never mutate it.
    const existing = await db.botInboundEvent.findUnique({
      where: {
        botId_provider_externalEventId: { botId: bot.id, provider, externalEventId },
      },
    });
    if (!existing) throw err; // unique says it exists — defensive only
    if (payload && !existing.payload) {
      // First delivery had no usable payload (storage hiccup): backfill
      // the canonical payload with a CAS so a racing duplicate can't
      // double-write; a row that already HAS a payload is never touched.
      const backfilled = await db.botInboundEvent.updateMany({
        where: { id: existing.id, payload: null },
        data: { payload, payloadTruncated: truncated },
      });
      if (backfilled.count === 1) {
        return { ...existing, payload, payloadTruncated: truncated };
      }
      return (await db.botInboundEvent.findUnique({ where: { id: existing.id } })) ?? existing;
    }
    if (payload && existing.payload !== payload) {
      // Duplicate with a DIFFERENT payload — anomaly: the original stays
      // authoritative (recovery keeps replaying the first payload); the
      // mismatch is recorded for forensics and never replaces it.
      console.error(
        "bot inbound duplicate payload anomaly:",
        JSON.stringify({ eventId: existing.id, botId: bot.id, provider, externalEventId }),
      );
      try {
        await db.auditLog.create({
          data: {
            actor: "webhook",
            action: "bot_inbound_duplicate_payload_anomaly",
            targetType: "BotInboundEvent",
            targetId: existing.id,
            meta: JSON.stringify({ botId: bot.id, provider, externalEventId }),
          },
        });
      } catch (auditErr) {
        console.error(
          "duplicate-payload anomaly audit failed:",
          auditErr instanceof Error ? auditErr.message : auditErr,
        );
      }
    }
    return existing;
  }
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
  return (await claimBotEventForOwner(eventId)) !== null;
}

/**
 * V5 C-03 — the SAME claim, returning the lease OWNER (a fencing token).
 * The owner is stored on the row and every subsequent renewal/completion/
 * failure write by this caller is gated on it: after a stale takeover the
 * dispossessed (zombie) worker can no longer touch the row. Production
 * callers (webhook routes, recovery) MUST use this variant and thread the
 * holder through to finalize/fail/renew.
 */
export async function claimBotEventForOwner(eventId: string): Promise<string | null> {
  const now = new Date();
  const holder = randomUUID();
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
        { status: "processing", attempts: { lt: BOT_EVENT_MAX_ATTEMPTS }, leaseUntil: { lt: now } },
      ],
    },
    data: {
      status: "processing",
      attempts: { increment: 1 },
      leaseUntil: new Date(now.getTime() + BOT_EVENT_LEASE_MS),
      lockedBy: holder,
      lastError: null,
    },
  });
  return res.count === 1 ? holder : null;
}

/**
 * Renew the event lease while its worker is alive (H-01 heartbeat).
 * A live worker can therefore never be stolen; only a crashed worker
 * (whose heartbeat stopped) becomes take-overable.
 * V5 C-03 — when a holder is supplied the renewal is FENCED: a worker
 * whose event was taken over can no longer renew the lease it lost.
 */
export async function renewBotEventLease(eventId: string, holder?: string): Promise<void> {
  await db.botInboundEvent.updateMany({
    where: {
      id: eventId,
      status: "processing",
      ...(holder ? { lockedBy: holder } : {}),
    },
    data: { leaseUntil: new Date(Date.now() + BOT_EVENT_LEASE_MS) },
  });
}

/**
 * V5 C-02 — THE single authoritative event-completion transition.
 * The durable event layer itself — never a provider processor's return
 * value — decides whether an event is completed:
 *   * completed ONLY when no child BotWorkflowRun remains pending/
 *     failed/processing (every intended child is terminal-success);
 *   * returns false (and writes nothing) when any child is not
 *     terminal-success, or when the caller lost ownership (stale holder)
 *     — the caller must then fail the event so it stays retryable;
 *   * never infers success merely because a caller returned.
 */
export async function finalizeBotEvent(eventId: string, holder?: string): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const outstanding = await tx.botWorkflowRun.count({
      where: { eventId, status: { not: "completed" } },
    });
    if (outstanding > 0) return false;
    const res = await tx.botInboundEvent.updateMany({
      where: {
        id: eventId,
        status: { in: ["received", "processing"] },
        ...(holder ? { lockedBy: holder } : {}),
      },
      data: {
        status: "completed",
        completedAt: new Date(),
        leaseUntil: null,
        nextRetryAt: null,
        lastError: null,
      },
    });
    return res.count === 1;
  });
}

/**
 * Legacy-name completion entry point — now the C-02 authoritative
 * {@link finalizeBotEvent} (a caller returning is NOT success; a
 * non-terminal child keeps the event un-completed).
 */
export async function completeBotEvent(eventId: string, holder?: string): Promise<void> {
  await finalizeBotEvent(eventId, holder);
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
 *
 * V6 C-04 — `opts.terminal` marks a DELIBERATE dead transition for
 * events that can never be replayed (truncated / missing / unparseable
 * payload): they go dead immediately instead of burning the retry
 * budget on a permanently non-replayable input.
 */
export async function failBotEvent(
  eventId: string,
  errorFa: string,
  holder?: string,
  opts?: { terminal?: boolean },
): Promise<"failed" | "dead"> {
  const ev = await db.botInboundEvent.findUnique({
    where: { id: eventId },
    select: { attempts: true, status: true },
  });
  if (!ev || ev.status !== "processing") return "failed";
  const dead = opts?.terminal === true || ev.attempts >= BOT_EVENT_MAX_ATTEMPTS;
  await db.botInboundEvent.updateMany({
    where: {
      id: eventId,
      status: "processing",
      ...(holder ? { lockedBy: holder } : {}),
    },
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
 * V6 C-01 — atomic claim of a child run. THE state-machine entry point.
 *
 * Claimable (attempts < BOT_RUN_MAX_ATTEMPTS):
 *   * pending   with no lease or an EXPIRED lease;
 *   * failed    (lease is always cleared on failure) — retry;
 *   * processing with an EXPIRED lease — stale/crashed takeover.
 * A live-lease processing run is NEVER stealable; completed/dead are
 * terminal and never claimable. On success the row is transitioned to
 * `processing` in the SAME atomic update that sets the owner fencing
 * token and increments attempts exactly once.
 *
 * Returns the owner token, or null when this caller did not win.
 */
export async function claimBotWorkflowRunForOwner(runId: string): Promise<string | null> {
  const now = new Date();
  const holder = randomUUID();
  const res = await db.botWorkflowRun.updateMany({
    where: {
      id: runId,
      attempts: { lt: BOT_RUN_MAX_ATTEMPTS },
      OR: [
        { status: "pending", OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        { status: "failed", OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        { status: "processing", leaseUntil: { lt: now } },
      ],
    },
    data: {
      // V6 C-01 — the claim itself enters `processing`; the row is never
      // executed while it still reads pending/failed.
      status: "processing",
      attempts: { increment: 1 },
      leaseUntil: new Date(now.getTime() + BOT_EVENT_LEASE_MS),
      lockedBy: holder,
      lastError: null,
    },
  });
  return res.count === 1 ? holder : null;
}

/**
 * V6 C-01 — heartbeat renewal of a run lease. Renews ONLY a row that is
 * still `processing` AND still owned by `holder`: a live worker can
 * never be stolen, and a zombie worker whose run was taken over can no
 * longer renew the lease it lost. Returns true when the renewal landed.
 */
export async function renewBotWorkflowRunLease(runId: string, holder: string): Promise<boolean> {
  const res = await db.botWorkflowRun.updateMany({
    where: { id: runId, status: "processing", lockedBy: holder },
    data: { leaseUntil: new Date(Date.now() + BOT_EVENT_LEASE_MS) },
  });
  return res.count === 1;
}

/**
 * V6 C-01 — commit `completed`. Allowed ONLY from `processing` AND only
 * by the current owner: `completed` is immutable (never regressed) and a
 * zombie worker cannot complete a run taken over by another worker.
 */
export async function completeBotWorkflowRun(runId: string, holder: string): Promise<boolean> {
  const res = await db.botWorkflowRun.updateMany({
    where: { id: runId, status: "processing", lockedBy: holder },
    data: { status: "completed", lastError: null, leaseUntil: null },
  });
  return res.count === 1;
}

/**
 * V6 C-01 — fail a claimed run. Allowed ONLY from `processing` AND only
 * by the current owner. The run becomes `failed` (retryable) until
 * attempts reach BOT_RUN_MAX_ATTEMPTS, then converges on the terminal
 * `dead` state — bounded retries, observable terminal, no infinite
 * resurrection. The resume cursor (V5 H-04) is persisted atomically.
 */
export async function failBotWorkflowRun(
  runId: string,
  holder: string,
  errorFa: string,
  cursor?: unknown,
): Promise<"failed" | "dead"> {
  const row = await db.botWorkflowRun.findUnique({
    where: { id: runId },
    select: { attempts: true },
  });
  const dead = (row?.attempts ?? BOT_RUN_MAX_ATTEMPTS) >= BOT_RUN_MAX_ATTEMPTS;
  await db.botWorkflowRun.updateMany({
    where: { id: runId, status: "processing", lockedBy: holder },
    data: {
      status: dead ? "dead" : "failed",
      lastError: errorFa.slice(0, 500),
      leaseUntil: null,
      ...(cursor !== undefined ? { cursorJson: JSON.stringify(cursor) } : {}),
    },
  });
  return dead ? "dead" : "failed";
}

/**
 * Per-workflow execution record. Guarantees (V4 C-01/H-01, V6 C-01):
 *   * one run row per (event, workflow) — UNIQUE;
 *   * the claim transitions the row pending/failed → `processing`
 *     atomically (owner token + lease + one attempts increment);
 *   * a completed run NEVER executes again and is IMMUTABLE (a late
 *     failure cannot regress it);
 *   * the run carries its own lease: a claimed run whose worker is
 *     alive is renewed by a heartbeat and can never be stolen; a
 *     crashed run's lease expires and the run becomes claimable again
 *     (stale takeover); concurrent workers converge on the CAS;
 *   * the heartbeat renews ONLY processing rows owned by the token, so
 *     a zombie worker cannot keep a lost run alive;
 *   * `completed` is committed ONLY when the callback returns
 *     ok:true — an ok:false result or a thrown error keeps the run
 *     retryable (`failed`), never recorded as success;
 *   * the parent event's lease is renewed by the same heartbeat so the
 *     event lease and the child run lease can never contradict.
 */
export async function runWorkflowOnceForEvent(
  eventId: string,
  workflowId: string,
  execute: (resume: WorkflowResumeContext) => Promise<WorkflowExecutionOutcome>,
  opts?: { eventHolder?: string },
): Promise<{ executed: boolean; ok: boolean; contended?: boolean }> {
  const run = await db.botWorkflowRun.upsert({
    where: { eventId_workflowId: { eventId, workflowId } },
    create: { eventId, workflowId },
    update: {},
  });
  if (run.status === "completed") return { executed: false, ok: true };

  // V6 C-01 — the claim IS the state transition: pending/failed →
  // processing (and processing+expired-lease → processing takeover),
  // with a fresh owner fencing token, in one atomic CAS.
  const runHolder = await claimBotWorkflowRunForOwner(run.id);
  if (runHolder === null) {
    // V5 C-02 (Hole 1) — a contended claim is NOT a legitimate no-op.
    // The run's lease outliving the parent event's lease (mid-sequence
    // crash window, or a partially-failed heartbeat tick) means another
    // worker still owns this child: reporting ok:true here let the
    // aggregate complete the event while the child was still pending and
    // the workflow was lost forever. Distinguish honestly:
    const current = await db.botWorkflowRun.findUnique({
      where: { id: run.id },
      select: { status: true },
    });
    if (current?.status === "completed") return { executed: false, ok: true };
    if (current?.status === "processing") {
      // V6 C-01 — an abandoned `processing` row past the attempt cap can
      // never be claimed again; converge it on the terminal dead state
      // (CAS on expired lease: a worker that JUST took it over no-ops
      // this cleanup). A dead child keeps the parent event un-completed
      // and bounded-retryable until the event itself goes dead.
      await db.botWorkflowRun.updateMany({
        where: {
          id: run.id,
          status: "processing",
          leaseUntil: { lt: new Date() },
          attempts: { gte: BOT_RUN_MAX_ATTEMPTS },
        },
        data: { status: "dead", leaseUntil: null, lockedBy: null },
      });
    }
    return {
      executed: false,
      ok: false,
      contended: true,
    };
  }

  // V5 H-04 — load the durable per-step resume cursor from the previous
  // attempt (if any) so the engine resumes instead of re-sending.
  const resume = parseRunCursor(run.cursorJson);

  // H-01 heartbeat: keep BOTH this run's lease and the parent event's
  // lease alive while the worker is alive. The timer is always cleared
  // (finally) and failures inside a tick are logged, never unhandled.
  // V6 C-01 — the run renewal is FENCED to `processing` rows owned by
  // this holder (renewBotWorkflowRunLease); the event renewal is fenced
  // on its owner so a zombie worker can no longer renew either lease.
  const heartbeat = setInterval(() => {
    Promise.all([
      renewBotWorkflowRunLease(run.id, runHolder),
      opts?.eventHolder
        ? renewBotEventLease(eventId, opts.eventHolder)
        : Promise.resolve(),
    ]).catch((err: unknown) => {
      console.error(
        "bot workflow run lease renewal failed:",
        err instanceof Error ? err.message : err,
      );
    });
  }, Math.floor(BOT_EVENT_LEASE_MS / 3));
  heartbeat.unref?.();

  try {
    const outcome = await execute(resume);
    if (outcome && outcome.ok === true) {
      // V6 C-01 — completed is committed ONLY from processing, only by
      // the owner; a zombie (taken-over) worker cannot complete it.
      await completeBotWorkflowRun(run.id, runHolder);
      return { executed: true, ok: true };
    }
    // C-01: an explicit ok:false is a GENUINE failure — the run stays
    // retryable (or dies at the attempt cap) and is never completed.
    const errorFa = (outcome && outcome.errorFa ? outcome.errorFa : "اجرای گردش کار ناموفق بود.").slice(0, 500);
    await failBotWorkflowRun(run.id, runHolder, errorFa, outcome?.cursor);
    return { executed: true, ok: false };
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
    // V5 H-04 — a crash mid-walk carries the engine's cursor on the
    // error; persist it so the retry resumes from the interrupted step
    // instead of re-sending every already-delivered step.
    const carried = (err as { workflowCursor?: unknown } | null)?.workflowCursor;
    await failBotWorkflowRun(run.id, runHolder, msg, carried);
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
  jobs: Array<{
    workflowId: string;
    execute: (resume: WorkflowResumeContext) => Promise<WorkflowExecutionOutcome>;
  }>,
  opts?: { eventHolder?: string },
): Promise<void> {
  const failedWorkflowIds: string[] = [];
  for (const job of jobs) {
    const r = await runWorkflowOnceForEvent(eventId, job.workflowId, job.execute, {
      eventHolder: opts?.eventHolder,
    });
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
    opts: { isRetry: boolean; eventId: string; holder: string },
  ) => Promise<void>,
): Promise<void> {
  // `process` closes over the full Bot — callers pass it through.
  const events = await listRecoverableBotEvents(bot.id);
  for (const ev of events) {
    const holder = await claimBotEventForOwner(ev.id);
    if (!holder) continue;
    // V4 H-03 / V6 C-04 — a payload that can NEVER be replayed
    // (truncated, missing, unparseable) goes DEAD immediately: a
    // non-replayable event must not burn its retry budget (or any
    // recovery pass) on input that can never succeed.
    if (
      ev.payloadTruncated ||
      (ev.payload != null && ev.payload.endsWith(LEGACY_TRUNCATION_MARKER))
    ) {
      await failBotEvent(
        ev.id,
        "payload رویداد بیش از حد مجاز بزرگ است و برای بازیابی امن قابل استفاده نیست.",
        holder,
        { terminal: true },
      );
      continue;
    }
    if (!ev.payload) {
      await failBotEvent(ev.id, "رویداد بدون payload قابل بازیابی است.", holder, {
        terminal: true,
      });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(ev.payload);
    } catch {
      await failBotEvent(ev.id, "payload رویداد قابل تجزیه نیست.", holder, {
        terminal: true,
      });
      continue;
    }
    try {
      await process(bot as Bot, parsed, { isRetry: true, eventId: ev.id, holder });
      // V5 C-02 — completion is decided by the durable event layer
      // (all children terminal-success), never by the processor's return.
      const done = await finalizeBotEvent(ev.id, holder);
      if (!done) {
        await failBotEvent(
          ev.id,
          "تکمیل رویداد ممکن نبود: یک یا چند گردش کار این رویداد هنوز کامل نشده است.",
          holder,
        );
      }
    } catch (err) {
      await failBotEvent(ev.id, err instanceof Error ? err.message : "خطای بازیابی رویداد.", holder);
    }
  }
}
