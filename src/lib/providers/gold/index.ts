// =====================================================================
// POSTYAR — Gold price provider
// ---------------------------------------------------------------------
// `getGoldPrice` fetches a single instrument from the configured market-
// data provider via env POSTYAR_GOLD_PROVIDER_URL (a JSON endpoint).
// Caches for 60s. Persists a GoldPrice row on each successful fetch.
//
// If the provider is unconfigured or unreachable, returns a Persian
// error and the last known stale price (if any). NEVER fabricates live
// prices.
// =====================================================================
import { db } from "@/lib/db";
import { cache } from "@/lib/security/cache";
import { assertSafeOutboundUrl } from "@/lib/security/net-guard";
import { pinnedFetchJson } from "@/lib/security/http";

export type GoldInstrument = "18k" | "emami" | "bahar_azadi" | "ounce";

export interface GoldPriceResult {
  ok: boolean;
  instrument: GoldInstrument;
  priceRials: number | null;
  priceRialsFa?: string;
  fetchedAt?: string;
  source?: string;
  stalePriceRials?: number | null;
  errorFa?: string;
}

const TTL_MS = 60_000; // 60s

const INSTRUMENT_FA: Record<GoldInstrument, string> = {
  "18k": "طلای ۱۸ عیار",
  emami: "سکه امامی",
  bahar_azadi: "سکه بهار آزادی",
  ounce: "انس طلا",
};

export function instrumentFa(i: GoldInstrument): string {
  return INSTRUMENT_FA[i] ?? i;
}

/**
 * Returns the latest price for the given instrument.
 * Falls back to stale (last known) price when the provider is unreachable.
 */
export async function getGoldPrice(instrument: GoldInstrument): Promise<GoldPriceResult> {
  const cacheKey = `gold:price:${instrument}`;
  const cached = await cache.get<GoldPriceResult>(cacheKey);
  if (cached) return cached;

  const url = process.env.POSTYAR_GOLD_PROVIDER_URL ?? "";
  if (!url) {
    const stale = await getLastKnown(instrument);
    return {
      ok: false,
      instrument,
      priceRials: null,
      stalePriceRials: stale,
      errorFa: "داده‌های طلا در حال حاضر در دسترس نیست.",
    };
  }

  // P0.14 — the provider URL is admin/environment-configured; it still goes
  // through the egress guard (https-only, public IPs, safe ports) and a
  // bounded response read so neither an internal address nor an oversized
  // body can be abused.
  // C-06: pinnedFetchJson validates AND pins the connection to the
  // validated address (SNI keeps TLS tied to the real hostname), so a
  // rebinding DNS answer cannot re-point an approved URL at an internal
  // target between validation and connect.
  const parsed = await pinnedFetchJson<unknown>(url, {
    method: "GET",
    timeoutMs: 8_000,
    maxBytes: 512 * 1024,
    allowedPorts: [443],
  });
  if (!parsed.ok) {
    const stale = await getLastKnown(instrument);
    return {
      ok: false,
      instrument,
      priceRials: null,
      stalePriceRials: stale,
      errorFa: "ارتباط با ارائه‌دهنده داده طلا برقرار نشد.",
    };
  }
  const payload: unknown = parsed.data;

  // Expect: { data: { "18k": 12345678, emami: ..., ounce: ... } } OR flat
  // { "18k": rials, ... } OR { items: [{ instrument, priceRials }] }.
  const extracted = extractPrice(payload, instrument);
  if (!extracted || !Number.isFinite(extracted.priceRials) || extracted.priceRials <= 0) {
    const stale = await getLastKnown(instrument);
    return {
      ok: false,
      instrument,
      priceRials: null,
      stalePriceRials: stale,
      errorFa: "داده طلا در فرمت نامعتبر دریافت شد.",
    };
  }

  // Persist
  const now = new Date();
  try {
    await db.goldPrice.create({
      data: {
        instrument,
        priceRials: Math.floor(extracted.priceRials),
        fetchedAt: now,
        source: extracted.source ?? "provider",
      },
    });
  } catch {
    // best-effort persistence — don't fail the call
  }

  const result: GoldPriceResult = {
    ok: true,
    instrument,
    priceRials: Math.floor(extracted.priceRials),
    priceRialsFa: formatRials(extracted.priceRials),
    fetchedAt: now.toISOString(),
    source: extracted.source ?? "provider",
  };
  await cache.set(cacheKey, result, TTL_MS);
  return result;
}

/**
 * Returns the latest successfully-fetched price for each instrument.
 */
export async function getAllGoldPrices(): Promise<Record<GoldInstrument, GoldPriceResult>> {
  const instruments: GoldInstrument[] = ["18k", "emami", "bahar_azadi", "ounce"];
  const entries = await Promise.all(instruments.map((i) => getGoldPrice(i)));
  return {
    "18k": entries[0],
    emami: entries[1],
    bahar_azadi: entries[2],
    ounce: entries[3],
  };
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
async function getLastKnown(instrument: GoldInstrument): Promise<number | null> {
  const row = await db.goldPrice.findFirst({
    where: { instrument },
    orderBy: { fetchedAt: "desc" },
  });
  return row?.priceRials ?? null;
}

function extractPrice(payload: unknown, instrument: GoldInstrument): { priceRials: number; source?: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  // Try several shapes.
  // Shape A: { data: { "18k": rials, ... } }
  // Shape B: { "18k": rials, ... }
  // Shape C: { items: [{ instrument: "18k", priceRials: 1234 }] }
  // Shape D: nested under "gold": { "18k": ... }
  const candidates: unknown[] = [p.data, p.gold, p, p.items, p.result];
  for (const c of candidates) {
    if (!c) continue;
    if (Array.isArray(c)) {
      // Shape C
      for (const item of c) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        const ii = obj.instrument ?? obj.code ?? obj.id;
        if (typeof ii === "string" && ii === instrument) {
          const v = obj.priceRials ?? obj.price ?? obj.value;
          if (typeof v === "number") return { priceRials: v, source: "provider" };
          if (typeof v === "string") {
            const n = Number(v.replace(/[^\d.-]/g, ""));
            if (Number.isFinite(n)) return { priceRials: n, source: "provider" };
          }
        }
      }
      continue;
    }
    if (typeof c === "object") {
      const obj = c as Record<string, unknown>;
      const v = obj[instrument];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        return { priceRials: v, source: "provider" };
      }
      if (typeof v === "string") {
        const n = Number(v.replace(/[^\d.-]/g, ""));
        if (Number.isFinite(n) && n > 0) return { priceRials: n, source: "provider" };
      }
      if (v && typeof v === "object") {
        const vo = v as Record<string, unknown>;
        const p2 = vo.priceRials ?? vo.price ?? vo.value ?? vo.current;
        if (typeof p2 === "number" && Number.isFinite(p2) && p2 > 0) {
          return { priceRials: p2, source: "provider" };
        }
      }
    }
  }
  return null;
}

function formatRials(n: number): string {
  return new Intl.NumberFormat("fa-IR").format(Math.floor(n)) + " ریال";
}
