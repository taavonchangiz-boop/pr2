// =====================================================================
// POSTYAR — V4 M-06 end-to-end session revocation tests
// ---------------------------------------------------------------------
// Drives the REAL route handlers (not re-implementations) against the
// real database and asserts the required V4 scenario: an ALREADY-EXISTING
// session cookie must NEVER bypass the user's security state.
//
//   1. active session → admin suspends user (PATCH /api/admin/users/[id])
//      → the old cookie is rejected on the very next request;
//   2. active session → admin resets the password
//      (POST /api/admin/users/[id]/reset-password)
//      → the old cookie is rejected;
//   3. second session → user changes their own password
//      (POST /api/auth/me/password)
//      → the OTHER session is rejected while the current one survives;
//   4. active session → OTP-flow self reset
//      (POST /api/auth/reset-password)
//      → EVERY session is rejected.
//
// These tests FAILED against the pre-hardening implementation where
// suspension/reset wrote state without revoking live sessions (the lazy
// per-request status check alone did not exist).
// =====================================================================
import { test, expect, describe, beforeAll, beforeEach, mock } from "bun:test";
import { db } from "@/lib/db";
import { resetDb, seedUser, ensureDbConnected } from "./_db-helpers";
import { signJwt, hashToken, randomToken } from "@/lib/security/crypto";
import { cache } from "@/lib/security/cache";

// --- Mock next/headers cookies() (same pattern as db-authorization.test.ts) ---
let _cookieValue: string | undefined = undefined;
const _cookieStore = {
  get: (_name: string) => (_cookieValue !== undefined ? { value: _cookieValue } : undefined),
  set: (_name: string, value: string) => { _cookieValue = value; },
  delete: () => { _cookieValue = undefined; },
};
mock.module("next/headers", () => ({
  cookies: async () => _cookieStore,
}));

const { SESSION_COOKIE } = await import("@/lib/server/auth");
const { createSession, requireUser } = await import("@/lib/server/auth");

