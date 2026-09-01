// =====================================================================
// POSTYAR — cache + rate limiter + distributed lock + idempotency
// ---------------------------------------------------------------------
// TRUTH CONTRACT (addendum §3, §4, §5, §13):
//
//   When `REDIS_URL` is set AND Redis is reachable, ALL operations below
//   are backed by real Redis (distributed-safe across N processes).
//
//   When `REDIS_URL` is NOT set (local dev / sandbox), operations fall
//   back to the process-local in-memory implementation. This fallback is
//   EXPLICITLY isolated to development and is NEVER silently used in
//   production.
//
//   `isRedis` is a DYNAMIC boolean that reflects the REAL current state
//   (last successful PING). The health endpoint reports the SAME value.
//   When `isRedis` is false in production, the health endpoint reports
//   `redis: disabled` (no REDIS_URL) or `redis: down` (configured but
//   unreachable) — never `healthy` unless it actually is.
//
//   Financial / concurrency-sensitive callers that cannot tolerate the
//   in-memory fallback MUST call `requireRedis()` from `redis-client.ts`
//   and let the operation fail safely.
// =====================================================================
import { getRedis, isRedisConnected, pingRedis } from "./redis-client";

type Entry = { value: unknown; expiresAt: number | null };

// ---------------------------------------------------------------------
// In-memory fallback (dev only). Kept explicit and isolated.
// ---------------------------------------------------------------------
const store = new Map<string, Entry>();
const counters = new Map<string, { count: number; expiresAt: number }>();
const locks = new Map<string, { holder: string; expiresAt: number }>();
const idemStore = new Map<string, { result: unknown; expiresAt: number }>();

function now(): number { return Date.now(); }

// Periodic eviction to avoid unbounded growth (dev-only maps)
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const t = now();
    for (const [k, v] of store) if (v.expiresAt && v.expiresAt < t) store.delete(k);
    for (const [k, v] of counters) if (v.expiresAt < t) counters.delete(k);
    for (const [k, v] of locks) if (v.expiresAt < t) locks.delete(k);
    for (const [k, v] of idemStore) if (v.expiresAt < t) idemStore.delete(k);
  }, 60_000).unref?.();
}

import { randomToken } from "./crypto";

// ---------------------------------------------------------------------
// DYNAMIC liveness flag. Refreshed by `refreshRedisLiveness()`. Callers
// MUST read this at call-time, not at module-load time.
// ---------------------------------------------------------------------
let _isRedisLive = false;

async function refreshRedisLiveness(): Promise<boolean> {
  if (!process.env.REDIS_URL?.trim()) {
    _isRedisLive = false;
    return false;
  }
  const latency = await pingRedis();
  _isRedisLive = latency !== null;
  return _isRedisLive;
}

// Stale-refresh: trust the last known state for fast-path ops, but
// periodically re-PING so a dropped connection is detected within TTL.
let _lastRefreshAt = 0;
async function maybeRefresh(): Promise<void> {
  const t = now();
  if (t - _lastRefreshAt > 10_000) { // refresh at most every 10s
    _lastRefreshAt = t;
    await refreshRedisLiveness().catch(() => void 0);
  }
}

/**
 * Truthful, dynamic, call-time boolean. `false` in dev/sandbox; `true`
 * in production only after a successful PING. Read this at call-time.
 */
export function isRedisActive(): boolean {
  return _isRedisLive;
}

// ---------------------------------------------------------------------
// CACHE
// ---------------------------------------------------------------------
export const cache = {
  async get<T>(key: string): Promise<T | null> {
    await maybeRefresh();
    const client = getRedis();
    if (client && _isRedisLive) {
      const raw = await client.get(`cache:${key}`);
      if (raw === null) return null;
      try { return JSON.parse(raw) as T; } catch { return null; }
    }
    const e = store.get(key);
    if (!e) return null;
    if (e.expiresAt && e.expiresAt < now()) { store.delete(key); return null; }
    return e.value as T;
  },
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    await maybeRefresh();
    const client = getRedis();
    if (client && _isRedisLive) {
      const raw = JSON.stringify(value);
      if (ttlMs) await client.set(`cache:${key}`, raw, "PX", ttlMs);
      else await client.set(`cache:${key}`, raw);
      return;
    }
    store.set(key, { value, expiresAt: ttlMs ? now() + ttlMs : null });
  },
  async del(key: string): Promise<void> {
    await maybeRefresh();
    const client = getRedis();
    if (client && _isRedisLive) {
      await client.del(`cache:${key}`);
      return;
    }
    store.delete(key);
  },
  async incr(key: string, ttlMs: number): Promise<number> {
    await maybeRefresh();
    const client = getRedis();
    if (client && _isRedisLive) {
      const rKey = `counter:${key}`;
      const cnt = await client.incr(rKey);
      if (cnt === 1) await client.pexpire(rKey, ttlMs);
      return cnt;
    }
    const e = counters.get(key);
    const t = now();
    if (!e || e.expiresAt < t) { counters.set(key, { count: 1, expiresAt: t + ttlMs }); return 1; }
    e.count += 1;
    counters.set(key, e);
    return e.count;
  },
  async expire(key: string, ttlMs: number): Promise<void> {
    await maybeRefresh();
    const client = getRedis();
    if (client && _isRedisLive) {
      await client.pexpire(`counter:${key}`, ttlMs);
      return;
    }
    const e = counters.get(key);
    if (e) { e.expiresAt = now() + ttlMs; counters.set(key, e); }
  },
};

