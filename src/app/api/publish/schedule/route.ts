// POSTYAR — POST /api/publish/schedule
// Body: { contentId, destinationIds: string[], scheduledAtJalali: "now" | { jy, jm, jd, hour, minute } }
// Validates ownership + state machine + plan features. Converts
// Jalali → UTC ISO. Creates one PublishJob per destination with a
// deterministic idempotency key `contentId:destinationId:iso`.
//
// C-02 ROOT-CAUSE FIX — FULLY ATOMIC SCHEDULING: content-state transition,
// all per-destination job rows, and the quota reservation now commit in
// ONE database transaction (schedulePublishJobsAtomic). The previous flow
// reserved quota, moved the content status, and then created jobs one-by-
// one in separate transactions — a mid-loop failure left quota reserved,
// content moved, and only some jobs created. There is no compensation or
// refund path anymore: insufficient quota rolls the entire transaction
// back, and concurrent duplicate submissions converge on the UNIQUE job
// idempotency keys (quota is charged for exactly the rows created).
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
import { isContentStatus } from "@/lib/publishing/state";
import { schedulePublishJobsAtomic, ContentTransitionError } from "@/lib/queue/scheduler";
import { requirePlanFeature, type QuotaDimension } from "@/lib/payments/plans";

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

  // C-02 — ONE atomic transaction: content CAS transition + all job rows +
  // quota reservation for exactly the created rows. Any failure rolls back
  // everything (no partial commit, no quota loss, no duplicate reservation).
  try {
    const result = await schedulePublishJobsAtomic({
      ownerId: user.id,
      contentId,
      destinationIds: uniqueDestIds,
      runAtIso,
      scheduled: scheduledAtJalali !== "now",
      dimension: PUBLISH_DIMENSION,
    });

    await audit({
      userId: user.id,
      actor: "user",
      action: "publish_schedule",
      targetType: "content",
      targetId: contentId,
      ip,
      meta: {
        destinationCount: uniqueDestIds.length,
        newJobs: result.createdCount,
        scheduledAtIso: runAtIso,
        mode: scheduledAtJalali === "now" ? "now" : "scheduled",
      },
    });

    // If scheduling for "now", opportunistically run the worker so the user
    // sees immediate delivery without waiting for the next cron tick.
    if (scheduledAtJalali === "now") {
      try {
        const { runWorkerOnce } = await import("@/lib/queue/worker");
        // Fire-and-forget — we don't block the response (the cron worker is
        // the durable fallback; this only accelerates first delivery).
        void runWorkerOnce(5);
      } catch { /* ignore — cron will pick it up */ }
    }

    return NextResponse.json({ ok: true, jobs: result.jobs, scheduledAtIso: runAtIso }, { status: 201 });
  } catch (e) {
    if (e instanceof ContentTransitionError) {
      return NextResponse.json({ errorFa: e.message }, { status: 409 });
    }
    if (e instanceof AuthError) {
      return NextResponse.json({ errorFa: e.message }, { status: e.status });
    }
    throw e;
  }
}
