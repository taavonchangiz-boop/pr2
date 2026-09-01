// =====================================================================
// POSTYAR — Publish worker
// ---------------------------------------------------------------------
// runWorkerOnce():
//   - Claim up to N (default 5) `queued` jobs whose runAt <= now and
//     not currently locked. Each claim uses `acquireLock` to coordinate
//     across multiple processes (Redis-shaped lock).
//   - For each claimed job:
//       1. Set status=processing, lockedBy=<holder>, lockedAt=now.
//       2. Load Content + Destination.
//       3. Decrypt botToken.
//       4. Resolve provider.
//       5. Convert content + buttons → provider payload.
//       6. Call publishMessage.
//       7. On success: mark job `delivered`, set deliveredAt; the content
//          outcome is then RECONCILED (reconcileContentOutcome): all
//          destinations delivered → Content `delivered`; some delivered,
//          some definitively not → `partial` (V5 H-16); none → `failed`.
//          A Notification row is fired per delivery.
//       8. On failure: increment attempts; if attempts >= maxAttempts →
//          `failed`; else revert to `queued` with exponential backoff
//          (next runAt = now + 2^attempts * 30s, capped at 30 minutes).
//   - Release lock in finally. Returns a summary.
//
// V5 H-16 — uncertain outcomes: the reaper NEVER re-queues a stale
// `processing` job whose durable pre-send marker (deliveryAttemptedAt)
// is set — the provider call already went out, so its result is
// unknowable from the DB alone. Such a job transitions to `failed` with
// a bounded Persian uncertainty note + resultPayload {uncertain:true}.
// Re-queueing it would double-send (provider APIs have no idempotent
// send); marking it delivered would claim an unconfirmed success.
//
// All content status writes are CAS (updateMany where status ∈
// sourcesFor(target), count verified) — see publishing/state.ts.
//
// We do NOT log tokens, chat IDs, or sanitized raw payloads to stdout.
// Audit rows store only the Persian error message + a small JSON blob.
// =====================================================================
import { db } from "@/lib/db";
import { acquireLock, releaseLock } from "@/lib/security/cache";
import { getDestinationProvider, isValidProviderName } from "@/lib/providers/index";
import { getDestinationToken } from "@/lib/destinations/helpers";
import { safeJsonParse } from "@/lib/server/auth";
import { signMediaUrlToken } from "@/lib/security/crypto";
import { sourcesFor } from "@/lib/publishing/state";
import type { GlassButton } from "@/lib/types/glass-button";
import { getSetting } from "@/lib/providers/util";

export interface WorkerSummary {
  processed: number;
  delivered: number;
  failed: number;
  retried: number;
  errors: Array<{ jobId: string; errorFa: string }>;
}

const DEFAULT_BATCH = 5;
const BASE_BACKOFF_SEC = 30;
const MAX_BACKOFF_SEC = 30 * 60;
// V5 H-16 — bounded Persian note persisted on uncertain-outcome jobs
// (reaped AFTER the pre-send marker was written) and on the content
// when the uncertain job is the reason the content cannot be delivered.
export const UNCERTAIN_DELIVERY_FA =
  "ارسال انجام شد اما نتیجه آن نامشخص ماند؛ برای جلوگیری از ارسال تکراری، تلاش مجدد خودکار انجام نشد.";
// V5 H-16 — content-level note for the `partial` outcome.
const PARTIAL_OUTCOME_FA = "ارسال به برخی از مقصدها ناموفق بود؛ برای موارد باقی‌مانده می‌توانید تلاش مجدد کنید.";
const NON_TERMINAL_JOB_STATUSES: readonly string[] = ["queued", "processing"];
// A job left in `processing` longer than this is considered orphaned
// (its worker crashed or the process died mid-publish). The lease is
// deliberately much longer than the publish timeout so a LIVE publish
// can never be re-claimed (§22/§24).
const STALE_LEASE_MS = 10 * 60 * 1000;

function computeBackoffSec(attempts: number): number {
  const s = Math.pow(2, attempts) * BASE_BACKOFF_SEC;
  return Math.min(s, MAX_BACKOFF_SEC);
}

