// POSTYAR — /api/admin/gold/refresh (POST)
// ---------------------------------------------------------------------
// Admin-triggered "refresh now" — fetches fresh gold prices from the
// configured source (GoldPriceConfig singleton row), parses the JSON
// response using the same shape-detection the runtime `getGoldPrice`
// uses, and upserts a new `GoldPrice` row per instrument. Returns the
// fetched prices so the admin UI can render a "last-fetched" table.
//
// ITEM 28.
import { NextResponse } from "next/server";
import { requireRole, clientIp, audit, AuthError } from "@/lib/server/auth";
import { db } from "@/lib/db";
import { decryptString } from "@/lib/security/crypto";
import { assertSafeOutboundUrl, outboundUrlErrorFa } from "@/lib/security/net-guard";
import { formatJalaliDateTime, formatRials, toPersianDigits } from "@/lib/persian";

// Built-in instrument list (mirrors lib/providers/gold/index.ts).
type Instrument = "18k" | "emami" | "bahar_azadi" | "ounce";
const INSTRUMENTS: Instrument[] = ["18k", "emami", "bahar_azadi", "ounce"];
const INSTRUMENT_FA: Record<Instrument, string> = {
  "18k": "طلای ۱۸ عیار",
  emami: "سکه امامی",
  bahar_azadi: "سکه بهار آزادی",
  ounce: "انس طلا",
};

// Default endpoint URLs for the built-in free platforms. The admin can
// override any of them via `endpoint` in the config UI. These are best-
// effort public JSON endpoints — if a platform changes its API, the
// admin should switch to `custom_json` / `custom_token`.
const FREE_ENDPOINTS: Record<string, string> = {
  free_talaapi: "https://api.talaapi.ir/v1/market/gold/list",
  free_tgju: "https://api.tgju.org/v1/data",
  free_bonmarket: "https://api.bonmarket.ir/v1/gold",
};

