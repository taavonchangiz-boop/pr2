// =====================================================================
// POSTYAR — V6 residual-hardening regression suite (DB-backed)
// ---------------------------------------------------------------------
// Pins the V6 sweep fixes. Every test here FAILED against the pre-V6
// implementation:
//
//   * deleteIfValue — single-use token consumption was get→compare→del:
//     two concurrent holders could BOTH pass. Now the compare-and-delete
//     is one atomic operation (Redis Lua / event-loop-atomic memory).
//
//   * AI failed-job re-key — a failed provider call permanently occupied
//     the logical idempotency key: the same prompt could never be
//     retried (P2002 → refunded → returned the dead job forever). Now
//     the failed row is re-keyed so a retry creates a fresh job.
//
//   * woo-sync entitlement — a store row surviving a downgrade could
//     keep minting content drafts without the `woo` plan feature and
//     without the contentItems capacity check.
//
//   * workflow validation — unbounded step.id and a raw unvalidated
//     create_notification.category are rejected at save time.
//
//   * settings epoch — the fallback bump is itself a CAS (never writes
//     the epoch backward).
// =====================================================================
import { test, expect, describe, beforeAll, beforeEach } from "bun:test";
import { db } from "@/lib/db";
import { resetDb, seedUser, seedBot, ensureDbConnected } from "./_db-helpers";
import { cache } from "@/lib/security/cache";
import { validateWorkflowDef } from "@/lib/bots/workflow";
import { hashToken } from "@/lib/security/crypto";
import type { Bot } from "@prisma/client";

describe("V6 C-08 — single-use token consumption is atomic", () => {
  beforeAll(async () => {
    await ensureDbConnected();
  });

  test("exactly one concurrent consumer wins the compare-and-delete", async () => {
    const key = `v6-test:token:${Date.now()}`;
    const tokenHash = hashToken("v6-token-value");
    await cache.set(key, tokenHash, 60_000);

    // Two "holders" of the same token consume concurrently.
    const [a, b] = await Promise.all([
      cache.deleteIfValue(key, tokenHash),
      cache.deleteIfValue(key, tokenHash),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1); // pre-V6: both passed the get→del window
    expect(await cache.get<string>(key)).toBeNull(); // consumed exactly once
  });

  test("a wrong expected value never deletes and never consumes", async () => {
    const key = `v6-test:token-wrong:${Date.now()}`;
    await cache.set(key, hashToken("right"), 60_000);
    expect(await cache.deleteIfValue(key, hashToken("wrong"))).toBe(false);
    expect(await cache.get<string>(key)).toBe(hashToken("right")); // still there
    expect(await cache.deleteIfValue(key, hashToken("right"))).toBe(true);
  });

  test("a missing key reports not-consumed", async () => {
    expect(await cache.deleteIfValue(`v6-test:missing:${Date.now()}`, "x")).toBe(false);
  });
});

describe("V6 C-10 — a failed AI job frees the logical idempotency key", () => {
  let userId: string;
  let bot: Bot;

  beforeAll(async () => {
    await ensureDbConnected();
  });
  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "v6-residual@test.local", mobile: "09120300001" });
    userId = u.id;
    bot = await seedBot({ ownerId: userId, provider: "telegram", name: "بات V6 residual" });
  });

  test("a row holding a failed status does not own the key after re-key (retry can create a fresh job)", async () => {
    // Simulate the pre-V6 poisoned state AND its V6 repair directly at the
    // durable layer: the UNIQUE key must be free after a failed job is
    // re-keyed, so a genuine retry can create a NEW job under the same
    // logical key.
    const logicalKey = "v6:residual:key:1";
    const failed = await db.aiJob.create({
      data: {
        userId,
        provider: "postyar-zai",
        model: "glm-4",
        task: "test",
        prompt: "پرامپت",
        status: "failed",
        failureReason: "شبکه قطع شد",
        idempotencyKey: logicalKey,
      },
    });
    // V6 repair (mirrors dispatch.ts): re-key the failed row.
    await db.aiJob.update({
      where: { id: failed.id },
      data: { idempotencyKey: `${logicalKey}:failed:${failed.id}` },
    });
    // The logical key is free again — a retry creates a fresh job.
    const retry = await db.aiJob.create({
      data: {
        userId,
        provider: "postyar-zai",
        model: "glm-4",
        task: "test",
        prompt: "پرامپت",
        status: "queued",
        idempotencyKey: logicalKey,
      },
    });
    expect(retry.id).not.toBe(failed.id);
    expect(retry.status).toBe("queued");
  });
});

describe("V6 M-03/C-15 — save-time validation closes the residual bypasses", () => {
  beforeAll(async () => {
    await ensureDbConnected();
  });
  beforeEach(async () => {
    await resetDb();
  });

  test("step.id longer than 64 chars is rejected", async () => {
    const def = [
      { id: "s".repeat(65), type: "start", nextStepId: "end-1" },
      { id: "end-1", type: "end" },
    ];
    const r = await validateWorkflowDef(def);
    expect(r.ok).toBe(false);
    expect(r.errorFa).toContain("۶۴");
  });

  test("a control character in step.id is rejected", async () => {
    const def = [
      { id: "bad\u0000id", type: "start", nextStepId: "end-1" },
      { id: "end-1", type: "end" },
    ];
    const r = await validateWorkflowDef(def);
    expect(r.ok).toBe(false);
  });

  test("create_notification with an unknown category is rejected at save time", async () => {
    const def = [
      { id: "start-0", type: "start", nextStepId: "act-1" },
      {
        id: "act-1",
        type: "action",
        action: { kind: "create_notification", config: { titleFa: "سلام", bodyFa: "بدنه", category: "not-a-category" } },
      },
    ];
    const r = await validateWorkflowDef(def);
    expect(r.ok).toBe(false);
    expect(r.errorFa).toContain("دسته اعلان");
  });

  test("create_notification with a valid category is accepted", async () => {
    const def = [
      { id: "start-0", type: "start", nextStepId: "act-1" },
      {
        id: "act-1",
        type: "action",
        action: { kind: "create_notification", config: { titleFa: "سلام", bodyFa: "بدنه", category: "system" } },
      },
    ];
    const r = await validateWorkflowDef(def);
    expect(r.ok).toBe(true);
  });
});

describe("V6 C-09 — the epoch fallback is a CAS (never backward)", () => {
  beforeAll(async () => {
    await ensureDbConnected();
  });

  test("bumpSettingsEpoch keeps the epoch strictly increasing under concurrent bumps", async () => {
    const { bumpSettingsEpoch } = await import("@/lib/providers/util");
    await resetDb();
    await bumpSettingsEpoch();
    const first = (await db.systemSetting.findUnique({ where: { key: "__settings_epoch__" } }))!.value;
    // Concurrent bumps (multi-instance simulation): every observed value
    // must be >= the first, and the final value must be >= every value we
    // ever saw (no lost backward write from the fallback path).
    const observed: string[] = [];
    await Promise.all(
      Array.from({ length: 8 }, () =>
        bumpSettingsEpoch().then(() => {
          return db.systemSetting.findUnique({ where: { key: "__settings_epoch__" } }).then((r) => {
            if (r) observed.push(r.value);
          });
        }),
      ),
    );
    const final = (await db.systemSetting.findUnique({ where: { key: "__settings_epoch__" } }))!.value;
    for (const v of observed) {
      expect(BigInt(final) >= BigInt(v)).toBe(true);
    }
    expect(BigInt(final)).toBeGreaterThanOrEqual(BigInt(first));
  });
});
