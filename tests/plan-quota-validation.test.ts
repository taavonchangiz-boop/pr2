// =====================================================================
// POSTYAR — M-02 strict plan quota/feature validation tests
// ---------------------------------------------------------------------
// Proves the admin plan-write validation helpers:
//   * unknown quota dimensions are REJECTED (never silently persisted);
//   * non-finite / non-numeric quota values are rejected;
//   * stored representation is normalized: negative → UNLIMITED_QUOTA
//     (-1), positive floored to an integer, 0 = disabled;
//   * unknown FEATURE keys are detected so the routes can return 400
//     instead of silently dropping typo'd keys.
// =====================================================================
import { describe, test, expect } from "bun:test";
import { parsePlanQuota, findUnknownFeatureKeys, UNLIMITED_QUOTA } from "../src/lib/payments/plans";

describe("M-02 — parsePlanQuota", () => {
  test("known dimensions with finite numbers pass through normalized", () => {
    const r = parsePlanQuota({ publishPerMonth: 10.9, aiPerMonth: 5, channels: 0, automation: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.quota.publishPerMonth).toBe(10); // floored
      expect(r.quota.aiPerMonth).toBe(5);
      expect(r.quota.channels).toBe(0); // 0 = disabled
      expect(r.quota.automation).toBe(3);
    }
  });

  test("negative values normalize to the UNLIMITED_QUOTA sentinel", () => {
    const r = parsePlanQuota({ publishPerMonth: -7 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.quota.publishPerMonth).toBe(UNLIMITED_QUOTA);
  });

  test("unknown dimensions are REJECTED", () => {
    expect(parsePlanQuota({ publshPerMonth: 5 }).ok).toBe(false);
    expect(parsePlanQuota({ evilKey: 1 }).ok).toBe(false);
  });

  test("non-finite numbers are REJECTED", () => {
    expect(parsePlanQuota({ publishPerMonth: Number.NaN }).ok).toBe(false);
    expect(parsePlanQuota({ publishPerMonth: Number.POSITIVE_INFINITY }).ok).toBe(false);
  });

  test("non-numeric types are REJECTED", () => {
    expect(parsePlanQuota({ publishPerMonth: true }).ok).toBe(false);
    expect(parsePlanQuota({ publishPerMonth: { a: 1 } }).ok).toBe(false);
  });

  test("numeric strings parse (defensive for legacy clients)", () => {
    const r = parsePlanQuota({ aiPerMonth: "12" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.quota.aiPerMonth).toBe(12);
  });

  test("raw JSON strings are accepted", () => {
    const r = parsePlanQuota('{"publishPerMonth": 4}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.quota.publishPerMonth).toBe(4);
  });

  test("an empty quota object is valid", () => {
    const r = parsePlanQuota({});
    expect(r.ok).toBe(true);
  });
});

describe("M-02 — findUnknownFeatureKeys", () => {
  test("typo'd feature keys are detected", () => {
    expect(findUnknownFeatureKeys({ publsh: true })).toEqual(["publsh"]);
    expect(
      findUnknownFeatureKeys({ publish: true, walllet: 5, goldd: false }).sort(),
    ).toEqual(["goldd", "walllet"]);
  });

  test("known catalog keys produce no unknowns", () => {
    expect(
      findUnknownFeatureKeys({
        publish: true, workflow: false, goldMonitor: true,
        publishPerMonth: 10, workflowSteps: -1,
      }),
    ).toEqual([]);
  });

  test("an empty feature object produces no unknowns", () => {
    expect(findUnknownFeatureKeys({})).toEqual([]);
  });
});