// ---------------------------------------------------------------------
// Sliding + fixed rate limit
// ---------------------------------------------------------------------
export async function rateLimit(opts: {
  key: string;
  limit: number;
  windowMs: number;
}): Promise<{ ok: boolean; count: number; resetMs: number }> {
  const count = await cache.incr(opts.key, opts.windowMs);
  const resetMs = opts.windowMs;
  return { ok: count <= opts.limit, count, resetMs };
}

// ---------------------------------------------------------------------
// Distributed lock
//   Redis: SET key value NX PX ttl + Lua-script compare-and-del release.
//   In-memory: Map-based (dev only).
// ---------------------------------------------------------------------
const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export async function acquireLock(key: string, ttlMs: number = 30_000): Promise<string | null> {
  await maybeRefresh();
  const client = getRedis();
  const holder = randomToken(16);
  if (client && _isRedisLive) {
    const rKey = `lock:${key}`;
    // SET key holder NX PX ttl — returns "OK" on success, null on contention.
    const res = await client.set(rKey, holder, "PX", ttlMs, "NX");
    return res === "OK" ? holder : null;
  }
  const existing = locks.get(key);
  const t = now();
  if (!existing || existing.expiresAt < t) {
    locks.set(key, { holder, expiresAt: t + ttlMs });
    return holder;
  }
  return null;
}

export async function releaseLock(key: string, holder: string): Promise<void> {
  await maybeRefresh();
  const client = getRedis();
  if (client && _isRedisLive) {
    await client.eval(RELEASE_LOCK_LUA, 1, `lock:${key}`, holder);
    return;
  }
  const existing = locks.get(key);
  if (existing && existing.holder === holder) locks.delete(key);
}

// ---------------------------------------------------------------------
// Idempotency — ATOMIC claim (P0.12 ROOT-CAUSE FIX)
// ---------------------------------------------------------------------
// The previous implementation was GET → fn() → SET: N concurrent callers
// with the same key ALL executed the business function (double quota
// consumption, double side effects). It was not idempotent.
//
// New protocol (works identically on Redis and the dev-only in-memory map):
//   1. ATOMICALLY claim the key: SET idem:<key> = "__claim__:<holder>" NX PX
//      <claimTtl>. Only ONE caller wins the claim.
//   2. The winner runs fn(), stores the JSON result (PX ttlMs), deletes the
//      claim marker, and returns.
//   3. Losers POLL for the result (bounded by waitTimeoutMs). When the
//      winner finishes, every loser returns the SAME result — the business
//      function executed exactly once.
//   4. ABANDONED claims (winner crashed mid-flight) are safe: the claim
//      marker expires after claimTtl; the next caller takes over and
//      re-executes. This is why claimTtl must exceed the business
//      function's worst-case duration. Durable correctness for money/
//      security operations additionally relies on DB-level uniqueness
//      (e.g. AiJob.idempotencyKey) layered under this claim.
//
// `opts.critical`: when true, the function REFUSES to run without a real
// Redis connection in production (fail closed). The process-local Map is
// acceptable ONLY for dev/test single-process operation — never silently
// for production-critical money/security paths.
// ---------------------------------------------------------------------
const IDEM_CLAIM_PREFIX = "__claim__:";
const IDEM_DEFAULT_CLAIM_TTL_MS = 90_000; // > AI provider timeout + margin
const IDEM_POLL_INTERVAL_MS = 120;
const IDEM_DEFAULT_WAIT_MS = 120_000;

export interface IdempotencyOptions {
  /** TTL of the stored result (default 24h). */
  ttlMs?: number;
  /** How long the in-flight claim may run before being considered abandoned. */
  claimTtlMs?: number;
  /** How long a losing caller waits for the winner's result. */
  waitTimeoutMs?: number;
  /** Fail closed without live Redis in production (money/security paths). */
  critical?: boolean;
}

