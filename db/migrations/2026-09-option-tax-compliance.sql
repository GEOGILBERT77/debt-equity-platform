-- Run this ONCE against your already-live Supabase database (SQL Editor -> paste ->
-- Run). It adds everything the v0.33.0 "stock option tax/compliance reporting"
-- feature needs: two new nullable columns on tables you already have, two new enums,
-- and three new tables. Nothing here touches or renames an existing column, and every
-- new column is nullable, so this is safe to run against a database with real data in
-- it already — every existing row just gets NULLs in the new columns until you fill
-- them in.
--
-- These are the exact same statements now folded into db/schema.sql for anyone
-- setting up a brand-new database from scratch — see that file's comments right above
-- each matching block, and prisma/schema.prisma's doc comments on Entity.
-- employerIdentificationNumber, Stakeholder.taxIdNumber, OptionExerciseEvent,
-- ShareDispositionEvent, and TaxFilingRecord, for the full reasoning behind each one.
--
-- Safe to run alongside (before or after) db/migrations/2026-09-add-default-entity.sql
-- and db/migrations/2026-09-amortization-schedule-approval.sql — none of these
-- migrations touch each other.
--
-- SECURITY — READ BEFORE POPULATING "taxIdNumber" WITH REAL DATA: that column stores a
-- government tax-ID number (an individual's SSN, or an entity's EIN) as PLAIN TEXT.
-- Before this column is actually populated with real stakeholder data, add field-level
-- encryption at rest (e.g. pgcrypto's pgp_sym_encrypt/decrypt, or application-layer
-- encryption before the value ever reaches this database) and restrict which
-- roles/endpoints can read it back in full. This migration deliberately does NOT
-- implement that — it's a deployment/infra decision (which KMS, which access-control
-- layer) that belongs to whoever operates this database, not something to guess at
-- here. Do not go live with real SSNs in this column as shipped.

ALTER TABLE "Entity" ADD COLUMN "employerIdentificationNumber" TEXT;
ALTER TABLE "Entity" ADD COLUMN "address" TEXT;

ALTER TABLE "Stakeholder" ADD COLUMN "taxIdNumber" TEXT;

CREATE TYPE "TaxFilingType" AS ENUM ('FORM_3921', 'W2_NSO_EXERCISE_INCOME', 'W2_ISO_DISQUALIFYING_DISPOSITION', 'ELECTION_83B_DEADLINE');
CREATE TYPE "TaxFilingStatus" AS ENUM ('PENDING', 'FILED', 'NOT_REQUIRED');

CREATE TABLE "OptionExerciseEvent" (
  "id" TEXT PRIMARY KEY,
  "instrumentId" TEXT NOT NULL REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "exerciseDate" TIMESTAMP(3) NOT NULL,
  "quantityExercised" NUMERIC(24,6) NOT NULL,
  "exercisePricePerShare" NUMERIC(24,6) NOT NULL,
  "fairMarketValuePerShareAtExercise" NUMERIC(24,6) NOT NULL,
  "recordedByUserId" TEXT REFERENCES "User"("id"),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "OptionExerciseEvent_instrumentId_idx" ON "OptionExerciseEvent"("instrumentId");
CREATE INDEX "OptionExerciseEvent_exerciseDate_idx" ON "OptionExerciseEvent"("exerciseDate");

CREATE TABLE "ShareDispositionEvent" (
  "id" TEXT PRIMARY KEY,
  "exerciseEventId" TEXT NOT NULL REFERENCES "OptionExerciseEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "dispositionDate" TIMESTAMP(3) NOT NULL,
  "quantitySold" NUMERIC(24,6) NOT NULL,
  "salePricePerShare" NUMERIC(24,6) NOT NULL,
  "recordedByUserId" TEXT REFERENCES "User"("id"),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ShareDispositionEvent_exerciseEventId_idx" ON "ShareDispositionEvent"("exerciseEventId");

CREATE TABLE "TaxFilingRecord" (
  "id" TEXT PRIMARY KEY,
  "entityId" TEXT NOT NULL REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "filingType" "TaxFilingType" NOT NULL,
  "taxYear" INTEGER NOT NULL,
  "exerciseEventId" TEXT REFERENCES "OptionExerciseEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "instrumentId" TEXT REFERENCES "Instrument"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "status" "TaxFilingStatus" NOT NULL DEFAULT 'PENDING',
  "filedDate" TIMESTAMP(3),
  "filedByUserId" TEXT REFERENCES "User"("id"),
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "TaxFilingRecord_entityId_idx" ON "TaxFilingRecord"("entityId");
CREATE INDEX "TaxFilingRecord_exerciseEventId_idx" ON "TaxFilingRecord"("exerciseEventId");
CREATE INDEX "TaxFilingRecord_instrumentId_idx" ON "TaxFilingRecord"("instrumentId");
-- Two PARTIAL unique indexes, not one combined UNIQUE(...) — see db/schema.sql's
-- comment right above the matching lines for why (standard SQL NULL-is-never-equal-
-- to-NULL semantics would otherwise let duplicate rows through).
CREATE UNIQUE INDEX "TaxFilingRecord_exercise_dedupe_idx" ON "TaxFilingRecord" ("entityId", "filingType", "taxYear", "exerciseEventId") WHERE "exerciseEventId" IS NOT NULL;
CREATE UNIQUE INDEX "TaxFilingRecord_instrument_dedupe_idx" ON "TaxFilingRecord" ("entityId", "filingType", "taxYear", "instrumentId") WHERE "instrumentId" IS NOT NULL;
