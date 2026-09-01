-- V5 repair: lease ownership (fencing), per-workflow resume cursor and
-- the durable OUTBOUND delivery state machine.
-- Additive only — existing rows keep their semantics (lockedBy NULL,
-- deliveryStatus NULL = legacy rows without delivery tracking).

-- V5 C-03: lease owners for the event inbox and per-workflow runs.
ALTER TABLE "BotInboundEvent" ADD COLUMN "lockedBy" TEXT;
ALTER TABLE "BotWorkflowRun" ADD COLUMN "lockedBy" TEXT;

-- V5 H-04: per-step resume cursor so a workflow retry resumes from the
-- interrupted step instead of re-sending every already-delivered step.
ALTER TABLE "BotWorkflowRun" ADD COLUMN "cursorJson" TEXT;

-- V5 H-04: durable outbound delivery states (pending|sent|failed|uncertain)
-- written BEFORE the provider send; a successful send followed by a crash
-- leaves an auditable `pending` row instead of a silently lost history row.
ALTER TABLE "BotHistory" ADD COLUMN "deliveryStatus" TEXT;
ALTER TABLE "BotHistory" ADD COLUMN "providerMessageId" TEXT;
ALTER TABLE "BotHistory" ADD COLUMN "workflowId" TEXT;
ALTER TABLE "BotHistory" ADD COLUMN "stepId" TEXT;

-- Deterministic lookup of a step's durable outbound message fate.
CREATE INDEX "BotHistory_botId_workflowId_stepId_idx" ON "BotHistory"("botId", "workflowId", "stepId");
