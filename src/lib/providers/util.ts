// =====================================================================
// POSTYAR — Destination provider util: sanitization + settings override
// ---------------------------------------------------------------------
// `sanitizeRaw` walks an unknown payload and:
//   - replaces any string containing "bot<token>/" with "bot<TOKEN>/"
//     (Telegram/Bale URL pattern)
//   - replaces any string containing "Bot <token>" (Rubika auth header echo)
//     with "Bot <TOKEN>"
//   - replaces any field whose name looks like "token" / "secret"
//   - truncates string values longer than 4KB to bound audit rows
//
// `getSetting(key, fallback)` lets provider libs (sms/email/ai) override
// their env vars via admin-managed `SystemSetting` rows: DB-first, then
// `process.env`, then the fallback. This is what powers ITEM 40 — the
// admin settings UI edits `POSTYAR_*` keys, the provider libs transparently
// pick them up.
// =====================================================================
import { db } from "@/lib/db";
import { decryptString } from "@/lib/security/crypto";

const MAX_STR_LEN = 4096;

function isTokenishKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k === "token" ||
    k === "bottoken" ||
    k === "secret" ||
    k === "apiaccesskey" ||
    k === "authorization" ||
    k === "password"
  );
}

function maskString(value: string): string {
  let v = value;
  // Telegram / Bale URL pattern: bot<TOKEN>/<method>
  v = v.replace(/bot\d+:[A-Za-z0-9_-]{20,}\//g, "bot<TOKEN>/");
  // Rubika auth header echo: "Bot <TOKEN>"
  v = v.replace(/Bot\s+[A-Za-z0-9._-]{16,}/g, "Bot <TOKEN>");
  if (v.length > MAX_STR_LEN) v = v.slice(0, MAX_STR_LEN) + "...[truncated]";
  return v;
}

export function sanitizeRaw(input: unknown, depth = 0): unknown {
  if (depth > 6) return "[max depth]";
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return maskString(input);
  if (typeof input === "number" || typeof input === "boolean") return input;
  if (input instanceof Error) {
    return { __error: true, name: input.name, message: maskString(input.message) };
  }
  if (Array.isArray(input)) {
    return input.slice(0, 32).map((v) => sanitizeRaw(v, depth + 1));
  }
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (isTokenishKey(k)) {
        out[k] = "<REDACTED>";
      } else {
        out[k] = sanitizeRaw(v, depth + 1);
      }
    }
    return out;
  }
  return String(input).slice(0, MAX_STR_LEN);
}

/** Scrub the token from a Telegram/Bale Bot API URL for safe logging. */
export function scrubTokenFromUrl(url: string): string {
  return url.replace(/bot\d+:[A-Za-z0-9_-]{20,}\//g, "bot<TOKEN>/");
}

// ---------------------------------------------------------------------
// Settings override: SystemSetting first, then env, then fallback.
// Used by SMS/Email/AI provider libs so the admin can override env
// without a redeploy. Always async (DB read); cached via Prisma's
// query plan cache + the in-process cache for hot paths.
// ---------------------------------------------------------------------
const settingCache = new Map<string, { value: string | null; exp: number }>();
const SETTING_TTL_MS = 30_000; // 30s in-process cache

/**
 * Resolve a configuration value with this precedence:
 *   1. `SystemSetting` row with the given key (admin override)
 *   2. `process.env[key]`
 *   3. the `fallback` argument
 *
 * The `key` SHOULD be the env-var name (e.g. `POSTYAR_SMS_PROVIDER`) so
 * both layers speak the same namespace. Returns `""` (not `undefined`)
 * when nothing matches and no fallback is provided — keeps the call sites
 * simple (no null-checks before passing to fetch headers).
 */
export async function getSetting(key: string, fallback: string = ""): Promise<string> {
  const now = Date.now();
  const cached = settingCache.get(key);
  if (cached && cached.exp > now) {
    if (cached.value !== null) return cached.value;
    // DB has no row — fall through to env
  } else {
    // Stale or absent — refresh from DB (best-effort).
    try {
      const row = await db.systemSetting.findUnique({ where: { key }, select: { value: true } });
      settingCache.set(key, { value: row?.value ?? null, exp: now + SETTING_TTL_MS });
      if (row?.value !== undefined) return resolveStoredSecret(row.value);
    } catch {
      // DB error → fall back to env silently. Never throw.
    }
  }
  return process.env[key] ?? fallback;
}

/**
 * P1.5 — secrets are encrypted at rest. Sensitive SystemSetting values are
 * written as `v1:aes-256-gcm:...` envelopes by the admin settings route;
 * this resolver decrypts them transparently. Legacy plaintext values (rows
 * written before the encryption change) are returned as-is so existing
 * deployments keep working; re-saving a secret through the admin UI
 * re-wraps it.
 */
export function resolveStoredSecret(value: string): string {
  if (!value) return value;
  if (!value.startsWith("v1:aes-256-gcm:")) return value;
  try {
    return decryptString(value);
  } catch {
    // Wrong master key or corrupt envelope — return empty rather than
    // leaking ciphertext fragments into provider calls.
    return "";
  }
}

/**
 * Clear the in-process cache for one key (or all keys when `key` is
 * omitted). Call this after the admin updates a setting so the next
 * `getSetting` call re-reads from the DB. Best-effort, non-throwing.
 */
export function invalidateSettingsCache(key?: string): void {
  if (key) {
    settingCache.delete(key);
    return;
  }
  settingCache.clear();
}
