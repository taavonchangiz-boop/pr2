-- V4 repair batch: C-01/C-02 execution-result contract, H-01 per-workflow
-- lease, H-02 durable retry backoff, H-03 explicit truncation marker,
-- H-04 DB-idempotent inbound history, H-06 O(1) wallet checkpoint read.
-- Additive only — no data loss, no destructive change.

-- H-02: durable retry schedule (exponential backoff + jitter target).
ALTER TABLE "BotInboundEvent" ADD COLUMN "nextRetryAt" DATETIME;

-- H-03: explicit truncation marker (truncated payloads are never replayed).
ALTER TABLE "BotInboundEvent" ADD COLUMN "payloadTruncated" BOOLEAN NOT NULL DEFAULT false;

-- H-01: per-workflow execution lease.
ALTER TABLE "BotWorkflowRun" ADD COLUMN "leaseUntil" DATETIME;

-- H-04: tie inbound history to the durable event identity (UNIQUE).
ALTER TABLE "BotHistory" ADD COLUMN "inboundEventId" TEXT;
CREATE UNIQUE INDEX "BotHistory_inboundEventId_key" ON "BotHistory"("inboundEventId");

-- H-06: O(1) latest-checkpoint wallet balance lookup.
CREATE INDEX "WalletTxn_userId_id_idx" ON "WalletTxn"("userId", "id");
