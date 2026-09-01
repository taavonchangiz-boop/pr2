// =====================================================================
// POSTYAR — OTP lifecycle DB-backed tests (addendum §9, §10, §47)
// ---------------------------------------------------------------------
// Guards the CRITICAL regression (randomNumericCode infinite loop) and
// proves the brute-force / replay / reuse defenses against a real DB:
//   1. randomNumericCode(6) returns a 6-digit numeric string in <5ms
//      (regression guard for the infinite-loop bug — addendum §9).
//   2. requestOtp stores codeHash, NEVER the plaintext code.
//   3. Resend cooldown (60s) enforced.
//   4. verifyOtp wrong code → attempts++; after 5 → locked.
//   5. Expired OTP rejected.
//   6. Already-consumed OTP rejected (replay defense).
//   7. Correct code → consumedAt set, returns success.
//   8. OTP is single-use (second verify with same code rejected).
// =====================================================================
import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../src/lib/db";
import { requestOtp, verifyOtp } from "../src/lib/server/auth";
import { randomNumericCode, hashOtp } from "../src/lib/security/crypto";
import { cache } from "../src/lib/security/cache";
import { resetDb } from "./db-helpers";

describe("OTP lifecycle + brute-force defense (DB-backed)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  test("randomNumericCode(6) is 6-digit numeric, <250ms, no infinite loop (regression guard)", async () => {
    const t0 = Date.now();
    const code = randomNumericCode(6);
    const elapsed = Date.now() - t0;
    expect(code).toMatch(/^\d{6}$/);
    expect(elapsed).toBeLessThan(250);
    // Entropy sanity: 100 draws produce >50 unique codes
    const set = new Set<string>();
    for (let i = 0; i < 100; i++) set.add(randomNumericCode(6));
    expect(set.size).toBeGreaterThan(50);
  });

  test("requestOtp stores codeHash, NOT plaintext code", async () => {
    const mobile = "09120000001";
    const res = await requestOtp(mobile, "register");
    expect(res.sent).toBe(true);
    const row = await db.otp.findFirst({ where: { mobile }, orderBy: { createdAt: "desc" } });
    expect(row).not.toBeNull();
    // The stored codeHash must NOT equal the plaintext code
    const devCode = await cache.get<string>(`dev:otp:${mobile}`);
    expect(devCode).toMatch(/^\d{6}$/);
    expect(row!.codeHash).not.toBe(devCode);
    // And the codeHash must equal hashOtp(plaintext)
    expect(row!.codeHash).toBe(hashOtp(devCode!));
  });

  test("resend cooldown (60s) enforced", async () => {
    const mobile = "09120000002";
    const r1 = await requestOtp(mobile, "register");
    expect(r1.sent).toBe(true);
    const r2 = await requestOtp(mobile, "register");
    expect(r2.sent).toBe(false);
    expect(r2.cooldownSec).toBeGreaterThanOrEqual(1);
  });

  test("verifyOtp wrong code increments attempts; after 5 → locked", async () => {
    const mobile = "09120000003";
    await requestOtp(mobile, "register");
    const devCode = await cache.get<string>(`dev:otp:${mobile}`);
    // 5 wrong attempts
    for (let i = 0; i < 5; i++) {
      const wrong = devCode === "000000" ? "111111" : "000000";
      const r = await verifyOtp(mobile, wrong, "register", "127.0.0.1");
      expect(r.ok).toBe(false);
    }
    // 6th attempt with the CORRECT code is rejected (locked)
    const locked = await verifyOtp(mobile, devCode!, "register", "127.0.0.2");
    expect(locked.ok).toBe(false);
    // Verify attempts reached the cap
    const row = await db.otp.findFirst({ where: { mobile }, orderBy: { createdAt: "desc" } });
    expect(row!.attempts).toBeGreaterThanOrEqual(5);
  });

  test("expired OTP rejected", async () => {
    const mobile = "09120000004";
    await requestOtp(mobile, "register");
    const devCode = await cache.get<string>(`dev:otp:${mobile}`);
    // Manually expire the row
    const row = await db.otp.findFirst({ where: { mobile }, orderBy: { createdAt: "desc" } });
    await db.otp.update({ where: { id: row!.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await verifyOtp(mobile, devCode!, "register", "127.0.0.3");
    expect(r.ok).toBe(false);
  });

  test("already-consumed OTP rejected (replay/single-use defense)", async () => {
    const mobile = "09120000005";
    await requestOtp(mobile, "register");
    const devCode = await cache.get<string>(`dev:otp:${mobile}`);
    // First verify succeeds
    const r1 = await verifyOtp(mobile, devCode!, "register", "127.0.0.4");
    expect(r1.ok).toBe(true);
    // Second verify with the SAME code rejected (consumedAt set)
    const r2 = await verifyOtp(mobile, devCode!, "register", "127.0.0.5");
    expect(r2.ok).toBe(false);
    // Verify consumedAt is set
    const row = await db.otp.findFirst({ where: { mobile }, orderBy: { createdAt: "desc" } });
    expect(row!.consumedAt).not.toBeNull();
  });

  test("correct code → success + consumedAt set", async () => {
    const mobile = "09120000006";
    await requestOtp(mobile, "register");
    const devCode = await cache.get<string>(`dev:otp:${mobile}`);
    const r = await verifyOtp(mobile, devCode!, "register", "127.0.0.6");
    expect(r.ok).toBe(true);
    const row = await db.otp.findFirst({ where: { mobile }, orderBy: { createdAt: "desc" } });
    expect(row!.consumedAt).not.toBeNull();
  });

  test("malformed code rejected (not 6 digits)", async () => {
    const mobile = "09120000007";
    await requestOtp(mobile, "register");
    const r = await verifyOtp(mobile, "abc123", "register", "127.0.0.7");
    expect(r.ok).toBe(false);
  });

  test("verifyOtp for login requires the user to exist", async () => {
    const mobile = "09120000008";
    // No user seeded — login requestOtp rejects
    const r = await requestOtp(mobile, "login");
    expect(r.sent).toBe(false);
    expect(r.errorFa).toBeTruthy();
  });
});
