// =====================================================================
// POSTYAR — bounded outbound HTTP helper (P0.14 / P2.4)
// ---------------------------------------------------------------------
// Uniform wrapper for outbound provider/gateway calls:
//   * AbortController-based timeout (caller-configurable),
//   * redirects REJECTED (a redirect could re-point a validated URL at an
//     internal address after validation — the caller validated the original
//     destination only),
//   * response-size bound (Content-Length checked up-front; the body is
//     additionally read with a hard cap so a lying/chunked server cannot
//     over-commit memory),
//   * JSON parse with a bounded buffer.
//
// URL/network policy (https-only, private-range rejection, port policy)
// lives in `net-guard.ts` and is applied by callers BEFORE fetching.
// =====================================================================

export class ResponseTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponseTooLargeError";
  }
}

export type BoundedFetchResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; status?: number; errorFa: string; errorText?: string };

export interface BoundedFetchOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB

/**
 * Perform a bounded fetch + JSON parse. Never throws for HTTP/protocol
 * failures — returns a typed envelope so call-sites convert directly to
 * Persian error messages.
 */
export async function fetchJsonWithLimit<T>(
  url: string,
  opts: BoundedFetchOptions = {},
): Promise<BoundedFetchResult<T>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(opts.headers ?? {}),
      },
      body: opts.body,
      signal: controller.signal,
      // Never follow redirects — a validated destination must not be
      // re-pointed at an internal address after validation (SSRF).
      redirect: "error",
    });
  } catch {
    clearTimeout(timer);
    return { ok: false, errorFa: "اتصال به سرویس خارجی ناموفق بود." };
  }
  clearTimeout(timer);

  if (!res.ok) {
    return { ok: false, status: res.status, errorFa: "سرویس خارجی پاسخ نامعتبر بازگرداند." };
  }

  const declaredLength = Number.parseInt(res.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, status: res.status, errorFa: "حجم پاسخ سرویس خارجی بیش از حد مجاز است." };
  }

  let text: string;
  try {
    text = await readBodyWithCap(res, maxBytes);
  } catch {
    return { ok: false, status: res.status, errorFa: "خواندن پاسخ سرویس خارجی ناموفق بود." };
  }

  try {
    const data = JSON.parse(text) as T;
    return { ok: true, data, status: res.status };
  } catch {
    return { ok: false, status: res.status, errorFa: "پاسخ سرویس خارجی قابل تجزیه نیست." };
  }
}

/** Read a response body with a hard byte cap (stream-aware). */
async function readBodyWithCap(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No stream — fall back to text() (the Content-Length check above
    // already bounded this path).
    return res.text();
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError("response body exceeds limit");
      }
      chunks.push(value);
    }
  }
  const parts = chunks.map((c) => Buffer.from(c));
  return Buffer.concat(parts).toString("utf8");
}

// =====================================================================
// C-06 — DNS-PINNED outbound fetch for user/admin-configurable URLs
// ---------------------------------------------------------------------
// assertSafeOutboundUrl() resolves DNS and rejects protected ranges, but
// a separate fetch() would resolve DNS a SECOND time — a rebinding
// attacker can return a public address to the validator and a private
// address to the fetch. pinnedFetchJson() closes that TOCTOU window:
//
//   1. URL policy via assertSafeOutboundUrl (scheme/port/userinfo).
//   2. Resolve ALL A/AAAA records and re-validate every address with
//      assertPublicIp (fail-closed on any resolver error).
//   3. Connect with node:https DIRECTLY to the validated IP while
//      keeping SNI (`servername`) and the Host header on the original
//      hostname — so TLS certificate validation still applies to the
//      real hostname. The socket can therefore only reach the exact
//      address that was validated; a rebind between validation and
//      connection is impossible.
//   4. No redirects (a 3xx is an error, same policy as fetchJsonWithLimit),
//      hard timeout, hard response-size cap, JSON-only.
// =====================================================================
import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import { assertSafeOutboundUrl, assertPublicIp, UnsafeOutboundUrlError } from "./net-guard";

export interface PinnedFetchOptions extends BoundedFetchOptions {
  /** Port allowlist (default [443]; the URL policy enforces https). */
  allowedPorts?: number[];
}

