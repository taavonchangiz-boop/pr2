// =====================================================================
// POSTYAR — Bot linking (link codes)
// ---------------------------------------------------------------------
// A logged-in POSTYAR user generates a short-lived (10 min) signed
// link code from the dashboard and types it inside the bot chat.
// The bot's workflow (START step) checks the linked user; if not
// linked, the bot prompts the user to enter their link code.
//
// Link code shape: `POSTYAR-XXXXXX` (6 base32 chars, no ambiguous
// chars). The PLAINTEXT code is shown ONCE to the user. The hash
// (SHA-256) is stored in `BotLinkCode.codeHash` (UNIQUE).
//
// The code's signature is HMAC("bot-link-code", `${botId}:${userId}:${expiryIso}:${nonce}`).
// The plaintext code embeds the HMAC suffix:
//   `POSTYAR-<base32(6)><base32(hmacSuffix(8))>`
//
// Verification on consume:
//   1. Parse the code → nonce + hmac suffix
//   2. Look up the BotLinkCode row by codeHash (we re-derive the hash
//      from the plaintext to find the row)
//   3. Verify expiry + single-use (consumedAt null)
//   4. Verify HMAC signature (constant-time)
//   5. $transaction: set consumedAt + consumedByProviderUserId, return userId
//   6. Rate-limited per providerUserId (max 5 attempts / 10 min)
// =====================================================================
import { db } from "@/lib/db";
import {
  hmacSign,
  hashToken,
  constantTimeEqual,
} from "@/lib/security/crypto";
import { rateLimit } from "@/lib/security/cache";
import { audit, AuthError } from "@/lib/server/auth";
import crypto from "node:crypto";

const LINK_CODE_TTL_MS = 10 * 60 * 1000; // 10 min
const LINK_CODE_NONCE_LEN = 6; // 6 base32 chars
const CONSUME_RATE_LIMIT = 5;
const CONSUME_RATE_WINDOW_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------
// Base32 (Crockford — no 0/O/1/I/L ambiguity)
// ---------------------------------------------------------------------
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function base32Encode(bytes: Buffer, len: number): string {
  // Build a bit-string from the bytes, then chunk into 5-bit groups.
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length && out.length < len; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, "0");
    const idx = parseInt(chunk, 2);
    out += CROCKFORD_ALPHABET[idx] ?? "0";
  }
  while (out.length < len) out += "0";
  return out.slice(0, len);
}

function randomBase32(len: number): string {
  const byteLen = Math.ceil((len * 5) / 8) + 4;
  const buf = crypto.randomBytes(byteLen);
  return base32Encode(buf, len);
}

// ---------------------------------------------------------------------
// Build the plaintext link code + its HMAC suffix
// ---------------------------------------------------------------------
// Format: POSTYAR-<6 base32 nonce><8 base32 hmac suffix>
// Total length: 8 + 6 + 8 = 22 chars.
const PREFIX = "POSTYAR-";
const NONCE_LEN = 6;
const HMAC_SUFFIX_LEN = 8;

function buildPayload(botId: string, userId: string | null, expiresAt: Date, nonce: string): string {
  return `${botId}:${userId ?? ""}:${expiresAt.toISOString()}:${nonce}`;
}