/**
 * ROOT-CAUSE FIX (audit §24 — crash recovery): jobs stuck in
 * `processing` were never retried — a worker crash (or OOM kill) between
 * the provider call and the status update left the job (and its Content)
 * permanently frozen, because the candidate query only selects `queued`.
 * This reaper re-claims orphaned jobs whose lease expired.
 *
 * V5 H-16 — UNCERTAIN OUTCOMES: the decision is now gated on the durable
 * pre-send marker (PublishJob.deliveryAttemptedAt):
 *
 *   deliveryAttemptedAt IS SET  → the provider call already went out (or
 *     was in flight) when the worker died. The outcome is unknowable:
 *     re-queueing would double-send and marking delivered would claim an
 *     unconfirmed success. The job transitions to `failed` carrying the
 *     bounded Persian uncertainty note + resultPayload {"uncertain":true}.
 *     NO requeue, NO re-send — ever.
 *
 *   deliveryAttemptedAt IS NULL → the send never went out; the orphan is
 *     safe to retry. Requeued with the standard exponential backoff,
 *     honoring maxAttempts (exhausted orphans → failed).
 *
 * After every terminal reaper decision the content outcome is reconciled
 * (the old code left orphan-failed contents frozen in `processing`).
 */
export async function reclaimStaleProcessingJobs(): Promise<number> {
  const staleBefore = new Date(Date.now() - STALE_LEASE_MS);
  const stale = await db.publishJob.findMany({
    where: { status: "processing", lockedAt: { lt: staleBefore } },
    select: {
      id: true,
      contentId: true,
      attempts: true,
      maxAttempts: true,
      deliveryAttemptedAt: true,
    },
    take: 20,
  });
  let reclaimed = 0;
  for (const job of stale) {
    if (job.deliveryAttemptedAt) {
      // Uncertain outcome — see the H-16 note above. Conditional on the
      // job still being processing with an expired lease (CAS).
      const res = await db.publishJob.updateMany({
        where: { id: job.id, status: "processing", lockedAt: { lt: staleBefore } },
        data: {
          status: "failed",
          attempts: job.attempts + 1,
          failureReason: UNCERTAIN_DELIVERY_FA,
          resultPayload: sanitizeResultPayload({ uncertain: true }),
          lockedBy: null,
          lockedAt: null,
        },
      });
      if (res.count > 0) {
        reclaimed += res.count;
        await reconcileContentOutcome(job.contentId, UNCERTAIN_DELIVERY_FA);
      }
      continue;
    }
    const attempts = job.attempts + 1;
    if (attempts >= job.maxAttempts) {
      const res = await db.publishJob.updateMany({
        where: { id: job.id, status: "processing", lockedAt: { lt: staleBefore } },
        data: {
          status: "failed",
          attempts,
          failureReason: "مهلت پردازش منقضی شد (worker از دست رفت).",
          lockedBy: null,
          lockedAt: null,
        },
      });
      if (res.count > 0) {
        reclaimed += res.count;
        await reconcileContentOutcome(job.contentId, "مهلت پردازش منقضی شد (worker از دست رفت).");
      }
    } else {
      const backoffSec = computeBackoffSec(attempts);
      const res = await db.publishJob.updateMany({
        where: { id: job.id, status: "processing", lockedAt: { lt: staleBefore } },
        data: {
          status: "queued",
          attempts,
          runAt: new Date(Date.now() + backoffSec * 1000),
          lockedBy: null,
          lockedAt: null,
          failureReason: "پردازش ناتمام ماند و برای تلاش مجدد بازگردانده شد.",
        },
      });
      reclaimed += res.count;
    }
  }
  return reclaimed;
}

function sanitizeResultPayload(raw: unknown): string {
  // Bound size for DB column
  try {
    const s = JSON.stringify(raw ?? {});
    if (s.length > 4000) return s.slice(0, 4000) + "...[truncated]";
    return s;
  } catch {
    return "{}";
  }
}

