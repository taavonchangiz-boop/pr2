// =====================================================================
// POSTYAR — DB test helpers (DB-backed test tier)
// ---------------------------------------------------------------------
// Shared utilities for the tests/db-*.test.ts suite. Provides:
//   * `resetDb()` — truncate every table in the test DB for isolation.
//     Uses a single $transaction (SQLite deferred-FK semantics check at
//     COMMIT; deleting from ALL tables in one tx never violates FK).
//   * `seedUser()` — quick User factory for ownership / role tests.
//   * `seedPlan()` — quick Plan row.
//   * `seedDestination()` / `seedContent()` / `seedBot()` — for the
//     publishing / worker / bot-linking suites.
//
// Env: tests/preload.ts sets DATABASE_URL = file:/…/db/test.db BEFORE
// any test module imports `@/lib/db`. The shared PrismaClient singleton
// therefore operates on the test DB. The dev DB (db/custom.db) is NEVER
// touched.
// =====================================================================
import { db } from "@/lib/db";
import { encryptString } from "@/lib/security/crypto";
import { hashPassword } from "@/lib/security/crypto";
import type { User, Plan, Destination, Content, Bot, Order, Media } from "@prisma/client";

// Deletion order is irrelevant for SQLite under deferred-FK + a single
// $transaction: every table is emptied atomically and the COMMIT-time
// check sees no dangling references. We pass an array of deleteMany
// operations; Prisma wraps them in one transaction.
const TABLES = [
  // Children first to be safe under RESTRICT FKs (should be a no-op for
  // CASCADE / SET NULL policies, but documents intent).
  "profile",
  "session",
  "otp",
  "ticketReply",
  "ticket",
  "botHistory",
  "botLinkCode",
  "botWorkflow",
  "autoResponder",
  "notification",
  "media",
  "glassButton",
  "publishJob",
  "subscription",
  "cardTransferReceipt",
  "bankGatewayRef",
  "balePaymentRef",
  "walletTxn",
  "ledgerEntry",
  "bankCard",
  "discountPlan",
  "discountUsage",
  "discount",
  "referralReward",
  "adCampaign",
  "aiJob",
  "goldPrice",
  "goldBot",
  "wooCommerceStore",
  "auditLog",
  "systemSetting",
  "healthCheck",
  "content",
  "destination",
  "bot",
  "plan",
  "order",
  // Root last
  "user",
] as const;

export async function resetDb(): Promise<void> {
  // Ensure the engine is connected before issuing queries. The Prisma
  // engine starts lazily on first query; in test runs that begin with
  // raw SQL, the engine can race with the first invocation and surface
  // an "Engine is not yet connected" error. Calling $connect() is
  // idempotent — safe to call repeatedly.
  await db.$connect();
  // Disable FK enforcement for the connection during teardown to avoid
  // any RESTRICT ordering surprise; re-enable afterwards.
  await db.$executeRawUnsafe("PRAGMA foreign_keys = OFF");
  try {
    await db.$transaction(
      TABLES.map((name) =>
        // Prisma's model access via (db as any)[name] is avoided; use raw
        // SQL DELETE — uniformly safe and avoids model-name typos.
        db.$executeRawUnsafe(`DELETE FROM "${name}"`),
      ),
    );
    // Reset autoincrement sequences ONLY if sqlite_sequence exists. This
    // table is created lazily by SQLite when the first AUTOINCREMENT column
    // is declared; the POSTYAR schema uses cuid() ids (no AUTOINCREMENT) so
    // the table usually does not exist. Try-catch would also work, but
    // Prisma's logger still emits a noisy `prisma:error` line on caught
    // raw-query errors — guard with an explicit existence check instead.
    const seqExists = await db.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'`,
    );
    if (seqExists.length > 0) {
      await db.$executeRawUnsafe(
        `DELETE FROM sqlite_sequence WHERE name IN (${TABLES.map(() => "?").join(",")})`,
        ...TABLES,
      );
    }
  } finally {
    await db.$executeRawUnsafe("PRAGMA foreign_keys = ON");
  }
}

/**
 * Warm up the Prisma engine. Call once at the top of each test file's
 * beforeAll to ensure queries don't race with engine startup.
 * Idempotent — calling repeatedly is safe. Also raises SQLite's
 * busy_timeout so concurrent transactions retry on SQLITE_BUSY for
 * up to 30s instead of failing fast (default 5s) — needed for the
 * wallet concurrent-mutation tests.
 */
export async function ensureDbConnected(): Promise<void> {
  await db.$connect();
  // Raise SQLite's busy_timeout so concurrent transactions retry on
  // SQLITE_BUSY instead of erroring out immediately. Prisma's SQLite
  // pool serializes writers via this lock; the default is too short
  // for test-tier concurrency tests. PRAGMA returns a row, so we use
  // $queryRawUnsafe rather than $executeRawUnsafe (which forbids
  // result-returning statements under SQLite).
  await db.$queryRawUnsafe("PRAGMA busy_timeout = 30000");
  // Issue a trivial query to make sure the engine is responsive.
  await db.user.count();
}

