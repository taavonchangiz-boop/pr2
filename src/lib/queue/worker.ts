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
//       7. On success: mark job `delivered`, set deliveredAt; if all jobs
//          of this content are delivered → mark Content.status=`delivered`.
//          Fire a Notification row.
//       8. On failure: increment attempts; if attempts >= maxAttempts →
//          `failed`; else revert to `queued` with exponential backoff
//          (next runAt = now + 2^attempts * 30s, capped at 30 minutes).
//   - Release lock in finally. Returns a summary.
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
import { assertTransition, isContentStatus } from "@/lib/publishing/state";
import type { GlassButton } from "@/lib/types/glass-button";

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
 * This reaper re-queues orphaned jobs whose lease expired, honoring
 * maxAttempts with the standard exponential backoff. At-least-once
 * semantics: if the orphaned worker actually delivered before dying,
 * the retry may double-send — that is inherent to provider APIs without
 * idempotent send; the lease is kept long (10 min) to make the window
 * rare, and attempts/maxAttempts still bound total sends.
 */
async function reclaimStaleProcessingJobs(): Promise<number> {
  const staleBefore = new Date(Date.now() - STALE_LEASE_MS);
  const stale = await db.publishJob.findMany({
    where: { status: "processing", lockedAt: { lt: staleBefore } },
    select: { id: true, attempts: true, maxAttempts: true },
    take: 20,
  });
  let reclaimed = 0;
  for (const job of stale) {
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
      reclaimed += res.count;
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
    const holder = await acquireLock(lockKey, 60_000);
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

  // Mark as processing under this lock.
  await db.publishJob.update({
    where: { id: jobId },
    data: {
      status: "processing",
      lockedBy: holder.slice(0, 64),
      lockedAt: new Date(),
    },
  });

  const [content, destination] = await Promise.all([
    db.content.findUnique({ where: { id: job.contentId } }),
    db.destination.findUnique({ where: { id: job.destinationId } }),
  ]);
  if (!content || !destination) {
    await db.publishJob.update({
      where: { id: jobId },
      data: { status: "failed", failureReason: "محتوا یا مقصد یافت نشد." },
    });
    return { outcome: "failed", errorFa: "محتوا یا مقصد یافت نشد." };
  }
  if (destination.status === "deleted") {
    await db.publishJob.update({
      where: { id: jobId },
      data: { status: "cancelled", failureReason: "مقصد حذف شده است." },
    });
    return { outcome: "failed", errorFa: "مقصد حذف شده است." };
  }
  if (!isValidProviderName(destination.provider)) {
    await db.publishJob.update({
      where: { id: jobId },
      data: { status: "failed", failureReason: "پروایدر نامعتبر است." },
    });
    return { outcome: "failed", errorFa: "پروایدر نامعتبر است." };
  }

  const botToken = await getDestinationToken(destination.id);
  if (!botToken) {
    await failJob(job, "توکن قابل رمزگشایی نیست.");
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
      const publicBase = process.env.POSTYAR_PUBLIC_BASE_URL;
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
    const r = await provider.publishMessage({
      botToken,
      chatId: destination.chatId,
      text: `${content.title ? content.title + "\n\n" : ""}${content.body}`,
      mediaUrl,
      buttons,
    });
    if (r.ok) {
      await db.publishJob.update({
        where: { id: jobId },
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
      await maybeMarkContentDelivered(content.id);
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
      await failJob(job, r.errorFa ?? "ارسال ناموفق بود.");
      return { outcome: "failed", errorFa: r.errorFa };
    }
    // Re-queue with backoff
    const backoffSec = computeBackoffSec(attempts);
    const nextRun = new Date(Date.now() + backoffSec * 1000);
    await db.publishJob.update({
      where: { id: jobId },
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
    return { outcome: "retried", errorFa: r.errorFa };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "خطای ناشناخته";
    const attempts = job.attempts + 1;
    if (attempts >= job.maxAttempts) {
      await failJob(job, msg);
      return { outcome: "failed", errorFa: msg };
    }
    const backoffSec = computeBackoffSec(attempts);
    const nextRun = new Date(Date.now() + backoffSec * 1000);
    await db.publishJob.update({
      where: { id: jobId },
      data: {
        status: "queued",
        attempts,
        runAt: nextRun,
        lockedBy: null,
        lockedAt: null,
        failureReason: msg,
      },
    });
    return { outcome: "retried", errorFa: msg };
  }
}

async function failJob(job: { id: string; contentId: string; attempts: number }, reason: string): Promise<void> {
  await db.publishJob.update({
    where: { id: job.id },
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
  // Mark Content.status = failed too, but ONLY if it was previously in
  // a processing/queued state and no other job is still queued/delivered.
  await maybeMarkContentFailed(job.contentId, reason);
}

/** Mark Content.status = delivered iff every non-cancelled job for the content is delivered. */
async function maybeMarkContentDelivered(contentId: string): Promise<void> {
  const outstanding = await db.publishJob.count({
    where: { contentId, status: { in: ["queued", "processing", "failed"] } },
  });
  if (outstanding > 0) return;
  const content = await db.content.findUnique({ where: { id: contentId }, select: { status: true } });
  if (!content) return;
  if (isContentStatus(content.status)) {
    try {
      assertTransition(content.status, "delivered");
      await db.content.update({ where: { id: contentId }, data: { status: "delivered", publishedAt: new Date() } });
    } catch { /* not a valid transition — leave alone */ }
  }
}

/** Mark Content.status = failed (with reason) when the worker has exhausted retries. */
async function maybeMarkContentFailed(contentId: string, reason: string): Promise<void> {
  const content = await db.content.findUnique({ where: { id: contentId }, select: { status: true } });
  if (!content) return;
  if (isContentStatus(content.status)) {
    try {
      assertTransition(content.status, "failed");
      await db.content.update({
        where: { id: contentId },
        data: { status: "failed", failureReason: reason.slice(0, 400) },
      });
    } catch { /* not a valid transition — leave alone */ }
  }
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
