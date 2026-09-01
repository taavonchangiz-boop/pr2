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
// without a redeploy. Always async; cached via a VERSIONED, SHARED cache
// (C-05 — multi-instance-safe):
//
//   * `SystemSetting` row `__settings_epoch__` is a monotonically
//     bumped version string (bumpSettingsEpoch, called by the admin
//     settings write routes in the same code path as the write).
//   * getSetting() reads the CURRENT epoch (in-process 3s cache), then
//     looks up the SHARED cache key `settings:<epoch>:<key>` (Redis
//     when REDIS_URL is live; process-local Map otherwise) with a 60s
//     TTL. A new epoch makes every old-epoch entry unreachable, so an
//     admin change becomes effective on ALL instances within the
//     explicit 3-second epoch-read window — without redeploy and
//     without unbounded staleness.
//   * The cached value is the RAW DB envelope (possibly
//     `v1:aes-256-gcm:...`); DECRYPTION happens on every read, so
//     plaintext secrets never sit in the shared cache. Legacy
//     plaintext values remain supported (resolveStoredSecret).
// ---------------------------------------------------------------------
import { cache } from "@/lib/security/cache";

/** SystemSetting key holding the cache-version epoch (C-05). */
export const SETTINGS_EPOCH_KEY = "__settings_epoch__";
const SETTINGS_SHARED_TTL_MS = 60_000; // bounds growth of old-epoch keys
const EPOCH_LOCAL_TTL_MS = 3_000; // explicit staleness window for admin changes

let epochLocal: { value: string; exp: number } | null = null;

async function readSettingsEpoch(): Promise<string> {
  const t = Date.now();
  if (epochLocal && epochLocal.exp > t) return epochLocal.value;
  try {
    const row = await db.systemSetting.findUnique({
      where: { key: SETTINGS_EPOCH_KEY },
      select: { value: true },
    });
    const value = row?.value ?? "0";
    epochLocal = { value, exp: t + EPOCH_LOCAL_TTL_MS };
    return value;
  } catch {
    // DB error → keep serving the last known epoch (bounded staleness).
    return epochLocal?.value ?? "0";
  }
}

/**
 * Bump the settings-cache epoch so EVERY application instance re-reads
 * SystemSetting values from the database on the next getSetting call
 * (within the explicit 3s epoch-read window). Must be awaited by the
 * admin write path AFTER the setting rows are committed.
 */
export async function bumpSettingsEpoch(): Promise<void> {
  const next = String(Date.now());
  await db.systemSetting.upsert({
    where: { key: SETTINGS_EPOCH_KEY },
    create: { key: SETTINGS_EPOCH_KEY, value: next },
    update: { value: next },
  });
  // This instance switches immediately; peers follow within EPOCH_LOCAL_TTL_MS.
  epochLocal = { value: next, exp: Date.now() + EPOCH_LOCAL_TTL_MS };
}

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
  // Guard: the epoch row itself must never be resolved as a setting.
  if (key === SETTINGS_EPOCH_KEY) return process.env[key] ?? fallback;
  const epoch = await readSettingsEpoch();
  const cacheKey = `settings:${epoch}:${key}`;
  const cached = await cache.get<{ v: string | null }>(cacheKey);
  if (cached && typeof cached === "object" && "v" in cached) {
    // DB has a row (v = raw stored value, possibly an encrypted envelope)
    if (cached.v !== null) return resolveStoredSecret(cached.v);
    // No row → fall through to env
  } else {
    // Cache miss — refresh from DB (best-effort).
    try {
      const row = await db.systemSetting.findUnique({ where: { key }, select: { value: true } });
      await cache.set(cacheKey, { v: row?.value ?? null }, SETTINGS_SHARED_TTL_MS);
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
 * Invalidate the settings cache. With the C-05 versioned design the
 * SHARED invalidation is the epoch bump (`bumpSettingsEpoch`, awaited by
 * the admin write routes); this function only clears THIS process's
 * epoch snapshot so the next getSetting re-reads the epoch immediately.
 * Best-effort, non-throwing. Call `bumpSettingsEpoch()` for cross-instance
 * invalidation.
 */
export function invalidateSettingsCache(_key?: string): void {
  epochLocal = null;
}
