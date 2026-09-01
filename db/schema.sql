-- Hand-derived, EXECUTED-AND-VALIDATED SQL translation of prisma/schema.prisma.
--
-- WHY THIS FILE EXISTS: this sandbox has no outbound npm registry access, so `prisma`
-- itself cannot be installed here, and `npx prisma migrate dev` / `npx prisma validate`
-- could not be run against the real schema (see the README's long-standing caveat on
-- this). Rather than leave the schema entirely unverified, this file is a careful,
-- by-hand translation of every model, enum, relation, index, and default in
-- prisma/schema.prisma into the Postgres DDL Prisma would generate — and it HAS been
-- run against a real, running PostgreSQL 16 instance (see db/validate.sql for the
-- representative-data exercise that ran against it), which is what actually catches a
-- bad column type, a missing index, or an illegal relation — not another read-through.
--
-- THIS FILE IS NOT A REPLACEMENT FOR PRISMA. Once real `npx prisma` access exists,
-- `prisma/schema.prisma` remains the source of truth: run `npx prisma migrate dev`
-- from it as normal, and treat PRISMA'S generated SQL as canonical, not this file.
-- This file's job was narrower and already done: prove the relational design itself
-- is sound (valid foreign keys, no illegal cycles, sensible cascade behavior, works
-- against representative inserts) before more gets built on top of it. Do not let this
-- file and prisma/schema.prisma drift apart silently — if you change one, update the
-- other, and re-run db/validate.sql to prove it still holds together.
--
-- ID GENERATION NOTE: `@default(cuid())` in Prisma is a CLIENT-side default (Prisma
-- Client generates the id value in application code before the INSERT), not a
-- database-level default — so, faithfully, none of the id columns below have a SQL
-- DEFAULT. db/validate.sql supplies explicit id values for every insert, exactly as
-- Prisma Client would.
--
-- CASCADE BEHAVIOR NOTE: every foreign key below is RESTRICT on delete, chosen
-- deliberately rather than left to guess at Prisma's own implicit default — a platform
-- whose entire premise is a permanent, auditable financial/tax record should never
-- silently cascade-delete that record because someone deleted an Entity or an
-- Instrument. Deleting anything with dependent rows should fail loudly and require an
-- explicit decision, not happen as a side effect.

BEGIN;

-- =============================================================================
-- ENUMS
-- =============================================================================
CREATE TYPE "StakeholderType" AS ENUM ('INVESTOR', 'DEBT_HOLDER', 'EMPLOYEE', 'ADVISOR', 'ENTITY_HOLDER');
CREATE TYPE "InstrumentType" AS ENUM ('STOCK_OPTION', 'RSU', 'SAR', 'WARRANT', 'CONVERTIBLE_NOTE', 'TERM_LOAN', 'REVOLVER', 'PIK_NOTE', 'PREFERRED_STOCK', 'COMMON_STOCK', 'RESTRICTED_STOCK');
CREATE TYPE "InstrumentStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'CONVERTED', 'EXERCISED', 'REPAID', 'EXTINGUISHED');
CREATE TYPE "CorrectionElection" AS ENUM ('PROSPECTIVE', 'RETROSPECTIVE');
CREATE TYPE "EntityRole" AS ENUM ('OWNER', 'EDITOR', 'VIEWER');

-- =============================================================================
-- User / EntityAccess (multi-tenancy — see prisma/schema.prisma's design note #4)
-- Created before Entity below since EntityAccess has a FK into it, and User has no
-- dependency on anything else in this file.
-- =============================================================================
CREATE TABLE "User" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  "passwordHash" TEXT NOT NULL,
  -- "Log out everywhere" counter (v0.20.0) — see prisma/schema.prisma's doc comment on
  -- this column and src/lib/auth/session.ts for the full design.
  "sessionVersion" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Entity
-- =============================================================================
CREATE TABLE "Entity" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "reportingCurrency" TEXT NOT NULL DEFAULT 'USD',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- EntityAccess — who can reach this Entity, and at what role. RESTRICT on both FKs
-- like everywhere else in this file: deleting a User or an Entity that still has
-- EntityAccess rows must fail loudly, not silently strip someone's access or orphan a
-- grant.
-- =============================================================================
CREATE TABLE "EntityAccess" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "entityId" TEXT NOT NULL REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "role" "EntityRole" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("userId", "entityId")
);
CREATE INDEX "EntityAccess_entityId_idx" ON "EntityAccess"("entityId");

