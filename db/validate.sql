-- Representative-data validation of db/schema.sql, run against a real Postgres 16
-- instance. This is the part that actually proves something — reading the schema
-- again wouldn't catch a bad foreign key direction, a NUMERIC precision that silently
-- truncates a real figure, or a RESTRICT that fires (or fails to fire) when it should.
-- Every section below either succeeds as expected or is EXPECTED to raise an error —
-- see the comment above each statement for which.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Core hierarchy: Entity -> Stakeholder -> Instrument -> InstrumentTermVersion
-- ---------------------------------------------------------------------------
INSERT INTO "Entity" ("id", "name", "reportingCurrency")
VALUES ('ent_1', 'Acme Robotics, Inc.', 'USD');

INSERT INTO "Stakeholder" ("id", "entityId", "type", "name", "email")
VALUES ('sh_1', 'ent_1', 'EMPLOYEE', 'Jane Doe', 'jane@example.com');

INSERT INTO "Instrument" ("id", "entityId", "stakeholderId", "type", "issueDate", "currency")
VALUES ('inst_1', 'ent_1', 'sh_1', 'STOCK_OPTION', '2025-01-01', 'USD');

-- JSONB round-trip: a representative ServiceConditionGrant-shaped terms payload,
-- matching what src/lib/accounting/vesting.ts's ServiceConditionGrant actually expects.
INSERT INTO "InstrumentTermVersion" ("id", "instrumentId", "effectiveDate", "label", "terms")
VALUES (
  'tv_1', 'inst_1', '2025-01-01', 'Original grant',
  '{"grantDate":"2025-01-01","quantity":12000,"grantDateFairValuePerUnit":2,"attributionMethod":"straight-line","tranches":[{"id":"t1","vestDate":"2026-01-01","quantity":3000},{"id":"t2","vestDate":"2027-01-01","quantity":3000},{"id":"t3","vestDate":"2028-01-01","quantity":3000},{"id":"t4","vestDate":"2029-01-01","quantity":3000}]}'::jsonb
);

-- Confirm the JSONB round-trips exactly and a nested field is queryable (not just
-- storable) — this is what "the engine's output can actually be persisted and read
-- back" means in practice, not just "it typechecks."
DO $$
DECLARE qty numeric;
BEGIN
  SELECT (terms->>'quantity')::numeric INTO qty FROM "InstrumentTermVersion" WHERE id = 'tv_1';
  IF qty IS DISTINCT FROM 12000 THEN
    RAISE EXCEPTION 'JSONB round-trip failed: expected quantity 12000, got %', qty;
  END IF;
  RAISE NOTICE 'PASS: JSONB terms payload round-trips and is queryable (quantity = %)', qty;
END $$;

-- ---------------------------------------------------------------------------
-- 2. ScheduleEntry + JournalEntry/JournalLine, with realistic NUMERIC(18,4) values
--    (using the exact Year-1 figures from tests/closeAndReporting.test.ts's golden
--    scenario: $24,000 grant, straight-line over 4 years -> $5,999.9986... a period,
--    a real fixed-point figure worth proving NUMERIC(18,4) holds without truncation)
-- ---------------------------------------------------------------------------
INSERT INTO "ScheduleEntry" ("id", "instrumentId", "periodStart", "periodEnd", "label", "amount", "endingBalance", "termVersionLabel")
VALUES ('se_y1', 'inst_1', '2025-01-01', '2026-01-01', 'Y1', 5999.9986, 5999.9986, 'Original grant');

INSERT INTO "JournalEntry" ("id", "instrumentId", "date", "description", "ascReference")
VALUES ('je_y1', 'inst_1', '2026-01-01', 'Stock-based compensation expense — Y1', 'ASC 718');

INSERT INTO "JournalLine" ("id", "journalEntryId", "account", "debit")
VALUES ('jl_y1_debit', 'je_y1', 'Stock Compensation Expense', 5999.9986);
INSERT INTO "JournalLine" ("id", "journalEntryId", "account", "credit")
VALUES ('jl_y1_credit', 'je_y1', 'Additional Paid-In Capital', 5999.9986);

DO $$
DECLARE stored_amount numeric;
BEGIN
  SELECT amount INTO stored_amount FROM "ScheduleEntry" WHERE id = 'se_y1';
  IF stored_amount IS DISTINCT FROM 5999.9986 THEN
    RAISE EXCEPTION 'NUMERIC(18,4) precision failed: expected 5999.9986, got %', stored_amount;
  END IF;
  RAISE NOTICE 'PASS: NUMERIC(18,4) holds the engine''s fixed-point figure exactly (%).', stored_amount;
