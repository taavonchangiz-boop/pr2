// POSTYAR — POST /api/publish/schedule
// Body: { contentId, destinationIds: string[], scheduledAtJalali: "now" | { jy, jm, jd, hour, minute } }
// Validates ownership + state machine + plan features + quota. Converts
// Jalali → UTC ISO. Creates one PublishJob per destination with a
// deterministic idempotency key `contentId:destinationId:iso` so duplicate
// submissions collapse.
//
// P0.1 ROOT-CAUSE FIX — authoritative quota path: the previous
// implementation created jobs and then did a best-effort, non-atomic
// read-modify-write of a legacy `publishUsed` counter on a DIFFERENT key
// than the quota engine's `publishPerMonth` dimension. Quota is now
// RESERVED ATOMICALLY (consumeQuota — CAS check-and-reserve) for exactly
// the number of NEW jobs before any job row is committed, and the legacy
// `publishUsed` writer is removed (single source of truth, P2.2).
//
// Quota unit: ONE publishPerMonth unit PER DESTINATION (the number of
// provider messages the operation will produce). This is explicit and
// consistent everywhere (documented here and in plans.ts).
//
// P0.15 — server-side plan feature gates: `publish` (always), `schedule`
// (for scheduled sends), `multiChannel` (>1 destination). UI hiding is
// not authorization.
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser, clientIp, audit, AuthError } from "@/lib/server/auth";
import { rateLimit } from "@/lib/security/cache";
import { jalaliToUtcIso } from "@/lib/persian";
import { assertTransition, isContentStatus } from "@/lib/publishing/state";
import { schedulePublishJob } from "@/lib/queue/scheduler";
import {
  consumeQuota,
  refundQuota,
  requirePlanFeature,
  type QuotaDimension,
} from "@/lib/payments/plans";

const JalaliSchema = z.object({
  jy: z.number().int().min(1300).max(1500),
  jm: z.number().int().min(1).max(12),
  jd: z.number().int().min(1).max(31),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
});

const Schema = z.object({
  contentId: z.string().min(1),
  destinationIds: z.array(z.string().min(1)).min(1, "حداقل یک مقصد الزامی است.").max(20),
  scheduledAtJalali: z.union([z.literal("now"), JalaliSchema]),
});

const PUBLISH_DIMENSION: QuotaDimension = "publishPerMonth";

