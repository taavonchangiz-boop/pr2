// =====================================================================
// POSTYAR — V5 fail-closed production tier regression suite
// ---------------------------------------------------------------------
// The fail-closed production tier was previously UNTESTED: dropping any
// `critical: true` flag today would pass the whole suite. These tests pin
// the production semantics of the cache/redis security primitives:
//
//   (a) idempotency(..., { critical: true }) THROWS the bounded Persian
//       error in production without a live Redis — and the wrapped fn is
//       never executed (fail closed, not fail open);
//   (b) rateLimit(..., { critical: true }) returns { ok:false } in the
//       same environment, WITHOUT touching the in-memory counter;
//   (c) WITHOUT `critical` the in-memory fallback still works in
//       production (availability preserved for non-critical paths);
//   (d) requireRedis() throws the bounded Persian error when Redis is
//       unconfigured (the documented hard-gate semantics);
//   (e) V5 H-17 — getPublicBaseUrl (via webhookUrlFor) treats the
//       .env.example placeholder https://postyar.example.com exactly like
//       an unset value: dev/preview falls back to localhost + poll route,
//       production fails closed with the bounded Persian error.
//
// ENV NOTE: cache.ts reads process.env.NODE_ENV at CALL time
// (cache.ts:169 rateLimit gate, cache.ts:497 idempotency gate) — no
// import-time snapshot — so in-process stubbing is exact. tests/preload.ts
// deletes REDIS_URL and sets NODE_ENV=test; every stubbing test restores
// both in afterEach so sibling suites are unaffected.
// =====================================================================
import { describe, test, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import type { Bot } from "@prisma/client";
import { resetDb, seedUser, seedOrder, ensureDbConnected, db } from "./_db-helpers";

// The preload environment (must be restored after every production stub).
const BASE_NODE_ENV = process.env.NODE_ENV;
const BASE_REDIS_URL = process.env.REDIS_URL;

function restoreEnv(): void {
  if (BASE_NODE_ENV === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
  else (process.env as Record<string, string | undefined>).NODE_ENV = BASE_NODE_ENV;
  if (BASE_REDIS_URL === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = BASE_REDIS_URL;
  delete process.env.POSTYAR_PUBLIC_BASE_URL;
  delete process.env.POSTYAR_ALLOW_REAL_BANK_IN_DEV;
}

afterEach(restoreEnv);

describe("V5 — fail-closed production tier (critical cache ops without Redis)", () => {
  test("(a) idempotency(critical) throws the bounded Persian error in production without Redis and never runs fn", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.REDIS_URL;
    const { idempotency } = await import("@/lib/security/cache");

    let ran = false;
    let thrown: unknown = null;
    try {
      await idempotency(
        "v5-prod-idem-a",
        async () => { ran = true; return { executed: true }; },
        60_000,
        { critical: true },
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    // The bounded Persian error names Redis (no stack/env internals leak).
    expect(msg).toContain("Redis");
    expect(msg.length).toBeLessThan(200);
    // FAIL CLOSED: the operation never executed on the per-process Map.
    expect(ran).toBe(false);
  });

  test("(b) rateLimit(critical) fails closed in production without Redis and leaves no counter residue", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.REDIS_URL;
    const { rateLimit } = await import("@/lib/security/cache");

    const r = await rateLimit({ key: "v5-prod-rl-b", limit: 3, windowMs: 60_000, critical: true });
    expect(r.ok).toBe(false);
    expect(r.count).toBe(4); // limit + 1 — the documented refused shape
    expect(r.resetMs).toBe(60_000);

    // The fail-closed path must not even have incremented the in-memory
    // counter: a non-critical read of the SAME key starts fresh at 1.
    const probe = await rateLimit({ key: "v5-prod-rl-b", limit: 3, windowMs: 60_000 });
    expect(probe.count).toBe(1);
    expect(probe.ok).toBe(true);
  });

  test("(c) without critical the in-memory fallback still works in production (availability preserved)", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.REDIS_URL;
    const { idempotency, rateLimit } = await import("@/lib/security/cache");

    const value = await idempotency(
      "v5-prod-noncrit-c",
      async () => ({ value: 42 }),
      60_000,
    );
    expect(value).toEqual({ value: 42 });

    const rl = await rateLimit({ key: "v5-prod-noncrit-rl-c", limit: 2, windowMs: 60_000 });
    expect(rl.ok).toBe(true);
    expect(rl.count).toBe(1);
  });

  test("(d) requireRedis() throws the bounded Persian error when Redis is unconfigured", async () => {
    delete process.env.REDIS_URL; // preload already deletes it — be explicit
    const { requireRedis } = await import("@/lib/security/redis-client");
    let thrown: unknown = null;
    try {
      requireRedis();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    expect(msg).toContain("Redis");
  });
});

// ---------------------------------------------------------------------
// V5 H-18 — bankVerifyAndFinalize dev gate (defense in depth)
// ---------------------------------------------------------------------
describe("V5 H-18 — bankVerifyAndFinalize refuses outside production unless explicitly overridden", () => {
  beforeAll(async () => {
    await ensureDbConnected();
    await resetDb();
  });

  afterEach(restoreEnv);

  test("dev/preview without override: refuses with the create-path message and leaves NO DB trace", async () => {
    const user = await seedUser({ email: "v5-bank-gate@test.local", mobile: "09130000920" });
    const order = await seedOrder({ userId: user.id, kind: "wallet_credit", amountRials: 500_000, status: "pending", provider: "bank" });
    await db.bankGatewayRef.create({ data: { orderId: order.id, authority: "v5-gate-authority", mode: "direct" } });

    const { bankVerifyAndFinalize } = await import("@/lib/payments/bank");
    const res = await bankVerifyAndFinalize({
      order: { id: order.id, userId: user.id, kind: order.kind, amountRials: order.amountRials, descriptionFa: order.descriptionFa, status: order.status },
      authority: "v5-gate-authority",
      status: "OK",
    });

    expect(res.ok).toBe(false);
    expect(res.paidRials).toBeUndefined();
    expect(res.errorFa).toBe("درگاه بانکی در محیط توسعه/پیش‌نمایش غیرفعال است؛ از پرداخت کارت به کارت استفاده کنید.");

    // The gate is the FIRST statement — the ref/order are untouched (no
    // verify call could have flipped anything to paid).
    const ref = await db.bankGatewayRef.findUnique({ where: { authority: "v5-gate-authority" } });
    expect(ref?.paidAt).toBeNull();
    const after = await db.order.findUnique({ where: { id: order.id } });
    expect(after?.status).toBe("pending");
  });

  test("dev WITH POSTYAR_ALLOW_REAL_BANK_IN_DEV=1: the gate passes through to the normal verify logic", async () => {
    process.env.POSTYAR_ALLOW_REAL_BANK_IN_DEV = "1";
    const { bankVerifyAndFinalize } = await import("@/lib/payments/bank");
    // Not configured + unknown authority → the ordinary refusal (NOT the
    // dev-gate message): the override re-enables the deliberate dev path.
    const res = await bankVerifyAndFinalize({
      order: { id: "no-such-order", userId: "no-such-user", kind: "wallet_credit", amountRials: 1, descriptionFa: "", status: "pending" },
      authority: "unknown-authority",
      status: "OK",
    });
    expect(res.ok).toBe(false);
    expect(res.errorFa).toBe("رفرنس بانکی معتبر نیست.");
  });

  test("the verify refusal message mirrors the create path exactly", async () => {
    const { bankCreatePaymentRequest, bankVerifyAndFinalize } = await import("@/lib/payments/bank");
    const createRes = await bankCreatePaymentRequest({
      order: { id: "x", userId: "x", kind: "wallet_credit", amountRials: 100_000, descriptionFa: "", status: "pending" },
      mode: "direct",
    });
    const verifyRes = await bankVerifyAndFinalize({
      order: { id: "x", userId: "x", kind: "wallet_credit", amountRials: 100_000, descriptionFa: "", status: "pending" },
      authority: "x",
    });
    expect(createRes.errorFa).toBeTruthy();
    expect(verifyRes.errorFa).toBe(createRes.errorFa);
  });
});

// ---------------------------------------------------------------------
// V5 H-17 — getPublicBaseUrl placeholder acceptance (via webhookUrlFor)
// ---------------------------------------------------------------------
describe("V5 H-17 — getPublicBaseUrl treats placeholder values as unset", () => {
  beforeAll(async () => {
    await ensureDbConnected();
    // Deterministic: no admin setting row may shadow the env fallbacks used
    // below (resetDb also isolates this suite from other files' rows).
    await resetDb();
    await seedUser({ email: "v5-baseurl-seed@test.local", mobile: "09130000900" });
  });

  afterEach(() => {
    restoreEnv();
  });

  const bot = { id: "bot-baseurl", provider: "telegram" } as unknown as Bot;

  test("the .env.example placeholder https://postyar.example.com degrades to the dev fallback", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "test"; // non-production → dev fallback path
    process.env.POSTYAR_PUBLIC_BASE_URL = "https://postyar.example.com";
    const { webhookUrlFor } = await import("@/lib/bots/register-webhook");
    const url = await webhookUrlFor(bot);
    expect(url.startsWith("http://localhost:3000/api/bots/incoming/telegram?bid=")).toBe(true);
    expect(url).not.toContain("example.com");
  });

  test("a REAL https URL is honored and a trailing slash is stripped", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    process.env.POSTYAR_PUBLIC_BASE_URL = "https://panel.mypostyar.ir/";
    const { webhookUrlFor } = await import("@/lib/bots/register-webhook");
    const url = await webhookUrlFor(bot);
    expect(url.startsWith("https://panel.mypostyar.ir/api/bots/incoming/telegram?bid=")).toBe(true);
  });

  test("production + placeholder fails closed with the bounded Persian error", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.POSTYAR_PUBLIC_BASE_URL = "https://postyar.example.com";
    const { webhookUrlFor } = await import("@/lib/bots/register-webhook");
    let thrown: unknown = null;
    try {
      await webhookUrlFor(bot);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    expect(msg).toBe("نشانی عمومی سرویس برای ثبت وب‌هوک پیکربندی نشده است.");
  });

  test("production + a real URL registers against the real origin", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.POSTYAR_PUBLIC_BASE_URL = "https://panel.mypostyar.ir";
    const { webhookUrlFor } = await import("@/lib/bots/register-webhook");
    const url = await webhookUrlFor(bot);
    expect(url.startsWith("https://panel.mypostyar.ir/api/bots/incoming/telegram?bid=")).toBe(true);
  });
});