// ---------------------------------------------------------------------
// Seed helpers — return plain Prisma rows. Use deterministic fields +
// random suffixes so unique constraints never collide across tests.
// ---------------------------------------------------------------------
let _seq = 0;
function uniqSuffix(): string {
  _seq += 1;
  return `${Date.now().toString(36)}-${_seq}`;
}

export async function seedUser(opts: Partial<{
  email: string;
  mobile: string;
  firstName: string;
  lastName: string;
  role: string;
  status: string;
  referralCode: string;
  referredById: string;
  password: string;
}> = {}): Promise<User> {
  const s = uniqSuffix();
  const email = opts.email ?? `user-${s}@test.local`;
  const mobile = opts.mobile ?? `0912${s.replace(/[^0-9]/g, "").slice(0, 7).padEnd(7, "0")}`;
  const referralCode = opts.referralCode ?? `R${s}`.slice(0, 8).toUpperCase();
  const password = opts.password ?? "Pass1234!";
  const passwordHash = await hashPassword(password);
  return db.user.create({
    data: {
      email,
      mobile,
      firstName: opts.firstName ?? "تستی",
      lastName: opts.lastName ?? "کاربر",
      role: opts.role ?? "user",
      status: opts.status ?? "active",
      referralCode,
      referredById: opts.referredById ?? null,
      passwordHash,
    },
  });
}

export async function seedPlan(opts: Partial<{
  code: string;
  nameFa: string;
  priceRials: number;
  intervalMonths: number;
  active: boolean;
  isPublic: boolean;
}> = {}): Promise<Plan> {
  const s = uniqSuffix();
  return db.plan.create({
    data: {
      code: opts.code ?? `plan-${s}`,
      nameFa: opts.nameFa ?? "طرح آزمایشی",
      descriptionFa: "",
      priceRials: opts.priceRials ?? 100_000,
      intervalMonths: opts.intervalMonths ?? 1,
      quota: JSON.stringify({ publishPerMonth: 10, aiPerMonth: 20, channels: 1, automation: 1 }),
      active: opts.active ?? true,
      // C-08: tests default to a NON-public plan (hidden plans are the
      // stricter case); tests that exercise the ordinary public purchase
      // path must pass isPublic: true explicitly.
      isPublic: opts.isPublic ?? false,
    },
  });
}

export async function seedDestination(opts: {
  ownerId: string;
  provider?: string;
  chatId?: string;
  label?: string;
  status?: string;
}): Promise<Destination> {
  const s = uniqSuffix();
  return db.destination.create({
    data: {
      ownerId: opts.ownerId,
      provider: opts.provider ?? "telegram",
      label: opts.label ?? `کانال ${s}`,
      botTokenEnc: encryptString(`000000000:AAAA-test-token-${s}`),
      chatId: opts.chatId ?? `-${s}`,
      status: opts.status ?? "active",
    },
  });
}

export async function seedContent(opts: {
  ownerId: string;
  title?: string;
  body?: string;
  status?: string;
}): Promise<Content> {
  const s = uniqSuffix();
  return db.content.create({
    data: {
      ownerId: opts.ownerId,
      title: opts.title ?? `محتوای آزمایشی ${s}`,
      body: opts.body ?? "متن نمونه",
      status: opts.status ?? "draft",
    },
  });
}

export async function seedBot(opts: {
  ownerId: string;
  provider?: string;
  name?: string;
  status?: string;
}): Promise<Bot> {
  const s = uniqSuffix();
  return db.bot.create({
    data: {
      ownerId: opts.ownerId,
      provider: opts.provider ?? "telegram",
      name: opts.name ?? `ربات ${s}`,
      botTokenEnc: encryptString(`000000000:AAAA-bot-token-${s}`),
      status: opts.status ?? "active",
    },
  });
}

export async function seedOrder(opts: {
  userId: string;
  amountRials: number;
  kind?: string;
  planId?: string | null;
  status?: string;
  provider?: string | null;
  idempotencyKey?: string;
}): Promise<Order> {
  const s = uniqSuffix();
  return db.order.create({
    data: {
      userId: opts.userId,
      kind: opts.kind ?? "wallet_credit",
      amountRials: opts.amountRials,
      planId: opts.planId ?? null,
      descriptionFa: "سفارش آزمایشی",
      status: opts.status ?? "pending",
      provider: opts.provider ?? null,
      idempotencyKey: opts.idempotencyKey ?? `order-${s}`,
    },
  });
}

export async function seedMedia(opts: {
  ownerId: string;
  kind?: string;
  mime?: string;
  sizeBytes?: number;
}): Promise<Media> {
  const s = uniqSuffix();
  return db.media.create({
    data: {
      ownerId: opts.ownerId,
      kind: opts.kind ?? "image",
      storagePath: `images/${s}.webp`,
      publicId: `${s}.webp`,
      mime: opts.mime ?? "image/webp",
      sizeBytes: opts.sizeBytes ?? 1024,
    },
  });
}

export { db };
