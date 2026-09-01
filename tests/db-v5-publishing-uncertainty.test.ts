// =====================================================================
// POSTYAR — V5 H-16 regression: publishing uncertainty + partial + CAS
// ---------------------------------------------------------------------
// Pins the V5 H-16 repairs against the REAL database:
//   * Reaper honors the durable pre-send marker (deliveryAttemptedAt):
//     a stale `processing` job whose send already went out transitions to
//     failed-with-uncertainty ({uncertain:true}) and is NEVER re-queued
//     or re-sent (the pre-fix reaper requeued ANY stale job → duplicate
//     posts). A stale job WITHOUT the marker is still requeued.
//   * Provider success + crash before the delivered-CAS: no resend, and
//     the crashed worker's late success write is lease-fenced (count 0).
//   * `partial` content outcome: A delivers + B exhausts → content
//     `partial` (the pre-fix code permanently mislabelled it `failed`);
//     re-scheduling B (partial → queued via the atomic scheduler) and
//     delivering it converges the content to `delivered`.
//   * All-destinations-failed content still → `failed`.
//   * reconcileContentOutcome is CAS (sourcesFor target-guarded):
//     concurrent reconciles converge without corrupting state, terminal
//     content is never overwritten, forbidden transitions never happen,
//     and in-flight siblings block the outcome decision.
// Harness mirrors tests/db-publishing-worker.test.ts /
// tests/db-worker-cancel-guard.test.ts (mocked global.fetch provider).
// =====================================================================
import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { resetDb, seedUser, seedDestination, seedContent, ensureDbConnected } from "./_db-helpers";
import { encryptString } from "../src/lib/security/crypto";
import {
  runWorkerOnce,
  reclaimStaleProcessingJobs,
  reconcileContentOutcome,
  UNCERTAIN_DELIVERY_FA,
} from "../src/lib/queue/worker";
import { schedulePublishJobsAtomic } from "../src/lib/queue/scheduler";
import { ensurePlansSeeded } from "../src/lib/payments/plans";
import { assertTransition, InvalidTransition } from "../src/lib/publishing/state";

// Valid per the provider token policy (/^\d{6,12}:[A-Za-z0-9_-]{30,}$/).
const TEST_BOT_TOKEN = `123456:${"A".repeat(35)}`;
// 11 minutes ago — strictly beyond the 10-minute STALE_LEASE_MS.
const STALE_LOCKED_AT = new Date(Date.now() - 11 * 60 * 1000);
const DUE = new Date(Date.now() - 1000);

const _originalFetch = global.fetch;
let fetchCalls = 0;
let mockMode: "ok" | "fail" | "ok-once-then-fail" = "ok";