export async function POST(req: Request) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);

  const rl = await rateLimit({ key: `pub:schedule:${user.id}`, limit: 30, windowMs: 60 * 1000 });
  if (!rl.ok) {
    return NextResponse.json({ errorFa: "تعداد درخواست بیش از حد مجاز است." }, { status: 429 });
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }
  const { contentId, destinationIds, scheduledAtJalali } = parsed.data;

  // Verify content ownership
  const content = await db.content.findUnique({ where: { id: contentId } });
  if (!content || content.ownerId !== user.id) {
    return NextResponse.json({ errorFa: "محتوا یافت نشد." }, { status: 404 });
  }
  if (!isContentStatus(content.status)) {
    return NextResponse.json({ errorFa: "وضعیت محتوا نامعتبر است." }, { status: 400 });
  }

  // Compute runAtIso (UTC) — "now" yields the current ISO timestamp.
  const runAtIso =
    scheduledAtJalali === "now"
      ? new Date().toISOString()
      : jalaliToUtcIso(
          scheduledAtJalali.jy,
          scheduledAtJalali.jm,
          scheduledAtJalali.jd,
          scheduledAtJalali.hour,
          scheduledAtJalali.minute,
        );

  // Validate state machine: draft → queued/allowed transition
  try {
    assertTransition(content.status, scheduledAtJalali === "now" ? "queued" : "scheduled");
  } catch {
    return NextResponse.json(
      { errorFa: `انتقال وضعیت از «${content.status}» مجاز نیست.` },
      { status: 400 },
    );
  }

  // De-duplicate destination IDs
  const uniqueDestIds = Array.from(new Set(destinationIds));
  // Verify all destinations belong to the user
  const owned = await db.destination.findMany({
    where: { id: { in: uniqueDestIds }, ownerId: user.id, status: { not: "deleted" } },
    select: { id: true },
  });
  if (owned.length !== uniqueDestIds.length) {
    return NextResponse.json(
      { errorFa: "یک یا چند مقصد یافت نشد یا متعلق به شما نیست." },
      { status: 404 },
    );
  }

  // P0.15 — server-side feature gates at the actual action boundary.
  try {
    await requirePlanFeature(user.id, "publish");
    if (scheduledAtJalali !== "now") {
      await requirePlanFeature(user.id, "schedule");
    }
    if (uniqueDestIds.length > 1) {
      await requirePlanFeature(user.id, "multiChannel");
    }
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 403;
    const msg = e instanceof AuthError ? e.message : "امکان انتشار در پلن فعلی شما فعال نیست.";
    return NextResponse.json({ errorFa: msg }, { status });
  }

  // P0.1 — determine which destinations still need a NEW job. A duplicate
  // submission (same contentId + destinationId + runAtIso) must NOT reserve
  // quota again for already-queued jobs.
  const jobKeys = uniqueDestIds.map((dstId) => `${contentId}:${dstId}:${runAtIso}`.slice(0, 200));
  const existingJobs = await db.publishJob.findMany({
    where: { idempotencyKey: { in: jobKeys } },
    select: { idempotencyKey: true },
  });
  const existingKeys = new Set(existingJobs.map((j) => j.idempotencyKey));
  const newDestIds = uniqueDestIds.filter(
    (dstId, idx) => !existingKeys.has(jobKeys[idx] as string),
  );

  // Reserve quota BEFORE any job is committed (atomic check-and-reserve).
  // A crash between reservation and job creation keeps the reservation
  // (fail-closed — documented consumeQuota semantics).
  if (newDestIds.length > 0) {
    let reserved = false;
    try {
      reserved = await consumeQuota({
        userId: user.id,
        dimension: PUBLISH_DIMENSION,
        amount: newDestIds.length,
      });
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 409;
      const msg = e instanceof AuthError ? e.message : "به‌روزرسانی سهمیه انتشار ناموفق بود.";
      return NextResponse.json({ errorFa: msg }, { status });
    }
    if (!reserved) {
      return NextResponse.json(
        { errorFa: "سهمیه انتشار ماهانه کافی نیست. پلن خود را ارتقا دهید یا ماه بعد تلاش کنید." },
        { status: 403 },
      );
    }
  }

  // Transition content status atomically BEFORE job creation (CAS on the
  // previous status) — a concurrent writer changing the status must not be
  // clobbered, and no jobs may exist for a content whose state transition
  // was rejected. On CAS failure the quota reservation is refunded.
  const next = scheduledAtJalali === "now" ? "queued" : "scheduled";
  const statusMoved = await db.content.updateMany({
    where: { id: contentId, ownerId: user.id, status: content.status },
    data: {
      status: next,
      scheduledAt: scheduledAtJalali === "now" ? null : new Date(runAtIso),
      destinationIds: JSON.stringify(uniqueDestIds),
    },
  });
  if (statusMoved.count === 0) {
    if (newDestIds.length > 0) {
      await refundQuota({
        userId: user.id,
        dimension: PUBLISH_DIMENSION,
        amount: newDestIds.length,
      });
    }
    return NextResponse.json(
      { errorFa: `انتقال وضعیت از «${content.status}» مجاز نیست.` },
      { status: 409 },
    );
  }

  // Create one PublishJob per destination. skipDuplicates guarantees that a
  // concurrent duplicate submission cannot violate the UNIQUE key.
  const results: Array<{ destinationId: string; created: boolean; jobId: string }> = [];
  let actuallyCreated = 0;
  for (let i = 0; i < uniqueDestIds.length; i++) {
    const dstId = uniqueDestIds[i] as string;
    const r = await schedulePublishJob({
      contentId,
      destinationId: dstId,
      runAtIso,
      idempotencyKey: jobKeys[i] as string,
    });
    if (r.created) actuallyCreated += 1;
    results.push({ destinationId: dstId, created: r.created, jobId: r.jobId });
  }

  // Concurrency reconciliation: if a parallel duplicate created some of the
  // jobs between our reservation and our inserts, refund the difference.
  // (Over-reservation is fail-closed; under-reservation is impossible.)
  if (newDestIds.length > actuallyCreated) {
    await refundQuota({
      userId: user.id,
      dimension: PUBLISH_DIMENSION,
      amount: newDestIds.length - actuallyCreated,
    });
  }

  await audit({
    userId: user.id,
    actor: "user",
    action: "publish_schedule",
    targetType: "content",
    targetId: contentId,
    ip,
    meta: {
      destinationCount: uniqueDestIds.length,
      newJobs: actuallyCreated,
      scheduledAtIso: runAtIso,
      mode: scheduledAtJalali === "now" ? "now" : "scheduled",
    },
  });

  // If scheduling for "now", opportunistically run the worker so the user
  // sees immediate delivery without waiting for the next cron tick.
  if (scheduledAtJalali === "now") {
    try {
      const { runWorkerOnce } = await import("@/lib/queue/worker");
      // Fire-and-forget — we don't block the response.
      void runWorkerOnce(5);
    } catch { /* ignore — cron will pick it up */ }
  }

  return NextResponse.json({ ok: true, jobs: results, scheduledAtIso: runAtIso }, { status: 201 });
}
