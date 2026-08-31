// =====================================================================
// POSTYAR — Advertising module
// ---------------------------------------------------------------------
// Lifecycle: pending → approved → running → completed
//                  ↘ rejected / cancelled
// All operations ownership-enforced. Admins can approve/reject.
// Ad images stored as WebP under /public/assets/ads/ (randomized filename)
// Money: INTEGER Rial. Persian error strings.
// =====================================================================
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import sharp from "sharp";
import { db } from "@/lib/db";
import { audit, AuthError } from "@/lib/server/auth";
import { formatRials } from "@/lib/persian";

const ADS_DIR = path.resolve(process.cwd(), "public", "assets", "ads");

// Default placements — auto-seeded on first ad create so the FK from
// AdCampaign.placement → AdPlacement.key always finds a valid target.
// `kind` mirrors the values used by the admin placement editor.
export const DEFAULT_AD_PLACEMENTS: Array<{
  key: string;
  labelFa: string;
  descriptionFa: string;
  kind: string;
  recommendedWidth: number;
  recommendedHeight: number;
  sortOrder: number;
}> = [
  {
    key: "user_dashboard_top",
    labelFa: "بالای داشبورد کاربر",
    descriptionFa: "نوار بنری افقی در بالای محتوای اصلی داشبورد کاربر.",
    kind: "banner_inline",
    recommendedWidth: 1200,
    recommendedHeight: 240,
    sortOrder: 10,
  },
  {
    key: "user_dashboard_sidebar",
    labelFa: "کنار داشبورد کاربر",
    descriptionFa: "کارت عمودی در پایین نوار کناری داشبورد کاربر.",
    kind: "sidebar_card",
    recommendedWidth: 480,
    recommendedHeight: 600,
    sortOrder: 20,
  },
  {
    key: "sticky_bar",
    labelFa: "نوار چسبان بالا",
    descriptionFa: "نوار باریک چسبان در بالای صفحه؛ قابل بستن توسط کاربر.",
    kind: "sticky_bar",
    recommendedWidth: 1200,
    recommendedHeight: 90,
    sortOrder: 30,
  },
  {
    key: "landing_hero",
    labelFa: "بنر هیرو لندینگ",
    descriptionFa: "بنر بزرگ بالای صفحهٔ اصلی (فقط برای نمایش همگانی).",
    kind: "banner_inline",
    recommendedWidth: 1600,
    recommendedHeight: 500,
    sortOrder: 40,
  },
  {
    key: "plans_page_banner",
    labelFa: "بنر صفحهٔ پلن‌ها",
    descriptionFa: "بنر افقی در بالای فهرست پلن‌ها.",
    kind: "banner_inline",
    recommendedWidth: 1200,
    recommendedHeight: 200,
    sortOrder: 50,
  },
  {
    key: "slider_main",
    labelFa: "اسلایدر اصلی",
    descriptionFa: "اسلایدر چرخشی صفحهٔ اصلی با چند اسلاید؛ هر اسلاید تصویری بزرگ.",
    kind: "slider",
    recommendedWidth: 1600,
    recommendedHeight: 600,
    sortOrder: 60,
  },
];

let seedPlacementsPromise: Promise<void> | null = null;

/** Idempotent — safe to call on every ad create. Inserts default placements
 *  if missing; never overwrites admin edits (labelFa/descriptionFa/active/
 *  sortOrder stay admin-owned on update). For the recommended-size + max-
 *  file-bytes fields, we ONLY seed them when the admin hasn't already set a
 *  non-zero value, so the default placements get their recommended sizes
 *  (1200×240 etc.) on first run but admin edits win afterward. */
