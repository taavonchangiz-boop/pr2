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
  test("a valid linear workflow passes", () => {
    const steps = baseSteps();
    steps[0]!.nextStepId = "m1";
    steps[1]!.nextStepId = "end1";
    const r = validateWorkflowDef(steps);
    expect(r.ok).toBe(true);
    expect(r.def?.steps.length).toBe(3);
  });

  test("dangling nextStepId is rejected", () => {
    const steps = baseSteps();
    steps[0]!.nextStepId = "does-not-exist";
    expect(validateWorkflowDef(steps).ok).toBe(false);
  });

  test("dangling condition branch targets are rejected", () => {
    const steps: WorkflowStep[] = [
      { id: "s1", type: "start" },
      {
        id: "c1",
        type: "condition",
        condition: { kind: "referral", thenStepId: "missing-true", elseStepId: "end1" },
      },
      { id: "end1", type: "end" },
    ];
    expect(validateWorkflowDef(steps).ok).toBe(false);

    const steps2: WorkflowStep[] = [
      { id: "s1", type: "start" },
      {
        id: "c1",
        type: "condition",
        condition: { kind: "referral", thenStepId: "end1", elseStepId: "missing-false" },
      },
      { id: "end1", type: "end" },
    ];
    expect(validateWorkflowDef(steps2).ok).toBe(false);
  });

  test("valid condition branches pass", () => {
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
    expect(validateWorkflowDef(steps).ok).toBe(true);
  });

  test("missing start is rejected; multiple starts are rejected", () => {
    const noStart: WorkflowStep[] = [
      { id: "m1", type: "message", text: "سلام" },
    ];
    expect(validateWorkflowDef(noStart).ok).toBe(false);

    const twoStarts: WorkflowStep[] = [
      { id: "s1", type: "start" },
      { id: "s2", type: "start" },
    ];
    expect(validateWorkflowDef(twoStarts).ok).toBe(false);
  });

  test("cycles are rejected at validation time", () => {
    const steps: WorkflowStep[] = [
      { id: "s1", type: "start", nextStepId: "m1" },
      { id: "m1", type: "message", text: "سلام", nextStepId: "a1" },
      { id: "a1", type: "action", action: { kind: "send_message", config: { text: "x" }, nextStepId: "m1" } },
    ];
    const r = validateWorkflowDef(steps);
    expect(r.ok).toBe(false);
    expect(r.errorFa).toContain("حلقه");
  });

  test("dangling action nextStepId is rejected", () => {
    const steps: WorkflowStep[] = [
      { id: "s1", type: "start", nextStepId: "a1" },
      { id: "a1", type: "action", action: { kind: "send_message", config: { text: "سلام" }, nextStepId: "ghost" } },
    ];
    expect(validateWorkflowDef(steps).ok).toBe(false);
  });

  test("per-kind action config: send_message without text rejected", () => {
    const steps: WorkflowStep[] = [
      { id: "s1", type: "start", nextStepId: "a1" },
      { id: "a1", type: "action", action: { kind: "send_message", config: { text: "  " } } },
    ];
    expect(validateWorkflowDef(steps).ok).toBe(false);
  });

  test("per-kind action config: initiate_payment without planCode rejected", () => {
    const steps: WorkflowStep[] = [
      { id: "s1", type: "start", nextStepId: "a1" },
      { id: "a1", type: "action", action: { kind: "initiate_payment", config: {} } },
    ];
    expect(validateWorkflowDef(steps).ok).toBe(false);
  });

  test("unsafe button URLs are rejected inside send_message config (P1.2)", () => {
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
      expect(validateWorkflowDef(steps).ok).toBe(false);
    }
  });

  test("safe https buttons pass", () => {
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
    expect(validateWorkflowDef(steps).ok).toBe(true);
  });

  test("button without url or callbackData is rejected", () => {
    const steps: WorkflowStep[] = [
      { id: "s1", type: "start", nextStepId: "a1" },
      {
        id: "a1",
        type: "action",
        action: { kind: "send_message", config: { text: "سلام", buttons: [{ label: "بدون مقصد" }] } },
      },
    ];
    expect(validateWorkflowDef(steps).ok).toBe(false);
  });
});
