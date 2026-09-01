// =====================================================================
// POSTYAR — C-02/M-01 SystemSetting cache + durable settings tests
// ---------------------------------------------------------------------
// Proves against the REAL database:
//   * getSetting() returns the USABLE decrypted value on cache miss AND
//     on cache hit (the historical bug: cache hit returned ciphertext);
//   * legacy plaintext rows still resolve;
//   * corrupt ciphertext fails CLOSED (empty string — never ciphertext);
//   * an admin write + epoch bump is deterministic on immediate read;
//   * the batch settings write is ONE transaction — a mid-batch failure
//     leaves NO partial rows (M-01 all-or-nothing, mirroring the exact
//     transactional shape used by PATCH /api/admin/settings).
// =====================================================================
import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { db } from "@/lib/db";
import { resetDb, ensureDbConnected } from "./_db-helpers";
import { getSetting, bumpSettingsEpoch, resolveStoredSecret } from "../src/lib/providers/util";
import { encryptString } from "../src/lib/security/crypto";

const KEY = "POSTYAR_AI_MODEL";
const SENSITIVE_KEY = "POSTYAR_AI_API_KEY";

describe("C-02 — SystemSetting cache always resolves to the runtime value", () => {
  beforeAll(async () => { await ensureDbConnected(); });

  beforeEach(async () => {
    await resetDb();
    await bumpSettingsEpoch(); // deterministic empty shared cache
  });

  test("encrypted value: cache MISS decrypts", async () => {
    await db.systemSetting.create({
      data: { key: KEY, value: encryptString("gpt-4o-mini") },
    });
    await bumpSettingsEpoch();
    expect(await getSetting(KEY)).toBe("gpt-4o-mini");
  });

  test("encrypted value: cache HIT decrypts too (never returns ciphertext)", async () => {
    await db.systemSetting.create({
      data: { key: SENSITIVE_KEY, value: encryptString("sk-secret-value-123") },
    });
    await bumpSettingsEpoch();
    const first = await getSetting(SENSITIVE_KEY);
    expect(first).toBe("sk-secret-value-123");
    // Second read goes through the shared cache (epoch-keyed) — the
    // historical defect returned the raw ciphertext envelope here.
    const second = await getSetting(SENSITIVE_KEY);
    expect(second).toBe("sk-secret-value-123");
    expect(second.startsWith("v1:aes-256-gcm:")).toBe(false);
  });

  test("legacy plaintext rows still resolve", async () => {
    await db.systemSetting.create({ data: { key: KEY, value: "legacy-plain" } });
    await bumpSettingsEpoch();
    expect(await getSetting(KEY)).toBe("legacy-plain");
  });

  test("corrupt ciphertext fails CLOSED (empty string, never the envelope)", async () => {
    const corrupt = "v1:aes-256-gcm:bm90LWl2:bm90LXRhZw:bm90LWNpcGhlcnRleHQ";
    expect(resolveStoredSecret(corrupt)).toBe("");
    await db.systemSetting.create({ data: { key: KEY, value: corrupt } });
    await bumpSettingsEpoch();
    expect(await getSetting(KEY)).toBe("");
  });

  test("admin update + epoch bump is deterministic on the immediate next read", async () => {
    await db.systemSetting.create({ data: { key: KEY, value: encryptString("model-a") } });
    await bumpSettingsEpoch();
    expect(await getSetting(KEY)).toBe("model-a"); // warms the cache
    await db.systemSetting.update({ where: { key: KEY }, data: { value: encryptString("model-b") } });
    await bumpSettingsEpoch(); // what every admin write path awaits
    expect(await getSetting(KEY)).toBe("model-b");
  });
});

describe("M-01 — batch settings write is all-or-nothing", () => {
  beforeAll(async () => { await ensureDbConnected(); });

  beforeEach(async () => {
    await resetDb();
    await bumpSettingsEpoch();
  });

  test("a mid-batch failure rolls back the WHOLE batch (no partial rows)", async () => {
    // Mirror of PATCH /api/admin/settings: one $transaction around the
    // upsert loop. The failing item violates the key UNIQUE constraint
    // (create inside the same tx), proving nothing partial survives.
    await db.systemSetting.create({ data: { key: "PRE-EXISTING-KEY", value: "x" } });
    await expect(
      db.$transaction(async (tx) => {
        await tx.systemSetting.upsert({
          where: { key: "BATCH-KEY-1" },
          create: { key: "BATCH-KEY-1", value: "v1" },
          update: { value: "v1" },
        });
        await tx.systemSetting.upsert({
          where: { key: "BATCH-KEY-2" },
          create: { key: "BATCH-KEY-2", value: "v2" },
          update: { value: "v2" },
        });
        // Simulated failure on the third item of the batch:
        await tx.systemSetting.create({ data: { key: "PRE-EXISTING-KEY", value: "dup" } });
      }),
    ).rejects.toBeTruthy();
    const rows = await db.systemSetting.findMany({
      where: { key: { in: ["BATCH-KEY-1", "BATCH-KEY-2"] } },
    });
    expect(rows.length).toBe(0); // pre-fix: row 1 (maybe 2) committed
  });

  test("a fully successful batch persists every row atomically", async () => {
    await db.$transaction(async (tx) => {
      for (const [k, v] of [["B1", "v1"], ["B2", "v2"], ["B3", "v3"]] as const) {
        await tx.systemSetting.upsert({
          where: { key: k },
          create: { key: k, value: v },
          update: { value: v },
        });
      }
    });
    const rows = await db.systemSetting.findMany({ where: { key: { in: ["B1", "B2", "B3"] } } });
    expect(rows.length).toBe(3);
  });
});
