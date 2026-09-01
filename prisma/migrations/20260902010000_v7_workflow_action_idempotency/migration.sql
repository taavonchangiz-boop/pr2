-- V7 static hardening: workflow-version binding and deterministic action/outbound idempotency.
ALTER TABLE "BotWorkflowRun" ADD COLUMN "workflowVersion" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "operationKey" TEXT;
ALTER TABLE "Notification" ADD COLUMN "operationKey" TEXT;
ALTER TABLE "BotHistory" ADD COLUMN "operationKey" TEXT;

CREATE UNIQUE INDEX "Ticket_operationKey_key" ON "Ticket"("operationKey");
CREATE UNIQUE INDEX "Notification_operationKey_key" ON "Notification"("operationKey");
CREATE UNIQUE INDEX "BotHistory_operationKey_key" ON "BotHistory"("operationKey");
