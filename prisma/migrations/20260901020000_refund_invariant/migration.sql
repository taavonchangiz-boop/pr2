-- C-03: database-enforced one-refund-per-order invariant.
-- The refund service previously relied on an application-level COUNT query,
-- which two concurrent refund requests could both pass. A UNIQUE nullable
-- column makes the invariant impossible to violate at the storage layer
-- (NULLs are distinct in both SQLite and MariaDB unique indexes, so rows
-- without an invariant key are unaffected).
-- Data preservation: existing refund rows (at most one per order by the
-- application check) are backfilled with their invariant key; if a legacy
-- database somehow holds multiple refund rows for one order, the backfill
-- keeps the EARLIEST row as the authoritative refund and deletes any
-- duplicates that would violate the new index (duplicates could only be
-- created through the pre-fix race and were never legitimate).
ALTER TABLE "LedgerEntry" ADD COLUMN "refundKey" TEXT;

UPDATE "LedgerEntry"
SET "refundKey" = 'refund:' || "orderId"
WHERE "eventType" = 'refund' AND "orderId" IS NOT NULL
  AND "id" = (
    SELECT "id" FROM "LedgerEntry" AS le
    WHERE le."eventType" = 'refund' AND le."orderId" = "LedgerEntry"."orderId"
    ORDER BY le."createdAt" ASC, le."id" ASC
    LIMIT 1
  );

DELETE FROM "LedgerEntry"
WHERE "eventType" = 'refund' AND "orderId" IS NOT NULL AND "refundKey" IS NULL;

CREATE UNIQUE INDEX "LedgerEntry_refundKey_key" ON "LedgerEntry"("refundKey");
