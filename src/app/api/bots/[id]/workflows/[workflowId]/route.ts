// POSTYAR — /api/bots/[id]/workflows/[workflowId]
// PATCH: update name/enabled/steps/trigger. DELETE: soft delete.
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requireUser,
  clientIp,
  audit,
  AuthError,
  safeJsonParse,
} from "@/lib/server/auth";
import { requirePlanFeature, requireFeatureCapacity } from "@/lib/payments/plans";
import { validateWorkflowDef } from "@/lib/bots/workflow";

const PatchSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  enabled: z.boolean().optional(),
  steps: z.array(z.unknown()).optional(),
  triggerKind: z.enum(["message", "command", "callback"]).optional(),
  triggerValue: z.string().max(200).nullable().optional(),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; workflowId: string }> },
) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const { id, workflowId } = await params;
  const bot = await db.bot.findFirst({ where: { id, ownerId: user.id }, select: { id: true } });
  if (!bot) {
    return NextResponse.json({ errorFa: "ربات یافت نشد." }, { status: 404 });
  }
  const wf = await db.botWorkflow.findFirst({ where: { id: workflowId, botId: id } });
  if (!wf) {
    return NextResponse.json({ errorFa: "گردالشکار یافت نشد." }, { status: 404 });
  }
  return NextResponse.json({
    workflow: {
      id: wf.id,
      botId: wf.botId,
      name: wf.name,
      enabled: wf.enabled,
      steps: safeJsonParse<unknown>(wf.steps, []),
      triggerKind: wf.triggerKind,
      triggerValue: wf.triggerValue,
      createdAt: wf.createdAt.toISOString(),
      updatedAt: wf.updatedAt.toISOString(),
    },
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; workflowId: string }> },
) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  const { id, workflowId } = await params;
  const bot = await db.bot.findFirst({ where: { id, ownerId: user.id }, select: { id: true } });
  if (!bot) {
    return NextResponse.json({ errorFa: "ربات یافت نشد." }, { status: 404 });
  }
  const existing = await db.botWorkflow.findFirst({ where: { id: workflowId, botId: id } });
  if (!existing) {
    return NextResponse.json({ errorFa: "گردالشکار یافت نشد." }, { status: 404 });
  }
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ errorFa: "بدنه درخواست نامعتبر است." }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { errorFa: parsed.error.issues[0]?.message ?? "ورودی نامعتبر است." },
      { status: 400 },
    );
  }
  // M-4/L-3 — the plan cap must hold at UPDATE time too: a downgraded
  // owner cannot grow an existing workflow past their current
  // workflowSteps limit (creation-time checks alone are not authz).
  if (parsed.data.steps !== undefined) {
    try {
      await requirePlanFeature(user.id, "workflow");
      const stepCount = Array.isArray(parsed.data.steps) ? parsed.data.steps.length : 0;
      await requireFeatureCapacity(user.id, "workflow", "workflowSteps", stepCount, "گام‌های گردش کار");
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 403;
      const msg = e instanceof AuthError ? e.message : "امکان گردش کار در پلن فعلی شما فعال نیست.";
      return NextResponse.json({ errorFa: msg }, { status });
    }
  }
  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.enabled !== undefined) data.enabled = parsed.data.enabled;
  if (parsed.data.triggerKind !== undefined) data.triggerKind = parsed.data.triggerKind;
  if (parsed.data.triggerValue !== undefined) data.triggerValue = parsed.data.triggerValue;
  if (parsed.data.steps !== undefined) {
    const wfValidation = validateWorkflowDef(parsed.data.steps);
    if (!wfValidation.ok || !wfValidation.def) {
      return NextResponse.json(
        { errorFa: wfValidation.errorFa ?? "تعریف گردالشکار نامعتبر است." },
        { status: 400 },
      );
    }
    data.steps = JSON.stringify(wfValidation.def.steps);
  }
  const updated = await db.botWorkflow.update({
    where: { id: workflowId },
    data,
    select: {
      id: true,
      name: true,
      enabled: true,
      triggerKind: true,
      triggerValue: true,
      updatedAt: true,
    },
  });
  await audit({
    userId: user.id,
    actor: "user",
    action: "bot_workflow_updated",
    targetType: "bot_workflow",
    targetId: workflowId,
    ip,
    meta: { botId: id, fields: Object.keys(data) },
  });
  return NextResponse.json({ ok: true, workflow: updated });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; workflowId: string }> },
) {
  let user;
  try { user = await requireUser(); } catch (e) {
    return NextResponse.json({ errorFa: (e as AuthError).message }, { status: (e as AuthError).status });
  }
  const ip = clientIp(req);
  const { id, workflowId } = await params;
  const bot = await db.bot.findFirst({ where: { id, ownerId: user.id }, select: { id: true } });
  if (!bot) {
    return NextResponse.json({ errorFa: "ربات یافت نشد." }, { status: 404 });
  }
  // Soft delete — set enabled=false so the workflow stops running,
  // but the row stays for audit. The hard delete is admin-only via a
  // dedicated endpoint (not yet needed).
  const existing = await db.botWorkflow.findFirst({ where: { id: workflowId, botId: id } });
  if (!existing) {
    return NextResponse.json({ errorFa: "گردالشکار یافت نشد." }, { status: 404 });
  }
  await db.botWorkflow.update({
    where: { id: workflowId },
    data: { enabled: false },
  });
  await audit({
    userId: user.id,
    actor: "user",
    action: "bot_workflow_deleted_soft",
    targetType: "bot_workflow",
    targetId: workflowId,
    ip,
    meta: { botId: id },
  });
  return NextResponse.json({ ok: true, softDeleted: true });
}
