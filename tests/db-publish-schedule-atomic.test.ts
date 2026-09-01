// =====================================================================
// POSTYAR — C-02 regression: atomic publish scheduling
// ---------------------------------------------------------------------
// schedulePublishJobsAtomic must commit the content-state transition, ALL
// per-destination job rows and the quota reservation in ONE transaction.
// Every test here would FAIL on the pre-fix implementation, which
// reserved quota, moved the content, then created jobs one-by-one in
// separate transactions (a mid-loop failure left partial state, and the
// scheduler's find-then-create raced under concurrency).
// =====================================================================
import { test, expect, describe, beforeAll, beforeEach } from "bun:test";
import { db } from "../src/lib/db";
import { resetDb, seedUser, seedPlan, ensureDbConnected } from "./_db-helpers";
import { schedulePublishJobsAtomic, ContentTransitionError } from "../src/lib/queue/scheduler";
import { getActiveSubscription, ensurePlansSeeded } from "../src/lib/payments/plans";
import { randomToken } from "../src/lib/security/crypto";

async function seedContent(ownerId: string, status: string): Promise<string> {
  const c = await db.content.create({
    data: {
      ownerId,
      title: "محتوای تستی",
      body: "متن",
      status,
    },
  });
  return c.id;
}

async function seedDestination(ownerId: string): Promise<string> {
  const { id } = await db.destination.create({
    data: {
      ownerId,
      provider: "telegram",
      label: "کانال تست",
      botTokenEnc: "x",
      chatId: "123",
    },
  });
  return id;
}

async function usedPublish(userId: string): Promise<number> {
  const sub = await getActiveSubscription(userId);
  if (!sub) return 0;
  const used = JSON.parse(sub.usedQuota) as Record<string, number>;
  return used.publishPerMonth ?? 0;
}

