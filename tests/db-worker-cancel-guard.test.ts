// =====================================================================
// POSTYAR — M-05/M-06 publishing worker guards (DB-backed)
// ---------------------------------------------------------------------
// Proves against the REAL database:
//   * M-05: a CANCELLED content's queued job is cancelled by the worker
//     and NEVER sent to the provider (the pre-fix behavior claimed the
//     job and delivered it);
//   * M-05: cancelQueuedJobsForContent removes every still-queued job of
//     a cancelled content (wired into the cancel/delete flow);
//   * M-06: the durable pre-send attempt marker (deliveryAttemptedAt)
//     is written BEFORE the provider call on every real delivery, and a
//     successful send converges to delivered without clobbering races.
// =====================================================================
import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { db } from "@/lib/db";
import { resetDb, seedUser, seedDestination, seedContent, ensureDbConnected } from "./_db-helpers";
import { encryptString } from "../src/lib/security/crypto";
import { schedulePublishJob, cancelQueuedJobsForContent } from "../src/lib/queue/scheduler";
import { runWorkerOnce } from "../src/lib/queue/worker";

// Valid per the provider token policy (/^\d{6,12}:[A-Za-z0-9_-]{30,}$/).
const TEST_BOT_TOKEN = `123456:${"A".repeat(35)}`;

const _originalFetch = global.fetch;

async function seedQueuedJob(contentId: string, destinationId: string, key: string) {
  return db.publishJob.create({
    data: {
      contentId,
      destinationId,
      status: "queued",
      runAt: new Date(Date.now() - 1000), // due
      idempotencyKey: key,
    },
  });
}

describe("M-05/M-06 — worker cancelled-content guard + delivery attempt marker", () => {
  beforeAll(async () => { await ensureDbConnected(); });

  beforeEach(async () => {
    await resetDb();
    // M-06: mock the provider API so a real send can be observed without
    // network. A Telegram-style success envelope satisfies publishMessage.
    let calls = 0;
    (global as unknown as { fetch: unknown }).fetch = (async () => {
      calls++;
      void calls;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = _originalFetch;
  });

  test("a cancelled content's queued job is cancelled by the worker and never sent", async () => {
    const u = await seedUser();
    const d = await seedDestination({ ownerId: u.id });
    const c = await seedContent({ ownerId: u.id, status: "processing" });
    const job = await seedQueuedJob(c.id, d.id, `m05-${Date.now()}`);
    // The content is cancelled AFTER the job was scheduled (the pre-fix
    // window: cancel flow only touched the content row, not the jobs).
    await db.content.update({ where: { id: c.id }, data: { status: "cancelled" } });

    const summary = await runWorkerOnce(5);
    expect(summary.processed).toBe(1);
    const after = await db.publishJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("cancelled");
    expect(after.failureReason).toContain("لغو");
    // The pre-send marker must NOT be set — the guard fires before send.
    expect(after.deliveryAttemptedAt).toBeNull();
  });

  test("cancelQueuedJobsForContent cancels all queued jobs of a content (cancel/delete flow)", async () => {
    const u = await seedUser();
    const d1 = await seedDestination({ ownerId: u.id });
    const d2 = await seedDestination({ ownerId: u.id });
    const c = await seedContent({ ownerId: u.id, status: "queued" });
    const j1 = await seedQueuedJob(c.id, d1.id, `m05b-1-${Date.now()}`);
    const j2 = await seedQueuedJob(c.id, d2.id, `m05b-2-${Date.now()}`);
    // An already-terminal job of the same content must stay untouched.
    const done = await db.publishJob.create({
      data: {
        contentId: c.id,
        destinationId: d1.id,
        status: "delivered",
        idempotencyKey: `m05b-3-${Date.now()}`,
      },
    });
    const n = await cancelQueuedJobsForContent(c.id, "محتوا لغو شده است.");
    expect(n).toBe(2);
    expect((await db.publishJob.findUniqueOrThrow({ where: { id: j1.id } })).status).toBe("cancelled");
    expect((await db.publishJob.findUniqueOrThrow({ where: { id: j2.id } })).status).toBe("cancelled");
    expect((await db.publishJob.findUniqueOrThrow({ where: { id: done.id } })).status).toBe("delivered");
  });

  test("M-06: a real delivery writes deliveryAttemptedAt BEFORE the send and converges to delivered", async () => {
    const u = await seedUser();
    const d = await seedDestination({ ownerId: u.id });
    await db.destination.update({
      where: { id: d.id },
      data: { botTokenEnc: encryptString(TEST_BOT_TOKEN) },
    });
    const c = await seedContent({ ownerId: u.id, status: "queued" });
    const job = await seedQueuedJob(c.id, d.id, `m06-${Date.now()}`);

    const summary = await runWorkerOnce(5);
    expect(summary.delivered).toBe(1);
    const after = await db.publishJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("delivered");
    expect(after.deliveryAttemptedAt).not.toBeNull();
    expect(after.deliveredAt).not.toBeNull();
    // Content reaches its terminal delivered state.
    const content = await db.content.findUniqueOrThrow({ where: { id: c.id } });
    expect(content.status).toBe("delivered");
  });
});
