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

function now(): number { return Date.now(); }

// Periodic eviction to avoid unbounded growth (dev-only maps)
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const t = now();
    for (const [k, v] of store) if (v.expiresAt && v.expiresAt < t) store.delete(k);
    for (const [k, v] of counters) if (v.expiresAt < t) counters.delete(k);
    for (const [k, v] of locks) if (v.expiresAt < t) locks.delete(k);
    for (const [k, v] of idemMemClaims) if (v.expiresAt < t) idemMemClaims.delete(k);
    for (const [k, v] of idemMemResults) if (v.expiresAt < t) idemMemResults.delete(k);
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
// Idempotency — ATOMIC, COMPLETION-AWARE claim protocol (C-01 ROOT-CAUSE FIX)
// ---------------------------------------------------------------------
// The previous Redis protocol stored the result at `idem:<key>:result` and
// DELETED the claim marker on completion. A later sequential duplicate
// then found no claim, re-acquired a fresh one and re-executed fn() — the
// operation was NOT idempotent after completion.
//
// New protocol (identical semantics on Redis and the dev-only in-memory
// fallback; every state transition is atomic):
//
//   Claim key `idem:<key>` holds exactly one of:
//     * `__inflight__<holder>`  — an execution is in flight (PX claimTtl)
//     * `__done__`              — a result was completed successfully
//                                 (PX resultTtl — same TTL as the result)
//   Result key `idem:<key>:result` holds the JSON result (PX resultTtl).
//
//   ACQUIRE (Lua, atomic):
//     1. claim == done        → read result; result present → return it
//                                (a completed result NEVER re-executes fn)
//     2. claim absent         → SET claim=inflight NX PX claimTtl
//                                → won: caller owns the execution
//     3. claim == inflight    → report in-flight (caller polls)
//
//   COMPLETE (Lua, atomic — winner only, holder-checked):
//     SET result PX ttl; SET claim=done PX ttl — one atomic step, so a
//     done marker can never exist without its result.
//
//   ABORT (Lua, holder-checked): fn threw → DEL the claim so the next
//     caller retries. Failed operations are NEVER cached as results.
//
//   ABANDONED claims (winner crashed mid-flight): the inflight marker
//     expires after claimTtl; the next ACQUIRE takes over safely. This is
//     why claimTtl must exceed the business function's worst-case
//     duration. Durable correctness for money/security operations
//     additionally relies on DB-level uniqueness (e.g.
//     AiJob.idempotencyKey) layered beneath this claim.
//
// `opts.critical`: when true, the function REFUSES to run without a real
// Redis connection in production (fail closed). The process-local Map is
// acceptable ONLY for dev/test single-process operation — never silently
// for production-critical money/security paths.
// ---------------------------------------------------------------------
const IDEM_INFLIGHT_PREFIX = "__inflight__";
const IDEM_DONE = "__done__";
const IDEM_DEFAULT_CLAIM_TTL_MS = 90_000; // > AI provider timeout + margin
const IDEM_POLL_INTERVAL_MS = 120;
const IDEM_DEFAULT_WAIT_MS = 120_000;

const IDEM_ACQUIRE_LUA = `
local claim = redis.call('GET', KEYS[1])
if claim == ARGV[3] then
  local result = redis.call('GET', KEYS[2])
  if result then return {2, result} end
  redis.call('DEL', KEYS[1])
  claim = false
end
if not claim then
  local ok = redis.call('SET', KEYS[1], ARGV[4] .. ARGV[1], 'PX', ARGV[2], 'NX')
  if ok then return {1, ''} end
  claim = redis.call('GET', KEYS[1])
end
return {0, claim}
`;

const IDEM_COMPLETE_LUA = `
local current = redis.call('GET', KEYS[1])
if current == ARGV[4] .. ARGV[1] then
  redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
  redis.call('SET', KEYS[1], ARGV[5], 'PX', ARGV[3])
  return 1
end
return 0
`;