export async function runWorkerOnce(batchSize: number = DEFAULT_BATCH): Promise<WorkerSummary> {
  const summary: WorkerSummary = { processed: 0, delivered: 0, failed: 0, retried: 0, errors: [] };
  const now = new Date();

  // Crash recovery first (audit §24): re-queue orphaned processing jobs.
  await reclaimStaleProcessingJobs();

  // Claim queued jobs whose runAt is in the past.
  // We select candidates first, then attempt lock acquisition individually.
  // This is the SQLite-friendly way (no SELECT FOR UPDATE SKIP LOCKED).
  const candidates = await db.publishJob.findMany({
    where: {
      status: "queued",
      runAt: { lte: now },
    },
    orderBy: { runAt: "asc" },
    take: Math.max(1, Math.min(batchSize, 20)),
  });

  for (const job of candidates) {
    const lockKey = `publish-job:${job.id}`;
    // P1.12: lock TTL must exceed the provider call timeout (+ margin) so a
    // LIVE worker never loses its lock while still publishing. Provider
    // fetches time out at ~30s; 5 minutes gives a wide safety margin. The
    // 10-minute stale DB lease remains the authoritative crash-recovery
    // bound (and is longer than this TTL, so an active job can never be
    // reclaimed by the reaper while its lock is alive).
    const holder = await acquireLock(lockKey, 5 * 60_000);
    if (!holder) continue; // another worker is on it
    try {
      const result = await processJob(job.id, holder);
      summary.processed += 1;
      if (result.outcome === "delivered") summary.delivered += 1;
      else if (result.outcome === "failed") summary.failed += 1;
      else if (result.outcome === "retried") summary.retried += 1;
      if (result.errorFa) summary.errors.push({ jobId: job.id, errorFa: result.errorFa });
    } finally {
      await releaseLock(lockKey, holder);
    }
  }
  return summary;
}

