// POSTYAR — POST /api/ads/click/[id] (PUBLIC, no auth)
// Increments the click counter for an active+approved campaign. Fire-and-
// forget style: returns 200 immediately; the lib swallows DB errors so a
// bad id (404-ish) won't break the click handler on the client.
import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/security/cache";
import { clientIp } from "@/lib/server/auth";
import { incrementClick } from "@/lib/payments/advertising";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  if (!id) return NextResponse.json({ ok: false }, { status: 400 });
  // ROOT-CAUSE FIX (audit — metric inflation): the click counter is a
  // billable metric and was trivially inflatable (no rate limit, no dedup).
  // Per-IP+campaign throttle bounds the abuse (impression-level dedup is
  // documented as a remaining risk).
  const ip = clientIp(req);
  const rl = await rateLimit({ key: `ad:click:${id}:${ip}`, limit: 5, windowMs: 60 * 60 * 1000 });
  if (!rl.ok) return NextResponse.json({ ok: true, throttled: true });
  void incrementClick(id); // fire-and-forget (lib catches errors)
  return NextResponse.json({ ok: true });
}
