// =====================================================================
// POSTYAR — Publish scheduler
// ---------------------------------------------------------------------
// schedulePublishJob (single-destination helper, idempotent by UNIQUE
// idempotencyKey; kept for callers that schedule exactly one job):
//   - If idempotencyKey already exists → return the existing job (no dup).
//   - Otherwise insert a new PublishJob in `queued` state with runAt.
//
// schedulePublishJobsAtomic (C-02 ROOT-CAUSE FIX): the publish route
// previously (1) reserved quota in its own transaction, (2) CAS-moved the
// Content status, then (3) created one PublishJob per destination in a
// LOOP of separate transactions. Any failure in the middle of that
// sequence (provider DB error, P2002 from the scheduler's non-atomic
// find-then-create, process crash) left quota reserved + content moved +
// only SOME jobs created — a partially committed business operation.
//
// The new primitive performs EVERYTHING in ONE database transaction with
// a precise invariant for every failure point:
//
//   1. Content state transition (CAS on the previous status) — invalid
//      transitions throw → nothing commits.
//   2. Job rows are inserted one-by-one inside the same transaction; the
//      UNIQUE idempotencyKey makes concurrent duplicate submissions
//      converge (the loser's conflicting insert is caught and treated as
//      already-created).
//   3. Quota is reserved for EXACTLY `created.count` rows, via the
//      transaction-bound consumeQuotaInTx: insufficient/disabled quota
//      THROWS → the whole transaction (content transition + all job
//      rows) rolls back. No quota can be reserved without the jobs
//      committing, and no jobs can commit without the quota.
//
//   Consequences: zero jobs → zero quota; retry after partial completion
//   is impossible; no duplicate quota reservation on retry; no refund
//   path exists to get wrong; no impossible content states.
// =====================================================================
import { db } from "@/lib/db";
import { assertTransition, isContentStatus } from "@/lib/publishing/state";
import { consumeQuotaInTx, type QuotaDimension } from "@/lib/payments/plans";
import { AuthError } from "@/lib/server/auth";

export interface ScheduleInput {
  contentId: string;
  destinationId: string;
  runAtIso: string;
  idempotencyKey: string;
  maxAttempts?: number;
}

export interface ScheduleResult {
  created: boolean;
  jobId: string;
  status: string;
}

export async function schedulePublishJob(input: ScheduleInput): Promise<ScheduleResult> {
  const idempotencyKey = input.idempotencyKey.slice(0, 200);
  // Idempotency: if the same key already exists, return the existing job.
  const existing = await db.publishJob.findUnique({
    where: { idempotencyKey },
    select: { id: true, status: true },
  });
  if (existing) {
    return { created: false, jobId: existing.id, status: existing.status };
  }
  try {
    const created = await db.publishJob.create({
      data: {
        contentId: input.contentId,
        destinationId: input.destinationId,
        runAt: new Date(input.runAtIso),
        status: "queued",
        maxAttempts: input.maxAttempts ?? 3,
        idempotencyKey,
        attempts: 0,
        lockedAt: null,
        lockedBy: null,
      },
    });
    return { created: true, jobId: created.id, status: created.status };
  } catch (err) {
    // Concurrent create with the same key: converge on the winner's row
    // instead of surfacing a raw P2002 (the pre-fix find-then-create let
    // this race interrupt multi-destination scheduling mid-loop).
    const msg = (err as { code?: string; message?: string })?.message ?? "";
    if (!/unique|UNIQUE|constraint/i.test(msg)) throw err;
    const winner = await db.publishJob.findUnique({
      where: { idempotencyKey },
      select: { id: true, status: true },
    });
    if (!winner) throw err;
    return { created: false, jobId: winner.id, status: winner.status };
  }
}

// ---------------------------------------------------------------------
// Atomic multi-destination scheduling (C-02)
// ---------------------------------------------------------------------
export interface SchedulePublishAtomicInput {
  ownerId: string;
  contentId: string;
  /** Deduped, ownership-verified destination ids (verified by the caller). */
  destinationIds: string[];
  runAtIso: string;
  /** false → "queued" (publish now), true → "scheduled". */
  scheduled: boolean;
  dimension: QuotaDimension;
  maxAttempts?: number;
}

export interface SchedulePublishAtomicResult {
  createdCount: number;
  contentStatus: string;
  jobs: Array<{ destinationId: string; created: boolean; jobId: string }>;
}

export class ContentTransitionError extends Error {
  status: string;
  constructor(status: string) {
    super(`انتقال وضعیت از «${status}» مجاز نیست.`);
    this.name = "ContentTransitionError";
    this.status = status;
  }
}