export function ensureAdPlacementsSeeded(): Promise<void> {
  if (seedPlacementsPromise) return seedPlacementsPromise;
  seedPlacementsPromise = (async () => {
    for (const p of DEFAULT_AD_PLACEMENTS) {
      await db.adPlacement.upsert({
        where: { key: p.key },
        create: {
          key: p.key,
          labelFa: p.labelFa,
          descriptionFa: p.descriptionFa,
          kind: p.kind,
          active: true,
          sortOrder: p.sortOrder,
          recommendedWidth: p.recommendedWidth,
          recommendedHeight: p.recommendedHeight,
          maxFileBytes: 5 * 1024 * 1024,
        },
        update: {
          // Keep label in sync only if admin hasn't renamed. We deliberately
          // don't overwrite descriptionFa / kind / active / sortOrder / sizes
          // so the admin's edits win. The recommended sizes are backfilled
          // in the next step ONLY when they're still 0.
          labelFa: p.labelFa,
        },
      });
      // One-shot backfill: if the row pre-existed (created before the size
      // fields existed) and the admin hasn't set them, write them now.
      // Skipped if the admin already configured them (non-zero).
      const existing = await db.adPlacement.findUnique({ where: { key: p.key }, select: { recommendedWidth: true, recommendedHeight: true, maxFileBytes: true } });
      if (existing && (existing.recommendedWidth === 0 || existing.recommendedHeight === 0 || existing.maxFileBytes === 0)) {
        await db.adPlacement.update({
          where: { key: p.key },
          data: {
            recommendedWidth: existing.recommendedWidth === 0 ? p.recommendedWidth : undefined,
            recommendedHeight: existing.recommendedHeight === 0 ? p.recommendedHeight : undefined,
            maxFileBytes: existing.maxFileBytes === 0 ? 5 * 1024 * 1024 : undefined,
          },
        });
      }
    }
  })();
  return seedPlacementsPromise;
}

async function ensureAdsDir(): Promise<void> {
  try {
    await fs.mkdir(ADS_DIR, { recursive: true });
  } catch { /* ignore */ }
}

async function persistAdImage(buf: Buffer): Promise<{ urlPath: string; sizeBytes: number; width: number; height: number }> {
  await ensureAdsDir();
  // Magic byte check via sharp decode — rejects anything that isn't a real image
  // Re-encode as WebP (q80), max 1200x1200 inside fit; strips EXIF/ICC.
  const transformer = sharp(buf, { animated: false }).rotate();
  const meta = await transformer.metadata().catch(() => null);
  if (!meta) throw new AuthError("فایل تصویر معتبر نیست.", 400);
  const webp = sharp(buf, { animated: false })
    .rotate()
    .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 });
  const out = await webp.toBuffer();
  const name = `ad_${crypto.randomBytes(12).toString("hex")}.webp`;
  const abs = path.join(ADS_DIR, name);
  await fs.writeFile(abs, out);
  const dim = await sharp(out).metadata();
  return {
    urlPath: `/assets/ads/${name}`,
    sizeBytes: out.byteLength,
    width: dim.width ?? 0,
    height: dim.height ?? 0,
  };
}

export interface AdView {
  id: string;
  title: string;
  descriptionFa: string;
  link: string | null;
  imagePath: string | null;
  imageUrl: string | null;
  placement: string;
  startAt: string | null;
  endAt: string | null;
  priceRials: number;
  priceFa: string;
  status: string;
  impressions: number;
  clicks: number;
  createdAt: string;
  reviewedAt: string | null;
}