END $$;

-- ---------------------------------------------------------------------------
-- 3. The audit-trail pattern from correctionService.ts / the Correction model's doc
--    comment: a RETROSPECTIVE correction supersedes an old ScheduleEntry/JournalEntry
--    and creates new ones, WITHOUT deleting anything. This is the single most
--    important behavior in the whole schema to prove actually works end to end.
-- ---------------------------------------------------------------------------
INSERT INTO "Correction" ("id", "instrumentId", "discoveredDate", "reason", "election", "previewSnapshot")
VALUES ('corr_1', 'inst_1', '2026-06-01', 'Grant-date FV data-entry error found during Q2 review', 'RETROSPECTIVE',
        '{"cumulativeDelta": "1000.00", "perPeriodDeltas": [{"period": "Y1", "delta": "1000.00"}]}'::jsonb);

-- Mark the ORIGINAL Y1 schedule entry as superseded (never deleted).
UPDATE "ScheduleEntry" SET "supersededByCorrectionId" = 'corr_1' WHERE id = 'se_y1';

-- Insert the CORRECTED Y1 schedule entry, pointing back at the same Correction.
INSERT INTO "ScheduleEntry" ("id", "instrumentId", "periodStart", "periodEnd", "label", "amount", "endingBalance", "termVersionLabel", "createdByCorrectionId")
VALUES ('se_y1_corrected', 'inst_1', '2025-01-01', '2026-01-01', 'Y1 (restated)', 6999.9986, 6999.9986, 'Original grant', 'corr_1');

-- Same pattern for the journal entry: original superseded, corrected one created.
UPDATE "JournalEntry" SET "supersededByCorrectionId" = 'corr_1' WHERE id = 'je_y1';
INSERT INTO "JournalEntry" ("id", "instrumentId", "date", "description", "ascReference", "createdByCorrectionId")
VALUES ('je_y1_corrected', 'inst_1', '2026-06-01', 'Stock-based compensation expense — Y1 (restated)', 'ASC 250', 'corr_1');
INSERT INTO "JournalLine" ("id", "journalEntryId", "account", "debit")
VALUES ('jl_y1c_debit', 'je_y1_corrected', 'Stock Compensation Expense', 6999.9986);
INSERT INTO "JournalLine" ("id", "journalEntryId", "account", "credit")
VALUES ('jl_y1c_credit', 'je_y1_corrected', 'Additional Paid-In Capital', 6999.9986);

-- "Current view" query (per the ScheduleEntry doc comment: filter supersededByCorrectionId
-- IS NULL) should return exactly the RESTATED row, not the original.
DO $$
DECLARE current_count integer;
DECLARE current_label text;
DECLARE total_count integer;
BEGIN
  SELECT count(*) INTO total_count FROM "ScheduleEntry" WHERE "instrumentId" = 'inst_1';
  SELECT count(*), max(label) INTO current_count, current_label
    FROM "ScheduleEntry" WHERE "instrumentId" = 'inst_1' AND "supersededByCorrectionId" IS NULL;
  IF total_count != 2 THEN
    RAISE EXCEPTION 'Expected 2 total ScheduleEntry rows (original + restated), got %', total_count;
  END IF;
  IF current_count != 1 OR current_label != 'Y1 (restated)' THEN
    RAISE EXCEPTION 'Current-view filter failed: expected exactly 1 current row labeled "Y1 (restated)", got % row(s), label=%', current_count, current_label;
  END IF;
  RAISE NOTICE 'PASS: audit trail intact — 2 total ScheduleEntry rows, exactly 1 in the current (non-superseded) view, and it is the restated one.';
END $$;

-- ---------------------------------------------------------------------------
-- 4. Referential integrity actually holds: deleting an Entity with dependent
--    Stakeholders/Instruments must fail (RESTRICT), not cascade silently.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    DELETE FROM "Entity" WHERE id = 'ent_1';
    RAISE EXCEPTION 'SCHEMA BUG: deleting an Entity with dependent rows should have been blocked by RESTRICT, but it succeeded.';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: deleting an Entity with dependent Stakeholders/Instruments correctly fails (foreign_key_violation), as RESTRICT requires.';
  END;
END $$;

-- Same check for deleting a Correction that's referenced by the audit trail — the
-- permanent-record guarantee this whole design exists for.
DO $$
BEGIN
  BEGIN
    DELETE FROM "Correction" WHERE id = 'corr_1';
    RAISE EXCEPTION 'SCHEMA BUG: deleting a Correction still referenced by superseded/created rows should have been blocked, but it succeeded.';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: deleting a Correction that the audit trail still references correctly fails.';
  END;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Defaults actually apply as declared.