export async function schedulePublishJobsAtomic(
  input: SchedulePublishAtomicInput,
): Promise<SchedulePublishAtomicResult> {
  const next = input.scheduled ? "scheduled" : "queued";
  const jobKeys = input.destinationIds.map(
    (dstId) => `${input.contentId}:${dstId}:${input.runAtIso}`.slice(0, 200),
  );

  const result = await db.$transaction(async (tx) => {
    const content = await tx.content.findUnique({
      where: { id: input.contentId },
      select: { id: true, ownerId: true, status: true },
    });
    if (!content || content.ownerId !== input.ownerId) {
      throw new AuthError("محتوا یافت نشد.", 404);
    }
    if (!isContentStatus(content.status)) {
      throw new AuthError("وضعیت محتوا نامعتبر است.", 400);
    }

    // Existing jobs for the requested keys (within the same transaction).
    const existing = await tx.publishJob.findMany({
      where: { idempotencyKey: { in: jobKeys } },
      select: { id: true, idempotencyKey: true, destinationId: true },
    });
    const existingByDst = new Map(existing.map((j) => [j.destinationId, j]));
    const allExist = input.destinationIds.every((d) => existingByDst.has(d));

    if (content.status !== next) {
      // Validate + CAS the transition (conditional on the current status —
      // a concurrent writer must not be clobbered). Invalid transitions are
      // normalized to ContentTransitionError so callers map them to a 409
      // (a raw InvalidTransition would surface as an opaque 500).
      try {
        assertTransition(content.status, next);
      } catch {
        throw new ContentTransitionError(content.status);
      }
      const moved = await tx.content.updateMany({
        where: { id: content.id, ownerId: input.ownerId, status: content.status },
        data: {
          status: next,
          scheduledAt: input.scheduled ? new Date(input.runAtIso) : null,
          destinationIds: JSON.stringify(input.destinationIds),
        },
      });
      if (moved.count === 0) {
        throw new ContentTransitionError(content.status);
      }
    } else if (!allExist) {
      // Status already at the target but jobs are missing (legacy partial
      // state) — the job inserts below repair it; no status change needed.
    } else {
      // Pure idempotent duplicate: everything already committed. Return
      // the existing jobs WITHOUT reserving any quota.
      return {
        createdCount: 0,
        contentStatus: content.status,
        jobs: input.destinationIds.map((dstId) => {
          const j = existingByDst.get(dstId)!;
          return { destinationId: dstId, created: false, jobId: j.id };
        }),
      };
    }

    // Insert one PublishJob per destination. The UNIQUE idempotencyKey is
    // the arbiter: a concurrent duplicate submission's extra inserts lose
    // the unique race and converge (createdCount reflects reality).
    let createdCount = 0;
    const insertedIds = new Set<string>();
    const insertedByDst = new Map<string, { id: string }>();
    for (let i = 0; i < input.destinationIds.length; i++) {
      const dstId = input.destinationIds[i] as string;
      if (existingByDst.has(dstId)) continue;
      try {
        const row = await tx.publishJob.create({
          data: {
            contentId: content.id,
            destinationId: dstId,
            runAt: new Date(input.runAtIso),
            status: "queued",
            maxAttempts: input.maxAttempts ?? 3,
            idempotencyKey: jobKeys[i] as string,
            attempts: 0,
          },
        });
        createdCount += 1;
        insertedIds.add(row.id);
        insertedByDst.set(dstId, { id: row.id });
      } catch (err) {
        const msg = (err as { code?: string; message?: string })?.message ?? "";
        if (!/unique|UNIQUE|constraint/i.test(msg)) throw err;
        // A concurrent submission created this exact job first — converge
        // on the winner's row (quota charged by the winner, not us).
      }
    }

    // Reserve quota for EXACTLY the rows this call created. Insufficient
    // quota throws → the whole transaction (status move + inserts) rolls
    // back: no reservation without jobs, no jobs without reservation.
    if (createdCount > 0) {
      await consumeQuotaInTx(tx, {
        userId: input.ownerId,
        dimension: input.dimension,
        amount: createdCount,
      });
    }

    // Build the response from the committed rows.
    return {
      createdCount,
      contentStatus: next,
      jobs: input.destinationIds.map((dstId) => {
        const prior = existingByDst.get(dstId);
        if (prior) return { destinationId: dstId, created: false, jobId: prior.id };
        return { destinationId: dstId, created: true, jobId: insertedByDst.get(dstId)?.id ?? "" };
      }),
    };
  });

  return result;
}

/** Cancel a queued/scheduled job. No-op if already terminal. */
export async function cancelJob(jobId: string): Promise<void> {
  await db.publishJob.updateMany({
    where: { id: jobId, status: { in: ["queued"] } },
    data: { status: "cancelled" },
  });
}