-- =============================================================================
-- Stakeholder
-- =============================================================================
CREATE TABLE "Stakeholder" (
  "id" TEXT PRIMARY KEY,
  "entityId" TEXT NOT NULL REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "type" "StakeholderType" NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "address" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Stakeholder_entityId_idx" ON "Stakeholder"("entityId");

-- =============================================================================
-- Instrument
-- =============================================================================
CREATE TABLE "Instrument" (
  "id" TEXT PRIMARY KEY,
  "entityId" TEXT NOT NULL REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "stakeholderId" TEXT NOT NULL REFERENCES "Stakeholder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "type" "InstrumentType" NOT NULL,
  "status" "InstrumentStatus" NOT NULL DEFAULT 'ACTIVE',
  "issueDate" TIMESTAMP(3) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Instrument_entityId_idx" ON "Instrument"("entityId");
CREATE INDEX "Instrument_stakeholderId_idx" ON "Instrument"("stakeholderId");

-- =============================================================================
-- InstrumentTermVersion (append-only — see prisma/schema.prisma's design note #2;
-- enforced by application code in modificationEngine.ts, not by a DB constraint, the
-- same way Postgres can't enforce "never call UPDATE on this table" on its own)
-- =============================================================================
CREATE TABLE "InstrumentTermVersion" (
  "id" TEXT PRIMARY KEY,
  "instrumentId" TEXT NOT NULL REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "effectiveDate" TIMESTAMP(3) NOT NULL,
  "label" TEXT NOT NULL,
  "terms" JSONB NOT NULL,
  -- Added v0.19.0 for the audit-trail report (src/lib/accounting/auditTrail.ts) — who
  -- recorded this version. Nullable forever: pre-migration rows have nothing to
  -- backfill from, and a direct-SQL insert can still legitimately skip it. No ON
  -- DELETE behavior beyond Postgres's default (NO ACTION) — see the matching note on
  -- Correction."createdByUserId" below.
  "createdByUserId" TEXT REFERENCES "User"("id"),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "InstrumentTermVersion_instrumentId_effectiveDate_idx" ON "InstrumentTermVersion"("instrumentId", "effectiveDate");

-- =============================================================================
-- Correction (created before ScheduleEntry/JournalEntry below, since both of those
-- have nullable FKs pointing at it)
-- =============================================================================
CREATE TABLE "Correction" (
  "id" TEXT PRIMARY KEY,
  "instrumentId" TEXT NOT NULL REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "discoveredDate" TIMESTAMP(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "election" "CorrectionElection" NOT NULL,
  "previewSnapshot" JSONB NOT NULL,
  -- Same v0.19.0 addition and nullability reasoning as
  -- InstrumentTermVersion."createdByUserId" above — who committed this correction.
  "createdByUserId" TEXT REFERENCES "User"("id"),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Correction_instrumentId_idx" ON "Correction"("instrumentId");

-- =============================================================================
-- ScheduleEntry
-- =============================================================================
CREATE TABLE "ScheduleEntry" (
  "id" TEXT PRIMARY KEY,
  "instrumentId" TEXT NOT NULL REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "label" TEXT NOT NULL,
  "amount" NUMERIC(18,4) NOT NULL,
  "endingBalance" NUMERIC(18,4),
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "ascReference" TEXT,
  "termVersionLabel" TEXT,
  "meta" JSONB,
  "supersededByCorrectionId" TEXT REFERENCES "Correction"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdByCorrectionId" TEXT REFERENCES "Correction"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ScheduleEntry_instrumentId_periodEnd_idx" ON "ScheduleEntry"("instrumentId", "periodEnd");
CREATE INDEX "ScheduleEntry_supersededByCorrectionId_idx" ON "ScheduleEntry"("supersededByCorrectionId");
CREATE INDEX "ScheduleEntry_createdByCorrectionId_idx" ON "ScheduleEntry"("createdByCorrectionId");

-- =============================================================================
-- JournalEntry
-- =============================================================================
CREATE TABLE "JournalEntry" (
  "id" TEXT PRIMARY KEY,
  "instrumentId" TEXT REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "date" TIMESTAMP(3) NOT NULL,
  "description" TEXT NOT NULL,
  "ascReference" TEXT,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "supersededByCorrectionId" TEXT REFERENCES "Correction"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdByCorrectionId" TEXT REFERENCES "Correction"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "JournalEntry_instrumentId_date_idx" ON "JournalEntry"("instrumentId", "date");
CREATE INDEX "JournalEntry_supersededByCorrectionId_idx" ON "JournalEntry"("supersededByCorrectionId");
CREATE INDEX "JournalEntry_createdByCorrectionId_idx" ON "JournalEntry"("createdByCorrectionId");

-- =============================================================================
-- JournalLine
-- =============================================================================
CREATE TABLE "JournalLine" (
  "id" TEXT PRIMARY KEY,
  "journalEntryId" TEXT NOT NULL REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "account" TEXT NOT NULL,
  "debit" NUMERIC(18,4),
  "credit" NUMERIC(18,4),
  "memo" TEXT
);
CREATE INDEX "JournalLine_journalEntryId_idx" ON "JournalLine"("journalEntryId");

-- =============================================================================
-- Document / DocumentVersion
-- =============================================================================
CREATE TABLE "Document" (
  "id" TEXT PRIMARY KEY,
  "entityId" TEXT NOT NULL REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "instrumentId" TEXT REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "title" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Document_entityId_idx" ON "Document"("entityId");
CREATE INDEX "Document_instrumentId_idx" ON "Document"("instrumentId");

CREATE TABLE "DocumentVersion" (
  "id" TEXT PRIMARY KEY,
  "documentId" TEXT NOT NULL REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "versionNumber" INTEGER NOT NULL,
  "storageUrl" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("documentId", "versionNumber")
);

COMMIT;