-- ---------------------------------------------------------------------------
INSERT INTO "Entity" ("id", "name") VALUES ('ent_2', 'No currency specified');
DO $$
DECLARE rc text;
BEGIN
  SELECT "reportingCurrency" INTO rc FROM "Entity" WHERE id = 'ent_2';
  IF rc != 'USD' THEN
    RAISE EXCEPTION 'Default reportingCurrency failed: expected USD, got %', rc;
  END IF;
  RAISE NOTICE 'PASS: reportingCurrency defaults to USD when not specified.';
END $$;

-- ---------------------------------------------------------------------------
-- 6. User / EntityAccess (multi-tenancy — prisma/schema.prisma design note #4):
--    a user's email is unique, a (user, entity) access grant is unique, one user can
--    have access to more than one entity, one entity can have more than one user, and
--    deleting either side of a grant that's still referenced correctly fails (RESTRICT).
-- ---------------------------------------------------------------------------
INSERT INTO "User" ("id", "email", "passwordHash") VALUES
  ('user_owner', 'owner@example.com', 'scrypt:deadbeef:cafebabe'),
  ('user_reviewer', 'reviewer@example.com', 'scrypt:deadbeef:cafed00d');

INSERT INTO "Entity" ("id", "name") VALUES ('ent_3', 'Second Client Co.');

-- The owner has access to BOTH entities (the accountant-serving-several-clients case
-- design note #4 calls out); the reviewer has read-only access to just one of them.
INSERT INTO "EntityAccess" ("id", "userId", "entityId", "role") VALUES
  ('ea_1', 'user_owner', 'ent_2', 'OWNER'),
  ('ea_2', 'user_owner', 'ent_3', 'OWNER'),
  ('ea_3', 'user_reviewer', 'ent_2', 'VIEWER');

DO $$
DECLARE owner_entity_count integer;
DECLARE ent2_user_count integer;
BEGIN
  SELECT count(*) INTO owner_entity_count FROM "EntityAccess" WHERE "userId" = 'user_owner';
  SELECT count(*) INTO ent2_user_count FROM "EntityAccess" WHERE "entityId" = 'ent_2';
  IF owner_entity_count != 2 THEN
    RAISE EXCEPTION 'Expected user_owner to have access to 2 entities, got %', owner_entity_count;
  END IF;
  IF ent2_user_count != 2 THEN
    RAISE EXCEPTION 'Expected ent_2 to have 2 users with access, got %', ent2_user_count;
  END IF;
  RAISE NOTICE 'PASS: one user can access multiple entities and one entity can have multiple users (many-to-many via EntityAccess).';
END $$;

-- Duplicate email must be rejected.
DO $$
BEGIN
  BEGIN
    INSERT INTO "User" ("id", "email", "passwordHash") VALUES ('user_dupe', 'owner@example.com', 'scrypt:x:y');
    RAISE EXCEPTION 'SCHEMA BUG: a duplicate User.email should have been rejected by the UNIQUE constraint, but it succeeded.';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: User.email UNIQUE constraint correctly rejects a duplicate address.';
  END;
END $$;

-- A duplicate (userId, entityId) grant must be rejected — a user has at most one role
-- per entity, never two conflicting rows to reconcile.
DO $$
BEGIN
  BEGIN
    INSERT INTO "EntityAccess" ("id", "userId", "entityId", "role") VALUES ('ea_dupe', 'user_owner', 'ent_2', 'EDITOR');
    RAISE EXCEPTION 'SCHEMA BUG: a duplicate (userId, entityId) EntityAccess row should have been rejected, but it succeeded.';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: EntityAccess UNIQUE(userId, entityId) correctly rejects a second grant for the same user/entity pair.';
  END;
END $$;

-- Deleting a User who still has an EntityAccess row must fail loudly (RESTRICT) —
-- silently cascading would silently strip every entity that grant referenced, and
-- silently deleting the User out from under an active grant is exactly the kind of
-- surprise this schema's RESTRICT-everywhere convention exists to prevent.
DO $$
BEGIN
  BEGIN
    DELETE FROM "User" WHERE id = 'user_owner';
    RAISE EXCEPTION 'SCHEMA BUG: deleting a User with EntityAccess rows should have been blocked by RESTRICT, but it succeeded.';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: deleting a User who still has EntityAccess grants correctly fails (foreign_key_violation).';
  END;
END $$;

-- Roll everything back — this script is a validation exercise, not seed data. Nothing
-- from this file should be left in the database afterward.
ROLLBACK;
