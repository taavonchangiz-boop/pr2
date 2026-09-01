// =====================================================================
// POSTYAR server-side auth helpers
// =====================================================================
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import {
  signJwt, verifyJwt, hashToken, hashOtp, hashPassword, verifyPassword,
  randomToken, randomNumericCode, constantTimeEqual,
} from "@/lib/security/crypto";
import { rateLimit } from "@/lib/security/cache";
import { normalizeMobile, isValidIranMobile } from "@/lib/persian";
import { AuthError } from "@/lib/auth-error";
import type { User, Prisma } from "@prisma/client";

export const SESSION_COOKIE = "postyar_sid";
export const SESSION_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

export type AuthUser = {
  id: string;
  email: string;
  mobile: string;
  firstName: string;
  lastName: string;
  role: string;
  status: string;
  referralCode: string;
};

function toAuthUser(u: User): AuthUser {
  return {
    id: u.id,
    email: u.email,
    mobile: u.mobile,
    firstName: u.firstName,
    lastName: u.lastName,
    role: u.role,
    status: u.status,
    referralCode: u.referralCode,
  };
}

export async function createSession(userId: string, ip?: string, userAgent?: string | null): Promise<void> {
  const sid = randomToken(16);
  const token = signJwt({ sub: userId, sid, role: "" }, SESSION_TTL_SEC);
  await db.session.create({
    data: {
      id: sid,
      userId,
      tokenHash: hashToken(token),
      ip: ip ?? null,
      userAgent: userAgent ?? null,
      expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000),
    },
  });
  const c = await cookies();
  c.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_SEC,
    path: "/",
  });
}

export async function clearSessionCookie(): Promise<void> {
  const c = await cookies();
  c.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", maxAge: 0, path: "/" });
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const c = await cookies();
  const token = c.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = verifyJwt(token);
  if (!payload) return null;
  const session = await db.session.findUnique({ where: { id: payload.sid } });
  if (!session || (session.expiresAt && session.expiresAt.getTime() < Date.now()) || session.revokedAt) return null;
  // constant-time compare cookie JWT hash vs stored hash (rotation detection)
  if (!constantTimeEqual(session.tokenHash, hashToken(token))) return null;
  const user = await db.user.findUnique({ where: { id: payload.sub } });
  if (!user || user.status !== "active") {
    if (user) {
      await db.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    }
    return null;
  }
  return toAuthUser(user);
}

