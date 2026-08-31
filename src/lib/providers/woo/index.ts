// =====================================================================
// POSTYAR — WooCommerce REST client
// ---------------------------------------------------------------------
// Credentials encrypted in WooCommerceStore (consumerKeyEnc,
// consumerSecretEnc). We use Basic auth + HTTPS to the WooCommerce
// REST API v3.
//
// All methods are non-throwing on HTTP errors — they return a
// `{ ok, errorFa }` envelope so the caller (API route) can convert
// directly to a 4xx/5xx response.
// =====================================================================
import { db } from "@/lib/db";
import { encryptString, decryptString } from "@/lib/security/crypto";
import { assertSafeOutboundUrl, outboundUrlErrorFa } from "@/lib/security/net-guard";
import { audit } from "@/lib/server/auth";

// ---------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------
export interface WooStoreView {
  id: string;
  storeUrl: string;
  status: string;
  lastSyncAt: string | null;
  createdAt: string;
  consumerKeyMasked: string; // masked — never the full key
}

export interface WooProduct {
  id: number;
  name: string;
  slug: string;
  permalink: string;
  shortDescription: string; // raw HTML
  description: string; // raw HTML
  price: string;
  regularPrice: string;
  salePrice: string;
  images: Array<{ src: string; alt?: string }>;
  categories?: Array<{ name: string }>;
  type?: string;
  status?: string;
  stockStatus?: string;
}

export interface ContentDraftFromWoo {
  title: string;
  body: string; // HTML stripped, plain text
  imageUrl: string | null;
  sourceUrl: string | null;
}

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------
function normalizeStoreUrl(u: string): string {
  let url = u.trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  // strip trailing slash
  return url.replace(/\/$/, "");
}

/**
 * ROOT-CAUSE FIX (audit §27 — SSRF): the store URL is fully user-supplied
 * and was previously fetched with no scheme/host restrictions, turning
 * the sync endpoint into an internal-network probe (loopback, RFC1918,
 * cloud metadata) with an error-message oracle. Every fetch now passes
 * the shared egress guard (https-only, no userinfo, resolved addresses
 * checked against private ranges) and network errors return a GENERIC
 * message — never the raw exception text.
 */
async function safeWooUrl(storeUrl: string, path: string): Promise<URL> {
  const base = await assertSafeOutboundUrl(normalizeStoreUrl(storeUrl), {
    allowedPorts: [443],
  });
  const url = new URL(`${base.origin}/wp-json/wc/v3/${path.replace(/^\//, "")}`);
  return url;
}

function maskKey(k: string): string {
  if (!k) return "";
  if (k.length <= 8) return "••••";
  return `${k.slice(0, 4)}••••${k.slice(-4)}`;
}

