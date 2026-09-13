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
-- v0.33.0 — see prisma/schema.prisma's doc comments on these two enums and on
-- TaxFilingRecord for the full reasoning behind each value.
CREATE TYPE "TaxFilingType" AS ENUM ('FORM_3921', 'W2_NSO_EXERCISE_INCOME', 'W2_ISO_DISQUALIFYING_DISPOSITION', 'ELECTION_83B_DEADLINE');
CREATE TYPE "TaxFilingStatus" AS ENUM ('PENDING', 'FILED', 'NOT_REQUIRED');
-- v0.44.0 — see prisma/schema.prisma's doc comment on this enum and on
-- Stakeholder.investorType/contactName for the full reasoning ("Investor Contacts" page).
CREATE TYPE "InvestorType" AS ENUM ('INDIVIDUAL', 'INSTITUTION');

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
  -- v0.33.0 — the filer's own identification for tax/compliance filings this entity
  -- generates on its stakeholders' behalf (Form 3921's "Transferor corporation" name/
  -- address/EIN box). NULLABLE: every entity that exists before this feature does has
  -- neither, and optionTaxCompliance.ts refuses to assemble a Form 3921 (rather than
  -- silently leaving the EIN blank on a real tax document) when either is missing.
  "employerIdentificationNumber" TEXT,
  "address" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- v0.21.0 — "default entity" (see prisma/schema.prisma's doc comment on
-- User.defaultEntityId for why this exists). Added here via ALTER TABLE rather than as
-- a column on the CREATE TABLE "User" statement above, purely because "User" is
-- created before "Entity" exists in this file (EntityAccess needs User first) and this
-- column's foreign key needs "Entity" to already exist. ON DELETE SET NULL — the one
-- FK in this whole file that isn't RESTRICT, deliberately: losing your default because
-- that entity was deleted should degrade gracefully, not block the deletion.
--
-- IF YOUR DATABASE ALREADY EXISTS (i.e. you ran this file once already, before this
-- column was added): running the whole file again will fail on the earlier CREATE
-- TABLE statements ("relation already exists"). Instead, run ONLY this one statement
-- by itself against your live database — see db/migrations/2026-09-add-default-entity.sql,
-- which contains just this line for exactly that purpose (Supabase's SQL Editor is
-- where a user of this app would paste it).
ALTER TABLE "User" ADD COLUMN "defaultEntityId" TEXT REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
  -- v0.44.0 — see prisma/schema.prisma's doc comments on these two columns
  -- ("Investor Contacts" page). NULLABLE, and only meaningful for an
  -- INVESTOR/ENTITY_HOLDER row.
  "investorType" "InvestorType",
  "contactName" TEXT,
  -- v0.33.0 — SSN (individual) or EIN (a business ADVISOR/ENTITY_HOLDER) for tax/
  -- compliance filings generated on this stakeholder's behalf (Form 3921's recipient
  -- TIN box). NULLABLE for every stakeholder recorded before this existed.
  --
  -- SECURITY — READ BEFORE DEPLOYING: this column is a government tax-ID number
  -- stored as PLAIN TEXT, same as every other free-text column on this table. That is
  -- NOT an acceptable production posture for an SSN. Before this column is actually
  -- populated with real data outside a sandbox/demo, add field-level encryption at
  -- rest (e.g. pgcrypto's pgp_sym_encrypt/decrypt, or application-layer encryption
  -- before the value reaches this database at all) and restrict which roles/endpoints
  -- can read it back in full. This migration deliberately does NOT implement that —
  -- it's a deployment/infra decision (which KMS, which access-control layer) that
  -- belongs to whoever operates the real database, not something to guess at here.
  "taxIdNumber" TEXT,
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
-- PerformanceCondition / PerformanceConditionAssessment (v0.38.0) — see
-- prisma/schema.prisma's doc comment on PerformanceCondition for the full design.
-- Created here, before InstrumentTermVersion, purely so InstrumentTermVersion's own
-- nullable FK to "PerformanceCondition" below can reference an already-existing
-- table — neither of these two depends on InstrumentTermVersion.
-- =============================================================================
CREATE TABLE "PerformanceCondition" (
  "id" TEXT PRIMARY KEY,
  "entityId" TEXT NOT NULL REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "code" TEXT NOT NULL,
  "description" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("entityId", "code")
);