const IDEM_ABORT_LUA = `
local current = redis.call('GET', KEYS[1])
if current == ARGV[2] .. ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

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

interface IdempotencyConfig {
  ttlMs: number;
  claimTtlMs: number;
  waitTimeoutMs: number;
}

type AcquireOutcome =
  | { state: "claimed" }
  | { state: "inflight" }
  | { state: "completed"; raw: string };

interface IdempotencyBackend {
  acquire(key: string, holder: string, cfg: IdempotencyConfig): Promise<AcquireOutcome>;
  complete(key: string, holder: string, resultJson: string, cfg: IdempotencyConfig): Promise<void>;
  abort(key: string, holder: string): Promise<void>;
  /** Result lookup for pollers (null while absent). */
  getResult(key: string): Promise<string | null>;
}

// ---------------- Redis backend (production) ----------------
function redisIdempotencyBackend(client: NonNullable<ReturnType<typeof getRedis>>): IdempotencyBackend {
  return {
    async acquire(key, holder, cfg) {
      const claimKey = `idem:${key}`;
      const res = (await client.eval(
        IDEM_ACQUIRE_LUA, 2, claimKey, `${claimKey}:result`,
        holder, String(cfg.claimTtlMs), IDEM_DONE, IDEM_INFLIGHT_PREFIX,
      )) as [number, string | null];
      if (res[0] === 1) return { state: "claimed" };
      if (res[0] === 2) return { state: "completed", raw: String(res[1] ?? "") };
      return { state: "inflight" };
    },
    async complete(key, holder, resultJson, cfg) {
      const claimKey = `idem:${key}`;
      await client.eval(
        IDEM_COMPLETE_LUA, 2, claimKey, `${claimKey}:result`,
        holder, resultJson, String(cfg.ttlMs), IDEM_INFLIGHT_PREFIX, IDEM_DONE,
      );
    },
    async abort(key, holder) {
      const claimKey = `idem:${key}`;
      await client.eval(
        IDEM_ABORT_LUA, 1, claimKey,
        holder, IDEM_INFLIGHT_PREFIX,
      );
    },
    async getResult(key) {
      return client.get(`idem:${key}:result`);
    },
  };
}

// ---------------- In-memory backend (dev/test only) ----------------
// Mirrors the Redis state machine exactly: claim → done/result, result
// checked BEFORE a new claim is created, failures release the claim
// without storing a result.
interface MemClaim { holder: string; expiresAt: number; done: boolean }
const idemMemClaims = new Map<string, MemClaim>();
const idemMemResults = new Map<string, { raw: string; expiresAt: number }>();

function memIdempotencyBackend(): IdempotencyBackend {
  return {
    async acquire(key, holder, cfg) {
      const t = now();
      const result = idemMemResults.get(key);
      const claim = idemMemClaims.get(key);
      if (claim && claim.done && claim.expiresAt > t) {
        if (result && result.expiresAt > t) return { state: "completed", raw: result.raw };
        idemMemClaims.delete(key); // done marker without result → reset
        idemMemResults.delete(key);
      } else if (claim && claim.expiresAt <= t) {
        idemMemClaims.delete(key); // abandoned claim expired
      }
      const fresh = idemMemClaims.get(key);
      if (!fresh) {
        // Single-threaded JS: check-then-set without an await between them
        // is atomic within the process.
        idemMemClaims.set(key, { holder, expiresAt: t + cfg.claimTtlMs, done: false });
        return { state: "claimed" };
      }
      return { state: "inflight" };
    },
    async complete(key, holder, resultJson, cfg) {
      const t = now();
      const claim = idemMemClaims.get(key);
      if (claim && !claim.done && claim.holder === holder && claim.expiresAt > t) {
        idemMemResults.set(key, { raw: resultJson, expiresAt: t + cfg.ttlMs });
        idemMemClaims.set(key, { holder, expiresAt: t + cfg.ttlMs, done: true });
      }
      // Holder mismatch → claim expired/lost; do nothing (same as Redis).
    },
    async abort(key, holder) {
      const claim = idemMemClaims.get(key);
      if (claim && claim.holder === holder && !claim.done) idemMemClaims.delete(key);
    },
    async getResult(key) {
      const r = idemMemResults.get(key);
      if (!r) return null;
      if (r.expiresAt <= now()) { idemMemResults.delete(key); return null; }
      return r.raw;
    },
  };
}

async function parseResultOr<T>(raw: string | null): Promise<T | null> {
  if (raw === null) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

async function runIdempotency<T>(
  backend: IdempotencyBackend,
  key: string,
  fn: () => Promise<T>,
  cfg: IdempotencyConfig,
): Promise<T> {
  const holder = randomToken(12);
  const first = await backend.acquire(key, holder, cfg);
  if (first.state === "completed") {
    const parsed = await parseResultOr<T>(first.raw);
    if (parsed !== null) return parsed;
  } else if (first.state === "claimed") {
    try {
      const result = await fn();
      await backend.complete(key, holder, JSON.stringify(result), cfg);
      return result;
    } catch (err) {
      // Failure semantics: release the claim, store NO result — the next
      // caller retries the operation.
      await backend.abort(key, holder).catch(() => undefined);
      throw err;
    }
  }

  // Someone else holds the claim — poll for the durable result; take over
  // the claim if it is abandoned.
  const deadline = Date.now() + cfg.waitTimeoutMs;
  for (;;) {
    const raw = await backend.getResult(key);
    if (raw !== null) {
      const parsed = await parseResultOr<T>(raw);
      if (parsed !== null) return parsed;
    }
    if (Date.now() >= deadline) break;
    const acq = await backend.acquire(key, holder, cfg);
    if (acq.state === "claimed") {
      try {
        const result = await fn();
        await backend.complete(key, holder, JSON.stringify(result), cfg);
        return result;
      } catch (err) {
        await backend.abort(key, holder).catch(() => undefined);
        throw err;
      }
    }
    if (acq.state === "completed") {
      const parsed = await parseResultOr<T>(acq.raw);
      if (parsed !== null) return parsed;
    }
    await new Promise((r) => setTimeout(r, IDEM_POLL_INTERVAL_MS));
  }
  // Wait budget exhausted — refuse rather than execute concurrently.
  throw new Error("عملیات هم‌زمان با کلید یکتا بیش از حد طول کشید. دوباره تلاش کنید.");
}

export async function idempotency<T>(
  key: string,
  fn: () => Promise<T>,
  ttlMs: number = 24 * 60 * 60 * 1000,
  opts: IdempotencyOptions = {},
): Promise<T> {
  const cfg: IdempotencyConfig = {
    ttlMs: opts.ttlMs ?? ttlMs,
    claimTtlMs: opts.claimTtlMs ?? IDEM_DEFAULT_CLAIM_TTL_MS,
    waitTimeoutMs: opts.waitTimeoutMs ?? IDEM_DEFAULT_WAIT_MS,
  };
  await maybeRefresh();
  const client = getRedis();
  if (client && _isRedisLive) {
    return runIdempotency<T>(redisIdempotencyBackend(client), key, fn, cfg);
  }

  // --- Fallback (dev/test only) ---
  if (opts.critical && process.env.NODE_ENV === "production") {
    // Fail closed: production-critical operations must never silently run
    // on a process-local Map (no cross-process serialization).
    throw new Error("عملیات حساس مالی نیاز به اتصال واقعی Redis دارد که در این محیط فعال نیست.");
  }
  return runIdempotency<T>(memIdempotencyBackend(), key, fn, cfg);
}

// ---------------------------------------------------------------------
// TEST HOOKS — used exclusively by tests/cache-idempotency-redis.test.ts
// to drive the RAW Redis state machine (claim lifecycle, done-marker
// visibility, abandoned claims) without going through the high-level
// idempotency() orchestration. Not used by production call-sites.
// ---------------------------------------------------------------------
export const IDEM_TEST_HOOKS = {
  claimKeyFor(key: string): string {
    return `idem:${key}`;
  },
  /** Raw ACQUIRE script evaluation (returns the [state, payload] pair). */
  async rawEvalAcquire(claimKey: string, holder: string, claimTtlMs: number): Promise<[number, string | null]> {
    const client = getRedis();
    if (!client) throw new Error("redis not available");
    const res = (await client.eval(
      IDEM_ACQUIRE_LUA, 2, claimKey, `${claimKey}:result`,
      holder, String(claimTtlMs), IDEM_DONE, IDEM_INFLIGHT_PREFIX,
    )) as [number, string | null];
    return res;
  },
  /** Raw SET-inflight claim with a tiny TTL (abandoned-claim simulation). */
  async rawEvalClaimTiny(claimKey: string, holder: string, ttlMs: number): Promise<number> {
    const client = getRedis();
    if (!client) throw new Error("redis not available");
    const res = await client.set(claimKey, `${IDEM_INFLIGHT_PREFIX}${holder}`, "PX", ttlMs, "NX");
    return res === "OK" ? 1 : 0;
  },
};

// ---------------------------------------------------------------------
// Public API for the health endpoint to call a fresh PING.
// ---------------------------------------------------------------------
export { refreshRedisLiveness, isRedisConnected };