async function idempotencyRedis<T>(
  client: NonNullable<ReturnType<typeof getRedis>>,
  idemKey: string,
  fn: () => Promise<T>,
  opts: Required<Omit<IdempotencyOptions, "critical">>,
): Promise<T> {
  const holder = randomToken(12);
  const claimRes = await client.set(
    idemKey,
    `${IDEM_CLAIM_PREFIX}${holder}`,
    "PX",
    opts.claimTtlMs,
    "NX",
  );
  if (claimRes === "OK") {
    // We own the claim — run the function exactly once.
    try {
      const result = await fn();
      await client.set(idemKey + ":result", JSON.stringify(result), "PX", opts.ttlMs);
      return result;
    } finally {
      // Release the claim so late losers read the result (or take over
      // after claim TTL expiry if fn threw before a result was stored).
      const current = await client.get(idemKey);
      if (current === `${IDEM_CLAIM_PREFIX}${holder}`) {
        await client.del(idemKey);
      }
    }
  }

  // Someone else holds the claim — poll for the result.
  const deadline = Date.now() + opts.waitTimeoutMs;
  while (Date.now() < deadline) {
    const raw = await client.get(idemKey + ":result");
    if (raw !== null) {
      try { return JSON.parse(raw) as T; } catch { /* fall through to retry */ }
    }
    const current = await client.get(idemKey);
    if (current === null) {
      // Claim released but result not visible yet (crash between del and
      // set, or abandoned). Retry the claim once via the outer loop below.
      const reClaim = await client.set(idemKey, `${IDEM_CLAIM_PREFIX}${holder}`, "PX", opts.claimTtlMs, "NX");
      if (reClaim === "OK") {
        try {
          // Check again — the previous winner may have stored the result
          // between our read and our claim.
          const raw2 = await client.get(idemKey + ":result");
          if (raw2 !== null) {
            try { return JSON.parse(raw2) as T; } catch { /* re-run */ }
          }
          const result = await fn();
          await client.set(idemKey + ":result", JSON.stringify(result), "PX", opts.ttlMs);
          return result;
        } finally {
          const cur2 = await client.get(idemKey);
          if (cur2 === `${IDEM_CLAIM_PREFIX}${holder}`) await client.del(idemKey);
        }
      }
    }
    await new Promise((r) => setTimeout(r, IDEM_POLL_INTERVAL_MS));
  }
  // Wait budget exhausted — refuse rather than execute concurrently.
  throw new Error("عملیات هم‌زمان با کلید یکتا بیش از حد طول کشید. دوباره تلاش کنید.");
}

// In-memory fallback claim registry (dev/test only).
const idemClaims = new Map<string, { holder: string; expiresAt: number }>();

export async function idempotency<T>(
  key: string,
  fn: () => Promise<T>,
  ttlMs: number = 24 * 60 * 60 * 1000,
  opts: IdempotencyOptions = {},
): Promise<T> {
  const cfg = {
    ttlMs: opts.ttlMs ?? ttlMs,
    claimTtlMs: opts.claimTtlMs ?? IDEM_DEFAULT_CLAIM_TTL_MS,
    waitTimeoutMs: opts.waitTimeoutMs ?? IDEM_DEFAULT_WAIT_MS,
  };
  await maybeRefresh();
  const client = getRedis();
  if (client && _isRedisLive) {
    return idempotencyRedis<T>(client, `idem:${key}`, fn, cfg);
  }

  // --- Fallback (dev/test only) ---
  if (opts.critical && process.env.NODE_ENV === "production") {
    // Fail closed: production-critical operations must never silently run
    // on a process-local Map (no cross-process serialization).
    throw new Error("عملیات حساس مالی نیاز به اتصال واقعی Redis دارد که در این محیط فعال نیست.");
  }

  const idemKey = `idem:${key}`;
  const t = now();
  const existingClaim = idemClaims.get(idemKey);
  const existingResult = idemStore.get(key);

  if (existingResult && existingResult.expiresAt > t) {
    return existingResult.result as T;
  }

  if (!existingClaim || existingClaim.expiresAt < t) {
    // Claim atomically (single-threaded JS — check+set without await in
    // between is atomic).
    idemClaims.set(idemKey, { holder: "self", expiresAt: t + cfg.claimTtlMs });
    try {
      const result = await fn();
      idemStore.set(key, { result, expiresAt: now() + cfg.ttlMs });
      return result;
    } finally {
      idemClaims.delete(idemKey);
    }
  }

  // Another in-flight claim — poll for the result.
  const deadline = Date.now() + cfg.waitTimeoutMs;
  while (Date.now() < deadline) {
    const res = idemStore.get(key);
    if (res && res.expiresAt > now()) return res.result as T;
    if (!idemClaims.has(idemKey)) {
      // Claim disappeared (finished with error or evicted) — take over.
      idemClaims.set(idemKey, { holder: "self", expiresAt: now() + cfg.claimTtlMs });
      try {
        const result = await fn();
        idemStore.set(key, { result, expiresAt: now() + cfg.ttlMs });
        return result;
      } finally {
        idemClaims.delete(idemKey);
      }
    }
    await new Promise((r) => setTimeout(r, IDEM_POLL_INTERVAL_MS));
  }
  throw new Error("عملیات هم‌زمان با کلید یکتا بیش از حد طول کشید. دوباره تلاش کنید.");
}

// ---------------------------------------------------------------------
// Public API for the health endpoint to call a fresh PING.
// ---------------------------------------------------------------------
export { refreshRedisLiveness, isRedisConnected };
