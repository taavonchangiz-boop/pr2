import { PrismaClient } from "@prisma/client";

// POSTYAR prisma client. In dev, log warnings only (not full queries —
// they leak data and clutter the log). Use global singleton to survive
// Next.js HMR.
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

// V4 H-05 — the AUTHORITATIVE production dialect is SQLite (file-based).
// The database file is switched to WAL journal mode ONCE per process:
// WAL is persistent (stored in the database header), enables concurrent
// readers alongside a single writer, and — combined with the
// busy_timeout/socket_timeout connection-URL parameters — is the mode in
// which the financial/concurrency invariants are proven by the real
// multi-connection test suite (tests/db-multi-connection-concurrency.test.ts).
// A pragma failure is logged loudly (never silent) but is not fatal: the
// invariants also hold under the default journal mode (single writer).
async function applySqliteJournalMode(client: PrismaClient): Promise<void> {
  if (!process.env.DATABASE_URL?.startsWith("file:")) return;
  try {
    await client.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
  } catch (err) {
    console.error(
      "sqlite WAL pragma failed (continuing with default journal mode):",
      err instanceof Error ? err.message : err,
    );
  }
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "production" ? ["error"] : ["warn", "error"],
  });

void applySqliteJournalMode(db);

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