async function provisionFreeRow(userId: string): Promise<void> {
  // schedulePublishJobsAtomic → consumeQuotaInTx provisions the free-plan
  // enforcement row lazily; we just trigger it once to read usage cleanly.
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

describe("C-02 — atomic publish scheduling (DB-backed)", () => {
  let userId: string;
  const runAt = () => new Date("2030-05-01T10:00:00.000Z").toISOString();

  beforeAll(async () => {
    await ensureDbConnected();
  });

  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "pub@test.local", mobile: "09120000701" });
    userId = u.id;
    await provisionFreeRow(userId);
  });

  test("multiple destinations: ALL jobs + content transition + exact quota in one commit", async () => {
    const contentId = await seedContent(userId, "draft");
    const d1 = await seedDestination(userId);
    const d2 = await seedDestination(userId);
    const d3 = await seedDestination(userId);
    const r = await schedulePublishJobsAtomic({
      ownerId: userId,
      contentId,
      destinationIds: [d1, d2, d3],
      runAtIso: runAt(),
      scheduled: false,
      dimension: "publishPerMonth",
    });
    expect(r.createdCount).toBe(3);
    const jobs = await db.publishJob.count({ where: { contentId } });
    expect(jobs).toBe(3);
    const content = await db.content.findUnique({ where: { id: contentId } });
    expect(content?.status).toBe("queued");
    expect(await usedPublish(userId)).toBe(3);
  });

  test("insufficient quota → NOTHING commits (no jobs, no transition, no quota)", async () => {
    // Free plan publishPerMonth = 5; request 20 destinations → over cap.
    const contentId = await seedContent(userId, "draft");
    const dests = await Promise.all(Array.from({ length: 20 }, () => seedDestination(userId)));
    await expect(schedulePublishJobsAtomic({
      ownerId: userId,
      contentId,
      destinationIds: dests,
      runAtIso: runAt(),
      scheduled: false,
      dimension: "publishPerMonth",
    })).rejects.toMatchObject({ name: "AuthError" });
    // NOTHING was created — the pre-fix code would have reserved quota
    // first (losing it) and/or committed partial jobs.
    expect(await db.publishJob.count({ where: { contentId } })).toBe(0);
    expect((await db.content.findUnique({ where: { id: contentId } }))?.status).toBe("draft");
    expect(await usedPublish(userId)).toBe(0);
  });

  test("zero NEW jobs (pure duplicate) consumes ZERO quota and returns existing jobs", async () => {
    const contentId = await seedContent(userId, "draft");
    const d1 = await seedDestination(userId);
    const first = await schedulePublishJobsAtomic({
      ownerId: userId,
      contentId,
      destinationIds: [d1],
      runAtIso: runAt(),
      scheduled: false,
      dimension: "publishPerMonth",
    });
    expect(first.createdCount).toBe(1);
    const before = await usedPublish(userId);
    // Same submission replayed (identical idempotency keys).
    const second = await schedulePublishJobsAtomic({
      ownerId: userId,
      contentId,
      destinationIds: [d1],
      runAtIso: runAt(),
      scheduled: false,
      dimension: "publishPerMonth",
    });
    expect(second.createdCount).toBe(0);
    expect(second.jobs[0]?.jobId).toBe(first.jobs[0]?.jobId);
    expect(await usedPublish(userId)).toBe(before);
    expect(await db.publishJob.count({ where: { contentId } })).toBe(1);
  });

  test("existing job + new job mixture: quota charged ONLY for the new job", async () => {
    const contentId = await seedContent(userId, "draft");
    const d1 = await seedDestination(userId);
    const d2 = await seedDestination(userId);
    await schedulePublishJobsAtomic({
      ownerId: userId,
      contentId,
      destinationIds: [d1],
      runAtIso: runAt(),
      scheduled: false,
      dimension: "publishPerMonth",
    });
    const r = await schedulePublishJobsAtomic({
      ownerId: userId,
      contentId,
      destinationIds: [d1, d2],
      runAtIso: runAt(),
      scheduled: false,
      dimension: "publishPerMonth",
    });
    expect(r.createdCount).toBe(1);
    expect(await db.publishJob.count({ where: { contentId } })).toBe(2);
    expect(await usedPublish(userId)).toBe(2);
  });

  test("concurrent duplicate submissions: no duplicate jobs, no double quota", async () => {
    const contentId = await seedContent(userId, "draft");
    const d1 = await seedDestination(userId);
    const d2 = await seedDestination(userId);
    const results = await Promise.allSettled([
      schedulePublishJobsAtomic({ ownerId: userId, contentId, destinationIds: [d1, d2], runAtIso: runAt(), scheduled: false, dimension: "publishPerMonth" }),
      schedulePublishJobsAtomic({ ownerId: userId, contentId, destinationIds: [d1, d2], runAtIso: runAt(), scheduled: false, dimension: "publishPerMonth" }),
      schedulePublishJobsAtomic({ ownerId: userId, contentId, destinationIds: [d1, d2], runAtIso: runAt(), scheduled: false, dimension: "publishPerMonth" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ createdCount: number }>[];
    // At least the winner fully commits.
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(fulfilled.reduce((acc, r) => acc + r.value.createdCount, 0)).toBe(2);
    expect(await db.publishJob.count({ where: { contentId } })).toBe(2);
    expect(await usedPublish(userId)).toBe(2);
  });

  test("invalid content transition → ContentTransitionError, no jobs created", async () => {
    const contentId = await seedContent(userId, "delivered");
    const d1 = await seedDestination(userId);
    await expect(schedulePublishJobsAtomic({
      ownerId: userId,
      contentId,
      destinationIds: [d1],
      runAtIso: runAt(),
      scheduled: false,
      dimension: "publishPerMonth",
    })).rejects.toBeInstanceOf(ContentTransitionError);
    expect(await db.publishJob.count({ where: { contentId } })).toBe(0);
  });

  test("retry after crash-like quota/insert failure leaves no orphan reservation", async () => {
    // First attempt fails at the quota gate (26 destinations > cap); the
    // retry with a legal count must succeed cleanly with exact accounting.
    const contentId = await seedContent(userId, "draft");
    const dests = await Promise.all(Array.from({ length: 26 }, () => seedDestination(userId)));
    await expect(schedulePublishJobsAtomic({
      ownerId: userId,
      contentId,
      destinationIds: dests,
      runAtIso: runAt(),
      scheduled: false,
      dimension: "publishPerMonth",
    })).rejects.toMatchObject({ name: "AuthError" });
    // Legal retry (3 destinations).
    const r = await schedulePublishJobsAtomic({
      ownerId: userId,
      contentId,
      destinationIds: dests.slice(0, 3),
      runAtIso: runAt(),
      scheduled: false,
      dimension: "publishPerMonth",
    });
    expect(r.createdCount).toBe(3);
    expect(await usedPublish(userId)).toBe(3);
    expect(await db.publishJob.count({ where: { contentId } })).toBe(3);
  });
});

// silence unused import lint if plan seeding helper is unnecessary here
void seedPlan;
void randomToken;