function toAdView(a: {
  id: string;
  title: string;
  descriptionFa: string;
  link: string | null;
  imagePath: string | null;
  placement: string;
  startAt: Date | null;
  endAt: Date | null;
  priceRials: number;
  status: string;
  impressions: number;
  clicks: number;
  createdAt: Date;
  reviewedAt: Date | null;
}): AdView {
  return {
    id: a.id,
    title: a.title,
    descriptionFa: a.descriptionFa,
    link: a.link,
    imagePath: a.imagePath,
    imageUrl: a.imagePath ?? null,
    placement: a.placement,
    startAt: a.startAt?.toISOString() ?? null,
    endAt: a.endAt?.toISOString() ?? null,
    priceRials: a.priceRials,
    priceFa: formatRials(a.priceRials),
    status: a.status,
    impressions: a.impressions,
    clicks: a.clicks,
    createdAt: a.createdAt.toISOString(),
    reviewedAt: a.reviewedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------
// Create ad draft
// ---------------------------------------------------------------------
export async function createAdDraft(input: {
  userId: string;
  title: string;
  descriptionFa?: string;
  link?: string;
  imageBuffer?: Buffer;
  placement?: string;
  startAt?: Date;
  endAt?: Date;
  priceRials?: number;
  ip?: string;
}): Promise<AdView> {
  if (!input.title || input.title.trim().length < 3) {
    throw new AuthError("عنوان تبلیغ حداقل ۳ نویسه باشد.", 400);
  }
  // Make sure default placements exist before we try to attach a campaign
  // to one. This is the FK-violation hotfix: previously, the user could
  // POST a campaign with a placement that wasn't yet in AdPlacement.
  await ensureAdPlacementsSeeded();
  const placementKey = (input.placement ?? "user_dashboard_top").trim();
  // ROOT-CAUSE FIX (audit — placement spam): the previous on-demand
  // creation let any authenticated user mint UNLIMITED AdPlacement rows
  // by inventing new keys. Placements are admin-managed: unknown keys are
  // now rejected with 400 (defaults are always seeded).
  const placement = await db.adPlacement.findUnique({ where: { key: placementKey } });
  if (!placement) {
    throw new AuthError("جایگاه تبلیغاتی انتخاب‌شده معتبر نیست.", 400);
  }
  let imagePath: string | null = null;
  if (input.imageBuffer && input.imageBuffer.byteLength > 0) {
    if (input.imageBuffer.byteLength > 5 * 1024 * 1024) {
      throw new AuthError("حجم تصویر بیش از ۵ مگابایت است.", 400);
    }
    const r = await persistAdImage(input.imageBuffer);
    imagePath = r.urlPath;
  }
  const created = await db.adCampaign.create({
    data: {
      ownerId: input.userId,
      title: input.title.slice(0, 200),
      descriptionFa: (input.descriptionFa ?? "").slice(0, 1000),
      link: input.link?.slice(0, 500) ?? null,
      imagePath,
      placement: placement.key,
      startAt: input.startAt ?? null,
      endAt: input.endAt ?? null,
      priceRials: input.priceRials ?? 0,
      status: "pending",
    },
  });
  await audit({
    userId: input.userId,
    actor: "user",
    action: "ad_draft_created",
    targetType: "ad",
    targetId: created.id,
    ip: input.ip,
    meta: { title: created.title, placement: created.placement },
  });
  return toAdView(created);
}

// ---------------------------------------------------------------------
// Submit for review (admin will approve)
// ---------------------------------------------------------------------
export async function submitAdForReview(input: {
  id: string;
  userId: string;
  ip?: string;
}): Promise<AdView> {
  const ad = await db.adCampaign.findUnique({ where: { id: input.id } });
  if (!ad) throw new AuthError("تبلیغ یافت نشد.", 404);
  if (ad.ownerId !== input.userId) throw new AuthError("دسترسی غیرمجاز.", 403);
  if (ad.status !== "pending" && ad.status !== "rejected") {
    throw new AuthError("این تبلیغ قابل ارسال مجدد نیست.", 400);
  }
  const updated = await db.adCampaign.update({
    where: { id: input.id },
    data: { status: "pending", reviewedAt: null, reviewedBy: null, adminNotes: null },
  });
  await audit({
    userId: input.userId,
    actor: "user",
    action: "ad_submitted_for_review",
    targetType: "ad",
    targetId: input.id,
    ip: input.ip,
  });
  return toAdView(updated);
}

// ---------------------------------------------------------------------
// Admin approve / reject
// ---------------------------------------------------------------------
export async function adminApproveAd(input: {
  id: string;
  adminId: string;
  ip?: string;
}): Promise<AdView> {
  const ad = await db.adCampaign.findUnique({ where: { id: input.id } });
  if (!ad) throw new AuthError("تبلیغ یافت نشد.", 404);
  // ROOT-CAUSE FIX (audit AD2 — state machine): approval is a real state
  // transition, gated atomically. Previously ANY state (running/completed/
  // already-approved) could be flipped back to "approved" and every repeat
  // call re-sent the owner notification.
  const updated = await db.adCampaign.updateMany({
    where: { id: input.id, status: { in: ["pending", "rejected"] } },
    data: {
      status: "approved",
      reviewedBy: input.adminId,
      reviewedAt: new Date(),
    },
  });
  if (updated.count === 0) {
    // Already approved or in a terminal/running state — idempotent no-op.
    const fresh = await db.adCampaign.findUniqueOrThrow({ where: { id: input.id } });
    return toAdView(fresh);
  }
  const approved = await db.adCampaign.findUniqueOrThrow({ where: { id: input.id } });
  await audit({
    userId: ad.ownerId,
    actor: "admin",
    action: "ad_approved",
    targetType: "ad",
    targetId: input.id,
    ip: input.ip,
    meta: { adminId: input.adminId },
  });
  // Notify the ad owner
  await db.notification.create({
    data: {
      userId: ad.ownerId,
      category: "ad",
      titleFa: "تأیید تبلیغ",
      bodyFa: `تبلیغ «${ad.title}» شما تأیید شد و در حال نمایش است.`,
      link: "/dashboard/advertising",
    },
  });
  return toAdView(approved);
}

export async function adminRejectAd(input: {
  id: string;
  adminId: string;
  reason?: string;
  ip?: string;
}): Promise<AdView> {
  const ad = await db.adCampaign.findUnique({ where: { id: input.id } });
  if (!ad) throw new AuthError("تبلیغ یافت نشد.", 404);
  // Same transition guard as approve (audit AD2).
  const updated = await db.adCampaign.updateMany({
    where: { id: input.id, status: { in: ["pending", "approved"] } },
    data: {
      status: "rejected",
      reviewedBy: input.adminId,
      reviewedAt: new Date(),
      adminNotes: input.reason ?? null,
    },
  });
  if (updated.count === 0) {
    const fresh = await db.adCampaign.findUniqueOrThrow({ where: { id: input.id } });
    return toAdView(fresh);
  }
  const rejected = await db.adCampaign.findUniqueOrThrow({ where: { id: input.id } });
  await audit({
    userId: ad.ownerId,
    actor: "admin",
    action: "ad_rejected",
    targetType: "ad",
    targetId: input.id,
    ip: input.ip,
    meta: { adminId: input.adminId, reason: input.reason },
  });
  await db.notification.create({
    data: {
      userId: ad.ownerId,
      category: "ad",
      titleFa: "رد تبلیغ",
      bodyFa: `تبلیغ «${ad.title}» شما رد شد.` + (input.reason ? ` دلیل: ${input.reason}` : ""),
      link: "/dashboard/advertising",
    },
  });
  return toAdView(rejected);
}

// ---------------------------------------------------------------------
// Impressions / clicks — atomic increments (idempotent best-effort)
// ---------------------------------------------------------------------
export async function incrementImpression(id: string): Promise<void> {
  await db.adCampaign.update({
    where: { id, status: { in: ["approved", "running"] } },
    data: { impressions: { increment: 1 } },
  }).catch(() => undefined);
}

export async function incrementClick(id: string): Promise<void> {
  await db.adCampaign.update({
    where: { id, status: { in: ["approved", "running"] } },
    data: { clicks: { increment: 1 } },
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------
export async function listActiveAds(): Promise<AdView[]> {
  const now = new Date();
  const rows = await db.adCampaign.findMany({
    where: {
      status: { in: ["approved", "running"] },
      OR: [{ startAt: null }, { startAt: { lte: now } }],
      AND: [
        { OR: [{ endAt: null }, { endAt: { gt: now } }] },
      ],
    },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toAdView);
}

export async function listMyAds(userId: string): Promise<AdView[]> {
  const rows = await db.adCampaign.findMany({
    where: { ownerId: userId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toAdView);
}

export async function listAllAdsForAdmin(): Promise<AdView[]> {
  const rows = await db.adCampaign.findMany({
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toAdView);
}

export async function getAd(id: string, userId: string): Promise<AdView> {
  const ad = await db.adCampaign.findUnique({ where: { id } });
  if (!ad) throw new AuthError("تبلیغ یافت نشد.", 404);
  if (ad.ownerId !== userId) throw new AuthError("دسترسی غیرمجاز.", 403);
  return toAdView(ad);
}

