// =====================================================================
// POSTYAR — outbound URL guard (SSRF protection, audit §27)
// ---------------------------------------------------------------------
// User- and admin-supplied URLs are fetched server-side (WooCommerce
// store URL, gold price endpoint, ...). Without a guard this is an SSRF
// primitive: internal hosts, loopback services, cloud metadata endpoints
// and private-network ports can be probed, and connection/timeout
// differences leak an error oracle.
//
// assertSafeOutboundUrl():
//   * enforces the https scheme (plaintext http to arbitrary hosts is
//     also a credential-leak channel),
//   * rejects embedded userinfo, non-standard ports and fragments,
//   * resolves EVERY DNS address (A + AAAA) and rejects loopback,
//     RFC1918, link-local (incl. 169.254.169.254), ULA, broadcast,
//     IPv4-mapped IPv6 and the "this network" range,
//   * is fail-closed: any resolution/parse error rejects the fetch.
// =====================================================================
import dns from "node:dns/promises";
import net from "node:net";

export class UnsafeOutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeOutboundUrlError";
  }
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) return true;
  const [a, b] = parts as [number, number, number, number];
  void b;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && parts[1] === 254) return true; // link-local / cloud metadata
  if (a === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // private
  if (a === 192 && parts[1] === 168) return true; // private
  if (a === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const addr = net.isIPv6(ip) ? ip : null;
  if (!addr) return true;
  const lower = addr.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd")) return true; // link-local / ULA
  if (lower.startsWith("ff")) return true; // multicast
  // IPv4-mapped / IPv4-compatible (::ffff:10.0.0.5 etc.)
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && mapped[1]) return isPrivateIPv4(mapped[1]);
  return false;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  return isPrivateIPv6(ip);
}

/**
 * Throw UnsafeOutboundUrlError when `ip` points at a protected range.
 * Exported so the pinned fetcher (http.ts) can re-validate every resolved
 * address at connect time (C-06 — DNS-rebinding defense).
 */
export function assertPublicIp(ip: string): void {
  if (!isPrivateIp(ip)) return;
  throw new UnsafeOutboundUrlError("آدرس به شبکه داخلی اشاره می‌کند و مجاز نیست.");
}

/**
 * Validate an outbound URL and return its origin (scheme://host[:port]).
 * Throws UnsafeOutboundUrlError when the URL must not be fetched.
 */
export async function assertSafeOutboundUrl(
  rawUrl: string,
  opts: { allowHttp?: boolean; allowedPorts?: number[] } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeOutboundUrlError("آدرس واردشده معتبر نیست.");
  }
  const schemeOk = url.protocol === "https:" || (opts.allowHttp === true && url.protocol === "http:");
  if (!schemeOk) {
    throw new UnsafeOutboundUrlError("تنها آدرس‌های https مجاز هستند.");
  }
  if (url.username || url.password) {
    throw new UnsafeOutboundUrlError("آدرس نباید شامل نام کاربری یا رمز باشد.");
  }
  if (url.hash) {
    throw new UnsafeOutboundUrlError("آدرس نباید شامل fragment باشد.");
  }
  const port = url.port ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
  const allowed = opts.allowedPorts ?? (url.protocol === "https:" ? [443] : [80]);
  if (!Number.isFinite(port) || !allowed.includes(port)) {
    throw new UnsafeOutboundUrlError("پورت آدرس مجاز نیست.");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // Literal IPs are checked directly; hostnames are resolved so a DNS
  // name pointing at an internal address is caught too. The pinned fetch
  // helper (pinnedFetchJson in security/http.ts) connects to one of these
  // validated addresses directly with SNI — closing the DNS-rebinding
  // TOCTOU window that a separate validate-then-fetch would leave open.
  const addresses = net.isIP(hostname)
    ? [hostname]
    : await dns.lookup(hostname, { all: true, verbatim: true }).catch(() => {
        throw new UnsafeOutboundUrlError("هاست آدرس قابل حل‌کردن نیست.");
      });
  for (const entry of addresses) {
    const ip = typeof entry === "string" ? entry : entry.address;
    assertPublicIp(ip);
  }
  return url;
}

/** Uniform Persian error for rejected URLs (no internal details leaked). */
export function outboundUrlErrorFa(err: unknown): string {
  if (err instanceof UnsafeOutboundUrlError) return err.message;
  return "آدرس مقصد مجاز نیست.";
}