async function processJob(
  jobId: string,
  holder: string,
): Promise<{ outcome: "delivered" | "failed" | "retried"; errorFa?: string }> {
  // Reload to ensure we still hold the latest state under the lock.
  const job = await db.publishJob.findUnique({ where: { id: jobId } });
  if (!job) return { outcome: "failed", errorFa: "کار یافت نشد." };
  if (job.status !== "queued") {
    // Already taken by another worker or terminal — skip.
    return { outcome: "retried", errorFa: undefined };
  }

  // Mark as processing under this lock — CONDITIONALLY on the job still
  // being `queued` and unleased (P1.12.6: a stale-lease reaper or another
  // worker may have moved it between our candidate read and now).
  const claimed = await db.publishJob.updateMany({
    where: { id: jobId, status: "queued" },
    data: {
      status: "processing",
      lockedBy: holder.slice(0, 64),
      lockedAt: new Date(),
    },
  });
  if (claimed.count === 0) {
    return { outcome: "retried", errorFa: undefined };
  }

  // Move the Content into `processing` so the terminal delivered/failed
  // transitions below are reachable. Previously NOTHING performed
  // queued→processing, so maybeMarkContentDelivered/Failed hit an
  // invalid-transition guard and content was stuck in `queued` forever.
  // `scheduled` is promoted as well: the scheduled→queued→processing chain
  // collapses at claim time (a due scheduled job IS being processed now;
  // no other code path performs the scheduled→queued promotion).
  await db.content.updateMany({
    where: { id: job.contentId, status: { in: ["queued", "scheduled"] } },
    data: { status: "processing" },
  });

  const [content, destination] = await Promise.all([
    db.content.findUnique({ where: { id: job.contentId } }),
    db.destination.findUnique({ where: { id: job.destinationId } }),
  ]);
  if (!content || !destination) {
    const res = await db.publishJob.updateMany({
      where: { id: jobId, status: "processing", lockedBy: holder.slice(0, 64) },
      data: { status: "failed", failureReason: "محتوا یا مقصد یافت نشد." },
    });
    if (res.count > 0) await reconcileContentOutcome(job.contentId, "محتوا یا مقصد یافت نشد.");
    return { outcome: "failed", errorFa: "محتوا یا مقصد یافت نشد." };
  }
  if (destination.status === "deleted") {
    const cancelled = await db.publishJob.updateMany({
      where: { id: jobId, status: "processing", lockedBy: holder.slice(0, 64) },
      data: { status: "cancelled", failureReason: "مقصد حذف شده است." },
    });
    if (cancelled.count > 0) {
      // Reconcile the content outcome — a cancelled terminal job counts as
      // "not delivered" for its destination: if every other destination
      // already received the message the content becomes `partial` (not
      // `delivered`), and if nothing was delivered it becomes `failed`.
      await reconcileContentOutcome(content.id, "مقصد حذف شده است.");
    }
    return { outcome: "failed", errorFa: "مقصد حذف شده است." };
  }
  // M-05: a cancelled content's jobs must never be SENT. The content-level
  // cancel flow cancels queued jobs, but a job claimed between the cancel
  // and the worker's read can still be in `processing` — the guard below
  // closes that window (previously processJob never re-checked the
  // content state after claiming and delivered to a cancelled content).
  if (content.status === "cancelled") {
    const res = await db.publishJob.updateMany({
      where: { id: jobId, status: "processing", lockedBy: holder.slice(0, 64) },
      data: { status: "cancelled", failureReason: "محتوا لغو شده است." },
    });
    if (res.count > 0) {
      // Terminal job transition — reconcile keeps the invariant uniform.
      // The content is already `cancelled` (terminal), so the CAS below
      // is a no-op by construction; it exists for state consistency.
      await reconcileContentOutcome(content.id);
    }
    return { outcome: "failed", errorFa: "محتوا لغو شده است." };
  }
  if (!isValidProviderName(destination.provider)) {
    const res = await db.publishJob.updateMany({
      where: { id: jobId, status: "processing", lockedBy: holder.slice(0, 64) },
      data: { status: "failed", failureReason: "پروایدر نامعتبر است." },
    });
    if (res.count > 0) await reconcileContentOutcome(content.id, "پروایدر نامعتبر است.");
    return { outcome: "failed", errorFa: "پروایدر نامعتبر است." };
  }

  const botToken = await getDestinationToken(destination.id);
  if (!botToken) {
    await failJob(job, "توکن قابل رمزگشایی نیست.", holder);
    return { outcome: "failed", errorFa: "توکن قابل رمزگشایی نیست." };
  }

  const provider = getDestinationProvider(destination.provider);
  // Load destination-scoped buttons, sorted by rowOrder.
  const buttonsRaw = await db.glassButton.findMany({
    where: { destinationId: destination.id, enabled: true },
    orderBy: [{ rowOrder: "asc" }, { createdAt: "asc" }],
  });
  const buttons: GlassButton[] = buttonsRaw.map((b) => ({
    id: b.id,
    label: b.label,
    url: b.url,
    callbackData: b.callbackData,
    rowOrder: b.rowOrder,
    enabled: b.enabled,
  }));

  // Resolve a media URL if the content has media (only the first media —
  // most providers don't support multi-attach in a single message).
  let mediaUrl: string | null = null;
  const mediaIds = safeJsonParse<string[]>(content.mediaIds, []);
  if (Array.isArray(mediaIds) && mediaIds.length > 0) {
    const m = await db.media.findUnique({ where: { id: mediaIds[0] } });
    if (m && m.ownerId === content.ownerId) {
      // Build a relative URL — provider fetches via the gateway. We do
      // not need to expose the storage URL to the provider — we expose
      // the public Next.js handler, which the provider can reach by
      // absolute URL via the gateway.
      // ROOT-CAUSE FIX (audit §21 — provider media access): the media
      // route is session-gated (and MUST stay that way — audit rule 45
      // forbids dropping auth or making storage public). External
      // providers cannot hold a session, so we append a SHORT-LIVED
      // HMAC token scoped to exactly this media id (10-minute TTL).
      // NOTE: Telegram and Bale fetch by URL; if our app is behind a
      // domain, set POSTYAR_PUBLIC_BASE_URL. Otherwise we fall back to
      // sending text-only with the caption referring to the media.
      // V4 M-14 — authoritative settings-aware resolver.
      const publicBase = (await getSetting("POSTYAR_PUBLIC_BASE_URL", "")).trim() || undefined;
      if (publicBase) {
        const { exp, sig } = signMediaUrlToken(m.id, 10 * 60);
        mediaUrl = `${publicBase.replace(/\/$/, "")}/api/media/${m.id}?exp=${exp}&sig=${sig}`;
      } else {
        // No public base — send text-only and treat as soft failure if
        // the destination's provider requires a public URL.
        mediaUrl = null;
      }
    }
  }

  try {
    // M-06: durable PRE-SEND attempt marker (conditional on lease
    // ownership). If this process dies after the provider accepted the
    // message but before the delivered/failed CAS below, the row proves
    // an outbound attempt was in flight — at-least-once semantics stay
    // observable and bounded by maxAttempts (Telegram/Bale/Rubika send
    // APIs have no idempotency token, so exactly-once is not claimable;
    // see the at-least-once note at the top of this file).
    await db.publishJob.updateMany({
      where: { id: jobId, status: "processing", lockedBy: holder.slice(0, 64) },
      data: { deliveryAttemptedAt: new Date() },
    });
    const r = await provider.publishMessage({
      botToken,
      chatId: destination.chatId,
      text: `${content.title ? content.title + "\n\n" : ""}${content.body}`,
      mediaUrl,
      buttons,
    });
    if (r.ok) {
      // Conditional on lease ownership (P1.12.6): if the stale-lease reaper
      // reclaimed this job while our provider call was in flight, our
      // late result must not clobber the reclaimed state.
      const delivered = await db.publishJob.updateMany({
        where: { id: jobId, status: "processing", lockedBy: holder.slice(0, 64) },
        data: {
          status: "delivered",
          deliveredAt: new Date(),
          resultPayload: sanitizeResultPayload({
            providerMessageId: r.providerMessageId,
            raw: r.raw,
          }),
          failureReason: null,
        },
      });
      if (delivered.count === 0) {
        // Lease lost mid-flight — do not touch terminal/reclaimed state.
        return { outcome: "retried", errorFa: "اجاره پردازش در میانه راه از دست رفت." };
      }
      await reconcileContentOutcome(content.id);
      await db.notification.create({
        data: {
          userId: content.ownerId,
          category: "publish",
          titleFa: "ارسال موفق",
          bodyFa: `پیام «${content.title}» با موفقیت ارسال شد.`,
          link: "/dashboard/content",
          readAt: null,
        },
      });
      return { outcome: "delivered" };
    }
    // Soft failure — exponential backoff unless we've exhausted attempts.
    const attempts = job.attempts + 1;
    const exhausted = attempts >= job.maxAttempts;
    if (exhausted || isHardFailure(r.raw)) {
      await failJob(job, r.errorFa ?? "ارسال ناموفق بود.", holder);
      return { outcome: "failed", errorFa: r.errorFa };
    }
    // Re-queue with backoff — conditional on lease ownership (P1.12.6).
    const backoffSec = computeBackoffSec(attempts);
    const nextRun = new Date(Date.now() + backoffSec * 1000);
    const requeued = await db.publishJob.updateMany({
      where: { id: jobId, status: "processing", lockedBy: holder.slice(0, 64) },
      data: {
        status: "queued",
        attempts,
        runAt: nextRun,
        lockedBy: null,
        lockedAt: null,
        failureReason: r.errorFa ?? null,
        resultPayload: sanitizeResultPayload({ raw: r.raw }),
      },
    });
    if (requeued.count === 0) {
      return { outcome: "retried", errorFa: "اجاره پردازش در میانه راه از دست رفت." };
    }
    return { outcome: "retried", errorFa: r.errorFa };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "خطای ناشناخته";
    const attempts = job.attempts + 1;
    if (attempts >= job.maxAttempts) {
      await failJob(job, msg, holder);
      return { outcome: "failed", errorFa: msg };
    }
    const backoffSec = computeBackoffSec(attempts);
    const nextRun = new Date(Date.now() + backoffSec * 1000);
    const requeued = await db.publishJob.updateMany({
      where: { id: jobId, status: "processing", lockedBy: holder.slice(0, 64) },
      data: {
        status: "queued",
        attempts,
        runAt: nextRun,
        lockedBy: null,
        lockedAt: null,
        failureReason: msg,
      },
    });
    if (requeued.count === 0) {
      return { outcome: "failed", errorFa: msg };
    }
    return { outcome: "retried", errorFa: msg };
  }
}

