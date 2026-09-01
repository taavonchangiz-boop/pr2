// =====================================================================
// POSTYAR — bot webhook hardening helpers (audit W1/W2/W3)
// ---------------------------------------------------------------------
// Shared by /api/bots/incoming/{telegram,bale,rubika}:
//   * webhookRequestGuard — per-IP rate limit + Content-Length cap.
//     The webhook URLs are constant per bot (bid+sig are not secrets
//     from anyone who has seen the URL), so unauthenticated flooding
//     must be throttled and oversized bodies rejected BEFORE the DB
//     lookup and HMAC work (CPU + AuditLog INSERT amplification).
//
// Event-level deduplication NO LONGER LIVES HERE. The former volatile
// claim (claimUpdateOnce — atomic INCR with a 24h TTL) was at-most-once:
// a crash after the claim permanently suppressed the provider's retry,
// and without REDIS_URL it degraded to a per-process Map. The single
// authoritative dedup owner is now the durable DB inbox in
// src/lib/bots/event-dedup.ts (BotInboundEvent UNIQUE + lease + retry).
// =====================================================================
import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/security/cache";
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
 * M-5: the Content-Length pre-check alone is bypassable (chunked
 * transfer-encoding or a lying length header). This reader enforces the
 * same cap on the ACTUAL stream — the connection is dropped as soon as
 * the accumulated bytes exceed WEBHOOK_MAX_BODY_BYTES, so no route ever
 * materializes an oversized webhook body in memory.
 */
export async function readBoundedWebhookBody(req: Request): Promise<{ ok: true; text: string } | { ok: false; errorFa: string }> {
  const reader = req.body?.getReader();
  if (!reader) {
    // No stream available (should not happen for POST) — fall back to text().
    try {
      return { ok: true, text: await req.text() };
    } catch {
      return { ok: false, errorFa: "خواندن بدنه درخواست ناموفق بود." };
    }
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    let chunk: { done: boolean; value?: Uint8Array };
    try {
      chunk = await reader.read();
    } catch {
      return { ok: false, errorFa: "خواندن بدنه درخواست ناموفق بود." };
    }
    if (chunk.done) break;
    if (chunk.value) {
      received += chunk.value.byteLength;
      if (received > WEBHOOK_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, errorFa: "بدنه وب‌هوک بیش از حد بزرگ است." };
      }
      chunks.push(chunk.value);
    }
  }
  const parts = chunks.map((c) => Buffer.from(c));
  return { ok: true, text: Buffer.concat(parts).toString("utf8") };
}