export async function pinnedFetchJson<T>(
  rawUrl: string,
  opts: PinnedFetchOptions = {},
): Promise<BoundedFetchResult<T>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const fail = (errorFa: string): BoundedFetchResult<T> => ({ ok: false, errorFa });

  // 1) URL policy (https-only, port/userinfo/fragment rules, DNS scan).
  try {
    await assertSafeOutboundUrl(rawUrl, { allowedPorts: opts.allowedPorts ?? [443] });
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) return fail("آدرس مقصد مجاز نیست.");
    return fail("آدرس مقصد مجاز نیست.");
  }

  let url: URL;
  try { url = new URL(rawUrl); } catch { return fail("آدرس مقصد مجاز نیست."); }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = url.port ? Number.parseInt(url.port, 10) : 443;

  // 2) Resolve + re-validate every address (the addresses we may pin to).
  let addresses: string[];
  if (net.isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      const entries = await dns.lookup(hostname, { all: true, verbatim: true });
      addresses = entries.map((e) => e.address);
    } catch {
      return fail("هاست آدرس قابل حل‌کردن نیست.");
    }
  }
  try {
    for (const ip of addresses) assertPublicIp(ip);
  } catch {
    return fail("آدرس به شبکه داخلی اشاره می‌کند و مجاز نیست.");
  }
  if (addresses.length === 0) return fail("هاست آدرس قابل حل‌کردن نیست.");
  const pinned = addresses[0] as string;

  // 3) Connect to the pinned IP; SNI + cert validation use the hostname.
  return new Promise<BoundedFetchResult<T>>((resolve) => {
    let settled = false;
    const done = (r: BoundedFetchResult<T>) => {
      if (!settled) { settled = true; resolve(r); }
    };
    let req: ReturnType<typeof https.request>;
    try {
      req = https.request(
        {
          host: pinned,
          port,
          path: `${url.pathname}${url.search}`,
          method: opts.method ?? "GET",
          servername: hostname, // SNI + certificate name check
          headers: {
            host: url.host,
            accept: "application/json",
            ...(opts.headers ?? {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          // Redirects are refused: a 3xx would re-point the request after
          // validation (fetchJsonWithLimit parity via redirect:"error").
          if (status < 200 || status >= 300) {
            // Consume a SMALL bounded slice of the error body so callers
            // can surface the remote service's own message (the target is
            // already pinned to a public, policy-approved host — this is
            // not an internal-target oracle).
            const errChunks: Buffer[] = [];
            let errReceived = 0;
            res.on("data", (c: Buffer) => {
              errReceived += c.length;
              if (errReceived <= 2048) errChunks.push(c);
              if (errReceived > 2048) res.destroy();
            });
            res.on("end", () => {
              const text = Buffer.concat(errChunks).toString("utf8").slice(0, 512);
              done({ ok: false, status, errorFa: "سرویس خارجی پاسخ نامعتبر بازگرداند.", errorText: text });
            });
            res.on("error", () => done({ ok: false, status, errorFa: "سرویس خارجی پاسخ نامعتبر بازگرداند." }));
            return;
          }
          const declared = Number.parseInt(res.headers["content-length"] ?? "", 10);
          if (Number.isFinite(declared) && declared > maxBytes) {
            res.destroy();
            done({ ok: false, status, errorFa: "حجم پاسخ سرویس خارجی بیش از حد مجاز است." });
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          res.on("data", (c: Buffer) => {
            received += c.length;
            if (received > maxBytes) {
              res.destroy();
              done({ ok: false, status, errorFa: "حجم پاسخ سرویس خارجی بیش از حد مجاز است." });
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            try {
              done({ ok: true, data: JSON.parse(text) as T, status });
            } catch {
              done({ ok: false, status, errorFa: "پاسخ سرویس خارجی قابل تجزیه نیست." });
            }
          });
          res.on("error", () => done({ ok: false, status, errorFa: "خواندن پاسخ سرویس خارجی ناموفق بود." }));
        },
      );
    } catch {
      done(fail("اتصال به سرویس خارجی ناموفق بود."));
      return;
    }
    // Socket inactivity timeout AND a hard total deadline: a slow-drip
    // responder can otherwise keep a dead connection alive forever inside
    // the inactivity window.
    const totalTimer = setTimeout(() => {
      req.destroy();
      done({ ok: false, errorFa: "اتصال به سرویس خارجی ناموفق بود." });
    }, timeoutMs + 1_000);
    req.on("close", () => clearTimeout(totalTimer));
    req.on("timeout", () => {
      req.destroy();
      done({ ok: false, errorFa: "اتصال به سرویس خارجی ناموفق بود." });
    });
    req.on("error", () => {
      done({ ok: false, errorFa: "اتصال به سرویس خارجی ناموفق بود." });
    });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