// Route handlers under test (imported after the mock is installed).
const adminUserRoute = await import("@/app/api/admin/users/[id]/route");
const adminResetRoute = await import("@/app/api/admin/users/[id]/reset-password/route");
const mePasswordRoute = await import("@/app/api/auth/me/password/route");
const selfResetRoute = await import("@/app/api/auth/reset-password/route");

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Create a session row directly (returns the RAW bearer token). */
async function rawSession(userId: string): Promise<string> {
  const sid = randomToken(16);
  const token = signJwt({ sub: userId, sid, role: "" }, 60 * 60);
  await db.session.create({
    data: {
      id: sid,
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return token;
}

describe("V4 M-06 — old sessions never bypass suspension / password reset (route-level e2e)", () => {
  let adminEmail: string;
  let victimEmail: string;
  let adminId: string;
  let victimId: string;
  let victimMobile: string;

  beforeAll(async () => {
    await ensureDbConnected();
  });

  beforeEach(async () => {
    await resetDb();
    _cookieValue = undefined;
    const admin = await seedUser({ email: undefined, role: "admin" });
    const victim = await seedUser({ email: undefined });
    adminId = admin.id;
    victimId = victim.id;
    adminEmail = admin.email;
    victimEmail = victim.email;
    victimMobile = victim.mobile;
    // Ensure a known password for the victim (me/password flow).
    // seedUser default password is "Pass1234!".
  });

  test("1. admin suspension kills the victim's LIVE session immediately", async () => {
    // Victim logs in first (a live session exists).
    await createSession(victimId, "127.0.0.1", "victim-agent");
    const victimToken = _cookieValue;
    expect(victimToken).toBeTruthy();
    // Sanity: the victim's session works.
    _cookieValue = victimToken;
    await expect(requireUser()).resolves.toMatchObject({ id: victimId });

    // Admin logs in and suspends the victim through the REAL route.
    await createSession(adminId, "127.0.0.1", "admin-agent");
    const adminToken = _cookieValue!;
    _cookieValue = adminToken;
    const res = await adminUserRoute.PATCH(
      jsonRequest(`http://localhost/api/admin/users/${victimId}`, { status: "suspended" }),
      { params: Promise.resolve({ id: victimId }) },
    );
    expect(res.status).toBe(200);

    // The victim's OLD cookie is rejected on the very next request.
    _cookieValue = victimToken;
    await expect(requireUser()).rejects.toMatchObject({ name: "AuthError", status: 401 });
    // The session row is revoked in the DB — not merely masked.
    const sessions = await db.session.findMany({ where: { userId: victimId } });
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
  });

  test("2. admin password reset kills the victim's LIVE session immediately", async () => {
    await createSession(victimId, "127.0.0.1", "victim-agent");
    const victimToken = _cookieValue!;
    _cookieValue = victimToken;
    await expect(requireUser()).resolves.toMatchObject({ id: victimId });

    await createSession(adminId, "127.0.0.1", "admin-agent");
    _cookieValue = _cookieValue; // admin token now in the mock store
    const res = await adminResetRoute.POST(
      jsonRequest(`http://localhost/api/admin/users/${victimId}/reset-password`, { newPassword: "NewPass9988!" }),
      { params: Promise.resolve({ id: victimId }) },
    );
    expect(res.status).toBe(200);

    // Old cookie rejected; every session revoked.
    _cookieValue = victimToken;
    await expect(requireUser()).rejects.toMatchObject({ name: "AuthError", status: 401 });
    const sessions = await db.session.findMany({ where: { userId: victimId } });
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
  });

  test("3. self password change revokes OTHER sessions but keeps the current one", async () => {
    // Current session + a second (stolen/other-device) session.
    await createSession(victimId, "127.0.0.1", "current-agent");
    const currentToken = _cookieValue!;
    const otherToken = await rawSession(victimId);

    _cookieValue = currentToken;
    const res = await mePasswordRoute.POST(
      jsonRequest("http://localhost/api/auth/me/password", {
        currentPassword: "Pass1234!",
        newPassword: "BrandNew1234!",
      }),
    );
    expect(res.status).toBe(200);

    // The OTHER session is dead.
    _cookieValue = otherToken;
    await expect(requireUser()).rejects.toMatchObject({ name: "AuthError", status: 401 });
    // The CURRENT session survives (the user is not logged out of the
    // device they changed the password from).
    _cookieValue = currentToken;
    await expect(requireUser()).resolves.toMatchObject({ id: victimId });
  });

  test("4. OTP-flow self reset revokes EVERY session of the user", async () => {
    await createSession(victimId, "127.0.0.1", "agent-1");
    const token1 = _cookieValue!;
    const token2 = await rawSession(victimId);

    // Stage the single-use reset token exactly as the OTP verify step does.
    const verifyToken = randomToken(24);
    await cache.set(`verify:reset:${victimMobile}`, hashToken(verifyToken), 10 * 60 * 1000);

    _cookieValue = token1; // does not matter — the reset flow is cookie-independent
    const res = await selfResetRoute.POST(
      jsonRequest("http://localhost/api/auth/reset-password", {
        mobile: victimMobile,
        verifyToken,
        newPassword: "ResetFlow1234!",
      }),
    );
    expect(res.status).toBe(200);

    // BOTH sessions are dead — a stolen session cannot survive a reset.
    _cookieValue = token1;
    await expect(requireUser()).rejects.toMatchObject({ name: "AuthError", status: 401 });
    _cookieValue = token2;
    await expect(requireUser()).rejects.toMatchObject({ name: "AuthError", status: 401 });
    // The single-use token is consumed — replay is rejected.
    const replay = await selfResetRoute.POST(
      jsonRequest("http://localhost/api/auth/reset-password", {
        mobile: victimMobile,
        verifyToken,
        newPassword: "SecondPass1234!",
      }),
    );
    expect(replay.status).toBe(400);
  });
});
