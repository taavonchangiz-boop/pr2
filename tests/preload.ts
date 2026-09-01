// Test preload — sets deterministic dev env vars BEFORE any test module
// imports the crypto module (which captures POSTYAR_MASTER_KEY at load
// time). Run automatically by `bun test` via bunfig.toml.
//
// DB-backed test tier:
//   * Both DATABASE_URL and TEST_DATABASE_URL point at db/test.db so the
//     @prisma/client generated from prisma/schema.prisma (which reads
//     DATABASE_URL at runtime) operates on the test DB. The dev server
//     is a SEPARATE process and is unaffected by env mutations here.
//   * db/custom.db (the dev DB) is NEVER touched by tests.
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
process.env.POSTYAR_MASTER_KEY = "a".repeat(64); // 64 hex chars = 32 bytes
process.env.POSTYAR_JWT_SECRET = "j".repeat(48); // >= 32 chars
// Ensure no REDIS_URL in test env so the in-memory fallback path is used
// (the production Redis-backed path is exercised in production via REDIS_URL).
delete process.env.REDIS_URL;
// --- DB-backed test tier env -----------------------------------------
// Absolute path: prisma CLI resolves relative `file:` URLs from the
// schema file's directory, but the @prisma/client at runtime resolves
// them from process.cwd(). Using an absolute path keeps both in sync
// and avoids accidentally creating a stray db/ under prisma/.
//
// SQLite URL params:
//   socket_timeout — how long a single query may run before the engine
//     gives up (default 5s). Concurrent transactions on SQLite's
//     single-writer pool can wait >5s for the lock under Promise.all
//     load; raise to 30s to tolerate the test-tier concurrency tests.
//   busy_timeout — SQLite's busy_timeout (how long the engine retries
//     SQLITE_BUSY on a locked table) — raised to 30s for the same
//     reason. NEVER set this low for the test tier.
//   connection_limit — force a single writer connection. Without this,
//     Prisma's engine may open multiple connections; SQLite's
//     file-level lock then deadlocks when parallel transactions
//     compete for the write lock across connections.
import path from "node:path";
// PORTABILITY FIX (audit — CI): the previous hardcoded absolute path
// (file:/home/z/my-project/db/test.db) only existed on the original dev
// sandbox; every other machine (including CI) got a broken test DB. The
// test DB now resolves NEXT TO THE REPO (db/test.db), independent of the
// checkout location.
const TEST_DB_PATH = path.join(process.cwd(), "db", "test.db");
const TEST_DB_URL = `file:${TEST_DB_PATH}?socket_timeout=30000&busy_timeout=30000&connection_limit=1`;
process.env.TEST_DATABASE_URL = TEST_DB_URL;
(process.env as Record<string, string | undefined>).DATABASE_URL = TEST_DB_URL;
// HERMETIC BUSINESS DEFAULTS: the suite asserts the documented referral
// defaults (20%, cap 100k — addendum §16). An operator .env carrying
// different overrides must never flip test expectations (bun auto-loads
// .env from cwd). Tests that need other values set them explicitly.
process.env.POSTYAR_REFERRAL_PERCENT = "20";
process.env.POSTYAR_REFERRAL_CAP_RIALS = "100000";