function installFetchMock(): void {
  (global as unknown as { fetch: unknown }).fetch = (async () => {
    fetchCalls++;
    const ok = mockMode === "ok" || (mockMode === "ok-once-then-fail" && fetchCalls === 1);
    return new Response(
      JSON.stringify(
        ok
          ? { ok: true, result: { message_id: fetchCalls } }
          : { ok: false, error_code: 400, description: "chat not found" },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

async function seedValidDestination(ownerId: string) {
  const d = await seedDestination({ ownerId });
  await db.destination.update({
    where: { id: d.id },
    data: { botTokenEnc: encryptString(TEST_BOT_TOKEN) },
  });
  return d;
}

async function seedJob(opts: {
  contentId: string;
  destinationId: string;
  key: string;
  status?: string;
  runAt?: Date;
  attempts?: number;
  maxAttempts?: number;
  lockedBy?: string | null;
  lockedAt?: Date | null;
  deliveryAttemptedAt?: Date | null;
  deliveredAt?: Date | null;
  resultPayload?: string | null;
}) {
  return db.publishJob.create({
    data: {
      contentId: opts.contentId,
      destinationId: opts.destinationId,
      idempotencyKey: opts.key,
      status: opts.status ?? "queued",
      runAt: opts.runAt ?? DUE,
      attempts: opts.attempts ?? 0,
      maxAttempts: opts.maxAttempts ?? 3,
      lockedBy: opts.lockedBy ?? null,
      lockedAt: opts.lockedAt ?? null,
      deliveryAttemptedAt: opts.deliveryAttemptedAt ?? null,
      deliveredAt: opts.deliveredAt ?? null,
      resultPayload: opts.resultPayload ?? null,
    },
  });
}

async function provisionFreeRow(userId: string): Promise<void> {
  // schedulePublishJobsAtomic → consumeQuotaInTx provisions the free-plan
  // enforcement row lazily; trigger it once so the retry path has quota.
  await ensurePlansSeeded();
  const plan = await db.plan.findUnique({ where: { code: "free" } });
  if (!plan) throw new Error("free plan missing");
  const activeKey = `${userId}:${plan.id}`;
  const existing = await db.subscription.findUnique({ where: { activeKey } });
  if (!existing) {
    await db.subscription.create({
      data: {
        userId,
        planId: plan.id,
        status: "active",
        endsAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        usedQuota: "{}",
        activeKey,
      },
    });
  }
}

// =====================================================================
// Reaper uncertainty — deliveryAttemptedAt gating
// =====================================================================
describe("V5 H-16 — reaper honors the pre-send marker (uncertain outcomes)", () => {
  beforeAll(async () => { await ensureDbConnected(); });

  beforeEach(async () => {
    await resetDb();
    fetchCalls = 0;
    mockMode = "ok";
    installFetchMock();
  });

  afterAll(() => {
    global.fetch = _originalFetch;
  });

  test("stale job WITH deliveryAttemptedAt → failed-with-uncertainty, NEVER re-queued, NEVER re-sent", async () => {
    const u = await seedUser();
    const d = await seedValidDestination(u.id);
    // "processing" = the realistic post-claim content state.
    const c = await seedContent({ ownerId: u.id, status: "processing" });
    const job = await seedJob({
      contentId: c.id,
      destinationId: d.id,
      key: `h16a-${Date.now()}`,
      status: "processing",
      lockedBy: "w1",
      lockedAt: STALE_LOCKED_AT,
      deliveryAttemptedAt: STALE_LOCKED_AT, // the send already went out
      maxAttempts: 3,
    });

    const s1 = await runWorkerOnce(5);
    // The reaper is not the candidate pipeline — nothing was "processed".
    expect(s1.processed).toBe(0);

    const after = await db.publishJob.findUniqueOrThrow({ where: { id: job.id } });
    // Failed with uncertainty — NOT requeued (old code: status "queued").
    expect(after.status).toBe("failed");
    expect(["processing", "queued"]).not.toContain(after.status);
    expect(after.attempts).toBe(1); // the in-flight attempt is consumed
    expect(after.failureReason).toContain("نامشخص");
    expect(after.failureReason).toContain("ارسال تکراری");
    const payload = JSON.parse(after.resultPayload ?? "{}") as { uncertain?: boolean };
    expect(payload.uncertain).toBe(true);
    expect(after.deliveryAttemptedAt).not.toBeNull();
    expect(after.deliveredAt).toBeNull(); // never claims an unconfirmed success

    // The provider send mock's call count did NOT increase — no re-send.
    expect(fetchCalls).toBe(0);

    // Even if the (requeued-by-old-code) job were made claimable, the new
    // semantics leave it terminal: a second worker pass must not send.
    await db.publishJob.update({ where: { id: job.id }, data: { runAt: DUE } });
    const s2 = await runWorkerOnce(5);
    expect(s2.processed).toBe(0);
    expect(fetchCalls).toBe(0);
    expect((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("failed");

    // Content reconciled from the terminal reaper decision: the only
    // destination is not-delivered → failed (old code froze it in
    // `processing` forever).
    const content = await db.content.findUniqueOrThrow({ where: { id: c.id } });
    expect(content.status).toBe("failed");
    expect(content.failureReason).toContain("نامشخص");
  });

  test("provider success + crash before delivered-CAS → no resend; the crashed worker's late success write is fenced", async () => {
    const u = await seedUser();
    const d = await seedValidDestination(u.id);
    const c = await seedContent({ ownerId: u.id, status: "processing" });
    const job = await seedJob({
      contentId: c.id,
      destinationId: d.id,
      key: `h16b-${Date.now()}`,
      status: "processing",
      lockedBy: "w1",
      lockedAt: STALE_LOCKED_AT,
      deliveryAttemptedAt: STALE_LOCKED_AT, // provider accepted, worker died before the CAS
      maxAttempts: 3,
    });

    // The provider was reachable and would have accepted the message —
    // yet the reaper must NOT re-drive the send.
    const s = await runWorkerOnce(5);
    expect(s.processed).toBe(0);
    expect(s.delivered).toBe(0);
    expect(fetchCalls).toBe(0);

    const after = await db.publishJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("failed");
    const payload = JSON.parse(after.resultPayload ?? "{}") as { uncertain?: boolean };
    expect(payload.uncertain).toBe(true);

    // The crashed worker's late result uses the EXACT production CAS
    // (status=processing + lease holder) — it must be fenced (count 0),
    // never resurrecting the reaped row as delivered.
    const lateWrite = await db.publishJob.updateMany({
      where: { id: job.id, status: "processing", lockedBy: "w1" },
      data: { status: "delivered", deliveredAt: new Date() },
    });
    expect(lateWrite.count).toBe(0);
    expect((await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("failed");
    expect(fetchCalls).toBe(0);
  });

  test("stale job WITHOUT deliveryAttemptedAt → still requeued (the send never went out)", async () => {
    const u = await seedUser();
    const d = await seedValidDestination(u.id);
    const c = await seedContent({ ownerId: u.id, status: "processing" });
    const job = await seedJob({
      contentId: c.id,
      destinationId: d.id,
      key: `h16c-${Date.now()}`,
      status: "processing",
      lockedBy: "w1",
      lockedAt: STALE_LOCKED_AT,
      deliveryAttemptedAt: null, // crashed BEFORE the pre-send marker
      maxAttempts: 3,
    });

    // Call the reaper exactly as production does (inside runWorkerOnce).
    const reclaimed = await reclaimStaleProcessingJobs();
    expect(reclaimed).toBe(1);
    const after = await db.publishJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("queued");
    expect(after.attempts).toBe(1);
    expect(after.runAt.getTime()).toBeGreaterThan(Date.now()); // backoff
    expect(fetchCalls).toBe(0);
    // Requeue is not a terminal decision — content stays in flight.
    expect((await db.content.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("processing");
  });
});

// =====================================================================
// Partial content outcome
// =====================================================================
describe("V5 H-16 — partial content outcome", () => {
  beforeAll(async () => { await ensureDbConnected(); });

  beforeEach(async () => {
    await resetDb();
    fetchCalls = 0;
    mockMode = "ok-once-then-fail";
    installFetchMock();
  });

  afterAll(() => {
    global.fetch = _originalFetch;
  });

  test("A delivers + B exhausts → content `partial` (not failed); re-scheduling B delivers → content `delivered`", async () => {
    const u = await seedUser();
    const dA = await seedValidDestination(u.id);
    const dB = await seedValidDestination(u.id);
    const c = await seedContent({ ownerId: u.id, status: "queued" });
    // maxAttempts=1 → the first provider failure exhausts each job.
    // jobA runs first (strictly earlier runAt, same clock as the worker
    // sees) and gets the single "ok" mock call.
    const jobA = await seedJob({
      contentId: c.id, destinationId: dA.id, key: `h16d-a-${Date.now()}`,
      maxAttempts: 1, runAt: new Date(Date.now() - 3000),
    });
    const jobB = await seedJob({
      contentId: c.id, destinationId: dB.id, key: `h16d-b-${Date.now()}`,
      maxAttempts: 1, runAt: new Date(Date.now() - 2000),
    });

    await runWorkerOnce(5);
    expect(fetchCalls).toBe(2);
    expect((await db.publishJob.findUniqueOrThrow({ where: { id: jobA.id } })).status).toBe("delivered");
    const bAfter = await db.publishJob.findUniqueOrThrow({ where: { id: jobB.id } });
    expect(bAfter.status).toBe("failed");
    expect(bAfter.attempts).toBe(1);

    // THE H-16 regression: the content must read `partial` — the pre-fix
    // reconciler mislabelled it `failed` the moment B exhausted.
    let content = await db.content.findUniqueOrThrow({ where: { id: c.id } });
    expect(content.status).toBe("partial");
    expect(content.failureReason).toContain("برخی");

    // Re-schedule ONLY the failed destination through the atomic
    // scheduler (the production retry path): partial → queued.
    await provisionFreeRow(u.id);
    const rescheduled = await schedulePublishJobsAtomic({
      ownerId: u.id,
      contentId: c.id,
      destinationIds: [dB.id],
      runAtIso: DUE.toISOString(),
      scheduled: false,
      dimension: "publishPerMonth",
    });
    expect(rescheduled.createdCount).toBe(1);
    content = await db.content.findUniqueOrThrow({ where: { id: c.id } });
    expect(content.status).toBe("queued");

    // The retry succeeds → every destination has a delivered job →
    // content `delivered`; the older failed row is preserved history.
    mockMode = "ok";
    await runWorkerOnce(5);
    content = await db.content.findUniqueOrThrow({ where: { id: c.id } });
    expect(content.status).toBe("delivered");
    expect(content.publishedAt).not.toBeNull();
    expect(content.failureReason).toBeNull();

    const jobs = await db.publishJob.findMany({ where: { contentId: c.id } });
    expect(jobs).toHaveLength(3);
    expect(jobs.filter((j) => j.status === "delivered")).toHaveLength(2); // A + retried B
    expect(jobs.filter((j) => j.id === jobB.id && j.status === "failed")).toHaveLength(1);
  });

  test("all destinations exhaust → content `failed` (not partial)", async () => {
    const u = await seedUser();
    const dA = await seedValidDestination(u.id);
    const dB = await seedValidDestination(u.id);
    const c = await seedContent({ ownerId: u.id, status: "queued" });
    await seedJob({ contentId: c.id, destinationId: dA.id, key: `h16e-a-${Date.now()}`, maxAttempts: 1 });
    await seedJob({ contentId: c.id, destinationId: dB.id, key: `h16e-b-${Date.now()}`, maxAttempts: 1 });

    mockMode = "fail";
    await runWorkerOnce(5);
    expect(fetchCalls).toBe(2);
    const jobs = await db.publishJob.findMany({ where: { contentId: c.id } });
    expect(jobs.every((j) => j.status === "failed")).toBe(true);
    const content = await db.content.findUniqueOrThrow({ where: { id: c.id } });
    expect(content.status).toBe("failed");
    expect(content.failureReason).toContain("چت یافت نشد");
  });
});

// =====================================================================
// reconcileContentOutcome — CAS + idempotent convergence
// =====================================================================
describe("V5 H-16 — reconcileContentOutcome CAS", () => {
  beforeAll(async () => { await ensureDbConnected(); });

  beforeEach(async () => { await resetDb(); });

  test("concurrent reconcile calls (Promise.all) converge on `partial` without corrupting state", async () => {
    const u = await seedUser();
    const dA = await seedDestination({ ownerId: u.id });
    const dB = await seedDestination({ ownerId: u.id });
    const c = await seedContent({ ownerId: u.id, status: "processing" });
    await seedJob({
      contentId: c.id, destinationId: dA.id, key: `h16f-a-${Date.now()}`,
      status: "delivered", deliveryAttemptedAt: DUE, deliveredAt: DUE,
    });
    await seedJob({ contentId: c.id, destinationId: dB.id, key: `h16f-b-${Date.now()}`, status: "failed" });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => reconcileContentOutcome(c.id)),
    );
    // Exactly one CAS wins (processing → partial); the rest see the
    // content already out of the source set and must NOT write.
    expect(results.filter((r) => r === "partial")).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(7);

    const content = await db.content.findUniqueOrThrow({ where: { id: c.id } });
    expect(content.status).toBe("partial");
    expect(content.failureReason).toContain("برخی");
    // Jobs untouched by reconciliation.
    const jobs = await db.publishJob.findMany({ where: { contentId: c.id } });
    expect(jobs.map((j) => j.status).sort()).toEqual(["delivered", "failed"]);
  });

  test("reconcile never overwrites terminal content or performs forbidden transitions", async () => {
    const u = await seedUser();
    const dA = await seedDestination({ ownerId: u.id });
    const dB = await seedDestination({ ownerId: u.id });

    // cancelled content + all-undelivered jobs → stays cancelled.
    const c1 = await seedContent({ ownerId: u.id, status: "cancelled" });
    await seedJob({ contentId: c1.id, destinationId: dA.id, key: `h16g-1-${Date.now()}`, status: "cancelled" });
    await seedJob({ contentId: c1.id, destinationId: dB.id, key: `h16g-2-${Date.now()}`, status: "failed" });
    expect(await reconcileContentOutcome(c1.id)).toBeNull();
    expect((await db.content.findUniqueOrThrow({ where: { id: c1.id } })).status).toBe("cancelled");

    // delivered content re-reconciled → CAS source set excludes `delivered`
    // (delivered is terminal; no rewrite, no publishedAt churn).
    const c2 = await seedContent({ ownerId: u.id, status: "delivered" });
    await seedJob({
      contentId: c2.id, destinationId: dA.id, key: `h16g-3-${Date.now()}`,
      status: "delivered", deliveredAt: DUE,
    });
    expect(await reconcileContentOutcome(c2.id)).toBeNull();
    expect((await db.content.findUniqueOrThrow({ where: { id: c2.id } })).status).toBe("delivered");

    // draft content + all-failed jobs → draft has no edge to `failed`.
    const c3 = await seedContent({ ownerId: u.id, status: "draft" });
    await seedJob({ contentId: c3.id, destinationId: dA.id, key: `h16g-4-${Date.now()}`, status: "failed" });
    expect(await reconcileContentOutcome(c3.id)).toBeNull();
    expect((await db.content.findUniqueOrThrow({ where: { id: c3.id } })).status).toBe("draft");
  });

  test("reconcile is a no-op while any sibling job is still in flight", async () => {
    const u = await seedUser();
    const dA = await seedDestination({ ownerId: u.id });
    const dB = await seedDestination({ ownerId: u.id });
    const c = await seedContent({ ownerId: u.id, status: "processing" });
    await seedJob({
      contentId: c.id, destinationId: dA.id, key: `h16h-a-${Date.now()}`,
      status: "delivered", deliveredAt: DUE,
    });
    await seedJob({
      contentId: c.id, destinationId: dB.id, key: `h16h-b-${Date.now()}`,
      status: "queued", runAt: new Date(Date.now() + 60_000),
    });
    expect(await reconcileContentOutcome(c.id)).toBeNull();
    expect((await db.content.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("processing");
  });
});

// =====================================================================
// Partial transition matrix (pure machine — DB-independent summary of
// the strengthened publishing-state suite).
// =====================================================================
describe("V5 H-16 — partial transition matrix (pure)", () => {
  test("processing → partial ok; partial → queued ok; delivered → partial rejected", () => {
    expect(() => assertTransition("processing", "partial")).not.toThrow();
    expect(() => assertTransition("partial", "queued")).not.toThrow();
    expect(() => assertTransition("delivered", "partial")).toThrow(InvalidTransition);
  });
});