function stripHtml(html: string): string {
  // Minimal HTML strip — removes tags, decodes common entities, collapses whitespace.
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function basicAuthHeader(key: string, secret: string): string {
  return `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`;
}

async function wooFetch<T>(
  store: { storeUrl: string; consumerKey: string; consumerSecret: string },
  path: string,
  opts: { method?: "GET" | "POST"; qs?: Record<string, string | number>; body?: unknown } = {},
): Promise<{ ok: true; data: T } | { ok: false; status?: number; errorFa: string }> {
  let url: URL;
  try {
    url = await safeWooUrl(store.storeUrl, path);
  } catch (e) {
    return { ok: false, errorFa: outboundUrlErrorFa(e) };
  }
  if (opts.qs) for (const [k, v] of Object.entries(opts.qs)) url.searchParams.set(k, String(v));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: opts.method ?? "GET",
      headers: {
        Authorization: basicAuthHeader(store.consumerKey, store.consumerSecret),
        Accept: "application/json",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
      // Never follow redirects — an attacker-controlled host could 302
      // the request to an internal address after validation.
      redirect: "error",
    });
  } catch {
    clearTimeout(timer);
    // Generic message only — raw error text is an SSRF/probing oracle.
    return { ok: false, errorFa: "ارتباط با فروشگاه ناموفق بود. آدرس فروشگاه را بررسی کنید." };
  }
  clearTimeout(timer);
  if (!res.ok) {
    let msg = `کد HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { message?: string };
      if (j.message && typeof j.message === "string" && j.message.length <= 200) {
        // Bound + reflect only the store's own short message (the store
        // is the user's own registered host — not an internal target,
        // which the URL guard already rejected).
        msg = j.message;
      }
    } catch {
      // ignore
    }
    return { ok: false, status: res.status, errorFa: `فراخوانی فروشگاه ناموفق بود: ${msg}` };
  }
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    return { ok: false, errorFa: "پاسخ فروشگاه قابل تجزیه نیست." };
  }
  return { ok: true, data };
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------
export async function testConnection(storeId: string): Promise<{ ok: boolean; errorFa?: string; storeName?: string }> {
  const row = await db.wooCommerceStore.findUnique({ where: { id: storeId } });
  if (!row) return { ok: false, errorFa: "فروشگاه یافت نشد." };
  const consumerKey = decryptString(row.consumerKeyEnc);
  const consumerSecret = decryptString(row.consumerSecretEnc);
  const r = await wooFetch<{ store?: { name?: string } }>(
    { storeUrl: row.storeUrl, consumerKey, consumerSecret },
    "system_status",
  );
  if (!r.ok) return r;
  return { ok: true, storeName: r.data.store?.name };
}

export async function listProducts(
  storeId: string,
  opts: { perPage?: number; page?: number; search?: string } = {},
): Promise<{ ok: boolean; items?: WooProduct[]; total?: number; errorFa?: string }> {
  const row = await db.wooCommerceStore.findUnique({ where: { id: storeId } });
  if (!row) return { ok: false, errorFa: "فروشگاه یافت نشد." };
  const consumerKey = decryptString(row.consumerKeyEnc);
  const consumerSecret = decryptString(row.consumerSecretEnc);
  const r = await wooFetch<WooProduct[]>(
    { storeUrl: row.storeUrl, consumerKey, consumerSecret },
    "products",
    { qs: { per_page: opts.perPage ?? 50, page: opts.page ?? 1, search: opts.search ?? "" } },
  );
  if (!r.ok) return r;
  return { ok: true, items: r.data, total: r.data.length };
}

export async function syncProducts(storeId: string, userId: string): Promise<{
  ok: boolean;
  syncedCount?: number;
  drafts?: ContentDraftFromWoo[];
  errorFa?: string;
}> {
  const row = await db.wooCommerceStore.findUnique({ where: { id: storeId } });
  if (!row) return { ok: false, errorFa: "فروشگاه یافت نشد." };
  if (row.userId !== userId) return { ok: false, errorFa: "دسترسی غیرمجاز." };

  const consumerKey = decryptString(row.consumerKeyEnc);
  const consumerSecret = decryptString(row.consumerSecretEnc);
  const r = await wooFetch<WooProduct[]>(
    { storeUrl: row.storeUrl, consumerKey, consumerSecret },
    "products",
    { qs: { per_page: 50, page: 1 } },
  );
  if (!r.ok) return r;

  const drafts: ContentDraftFromWoo[] = r.data.map((p) => transformWooProductToContent(p));

  // Persist as Content drafts owned by the user
  await db.content.createMany({
    data: drafts.map((d) => ({
      ownerId: userId,
      title: d.title.slice(0, 200),
      body: d.body.slice(0, 8000),
      status: "draft",
      mediaIds: d.imageUrl ? JSON.stringify([d.imageUrl]) : "[]",
      destinationIds: "[]",
    })),
  });

  await db.wooCommerceStore.update({
    where: { id: storeId },
    data: { lastSyncAt: new Date() },
  });

  await audit({
    userId,
    actor: "user",
    action: "woo_sync",
    targetType: "woo_store",
    targetId: storeId,
    meta: { syncedCount: drafts.length },
  });

  return { ok: true, syncedCount: drafts.length, drafts };
}

export function transformWooProductToContent(
  product: WooProduct,
): ContentDraftFromWoo {
  const title = (product.name ?? "").trim() || "بدون عنوان";
  const body = stripHtml(product.shortDescription || product.description || "");
  const imageUrl = product.images?.[0]?.src ?? null;
  return {
    title,
    body,
    imageUrl,
    sourceUrl: product.permalink || null,
  };
}

// ---------------------------------------------------------------------
// Store CRUD (used by the API routes)
// ---------------------------------------------------------------------
export async function createStore(input: {
  userId: string;
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  ip: string;
}): Promise<{ ok: boolean; store?: WooStoreView; errorFa?: string }> {
  const cleanUrl = normalizeStoreUrl(input.storeUrl);
  if (!cleanUrl || !/^https?:\/\/[^/]+/i.test(cleanUrl)) {
    return { ok: false, errorFa: "آدرس فروشگاه نامعتبر است." };
  }
  if (!input.consumerKey || !input.consumerSecret) {
    return { ok: false, errorFa: "کلید و رمز ووکامرس الزامی است." };
  }

  // Test connection BEFORE saving — verify creds by hitting system_status.
  const r = await wooFetch<{ store?: { name?: string } }>(
    { storeUrl: cleanUrl, consumerKey: input.consumerKey, consumerSecret: input.consumerSecret },
    "system_status",
  );
  if (!r.ok) return r;

  const consumerKeyEnc = encryptString(input.consumerKey);
  const consumerSecretEnc = encryptString(input.consumerSecret);
  const row = await db.wooCommerceStore.create({
    data: {
      userId: input.userId,
      storeUrl: cleanUrl,
      consumerKeyEnc,
      consumerSecretEnc,
      status: "active",
    },
  });

  await audit({
    userId: input.userId,
    actor: "user",
    action: "woo_store_created",
    targetType: "woo_store",
    targetId: row.id,
    ip: input.ip,
    meta: { storeUrl: cleanUrl },
  });

  return { ok: true, store: toView(row) };
}

export async function listMyStores(userId: string): Promise<WooStoreView[]> {
  const rows = await db.wooCommerceStore.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toView);
}

export async function deleteStore(storeId: string, userId: string): Promise<{ ok: boolean; errorFa?: string }> {
  const row = await db.wooCommerceStore.findUnique({ where: { id: storeId } });
  if (!row) return { ok: false, errorFa: "فروشگاه یافت نشد." };
  if (row.userId !== userId) return { ok: false, errorFa: "دسترسی غیرمجاز." };
  await db.wooCommerceStore.delete({ where: { id: storeId } });
  await audit({
    userId,
    actor: "user",
    action: "woo_store_deleted",
    targetType: "woo_store",
    targetId: storeId,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------
// Admin: list all stores
// ---------------------------------------------------------------------
export async function listAllStoresForAdmin(): Promise<WooStoreView[]> {
  const rows = await db.wooCommerceStore.findMany({
    orderBy: { createdAt: "desc" },
    include: { user: { select: { id: true, email: true, businessName: true, firstName: true, lastName: true } } },
  });
  return rows.map((r) => ({
    ...toView(r),
    // include the user view for admin display
    ...(r as unknown as { user: unknown }).user
      ? { owner: (r as unknown as { user: { id: string; email: string; businessName: string; firstName: string; lastName: string } }).user }
      : {},
  })) as WooStoreView[];
}

// ---------------------------------------------------------------------
// View helper
// ---------------------------------------------------------------------
function toView(row: {
  id: string;
  storeUrl: string;
  status: string;
  lastSyncAt: Date | null;
  createdAt: Date;
  consumerKeyEnc: string;
}): WooStoreView {
  let masked = "";
  try {
    masked = maskKey(decryptString(row.consumerKeyEnc));
  } catch {
    masked = "";
  }
  return {
    id: row.id,
    storeUrl: row.storeUrl,
    status: row.status,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    consumerKeyMasked: masked,
  };
}