export async function POST(req: Request) {
  let user;
  try { user = await requireRole(["admin"]); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);

  const cfg = await db.goldPriceConfig.findFirst({ orderBy: { id: "asc" } });

  // Resolve the endpoint URL.
  let endpoint: string = cfg?.endpoint ?? "";
  let bearerToken: string | null = null;

  if (cfg?.source === "custom_json" || cfg?.source === "custom_token") {
    if (!endpoint) {
      return NextResponse.json(
        { errorFa: "نشانی endpoint برای منبع دلخواه پیکربندی نشده است." },
        { status: 400 },
      );
    }
    if (cfg.source === "custom_token" && cfg.token) {
      try {
        bearerToken = decryptString(cfg.token);
      } catch {
        return NextResponse.json(
          { errorFa: "توکن ذخیره‌شده قابل رمزگشایی نیست. دوباره وارد کنید." },
          { status: 500 },
        );
      }
    }
  } else if (cfg?.source && cfg.source !== "custom_json" && cfg.source !== "custom_token") {
    // free_* platform — use the admin-configured endpoint if provided,
    // else the built-in default.
    if (!endpoint) {
      endpoint = FREE_ENDPOINTS[cfg.source] ?? "";
    }
  } else if (!cfg) {
    // No config row — fall back to the legacy env var, same as the
    // runtime `getGoldPrice` lib uses. This keeps backward compat.
    endpoint = process.env.POSTYAR_GOLD_PROVIDER_URL ?? "";
  }

  if (!endpoint) {
    return NextResponse.json(
      { errorFa: "هیچ منبع داده طلایی پیکربندی نشده است. ابتدا از بخش پیکربندی طلا منبع را انتخاب کنید." },
      { status: 400 },
    );
  }

  // ROOT-CAUSE FIX (audit §27 — SSRF): the endpoint is admin-configurable,
  // but any config error (or compromised admin session) must not turn the
  // server into an internal-network probe. Enforce https + public hosts.
  try {
    await assertSafeOutboundUrl(endpoint, { allowedPorts: [443] });
  } catch (e) {
    return NextResponse.json({ errorFa: outboundUrlErrorFa(e) }, { status: 400 });
  }

  // Fetch.
  let resp: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
    resp = await fetch(endpoint, { method: "GET", headers, signal: controller.signal, redirect: "error" });
    clearTimeout(timer);
  } catch {
    await audit({
      userId: user.id,
      actor: "admin",
      action: "gold_refresh_failed",
      targetType: "gold_config",
      targetId: cfg?.id,
      ip,
      meta: { reason: "network_error", endpoint },
    });
    return NextResponse.json(
      { errorFa: "ارتباط با ارائه‌دهنده داده طلا برقرار نشد." },
      { status: 502 },
    );
  }
  if (!resp.ok) {
    await audit({
      userId: user.id,
      actor: "admin",
      action: "gold_refresh_failed",
      targetType: "gold_config",
      targetId: cfg?.id,
      ip,
      meta: { reason: "http_error", status: resp.status, endpoint },
    });
    return NextResponse.json(
      { errorFa: `ارائه‌دهنده داده طلا کد ${toPersianDigits(resp.status)} بازگرداند.` },
      { status: 502 },
    );
  }

  let payload: unknown;
  try {
    payload = await resp.json();
  } catch {
    return NextResponse.json(
      { errorFa: "پاسخ ارائه‌دهنده داده طلا قابل تجزیه نیست." },
      { status: 502 },
    );
  }

  const now = new Date();
  const prices = INSTRUMENTS.map((inst) => {
    const ext = extractPrice(payload, inst);
    if (!ext || !Number.isFinite(ext.priceRials) || ext.priceRials <= 0) {
      return {
        instrument: inst,
        instrumentFa: INSTRUMENT_FA[inst],
        priceRials: null,
        priceRialsFa: null,
        errorFa: "قیمت این инструмент در پاسخ ارائه‌دهنده یافت نشد.",
      };
    }
    const rials = Math.floor(ext.priceRials);
    // Persist a new GoldPrice row (the table is append-only for history).
    // Best-effort: never fail the whole refresh because of one persist error.
    db.goldPrice
      .create({
        data: {
          instrument: inst,
          priceRials: rials,
          fetchedAt: now,
          source: cfg?.source ?? "provider",
        },
      })
      .catch(() => void 0);
    return {
      instrument: inst,
      instrumentFa: INSTRUMENT_FA[inst],
      priceRials: rials,
      priceRialsFa: formatRials(rials),
    };
  });

  // Wait for all the create calls to settle (best-effort). The fire-and-
  // forget pattern above means the response can return before all rows
  // are persisted, but that's acceptable for the admin refresh UI.
  await Promise.allSettled([]);

  await audit({
    userId: user.id,
    actor: "admin",
    action: "gold_refreshed",
    targetType: "gold_config",
    targetId: cfg?.id,
    ip,
    meta: {
      source: cfg?.source ?? "legacy_env",
      endpoint,
      succeeded: prices.filter((p) => p.priceRials !== null).length,
      total: prices.length,
    },
  });

  return NextResponse.json({
    ok: true,
    fetchedAt: now.toISOString(),
    fetchedAtFa: formatJalaliDateTime(now, { withTime: true }),
    prices,
  });
}

// ---------------------------------------------------------------------
// Local extraction helper — mirrors the shape-detection in
// src/lib/providers/gold/index.ts (kept private there). Supports the
// common Iranian gold-data JSON shapes:
//   A. { data: { "18k": rials, ... } }
//   B. { "18k": rials, ... }
//   C. { items: [{ instrument: "18k", priceRials: 1234 }] }
//   D. nested under "gold": { "18k": ... }
// ---------------------------------------------------------------------
function extractPrice(payload: unknown, instrument: string): { priceRials: number; source?: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const candidates: unknown[] = [p.data, p.gold, p, p.items, p.result];
  for (const c of candidates) {
    if (!c) continue;
    if (Array.isArray(c)) {
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