async function failJob(
  job: { id: string; contentId: string; attempts: number },
  reason: string,
  holder?: string,
): Promise<void> {
  // Conditional on lease ownership when called from a live worker (P1.12.6).
  const res = await db.publishJob.updateMany({
    where: {
      id: job.id,
      status: "processing",
      ...(holder ? { lockedBy: holder.slice(0, 64) } : {}),
    },
    data: {
      status: "failed",
      failureReason: reason.slice(0, 400),
      lockedBy: null,
      lockedAt: null,
      // Persist the final attempt count so the DB row reflects the
      // total number of tries (the caller computes `attempts =
      // job.attempts + 1` before calling failJob, but the column was
      // previously NOT updated on the exhausted path — leaving the
      // row's `attempts` field stuck at the pre-final-attempt value).
      attempts: job.attempts + 1,
    },
  });
  if (res.count === 0) return; // lease lost or state moved — leave alone
  // Reconcile the content outcome for this terminal job transition.
  await reconcileContentOutcome(job.contentId, reason);
}

/**
 * V5 H-16 — content outcome reconciliation (single authoritative
 * replacement for the old maybeMarkContentDelivered/maybeMarkContentFailed
 * pair). Called after EVERY job terminal transition (delivered, failed,
 * cancelled) and after every terminal reaper decision.
 *
 * Decision procedure (truthful, per-destination):
 *   1. No jobs → nothing to reconcile.
 *   2. ANY job still queued/processing → outcome not yet decidable; the
 *      content keeps its current status (the old code mislabelled a
 *      content `failed` the moment its FIRST job exhausted attempts while
 *      siblings were still in flight, and then could never recover).
 *   3. All jobs terminal — a destination counts as DELIVERED iff any of
 *      its jobs delivered (retries append rows per destination; an older
 *      failed row never negates a real delivery):
 *        every destination delivered            → content `delivered`
 *        at least one delivered, some not       → content `partial`
 *        nothing delivered anywhere             → content `failed`
 *
 * ALL writes are CAS: updateMany where status ∈ sourcesFor(target) (the
 * machine-derived reverse adjacency) with the moved count verified — a
 * write can never land on a status the machine forbids, terminal rows are
 * never overwritten, and concurrent reconciles converge idempotently.
 *
 * Returns the applied target status, or null when no write happened
 * (undecidable, nothing to do, or CAS lost to a concurrent writer).
 */