export async function revokeCurrentSession(): Promise<void> {
  const c = await cookies();
  const token = c.get(SESSION_COOKIE)?.value;
  if (!token) return;
  const payload = verifyJwt(token);
  if (!payload) return;
  await db.session.updateMany({
    where: { id: payload.sid, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await clearSessionCookie();
}

export async function requireUser(): Promise<AuthUser> {
  const u = await getCurrentUser();
  if (!u) throw new AuthError("نیاز به ورود", 401);
  return u;
}

export async function requireRole(roles: string[]): Promise<AuthUser> {
  const u = await requireUser();
  if (!roles.includes(u.role)) throw new AuthError("دسترسی غیرمجاز", 403);
  return u;
}

// V6 M-01 — AuthError moved to the dependency-free canonical module
// `@/lib/auth-error` (plans.ts previously had to define a DUPLICATE class
// because importing this server module from the client-safe plan boundary
// was forbidden — two classes broke instanceof across that boundary).
// Re-exported here so every existing import path keeps its identity.
export { AuthError } from "@/lib/auth-error";

// M-4 — EXPLICIT PROXY TRUST. X-Forwarded-For is attacker-controlled
// whenever the Node server port is directly reachable (it is only safe
// behind the repo's Caddy gateway, which overwrites the header with
// {remote_host}). The application therefore trusts the first XFF hop
// ONLY when the operator explicitly opts in with POSTYAR_TRUST_PROXY=1
// (set in production deployments behind the reverse proxy). Without the
// opt-in every request shares one conservative rate-limit bucket —
// fail-closed for brute-force throttles (OTP/login/reset/ad metrics),
// never fail-open.
const TRUST_PROXY = process.env.POSTYAR_TRUST_PROXY === "1";
const UNKNOWN_IP = "0.0.0.0";

export function clientIp(req: Request): string {
  if (TRUST_PROXY) {
    return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || UNKNOWN_IP;
  }
  // No trusted proxy configured: the header is untrusted and must not
  // influence security decisions (per-IP throttles, audit attribution).
  return UNKNOWN_IP;
}

// ---------------------------------------------------------------------
// OTP flow
// ---------------------------------------------------------------------
const OTP_TTL_MS = 2 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60_000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_REQUEST_LIMIT = 5;
const OTP_REQUEST_WINDOW_MS = 60 * 60 * 1000;

export async function requestOtp(mobileRaw: string, purpose: "login" | "register" | "reset"): Promise<{ sent: boolean; cooldownSec: number; errorFa?: string }> {
  const mobile = normalizeMobile(mobileRaw);
  if (!isValidIranMobile(mobile)) return { sent: false, cooldownSec: 0, errorFa: "شماره موبایل نامعتبر است." };

  const mobileKey = `otp:req:${mobile}`;
  const rl = await rateLimit({ key: mobileKey, limit: OTP_REQUEST_LIMIT, windowMs: OTP_REQUEST_WINDOW_MS, critical: true });
  if (!rl.ok) return { sent: false, cooldownSec: 600, errorFa: "تعداد درخواست کد بیش از حد مجاز است. یک ساعت بعد تلاش کنید." };

  const existing = await db.user.findUnique({ where: { mobile } });
  if (purpose === "login" && !existing) return { sent: false, cooldownSec: 0, errorFa: "حسابی با این شماره یافت نشد. ابتدا ثبت‌نام کنید." };
  if (purpose === "register" && existing) return { sent: false, cooldownSec: 0, errorFa: "این شماره قبلاً ثبت شده است." };

  const recent = await db.otp.findFirst({
    where: { mobile, createdAt: { gt: new Date(Date.now() - OTP_RESEND_COOLDOWN_MS) } },
    orderBy: { createdAt: "desc" },
  });
  if (recent) {
    const remainSec = Math.ceil((recent.createdAt.getTime() + OTP_RESEND_COOLDOWN_MS - Date.now()) / 1000);
    return { sent: false, cooldownSec: Math.max(1, remainSec), errorFa: "برای درخواست کد جدید چند لحظه صبر کنید." };
  }

  const code = randomNumericCode(6);
  await db.otp.create({
    data: {
      mobile,
      codeHash: hashOtp(code),
      purpose,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      userId: existing?.id ?? null,
    },
  });

  await sendOtpViaSms(mobile, code, purpose);
  return { sent: true, cooldownSec: 60 };
}

export async function verifyOtp(mobileRaw: string, codeRaw: string, purpose: "login" | "register" | "reset", ip?: string): Promise<{ ok: boolean; userId?: string; errorFa?: string }> {
  const mobile = normalizeMobile(mobileRaw);
  if (!isValidIranMobile(mobile)) return { ok: false, errorFa: "شماره نامعتبر است." };
  const code = codeRaw.trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, errorFa: "کد نامعتبر است." };

  // IP-level brute-force throttle (per IP, across all mobiles)
  if (ip) {
    const ipRl = await rateLimit({ key: `otp:ver:${ip}`, limit: 30, windowMs: 15 * 60 * 1000, critical: true });
    if (!ipRl.ok) return { ok: false, errorFa: "تعداد تلاش از این نشانی بیش از حد مجاز بود. ۱۵ دقیقه بعد تلاش کنید." };
  }

  const candidate = await db.otp.findFirst({
    where: { mobile, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!candidate) return { ok: false, errorFa: "کد معتبر یافت نشد یا منقضی شده است." };

  const expectedHash = hashOtp(code);
  const codeMatches = expectedHash === candidate.codeHash;

  // ROOT-CAUSE FIX (audit §9 — concurrent verification race): the previous
  // implementation read `attempts`, wrote `attempts + 1` from that stale
  // value, then consumed via a second unconditional update — two parallel
  // requests with the same code could BOTH consume one OTP. Now every
  // state change is a single conditional atomic UPDATE:
  //   * wrong code  → attempts incremented only while attempts < MAX and
  //     still unconsumed (count 0 ⇒ exhausted/consumed ⇒ dead);
  //   * right code  → consumed only while still unconsumed and under the
  //     attempt cap (count 1 ⇒ this request and ONLY this request won).
  if (!codeMatches) {
    const bumped = await db.otp.updateMany({
      where: {
        id: candidate.id,
        consumedAt: null,
        attempts: { lt: OTP_MAX_ATTEMPTS },
      },
      data: { attempts: { increment: 1 } },
    });
    if (bumped.count === 0) {
      // Attempt cap reached (or consumed concurrently) — kill the code.
      await db.otp.updateMany({
        where: { id: candidate.id, consumedAt: null },
        data: { expiresAt: new Date() },
      });
      return { ok: false, errorFa: "تعداد تلاش بیش از حد مجاز بود. کد جدید درخواست کنید." };
    }
    return { ok: false, errorFa: "کد نادرست است." };
  }

  const consumed = await db.otp.updateMany({
    where: {
      id: candidate.id,
      consumedAt: null,
      attempts: { lt: OTP_MAX_ATTEMPTS },
    },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) {
    return { ok: false, errorFa: "کد قبلاً مصرف شده یا منقضی شده است. کد جدید درخواست کنید." };
  }
  return { ok: true, userId: candidate.userId ?? undefined };
}

export { hashPassword, verifyPassword };

async function sendOtpViaSms(mobile: string, code: string, purpose: string): Promise<void> {
  if (process.env.NODE_ENV === "production" && process.env.POSTYAR_SMS_PROVIDER) {
    const { dispatchOtp } = await import("@/lib/providers/sms");
    await dispatchOtp(mobile, code, purpose);
    return;
  }
  if (process.env.NODE_ENV !== "production") {
    const { cache } = await import("@/lib/security/cache");
    await cache.set(`dev:otp:${mobile}`, code, 2 * 60 * 1000);
  }
}

export async function newReferralCode(): Promise<string> {
  for (let i = 0; i < 12; i++) {
    const c = randomToken(3).toUpperCase().slice(0, 6);
    const exists = await db.user.findUnique({ where: { referralCode: c }, select: { id: true } });
    if (!exists) return c;
  }
  return randomToken(6).toUpperCase();
}

// ---------------------------------------------------------------------
// First-admin bootstrap (audit §8 — first-admin race)
// ---------------------------------------------------------------------
// The "count users == 0 → create privileged user" pattern is unsafe
// under concurrent registration: two parallel requests both count 0 and
// BOTH become super-admin. An in-memory mutex is not sufficient for a
// distributed deployment. The fix is a DATABASE-LEVEL atomic claim: the
// FIRST registrar to successfully INSERT the singleton SystemSetting row
// (primary key `key`, UNIQUE) wins; every loser's INSERT violates the
// constraint and stays a regular user. Works identically on SQLite and
// MariaDB, across any number of app instances.
export const BOOTSTRAP_ADMIN_SETTING_KEY = "bootstrap_admin_claimed";

export async function claimFirstAdmin(userId: string): Promise<boolean> {
  try {
    await db.systemSetting.create({
      data: { key: BOOTSTRAP_ADMIN_SETTING_KEY, value: userId },
    });
    return true;
  } catch {
    // Unique violation — the bootstrap claim was already taken.
    return false;
  }
}

export async function audit(opts: {
  userId?: string | null;
  actor: string;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string;
  meta?: Record<string, unknown>;
  /** Optional transaction client — when supplied, the audit row JOINS the
   *  caller's transaction (atomic with it). This also avoids the SQLite
   *  single-connection deadlock that happens when a global-client write is
   *  issued from inside an open transaction. */
  tx?: Prisma.TransactionClient;
  /** M-04: critical audits (financial/security actions) must NEVER be
   *  lost. Inside a transaction the row commits atomically with the
   *  action — a failure here throws, rolling back the whole operation so
   *  committed money can never exist without its audit trail; the
   *  caller's idempotent retry heals. Non-critical calls stay
   *  best-effort (logged, never break the main flow). */
  critical?: boolean;
}): Promise<void> {
  const client = opts.tx ?? db;
  try {
    await client.auditLog.create({
      data: {
        userId: opts.userId ?? null,
        actor: opts.actor,
        action: opts.action,
        targetType: opts.targetType,
        targetId: opts.targetId,
        ip: opts.ip,
        meta: JSON.stringify(opts.meta ?? {}),
      },
    });
  } catch (err) {
    if (opts.critical) {
      throw err instanceof Error ? err : new Error("audit write failed");
    }
    // Audit must never break the main flow, but a lost audit row for a
    // security/financial action must at least be VISIBLE to operators
    // (audit §31 — silent failure). Never swallow without a trace.
    console.error("audit write failed:", err instanceof Error ? err.message : err);
  }
}

export function safeJsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
