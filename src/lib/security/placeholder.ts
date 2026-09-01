// =====================================================================
// POSTYAR — placeholder-credential detection (V4 M-10)
// ---------------------------------------------------------------------
// Values copied verbatim from .env.example (REPLACE_*, example.com hosts,
// <angle-bracket> templates) are NEVER valid production credentials.
// Treating them as "configured" caused preview/dev environments to issue
// real outbound requests to SMS/bank providers with garbage credentials.
// Every provider config resolver that gates an OUTBOUND side effect must
// use this helper alongside its null/empty checks.
// =====================================================================

/** Detects placeholder/template credential values copied from templates. */
export function isPlaceholderSecret(v: string | undefined | null): boolean {
  if (!v) return false;
  const s = v.trim();
  if (!s) return false;
  if (/^replace[_-]/i.test(s)) return true; // REPLACE_WITH_…, REPLACE_…
  if (/^(change)?me$/i.test(s) || /^changeme$/i.test(s)) return true;
  if (/^<.*>$/.test(s)) return true; // <YOUR_API_KEY>
  if (/^(your|dummy|sample|placeholder)[_-]/i.test(s)) return true;
  // Template hosts from .env.example (bank-gateway.example.com etc.)
  if (/(^|\.)example\.(com|net|org|ir)(\/|:|$)/i.test(s)) return true;
  return false;
}
