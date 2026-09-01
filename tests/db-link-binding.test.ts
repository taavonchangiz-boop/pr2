// =====================================================================
// POSTYAR — Provider identity binding regression tests (P1.3)
// ---------------------------------------------------------------------
// Invariants:
//   * a provider identity binds to ONE POSTYAR account per bot;
//   * re-binding the SAME account is allowed (idempotent refresh);
//   * re-binding to a DIFFERENT account is BLOCKED (no silent takeover);
//   * two codes consumed CONCURRENTLY for the same provider identity:
//     exactly one wins (UNIQUE bindingKey), the loser is rejected;
//   * all link/rebind attempts are audited.
// =====================================================================
import { test, expect, describe, beforeAll, beforeEach } from "bun:test";
import { resetDb, seedUser, seedBot, ensureDbConnected, db } from "./_db-helpers";
import { generateLinkCode, consumeLinkCode, base32Encode, LINK_CODE_PREFIX } from "@/lib/bots/link";
import { hmacSign, hashToken } from "@/lib/security/crypto";
import crypto from "node:crypto";

/** Construct a genuinely HMAC-valid link code for an arbitrary account
 *  (the test acts as the issuing server) — used to prove that even a
 *  cryptographically valid cross-account code cannot hijack a bound
 *  provider identity. */
async function forgeValidCode(input: { botId: string; userId: string }): Promise<string> {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const nonce = crypto.randomBytes(8).toString("hex").slice(0, 6).toUpperCase();
  const payload = `${input.botId}:${input.userId}:${expiresAt.toISOString()}:${nonce}`;
  const expectedHmac = hmacSign("bot-link-code", payload).slice(0, 8).toUpperCase();
  const suffix = base32Encode(Buffer.from(expectedHmac, "utf8"), 8);
  const plaintext = `${LINK_CODE_PREFIX}${nonce}${suffix}`;
  await db.botLinkCode.create({
    data: { botId: input.botId, userId: input.userId, codeHash: hashToken(plaintext), expiresAt },
  });
  return plaintext;
}

describe("bot link identity binding (DB-backed)", () => {
  let userId: string;
  let otherUserId: string;
  let botId: string;

  beforeAll(async () => {
    await ensureDbConnected();
  });

  beforeEach(async () => {
    await resetDb();
    const u = await seedUser({ email: "link@test.local", mobile: "09120000401" });
    const o = await seedUser({ email: "link2@test.local", mobile: "09120000402" });
    userId = u.id;
    otherUserId = o.id;
    const b = await seedBot({ ownerId: userId });
    botId = b.id;
  });

  test("consume links the provider identity to the code owner", async () => {
    const { code } = await generateLinkCode({ userId, botId });
    const r = await consumeLinkCode({ botId, code, providerUserId: "tg-777" });
    expect(r.ok).toBe(true);
    expect(r.userId).toBe(userId);
    const binding = await db.botLinkCode.findFirst({
      where: { botId, bindingKey: `${botId}:tg-777` },
    });
    expect(binding?.userId).toBe(userId);
  });

  test("re-binding the SAME account is allowed", async () => {
    const c1 = await generateLinkCode({ userId, botId });
    expect((await consumeLinkCode({ botId, code: c1.code, providerUserId: "tg-778" })).ok).toBe(true);
    const c2 = await generateLinkCode({ userId, botId });
    const r2 = await consumeLinkCode({ botId, code: c2.code, providerUserId: "tg-778" });
    expect(r2.ok).toBe(true);
  });

  test("re-binding to a DIFFERENT account is blocked (no silent takeover)", async () => {
    const c1 = await generateLinkCode({ userId, botId });
    const r1 = await consumeLinkCode({ botId, code: c1.code, providerUserId: "tg-779" });
    expect(r1.ok).toBe(true);
    expect(r1.userId).toBe(userId);

    // A cryptographically VALID code issued to ANOTHER account cannot
    // hijack the bound identity.
    const forged = await forgeValidCode({ botId, userId: otherUserId });
    const r2 = await consumeLinkCode({ botId, code: forged, providerUserId: "tg-779" });
    expect(r2.ok).toBe(false);

    // The original binding is untouched.
    const binding = await db.botLinkCode.findFirst({
      where: { botId, bindingKey: `${botId}:tg-779` },
    });
    expect(binding?.userId).toBe(userId);
  });

  test("CONCURRENT consumption of two codes for one identity → exactly one wins", async () => {
    const c1 = await generateLinkCode({ userId, botId });
    // The second code is a valid code for the OTHER account (hijack).
    const c2 = await forgeValidCode({ botId, userId: otherUserId });
    const [r1, r2] = await Promise.all([
      consumeLinkCode({ botId, code: c1.code, providerUserId: "tg-780" }),
      consumeLinkCode({ botId, code: c2, providerUserId: "tg-780" }),
    ]);
    const winners = [r1, r2].filter((r) => r.ok);
    expect(winners.length).toBe(1);
    // Exactly one binding row exists for the identity.
    const bindings = await db.botLinkCode.findMany({
      where: { botId, bindingKey: `${botId}:tg-780`, consumedAt: { not: null } },
    });
    expect(bindings.length).toBe(1);
  });

  test("rebind attempts are audited", async () => {
    const c1 = await generateLinkCode({ userId, botId });
    await consumeLinkCode({ botId, code: c1.code, providerUserId: "tg-781" });
    const forged = await forgeValidCode({ botId, userId: otherUserId });
    await consumeLinkCode({ botId, code: forged, providerUserId: "tg-781" });
    const audits = await db.auditLog.findMany({
      where: { action: "bot_link_rebind_blocked" },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });
});