// ---------------------------------------------------------------------
// generateLinkCode — issues a fresh single-use code
// ---------------------------------------------------------------------
async function generateLinkCodeImpl(input: {
  botId: string;
  userId: string;
}): Promise<{ code: string; expiresAt: Date; linkCodeId: string }> {
  if (!input.botId) throw new AuthError("شناسه ربات الزامی است.", 400);
  if (!input.userId) throw new AuthError("شناسه کاربر الزامی است.", 400);
  // Verify the bot exists + is owned by the user
  const bot = await db.bot.findUnique({
    where: { id: input.botId },
    select: { id: true, ownerId: true, provider: true, name: true },
  });
  if (!bot || bot.ownerId !== input.userId) {
    throw new AuthError("ربات یافت نشد یا متعلق به شما نیست.", 404);
  }
  // Cap active (un-consumed, un-expired) codes per bot to 10 — prevent abuse
  const now = new Date();
  const activeCount = await db.botLinkCode.count({
    where: {
      botId: input.botId,
      consumedAt: null,
      expiresAt: { gt: now },
    },
  });
  if (activeCount >= 10) {
    throw new AuthError("تعداد کدهای فعال بیش از حد است. چند لحظه بعد تلاش کنید.", 429);
  }
  const nonce = randomBase32(NONCE_LEN);
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
  const payload = buildPayload(input.botId, input.userId, expiresAt, nonce);
  const hmacSuffix = hmacSign("bot-link-code", payload).slice(0, HMAC_SUFFIX_LEN).toUpperCase();
  // Re-verify the suffix is base32-friendly (hex chars 0-9 a-f → uppercase letters A-F + digits)
  // HMAC hex is 0-9a-f; we map to Crockford subset by hashing the hmacSuffix to base32 again.
  const suffixB32 = base32Encode(Buffer.from(hmacSuffix, "utf8"), HMAC_SUFFIX_LEN);
  const plaintext = `${PREFIX}${nonce}${suffixB32}`;
  const codeHash = hashToken(plaintext);
  try {
    const row = await db.botLinkCode.create({
      data: {
        botId: input.botId,
        userId: input.userId,
        codeHash,
        expiresAt,
      },
    });
    await audit({
      userId: input.userId,
      actor: "user",
      action: "bot_link_code_generated",
      targetType: "bot",
      targetId: input.botId,
      meta: { linkCodeId: row.id },
    });
    return { code: plaintext, expiresAt, linkCodeId: row.id };
  } catch (err) {
    // Hash collision (extremely unlikely) → retry once
    const msg = (err as { code?: string; message?: string })?.message ?? "";
    if (/unique|UNIQUE|constraint/i.test(msg)) {
      return generateLinkCodeImpl(input);
    }
    throw err;
  }
}

/**
 * Public entry with a BOUNDED retry (audit L1): hash collisions retry at
 * most 3 times. The previous implementation recursed without any depth
 * cap — an unexpected repeated-unique failure could recurse unboundedly.
 */
export async function generateLinkCode(input: {
  userId: string;
  botId: string;
  destinationId?: string;
}): Promise<{ code: string; expiresAt: Date; linkCodeId: string }> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await generateLinkCodeImpl(input);
    } catch (err) {
      const msg = (err as { code?: string; message?: string })?.message ?? "";
      if (/unique|UNIQUE|constraint/i.test(msg)) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("کد اتصال قابل تولید نیست.");
}

