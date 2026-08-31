// POSTYAR — GET /api/ads/serve/[placement] (PUBLIC, no auth)
// Returns the active+approved+currently-running campaigns for a placement.
//   JSON: { campaigns: [{ id, title, descriptionFa, link, imagePath, kind }] }
// Impressions are incremented fire-and-forget (the lib swallows errors). We
// do NOT block the response on the increment.
import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/security/cache";
import { clientIp } from "@/lib/server/auth";
import { db } from "@/lib/db";
import { incrementImpression } from "@/lib/payments/advertising";

type Params = { params: Promise<{ placement: string }> };

export async function GET(req: Request, { params }: Params) {
  const { placement } = await params;
  if (!placement || placement.length > 60) {
    return NextResponse.json({ campaigns: [] });
  }
  // Resolve the placement record; inactive or missing → empty list.
  const slot = await db.adPlacement.findUnique({ where: { key: placement } });
  if (!slot || !slot.active) {
    return NextResponse.json({ campaigns: [] });
  }
  const now = new Date();
  // Slider placements render one campaign at a time (the preview pane on the
  // create-ad form shows rounded corners + nav-dots; multi-slide logic is
  // out of scope per the task brief, so we just take 1 here and the
  // <AdSlot> client treats `slider` kind the same as `banner_inline`).
  const isSlider = slot.kind === "slider";
  const rows = await db.adCampaign.findMany({
    where: {
      placement,
      status: { in: ["approved", "running"] },
      OR: [{ startAt: null }, { startAt: { lte: now } }],
      AND: [{ OR: [{ endAt: null }, { endAt: { gt: now } }] }],
    },
    orderBy: { createdAt: "desc" },
    take: isSlider ? 1 : 10,
  });
  // Fire-and-forget impressions. The lib already swallows errors so this is safe.
  // ROOT-CAUSE FIX (audit — metric inflation): impressions are throttled
  // per IP+placement so scripted GET loops cannot inflate counters.
  const ip = clientIp(req);
  for (const r of rows) {
    const rl = await rateLimit({ key: `ad:imp:${r.id}:${ip}`, limit: 10, windowMs: 60 * 60 * 1000 });
    if (!rl.ok) continue;
    void incrementImpression(r.id);
  }
  return NextResponse.json({
    campaigns: rows.map((r) => ({
      id: r.id,
      title: r.title,
      descriptionFa: r.descriptionFa,
      link: r.link,
      imagePath: r.imagePath,
      kind: slot.kind,
    })),
  });
}
