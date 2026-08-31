// POSTYAR — POST /api/woo/stores/[id]/sync
// Syncs products → emits Content drafts owned by user
import { NextResponse } from "next/server";
import { requireUser, clientIp, AuthError } from "@/lib/server/auth";
import { rateLimit } from "@/lib/security/cache";
import { syncProducts } from "@/lib/providers/woo";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  void ip;
  const { id } = await params;
  // SSRF amplification guard (audit WO1): throttle outbound sync probes.
  const rlSync = await rateLimit({ key: `woo:sync:${user.id}`, limit: 10, windowMs: 10 * 60 * 1000 });
  if (!rlSync.ok) {
    return NextResponse.json({ errorFa: "تعداد همگام‌سازی بیش از حد مجاز است." }, { status: 429 });
  }
  const r = await syncProducts(id, user.id);
  if (!r.ok) {
    return NextResponse.json({ errorFa: r.errorFa ?? "همگام‌سازی ناموفق بود." }, { status: 400 });
  }
  return NextResponse.json({
    ok: true,
    syncedCount: r.syncedCount,
    drafts: r.drafts,
  });
}
