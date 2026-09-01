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
  | { ok: false; status?: number; errorFa: string };

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