// ---------------------------------------------------------------------
// consumeLinkCode — verify + link the provider user
// ---------------------------------------------------------------------
export async function consumeLinkCode(input: {
  botId: string;
  code: string;
  providerUserId: string;
}): Promise<{ ok: boolean; userId?: string; errorFa?: string }> {
  if (!input.botId) return { ok: false, errorFa: "شناسه ربات الزامی است." };
  if (!input.code) return { ok: false, errorFa: "کد اتصال الزامی است." };
  if (!input.providerUserId) return { ok: false, errorFa: "شناسه کاربر در ربات الزامی است." };

  // Rate limit per providerUserId
  const rlKey = `bot:link:consume:${input.providerUserId}`;
  const rl = await rateLimit({
    key: rlKey,
    limit: CONSUME_RATE_LIMIT,
    windowMs: CONSUME_RATE_WINDOW_MS,
  });
  if (!rl.ok) {
    return { ok: false, errorFa: "تعداد تلاش بیش از حد مجاز است. ده دقیقه بعد تلاش کنید." };
  }

  // Normalize code (uppercase, strip whitespace, strip Persian digits)
  const normalized = input.code.trim().toUpperCase().replace(/[۰-۹]/g, (d) =>
    String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)),
  );

  // Validate format
  if (!normalized.startsWith(PREFIX)) {
    return { ok: false, errorFa: "قالب کد نامعتبر است." };
  }
  const body = normalized.slice(PREFIX.length);
  if (body.length !== NONCE_LEN + HMAC_SUFFIX_LEN) {
    return { ok: false, errorFa: "طول کد نامعتبر است." };
  }

  // Look up the BotLinkCode row by hash
  const codeHash = hashToken(normalized);
  const row = await db.botLinkCode.findUnique({ where: { codeHash } });
  if (!row) {
    return { ok: false, errorFa: "کد نامعتبر است یا قبلاً استفاده شده است." };
  }
  if (row.consumedAt) {
    return { ok: false, errorFa: "این کد قبلاً استفاده شده است." };
  }
  const now = new Date();
  if (row.expiresAt.getTime() < now.getTime()) {
    return { ok: false, errorFa: "کد منقضی شده است." };
  }
  if (row.botId !== input.botId) {
    return { ok: false, errorFa: "این کد برای ربات دیگری صادر شده است." };
  }

  // Re-derive HMAC + verify
  const nonce = body.slice(0, NONCE_LEN);
  const storedSuffix = body.slice(NONCE_LEN);
  const payload = buildPayload(row.botId, row.userId ?? null, row.expiresAt, nonce);
  const expectedHmac = hmacSign("bot-link-code", payload).slice(0, HMAC_SUFFIX_LEN).toUpperCase();
  const expectedSuffix = base32Encode(Buffer.from(expectedHmac, "utf8"), HMAC_SUFFIX_LEN);
  if (!constantTimeEqual(expectedSuffix, storedSuffix)) {
    // HMAC mismatch — either tampered, or the code was re-issued (nonce reuse)
    // We can't trust this code even though the hash matched; reject.
    await audit({
      userId: row.userId ?? null,
      actor: "webhook",
      action: "bot_link_code_signature_mismatch",
      targetType: "bot",
      targetId: row.botId,
      meta: { linkCodeId: row.id },
    });
    return { ok: false, errorFa: "کد نامعتبر است." };
  }

  // $transaction: mark consumed
  try {
    const updated = await db.$transaction(async (tx) => {
      const r = await tx.botLinkCode.updateMany({
        where: { id: row.id, consumedAt: null },
        data: {
          consumedAt: now,
          consumedByProviderUserId: input.providerUserId,
        },
      });
      if (r.count === 0) return null; // already consumed by parallel call
      return row;
    });
    if (!updated) {
      return { ok: false, errorFa: "این کد قبلاً استفاده شده است." };
    }
    await audit({
      userId: row.userId ?? null,
      actor: "webhook",
      action: "bot_link_code_consumed",
      targetType: "bot",
      targetId: row.botId,
      meta: { linkCodeId: row.id, providerUserId: input.providerUserId },
    });
    return { ok: true, userId: row.userId ?? undefined };
  } catch (err) {
    const msg = (err as Error)?.message ?? "";
    return { ok: false, errorFa: `خطا در اتصال: ${msg}` };
  }
}

// ---------------------------------------------------------------------
// List link codes for a bot (owner-only; never returns plaintext)
// ---------------------------------------------------------------------
export async function listLinkCodesForBot(botId: string, ownerId: string) {
  const bot = await db.bot.findUnique({
    where: { id: botId },
    select: { id: true, ownerId: true },
  });
  if (!bot || bot.ownerId !== ownerId) {
    throw new AuthError("ربات یافت نشد یا متعلق به شما نیست.", 404);
  }
  const rows = await db.botLinkCode.findMany({
    where: { botId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      expiresAt: true,
      consumedAt: true,
      consumedByProviderUserId: true,
      createdAt: true,
      // NEVER select codeHash (returns hash, not plaintext, but still
      // not needed by the client and avoids any chance of leak).
    },
  });
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    consumed: !!r.consumedAt,
    consumedAt: r.consumedAt ? r.consumedAt.toISOString() : null,
    consumedByProviderUserIdMasked: r.consumedByProviderUserId
      ? `${r.consumedByProviderUserId.slice(0, 4)}••••`
      : null,
  }));
}

// ---------------------------------------------------------------------
// Sanitize a code for display: only first 4 chars + last 4 chars
// (used when re-listing — we never return the plaintext after issue)
// ---------------------------------------------------------------------
export function maskLinkCode(code: string): string {
  if (code.length <= 8) return "••••";
  return `${code.slice(0, 4)}••••${code.slice(-4)}`;
}
