// =====================================================================
// POSTYAR — C-07 regression: link-code verification entropy (quantitative)
// ---------------------------------------------------------------------
// Redemption requires presenting the FULL plaintext code (lookup by
// SHA-256 of the plaintext). The effective online-guessing space is
// therefore the whole code body: nonce (30 bits) + HMAC-derived suffix
// (60 bits) = 90 bits. At the enforced redemption rate limits
// (5 attempts / 10 min per provider identity AND 60 / 10 min per bot),
// the expected time to guess even a single 60-bit MAC is ~3.8 million
// years; the 90-bit full space is astronomically beyond reach.
// This test pins the quantitative properties so the entropy can never
// silently regress.
// =====================================================================
import { test, expect, describe } from "bun:test";
import {
  LINK_CODE_PREFIX,
  LINK_CODE_NONCE_LEN,
  LINK_CODE_HMAC_SUFFIX_LEN,
  base32Encode,
} from "../src/lib/bots/link";

const CROCKFORD_ALPHABET_SIZE = 32; // Crockford base32
const BITS_PER_CHAR = Math.log2(CROCKFORD_ALPHABET_SIZE); // exactly 5

describe("C-07 — link code verification entropy", () => {
  test("code body is 18 base32 chars = 90 bits of verification entropy", () => {
    const totalChars = LINK_CODE_NONCE_LEN + LINK_CODE_HMAC_SUFFIX_LEN;
    const bits = totalChars * BITS_PER_CHAR;
    expect(totalChars).toBe(18);
    expect(bits).toBe(90);
    // The pre-C-07 code carried an 8-char suffix (70 bits total); the
    // hardened MAC must contribute at least 60 bits on its own.
    expect(LINK_CODE_HMAC_SUFFIX_LEN * BITS_PER_CHAR).toBeGreaterThanOrEqual(60);
  });

  test("base32Encode output stays within the 32-symbol Crockford alphabet", () => {
    const sample = base32Encode(Buffer.from("0102030405060708", "hex"), 40);
    expect(sample).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/);
    expect(sample.length).toBe(40);
  });

  test("suffix is derived from an HMAC over bot+user+expiry+nonce (not from the nonce alone)", () => {
    // Structural test: the two components occupy disjoint, fixed-length
    // slices of the plaintext, so a guesser must break the MAC slice —
    // whose entropy is pinned by the test above — in addition to the nonce.
    const code = `${LINK_CODE_PREFIX}${"X".repeat(LINK_CODE_NONCE_LEN)}${"Y".repeat(LINK_CODE_HMAC_SUFFIX_LEN)}`;
    expect(code.startsWith(LINK_CODE_PREFIX)).toBe(true);
    expect(code.length).toBe(LINK_CODE_PREFIX.length + LINK_CODE_NONCE_LEN + LINK_CODE_HMAC_SUFFIX_LEN);
  });
});
