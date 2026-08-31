// =====================================================================
// POSTYAR — bot webhook hardening helpers (audit W1/W2/W3)
// ---------------------------------------------------------------------
// Shared by /api/bots/incoming/{telegram,bale,rubika}:
//   * webhookRequestGuard — per-IP rate limit + Content-Length cap.
//     The webhook URLs are constant per bot (bid+sig are not secrets
//     from anyone who has seen the URL), so unauthenticated flooding
//     must be throttled and oversized bodies rejected BEFORE the DB
//     lookup and HMAC work (CPU + AuditLog INSERT amplification).
//   * claimUpdateOnce — ATOMIC update_id dedup. The previous
//     check-then-set (cache.get then cache.set) let two concurrent
//     deliveries of the same update BOTH run their workflows. A counter
//     incr with TTL is atomic in both the Redis-backed and in-memory
//     implementations: the first caller observes 1 and wins; every
//     later delivery observes > 1 and is dropped.
// =====================================================================
import { NextResponse } from "next/server";
import { cache, rateLimit } from "@/lib/security/cache";
import { clientIp } from "@/lib/server/auth";

export const WEBHOOK_MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB — Bot API updates are far smaller

export async function webhookRequestGuard(req: Request): Promise<Response | null> {
  const ip = clientIp(req);
  const rl = await rateLimit({ key: `webhook:${ip}`, limit: 300, windowMs: 60 * 1000 });
  if (!rl.ok) {
    return NextResponse.json({ ok: false, errorFa: "تعداد درخواست‌ها بیش از حد مجاز است." }, { status: 429 });
  }
  const contentLength = Number.parseInt(req.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > WEBHOOK_MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, errorFa: "بدنه وب‌هوک بیش از حد بزرگ است." }, { status: 413 });
  }
  return null;
}

/**
 * Atomic first-delivery claim. Returns true when THIS call is the first
 * delivery of the update (and therefore should be processed); false when
 * the update was already claimed (duplicate delivery).
 */
export async function claimUpdateOnce(botId: string, provider: string, updateId: string | number): Promise<boolean> {
  const n = await cache.incr(`bot:upd:${botId}:${provider}:${String(updateId)}`, 24 * 60 * 60 * 1000);
  return n === 1;
}
