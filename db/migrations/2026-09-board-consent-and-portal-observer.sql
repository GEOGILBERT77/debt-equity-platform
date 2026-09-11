-- Run this ONCE against your already-live Supabase database (SQL Editor -> paste ->
-- Run). It adds everything v0.36.0's "board approval / consent record-keeping" and
-- "board member portal observer" features need: two new columns on existing tables,
-- one new enum, and two new tables. Nothing here renames or removes anything, and the
-- two new columns are both NOT NULL with a DEFAULT FALSE, so this is safe to run
-- against a database with real data in it already — every existing row picks up
-- `FALSE` for both new columns automatically, and nothing changes behavior until you
-- start marking specific access grants as board-observer or recording consents.
--
-- These are the exact same statements now folded into db/schema.sql for anyone
-- setting up a brand-new database from scratch — see that file's comments right above
-- the matching block, and prisma/schema.prisma's doc comments on BoardConsent and
-- StakeholderAccess.boardObserver for the full design reasoning (in short: BoardConsent
-- is a governance/audit record, NOT a workflow gate — it is read by nothing in the
-- accounting engine, cap table rollup, or close workflow; board-observer access is a
-- boolean flag rather than a new StakeholderType, to avoid touching every place that
-- already branches on StakeholderType).
--
-- Safe to run alongside (before or after) db/migrations/2026-09-add-default-entity.sql,
-- db/migrations/2026-09-amortization-schedule-approval.sql,
-- db/migrations/2026-09-option-tax-compliance.sql, and
-- db/migrations/2026-09-stakeholder-portal.sql — none of these migrations touch each
-- other. This migration DOES depend on the tables created by
-- 2026-09-stakeholder-portal.sql ("StakeholderAccess", "PortalInvite") already
-- existing — run that one first if you haven't already.

ALTER TABLE "StakeholderAccess" ADD COLUMN "boardObserver" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "PortalInvite" ADD COLUMN "grantsBoardObserverAccess" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TYPE "BoardConsentType" AS ENUM ('WRITTEN_CONSENT', 'BOARD_MEETING');

CREATE TABLE "BoardConsent" (
  "id" TEXT PRIMARY KEY,
  "entityId" TEXT NOT NULL REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "consentType" "BoardConsentType" NOT NULL,
  "decisionDate" TIMESTAMP(3) NOT NULL,
  "createdByUserId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "BoardConsent_entityId_idx" ON "BoardConsent"("entityId");

CREATE TABLE "BoardConsentInstrument" (
  "id" TEXT PRIMARY KEY,
  "boardConsentId" TEXT NOT NULL REFERENCES "BoardConsent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "instrumentId" TEXT NOT NULL REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("boardConsentId", "instrumentId")
);
CREATE INDEX "BoardConsentInstrument_instrumentId_idx" ON "BoardConsentInstrument"("instrumentId");