export async function reconcileContentOutcome(
  contentId: string,
  failureReasonFa?: string,
): Promise<"delivered" | "partial" | "failed" | null> {
  const jobs = await db.publishJob.findMany({
    where: { contentId },
    select: { status: true, destinationId: true },
  });
  if (jobs.length === 0) return null; // nothing to reconcile
  if (jobs.some((j) => NON_TERMINAL_JOB_STATUSES.includes(j.status))) return null;

  // Per-destination effective outcome.
  const destinationDelivered = new Map<string, boolean>();
  for (const j of jobs) {
    if (j.status === "delivered") {
      destinationDelivered.set(j.destinationId, true);
    } else if (!destinationDelivered.get(j.destinationId)) {
      destinationDelivered.set(j.destinationId, false);
    }
  }
  const totalDestinations = destinationDelivered.size;
  const deliveredDestinations = [...destinationDelivered.values()].filter(Boolean).length;

  let target: "delivered" | "partial" | "failed";
  if (deliveredDestinations === totalDestinations) {
    target = "delivered";
  } else if (deliveredDestinations > 0) {
    target = "partial";
  } else {
    target = "failed";
  }

  const sources = sourcesFor(target);
  if (sources.length === 0) return null;

  // Build the mutation per target. `delivered` stamps publishedAt and
  // clears any stale failure note; `partial` carries a bounded Persian
  // note; `failed` carries the caller's reason when provided.
  const data =
    target === "delivered"
      ? { status: target, publishedAt: new Date(), failureReason: null }
      : target === "partial"
        ? { status: target, failureReason: PARTIAL_OUTCOME_FA }
        : {
            status: target,
            ...(failureReasonFa ? { failureReason: failureReasonFa.slice(0, 400) } : {}),
          };

  const moved = await db.content.updateMany({
    where: { id: contentId, status: { in: sources } },
    data,
  });
  return moved.count > 0 ? target : null;
}

/**
 * Some provider responses indicate permanent failure (e.g., "unsupported
 * feature"). We treat those as hard failures even if attempts remain.
 */
function isHardFailure(raw: unknown): boolean {
  if (raw && typeof raw === "object" && "supported" in raw) {
    return raw.supported === false;
  }
  return false;
}

/** Convenience helper used by the cron/health endpoint to report worker status. */
export async function workerQueueDepth(): Promise<{ queued: number; processing: number; failed: number }> {
  const [queued, processing, failed] = await Promise.all([
    db.publishJob.count({ where: { status: "queued" } }),
    db.publishJob.count({ where: { status: "processing" } }),
    db.publishJob.count({ where: { status: "failed" } }),
  ]);
  return { queued, processing, failed };
}
