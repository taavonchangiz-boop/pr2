-- AlterTable
ALTER TABLE "PublishJob" ADD COLUMN "deliveryAttemptedAt" DATETIME;

-- CreateTable
CREATE TABLE "BotInboundEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "botId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" DATETIME,
    "lastError" TEXT,
    "payload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    CONSTRAINT "BotInboundEvent_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BotWorkflowRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BotWorkflowRun_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "BotInboundEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BotWorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "BotWorkflow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BotInboundEvent_botId_status_leaseUntil_idx" ON "BotInboundEvent"("botId", "status", "leaseUntil");

-- CreateIndex
CREATE INDEX "BotInboundEvent_botId_updatedAt_idx" ON "BotInboundEvent"("botId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BotInboundEvent_botId_provider_externalEventId_key" ON "BotInboundEvent"("botId", "provider", "externalEventId");

-- CreateIndex
CREATE INDEX "BotWorkflowRun_workflowId_idx" ON "BotWorkflowRun"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "BotWorkflowRun_eventId_workflowId_key" ON "BotWorkflowRun"("eventId", "workflowId");
