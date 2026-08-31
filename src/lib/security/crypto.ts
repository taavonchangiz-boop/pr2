// =====================================================================
// POSTYAR security primitives
// - AES-256-GCM for encrypting provider tokens at rest
// - HMAC-SHA256 for signing link codes / callback URLs
// - constant-time compare
// - cryptographically secure OTP & random token generators
// - JWT (HS256) with kid rotation
// All keys come from env (POSTYAR_MASTER_KEY). Fail-closed if missing.
// =====================================================================
import crypto from "node:crypto";
import jwtLib from "jsonwebtoken";
import CryptoJS from "crypto-js";

const MASTER_KEY_HEX = process.env.POSTYAR_MASTER_KEY ?? ""; // 64 hex chars = 32 bytes
const JWT_SECRET = process.env.POSTYAR_JWT_SECRET ?? MASTER_KEY_HEX ?? "";

function getKey(): Buffer {
  if (!MASTER_KEY_HEX || MASTER_KEY_HEX.length !== 64 || !/^[0-9a-fA-F]+$/.test(MASTER_KEY_HEX)) {
    // In dev only, derive a deterministic key from process.cwd()+package.json
    // so things keep working without env. In production, env MUST be set.
    if (process.env.NODE_ENV === "production") {
      throw new Error("POSTYAR_MASTER_KEY not configured (need 64 hex chars)");
    }
    const fallback = crypto.createHash("sha256").update("postyar-dev-" + process.cwd()).digest();
    return fallback;
  }
  return Buffer.from(MASTER_KEY_HEX, "hex");
}

function getJwtSecret(): string {
  if (JWT_SECRET && JWT_SECRET.length >= 32) return JWT_SECRET;
  if (process.env.NODE_ENV === "production") throw new Error("POSTYAR_JWT_SECRET not configured");
  return crypto.createHash("sha256").update("postyar-jwt-dev-" + process.cwd()).digest("hex");
}

// ---------------------------------------------------------------------
// AES-256-GCM
// ---------------------------------------------------------------------
export function encryptString(plaintext: string): string {
  if (!plaintext) return "";
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", "aes-256-gcm", iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export function decryptString(packed: string): string {
  if (!packed) return "";
  const parts = packed.split(":");
  if (parts.length !== 5 || parts[0] !== "v1" || parts[1] !== "aes-256-gcm") {
    throw new Error("invalid ciphertext envelope");
  }
  const key = getKey();
  const iv = Buffer.from(parts[2], "base64");
  const tag = Buffer.from(parts[3], "base64");
  const enc = Buffer.from(parts[4], "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

// ---------------------------------------------------------------------
// HMAC-SHA256 (separate keys derived from master via HKDF-style)
// ---------------------------------------------------------------------
function deriveKey(label: string): Buffer {
  const key = getKey();
  return crypto.createHmac("sha256", key).update(label).digest();
}

export function hmacSign(label: string, payload: string): string {
  return crypto.createHmac("sha256", deriveKey(label)).update(payload).digest("hex");
}

export function hmacVerify(label: string, payload: string, signatureHex: string): boolean {
  const expected = hmacSign(label, payload);
  return constantTimeEqual(expected, signatureHex);
}

// ---------------------------------------------------------------------
// Constant-time comparison
// ---------------------------------------------------------------------
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------
// Secure random tokens
// ---------------------------------------------------------------------
export function randomToken(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function randomNumericCode(length: number = 6): string {
  // Cryptographically secure OTP using rejection sampling.
  // We generate a 32-bit unsigned integer and take it modulo `max`.
  // To eliminate modulo bias, we reject values that fall in the
  // "biased tail" region [2^32 - (2^32 mod max), 2^32).
  //
  // CRITICAL: the rejection bound must use the FULL 2^32 space, not
  // 256. The previous implementation computed
  //   limit = Math.floor(256 / max) * max
  // which evaluates to 0 for length >= 3 (max >= 1000), causing the
  // rejection loop `while (n >= limit)` to become `while (n >= 0)` —
  // a synchronous infinite loop that blocked the event loop. This
  // broke OTP issuance for mobile login.
  const max = Math.pow(10, length);
  const U32 = 0x100000000; // 2^32
  const limit = U32 - (U32 % max);
  for (let attempts = 0; attempts < 32; attempts++) {
    const r = crypto.randomBytes(4).readUInt32BE(0);
    if (r < limit) {
      return (r % max).toString().padStart(length, "0");
    }
  }
  // Fallback (probability vanishingly small for max << 2^32):
  const fallback = crypto.randomBytes(4).readUInt32BE(0) % max;
  return fallback.toString().padStart(length, "0");
}

export function hashOtp(otp: string, salt: string = "postyar-otp"): string {
  return crypto.createHash("sha256").update(salt + ":" + otp).digest("hex");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ---------------------------------------------------------------------
// Password hashing (bcrypt)
// ---------------------------------------------------------------------
import bcrypt from "bcryptjs";
export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 12);
}
export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  try { return await bcrypt.compare(pw, hash); } catch { return false; }
}

// ---------------------------------------------------------------------
// JWT (HS256) — short-lived session token. Token is stored HttpOnly.
// ---------------------------------------------------------------------
export interface JwtPayload {
  sub: string;       // user id
  role: string;
  sid: string;       // session id
  iat?: number;
  exp?: number;
}

export function signJwt(payload: Omit<JwtPayload, "iat" | "exp">, expiresInSec: number = 60 * 60 * 24 * 7): string {
  return jwtLib.sign(payload, getJwtSecret(), { algorithm: "HS256", expiresIn: expiresInSec });
}

export function verifyJwt(token: string): JwtPayload | null {
  try {
    const decoded = jwtLib.verify(token, getJwtSecret(), { algorithms: ["HS256"] }) as JwtPayload;
    return decoded;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Signed short-lived media URLs (audit §21 — provider media access)
// ---------------------------------------------------------------------
// Providers (Telegram/Bale) fetch published media by URL. The media
// route is session-gated (as it must stay), so the worker embeds a
// short-lived HMAC token scoped to ONE media id: `?exp=<unix>&sig=<hmac>`.
// The token is NOT permanent, NOT guessable, expires quickly, and grants
// read access to that single media record only.
export function signMediaUrlToken(mediaId: string, ttlSec: number = 10 * 60): {
  exp: number;
  sig: string;
} {
  const exp = Math.floor(Date.now() / 1000) + Math.max(30, ttlSec);
  const sig = hmacSign("media-url", `${mediaId}:${exp}`);
  return { exp, sig };
}

export function verifyMediaUrlToken(mediaId: string, exp: string | null, sig: string | null): boolean {
  if (!exp || !sig) return false;
  const expNum = Number.parseInt(exp, 10);
  if (!Number.isFinite(expNum)) return false;
  if (expNum * 1000 < Date.now()) return false;
  return hmacVerify("media-url", `${mediaId}:${expNum}`, sig);
}

// ---------------------------------------------------------------------
// CryptoJS-backed helpers (used by client where Node crypto not available)
// ---------------------------------------------------------------------
export function sha256Hex(input: string): string {
  return CryptoJS.SHA256(input).toString();
}

export function hmacSha256Hex(label: string, payload: string): string {
  // For client-side verification only (e.g., bot link codes)
  return CryptoJS.HmacSHA256(payload, label).toString();
}