CREATE TABLE "PerformanceConditionAssessment" (
  "id" TEXT PRIMARY KEY,
  "performanceConditionId" TEXT NOT NULL REFERENCES "PerformanceCondition"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "effectiveDate" TIMESTAMP(3) NOT NULL,
  "probable" BOOLEAN NOT NULL,
  "note" TEXT,
  -- Nullable for the same reason InstrumentTermVersion."createdByUserId" below is.
  "createdByUserId" TEXT REFERENCES "User"("id"),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PerformanceConditionAssessment_conditionId_effectiveDate_idx" ON "PerformanceConditionAssessment"("performanceConditionId", "effectiveDate");

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
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- v0.38.0 — opts this term version into a shared PerformanceCondition instead of (or
  -- alongside, though it's only ever READ when set) its own inline
  -- "probabilityAssessments" inside "terms". See PerformanceCondition's doc comment.
  "performanceConditionId" TEXT REFERENCES "PerformanceCondition"("id") ON DELETE SET NULL ON UPDATE CASCADE
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

-- =============================================================================
-- AmortizationScheduleApproval / AmortizationScheduleRow (v0.22.0) — the full,
-- end-to-end, MONTHLY projected amortization table for one instrument, approved once
-- as the record of that grant's accounting treatment. See
-- prisma/schema.prisma's doc comment on AmortizationScheduleApproval for the full
-- reasoning, especially why this is deliberately separate from ScheduleEntry (a
-- projection saved at approval time vs. what's actually been recognized/booked as of
-- a real date).
-- =============================================================================
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

-- =============================================================================
-- OptionExerciseEvent / ShareDispositionEvent / TaxFilingRecord (v0.33.0) — stock
-- option tax/compliance reporting. See src/lib/accounting/optionTaxCompliance.ts and
-- prisma/schema.prisma's doc comments on each of these three models for the full
-- reasoning. Created here, after Instrument/User/Entity above, since all three of
-- these tables reference one of those.
-- =============================================================================
CREATE TABLE "OptionExerciseEvent" (
  "id" TEXT PRIMARY KEY,
  "instrumentId" TEXT NOT NULL REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "exerciseDate" TIMESTAMP(3) NOT NULL,
  "quantityExercised" NUMERIC(24,6) NOT NULL,
  "exercisePricePerShare" NUMERIC(24,6) NOT NULL,
  -- Fair market value per share ON THE EXERCISE DATE — drives the ISO bargain-element
  -- AMT preference (taxElections.ts's computeIsoExerciseAmtPreference) and Form 3921
  -- Box 4. NOT the same figure as InstrumentTermVersion's grant-date fair value.
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
  -- The calendar year the obligation pertains to (year of exercise/disposition for
  -- FORM_3921/W2_* — both annual filings even though the triggering event has a
  -- specific date within that year).
  "taxYear" INTEGER NOT NULL,
  "exerciseEventId" TEXT REFERENCES "OptionExerciseEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  -- ELECTION_83B_DEADLINE traces back to the GRANT itself (a RESTRICTED_STOCK
  -- instrument's issue/transfer date starts the 30-day clock) — there's no exercise
  -- involved. NULL for every other filingType. Two ELECTION_83B_DEADLINE rows for the
  -- same entity/year but different instruments (exerciseEventId NULL on both) do NOT
  -- collide on the UNIQUE constraint below — standard SQL NULL-is-never-equal-to-NULL
  -- semantics, confirmed against a real Postgres 16 instance in db/validate.sql.
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
-- Two PARTIAL unique indexes, not one combined UNIQUE(...), because standard SQL
-- treats every NULL as distinct from every other NULL: exactly one of exerciseEventId/
-- instrumentId is ever set on a given row (see each column's doc comment above), so a
-- plain multi-column UNIQUE across both would never actually catch a duplicate — the
-- "other" column would be NULL on both rows being compared, and NULL <> NULL always.
-- These two indexes instead each enforce dedup only among the rows where their own
-- column is actually populated — exactly the guarantee this table needs. See
-- db/validate.sql for the representative-data proof (both a same-exercise duplicate
-- and a same-instrument duplicate are correctly rejected; two different instruments'
-- 83(b) deadlines, both with exerciseEventId NULL, are correctly allowed to coexist).
CREATE UNIQUE INDEX "TaxFilingRecord_exercise_dedupe_idx" ON "TaxFilingRecord" ("entityId", "filingType", "taxYear", "exerciseEventId") WHERE "exerciseEventId" IS NOT NULL;
CREATE UNIQUE INDEX "TaxFilingRecord_instrument_dedupe_idx" ON "TaxFilingRecord" ("entityId", "filingType", "taxYear", "instrumentId") WHERE "instrumentId" IS NOT NULL;

-- =============================================================================
-- Stakeholder/investor self-service portal (v0.35.0)
-- =============================================================================
-- A fully separate identity system from User/EntityAccess above — see
-- StakeholderUser's doc comment in prisma/schema.prisma for the full design and why
-- a Stakeholder row doesn't just get a password column directly (one real person can
-- be a stakeholder of more than one Entity, and needs one login across all of them).

CREATE TABLE "StakeholderUser" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  -- Same "scrypt:<saltHex>:<hashHex>" format as "User"."passwordHash". NULLABLE: a row
  -- can exist before any password is set (created the moment an admin first invites
  -- this email) — see POST /api/portal/accept-invite.
  "passwordHash" TEXT,
  "sessionVersion" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "StakeholderAccess" (
  "id" TEXT PRIMARY KEY,
  "stakeholderUserId" TEXT NOT NULL REFERENCES "StakeholderUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "stakeholderId" TEXT NOT NULL REFERENCES "Stakeholder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- v0.36.0 — see this column's doc comment in prisma/schema.prisma: when true, this
  -- access grant sees the entity's full cap table on the portal instead of just this
  -- one stakeholder's own holdings ("board member portal" access).
  "boardObserver" BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE ("stakeholderUserId", "stakeholderId")
);
CREATE INDEX "StakeholderAccess_stakeholderId_idx" ON "StakeholderAccess"("stakeholderId");

CREATE TABLE "PortalInvite" (
  "id" TEXT PRIMARY KEY,
  "stakeholderId" TEXT NOT NULL REFERENCES "Stakeholder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- SHA-256 hex of the raw invite token — only the hash is ever stored, same
  -- at-rest-leak reasoning as password hashing. See portalInvite.ts.
  "tokenHash" TEXT NOT NULL UNIQUE,
  "createdByUserId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "acceptedByUserId" TEXT REFERENCES "StakeholderUser"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- v0.36.0 — carried onto the resulting StakeholderAccess.boardObserver at
  -- acceptance time. See that column's doc comment.
  "grantsBoardObserverAccess" BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX "PortalInvite_stakeholderId_idx" ON "PortalInvite"("stakeholderId");

-- =============================================================================
-- Board approval / consent record-keeping (v0.36.0)
-- =============================================================================
-- A governance record, deliberately NOT a workflow gate — see BoardConsent's doc
-- comment in prisma/schema.prisma for the full reasoning (this table is read by
-- nothing in the accounting engine, cap table rollup, or close workflow).

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

COMMIT;
