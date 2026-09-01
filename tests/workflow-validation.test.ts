// =====================================================================
// POSTYAR — Workflow graph validation + button URL hardening (P1.1/P1.2)
// ---------------------------------------------------------------------
// Invariants:
//   * dangling nextStepId / thenStepId / elseStepId references are
//     REJECTED (they previously silently truncated the walk);
//   * duplicate start nodes are rejected; a start node is required;
//   * cycles are rejected at validation time (the runtime visited-guard
//     silently truncated execution before);
//   * per-kind action config is validated;
//   * button URLs accept ONLY https (javascript:/data:/http:/control
//     characters rejected) and callbackData is bounded/printable;
//   * a fully valid workflow passes.
// =====================================================================
import { test, expect, describe } from "bun:test";
import { validateWorkflowDef, type WorkflowStep } from "../src/lib/bots/workflow";

function baseSteps(): WorkflowStep[] {
  return [
    { id: "s1", type: "start" },
    { id: "m1", type: "message", text: "سلام! به پُست‌یار خوش آمدید." },
    { id: "end1", type: "end" },
  ];
}

describe("workflow graph validation (P1.1)", () => {
  test("a valid linear workflow passes", async () => {
    const steps = baseSteps();
    steps[0]!.nextStepId = "m1";
    steps[1]!.nextStepId = "end1";
    const r = await validateWorkflowDef(steps);
    expect(r.ok).toBe(true);
    expect(r.def?.steps.length).toBe(3);
  });

  test("dangling nextStepId is rejected", async () => {
    const steps = baseSteps();
    steps[0]!.nextStepId = "does-not-exist";
    expect((await validateWorkflowDef(steps)).ok).toBe(false);
  });

  test("dangling condition branch targets are rejected", async () => {
    const steps: WorkflowStep[] = [
      { id: "s1", type: "start" },
      {
        id: "c1",
        type: "condition",
        condition: { kind: "referral", thenStepId: "missing-true", elseStepId: "end1" },
      },
      { id: "end1", type: "end" },
    ];
    expect((await validateWorkflowDef(steps)).ok).toBe(false);

    const steps2: WorkflowStep[] = [
      { id: "s1", type: "start" },
      {
        id: "c1",
        type: "condition",
        condition: { kind: "referral", thenStepId: "end1", elseStepId: "missing-false" },
      },
      { id: "end1", type: "end" },
    ];
    expect((await validateWorkflowDef(steps2)).ok).toBe(false);
  });

  test("valid condition branches pass", async () => {
    const steps: WorkflowStep[] = [
      { id: "s1", type: "start" },
      {
        id: "c1",
        type: "condition",
        condition: { kind: "referral", thenStepId: "m1", elseStepId: "end1" },
      },
      { id: "m1", type: "message", text: "معرفی کنید!" },
      { id: "end1", type: "end" },
    ];
    expect((await validateWorkflowDef(steps)).ok).toBe(true);
  });

  test("missing start is rejected; multiple starts are rejected", async () => {
    const noStart: WorkflowStep[] = [
      { id: "m1", type: "message", text: "سلام" },
    ];
    expect((await validateWorkflowDef(noStart)).ok).toBe(false);

    const twoStarts: WorkflowStep[] = [
      { id: "s1", type: "start" },
      { id: "s2", type: "start" },
    ];
    expect((await validateWorkflowDef(twoStarts)).ok).toBe(false);
  });

  test("cycles are rejected at validation time", async () => {
    const steps: WorkflowStep[] = [
      { id: "s1", type: "start", nextStepId: "m1" },
      { id: "m1", type: "message", text: "سلام", nextStepId: "a1" },
      { id: "a1", type: "action", action: { kind: "send_message", config: { text: "x" }, nextStepId: "m1" } },
    ];
    const r = await validateWorkflowDef(steps);
    expect(r.ok).toBe(false);
    expect(r.errorFa).toContain("حلقه");
  });

  test("dangling action nextStepId is rejected", async () => {
    const steps: WorkflowStep[] = [
      { id: "s1", type: "start", nextStepId: "a1" },
      { id: "a1", type: "action", action: { kind: "send_message", config: { text: "سلام" }, nextStepId: "ghost" } },
    ];
    expect((await validateWorkflowDef(steps)).ok).toBe(false);
  });

  test("per-kind action config: send_message without text rejected", async () => {
    const steps: WorkflowStep[] = [
      { id: "s1", type: "start", nextStepId: "a1" },
      { id: "a1", type: "action", action: { kind: "send_message", config: { text: "  " } } },
    ];
    expect((await validateWorkflowDef(steps)).ok).toBe(false);
  });

  test("per-kind action config: initiate_payment without planCode rejected", async () => {
    const steps: WorkflowStep[] = [
      { id: "s1", type: "start", nextStepId: "a1" },
      { id: "a1", type: "action", action: { kind: "initiate_payment", config: {} } },
    ];
    expect((await validateWorkflowDef(steps)).ok).toBe(false);
  });

  test("unsafe button URLs are rejected inside send_message config (P1.2)", async () => {
    const cases = [
      { label: "x", url: "javascript:alert(1)" },
      { label: "x", url: "data:text/html;base64,PHNjcmlwdD4=" },
      { label: "x", url: "http://insecure.example.com" },
      { label: "x", url: "https://ok.example.com/path\n Evil" },
      { label: "x", url: "https://ok.example.com", callbackData: "has space" },
    ];
    for (const btn of cases) {
      const steps: WorkflowStep[] = [
        { id: "s1", type: "start", nextStepId: "a1" },
        {
          id: "a1",
          type: "action",
          action: { kind: "send_message", config: { text: "سلام", buttons: [btn] } },
        },
      ];
      expect((await validateWorkflowDef(steps)).ok).toBe(false);
    }
  });

  test("safe https buttons pass", async () => {
    const steps: WorkflowStep[] = [
      { id: "s1", type: "start", nextStepId: "a1" },
      {
        id: "a1",
        type: "action",
        action: {
          kind: "send_message",
          config: {
            text: "سلام",
            buttons: [
              { label: "سایت", url: "https://example.com/go" },
              { label: "اکشن", callbackData: "action_12" },
            ],
          },
        },
      },
    ];
    expect((await validateWorkflowDef(steps)).ok).toBe(true);
  });

  test("button without url or callbackData is rejected", async () => {
    const steps: WorkflowStep[] = [
      { id: "s1", type: "start", nextStepId: "a1" },
      {
        id: "a1",
        type: "action",
        action: { kind: "send_message", config: { text: "سلام", buttons: [{ label: "بدون مقصد" }] } },
      },
    ];
    expect((await validateWorkflowDef(steps)).ok).toBe(false);
  });

  // ------------------------------------------------------------------
  // V5 H-13 — save-time bounds that the runtime previously clamped
  // silently: button count, button label length, referenced ids.
  // ------------------------------------------------------------------
  test("more than 20 buttons is rejected at save (was silently clamped at runtime)", async () => {
    const buttons = Array.from({ length: 21 }, (_, i) => ({
      label: `دکمه ${i + 1}`,
      callbackData: `cb_${i}`,
    }));
    const steps: WorkflowStep[] = [
      { id: "s1", type: "start", nextStepId: "a1" },
      {
        id: "a1",
        type: "action",
        action: { kind: "send_message", config: { text: "سلام", buttons } },
      },
    ];
    const r = await validateWorkflowDef(steps);
    expect(r.ok).toBe(false);
    expect(r.errorFa).toContain("دکمه");

    // 20 buttons exactly pass.
    const okSteps: WorkflowStep[] = [
      { id: "s1", type: "start", nextStepId: "a1" },
      {
        id: "a1",
        type: "action",
        action: {
          kind: "send_message",
          config: { text: "سلام", buttons: buttons.slice(0, 20) },
        },
      },
    ];
    expect((await validateWorkflowDef(okSteps)).ok).toBe(true);
  });

  test("button label longer than 64 chars is rejected at save (was clamped at runtime)", async () => {
    const steps: WorkflowStep[] = [
      { id: "s1", type: "start", nextStepId: "a1" },
      {
        id: "a1",
        type: "action",
        action: {
          kind: "send_message",
          config: {
            text: "سلام",
            buttons: [{ label: "ل".repeat(65), callbackData: "cb_1" }],
          },
        },
      },
    ];
    const r = await validateWorkflowDef(steps);
    expect(r.ok).toBe(false);
    expect(r.errorFa).toContain("برچسب");

    // A 64-char label passes; a longer label made shorter ONLY by control
    // characters (which the runtime cleans) also passes.
    const okSteps: WorkflowStep[] = [
      { id: "s1", type: "start", nextStepId: "a1" },
      {
        id: "a1",
        type: "action",
        action: {
          kind: "send_message",
          config: {
            text: "سلام",
            buttons: [{ label: "ل".repeat(64), callbackData: "cb_1" }],
          },
        },
      },
    ];
    expect((await validateWorkflowDef(okSteps)).ok).toBe(true);
  });

  test("show_order.orderId / send_content.contentId are bounded to 64 chars, no control chars", async () => {
    const longId = "x".repeat(65);
    const controlCharId = "abc\n123";
    const cases: Array<{ kind: "show_order" | "send_content"; field: "orderId" | "contentId"; value: string }> = [
      { kind: "show_order", field: "orderId", value: longId },
      { kind: "show_order", field: "orderId", value: controlCharId },
      { kind: "send_content", field: "contentId", value: longId },
      { kind: "send_content", field: "contentId", value: controlCharId },
    ];
    for (const c of cases) {
      const steps: WorkflowStep[] = [
        { id: "s1", type: "start", nextStepId: "a1" },
        {
          id: "a1",
          type: "action",
          action: { kind: c.kind, config: { [c.field]: c.value } },
        },
      ];
      expect((await validateWorkflowDef(steps)).ok).toBe(false);
    }
    // A bounded id passes the structural check (existence/ownership is a
    // runtime concern).
    const okSteps: WorkflowStep[] = [
      { id: "s1", type: "start", nextStepId: "a1" },
      { id: "a1", type: "action", action: { kind: "show_order", config: { orderId: "x".repeat(64) } } },
    ];
    expect((await validateWorkflowDef(okSteps)).ok).toBe(true);
  });
});
