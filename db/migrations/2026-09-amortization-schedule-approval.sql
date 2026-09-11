-- Run this ONCE against your already-live Supabase database (SQL Editor -> paste ->
-- Run) — it adds the two new tables the v0.22.0 "approved amortization schedule"
-- feature needs. Same two CREATE TABLE statements now folded into db/schema.sql for
-- anyone setting up a brand-new database from scratch — see that file's comment right
-- above the matching lines, and prisma/schema.prisma's doc comment on
-- AmortizationScheduleApproval, for the full reasoning.
--
-- Safe to run alongside (before or after) db/migrations/2026-09-add-default-entity.sql
-- — these two migrations don't touch each other.
CREATE TABLE "AmortizationScheduleApproval" (
  "id" TEXT PRIMARY KEY,
  "instrumentId" TEXT NOT NULL REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sourceTermVersionId" TEXT NOT NULL REFERENCES "InstrumentTermVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "approvedByUserId" TEXT REFERENCES "User"("id"),
  "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AmortizationScheduleApproval_instrumentId_idx" ON "AmortizationScheduleApproval"("instrumentId");

CREATE TABLE "AmortizationScheduleRow" (
  "id" TEXT PRIMARY KEY,
  "approvalId" TEXT NOT NULL REFERENCES "AmortizationScheduleApproval"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "label" TEXT NOT NULL,
  "amount" NUMERIC(18,4) NOT NULL,
  "endingBalance" NUMERIC(18,4),
  "currency" TEXT NOT NULL DEFAULT 'USD'
);
CREATE INDEX "AmortizationScheduleRow_approvalId_periodEnd_idx" ON "AmortizationScheduleRow"("approvalId", "periodEnd");
