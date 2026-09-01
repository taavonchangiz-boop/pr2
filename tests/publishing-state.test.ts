// =====================================================================
// POSTYAR — Publishing state machine test suite
// Covers addendum §9 (PUBLISHING tests): invalid transitions rejected,
// cancelled jobs cannot be published, terminal states enforced.
// Pure-function tests — no DB required.
// Env vars are set by tests/preload.ts (see bunfig.toml).
// =====================================================================
import { test, expect, describe } from "bun:test";
import {
  assertTransition,
  InvalidTransition,
  nextStates,
  isTerminal,
  isContentStatus,
} from "../src/lib/publishing/state";

describe("publishing state machine: valid transitions", () => {
  test("draft → scheduled", () => {
    expect(() => assertTransition("draft", "scheduled")).not.toThrow();
  });
  test("draft → queued", () => {
    expect(() => assertTransition("draft", "queued")).not.toThrow();
  });
  test("draft → cancelled", () => {
    expect(() => assertTransition("draft", "cancelled")).not.toThrow();
  });
  test("scheduled → queued", () => {
    expect(() => assertTransition("scheduled", "queued")).not.toThrow();
  });
  test("scheduled → cancelled", () => {
    expect(() => assertTransition("scheduled", "cancelled")).not.toThrow();
  });
  test("queued → processing", () => {
    expect(() => assertTransition("queued", "processing")).not.toThrow();
  });
  test("queued → cancelled", () => {
    expect(() => assertTransition("queued", "cancelled")).not.toThrow();
  });
  test("processing → delivered", () => {
    expect(() => assertTransition("processing", "delivered")).not.toThrow();
  });
  test("processing → failed", () => {
    expect(() => assertTransition("processing", "failed")).not.toThrow();
  });
  test("failed → queued (retry)", () => {
    expect(() => assertTransition("failed", "queued")).not.toThrow();
  });
});

// =====================================================================
// V5 H-16 — `partial` outcome (mixed delivery truth). Strengthened in
// Task 9-c: partial is a real content status with its own edges.
// =====================================================================
describe("publishing state machine: partial outcome (V5 H-16)", () => {
  test("processing → partial", () => {
    expect(() => assertTransition("processing", "partial")).not.toThrow();
  });
  test("partial → queued (retry path)", () => {
    expect(() => assertTransition("partial", "queued")).not.toThrow();
  });
  test("partial → cancelled", () => {
    expect(() => assertTransition("partial", "cancelled")).not.toThrow();
  });
  test("delivered → partial is rejected", () => {
    expect(() => assertTransition("delivered", "partial")).toThrow(InvalidTransition);
  });
  test("cancelled → partial is rejected", () => {
    expect(() => assertTransition("cancelled", "partial")).toThrow(InvalidTransition);
  });
  test("partial → delivered is rejected (must go through queued → processing)", () => {
    expect(() => assertTransition("partial", "delivered")).toThrow(InvalidTransition);
  });
  test("partial → failed is rejected (partial already encodes the mixed truth)", () => {
    expect(() => assertTransition("partial", "failed")).toThrow(InvalidTransition);
  });
  test("partial → scheduled is rejected (same as failed)", () => {
    expect(() => assertTransition("partial", "scheduled")).toThrow(InvalidTransition);
  });
  test("partial → processing is rejected (must go through queued)", () => {
    expect(() => assertTransition("partial", "processing")).toThrow(InvalidTransition);
  });
  test("nextStates(partial) = [queued, cancelled]", () => {
    expect(nextStates("partial")).toEqual(["queued", "cancelled"]);
  });
  test("partial is NOT terminal (re-schedulable like failed)", () => {
    expect(isTerminal("partial")).toBe(false);
  });
  test("isContentStatus accepts partial", () => {
    expect(isContentStatus("partial")).toBe(true);
  });
});

describe("publishing state machine: INVALID transitions (rejected)", () => {
  const invalidCases: Array<[string, string]> = [
    ["delivered", "processing"],   // cannot re-publish delivered
    ["delivered", "queued"],        // cannot re-queue delivered
    ["cancelled", "queued"],        // CANCELLED jobs cannot be published
    ["cancelled", "processing"],    // cannot resume cancelled
    ["scheduled", "processing"],   // must go through queued first
    ["draft", "delivered"],         // cannot skip queue
    ["queued", "delivered"],        // cannot skip processing
    ["processing", "queued"],       // cannot revert from processing to queued
  ];
  for (const [from, to] of invalidCases) {
    test(`${from} → ${to} throws InvalidTransition`, () => {
      try {
        assertTransition(from as never, to as never);
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidTransition);
        expect((e as Error).message).toContain("انتقال وضعیت نامعتبر");
      }
    });
  }
});

describe("publishing state machine: terminal states", () => {
  test("delivered is terminal", () => {
    expect(isTerminal("delivered")).toBe(true);
    expect(nextStates("delivered")).toEqual([]);
  });
  test("cancelled is terminal", () => {
    expect(isTerminal("cancelled")).toBe(true);
    expect(nextStates("cancelled")).toEqual([]);
  });
  test("draft is NOT terminal", () => {
    expect(isTerminal("draft")).toBe(false);
  });
  test("queued is NOT terminal", () => {
    expect(isTerminal("queued")).toBe(false);
  });
});

describe("publishing state machine: type guard", () => {
  test("accepts valid status strings", () => {
    expect(isContentStatus("draft")).toBe(true);
    expect(isContentStatus("delivered")).toBe(true);
    expect(isContentStatus("cancelled")).toBe(true);
  });
  test("rejects invalid status strings", () => {
    expect(isContentStatus("published")).toBe(false); // not in the enum
    expect(isContentStatus("PUBLISHED")).toBe(false);
    expect(isContentStatus("")).toBe(false);
    expect(isContentStatus("random")).toBe(false);
  });
});
