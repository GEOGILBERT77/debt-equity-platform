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

-- ---------------------------------------------------------------------------
-- 7. Option tax/compliance (v0.33.0): OptionExerciseEvent / ShareDispositionEvent /
--    TaxFilingRecord — exercised against the same 'inst_1' STOCK_OPTION grant used in
--    section 1 above, plus the two new nullable columns on Entity/Stakeholder.
-- ---------------------------------------------------------------------------
UPDATE "Entity" SET "employerIdentificationNumber" = '12-3456789', "address" = '1 Robotics Way, Palo Alto, CA' WHERE id = 'ent_1';
UPDATE "Stakeholder" SET "taxIdNumber" = '123-45-6789' WHERE id = 'sh_1';

-- A real exercise: 3,000 of the 12,000 granted shares exercised a year after grant,
-- at the $1.00 strike, with a $5.00 FMV on the exercise date (a real ISO bargain
-- element Form 3921/the AMT preference calc would need).
INSERT INTO "OptionExerciseEvent" ("id", "instrumentId", "exerciseDate", "quantityExercised", "exercisePricePerShare", "fairMarketValuePerShareAtExercise")
VALUES ('oee_1', 'inst_1', '2026-01-15', 3000, 1.00, 5.00);

-- A later disposition of some of those same shares, sold well before the 1-year-from-
-- exercise/2-year-from-grant qualifying holding period — a disqualifying disposition.
INSERT INTO "ShareDispositionEvent" ("id", "exerciseEventId", "dispositionDate", "quantitySold", "salePricePerShare")
VALUES ('sde_1', 'oee_1', '2026-03-01', 1000, 6.00);

-- The Form 3921 obligation this exercise creates, plus the disqualifying-disposition
-- W-2 obligation the later sale creates — both PENDING until a user marks them filed.
INSERT INTO "TaxFilingRecord" ("id", "entityId", "filingType", "taxYear", "exerciseEventId")
VALUES
  ('tfr_1', 'ent_1', 'FORM_3921', 2026, 'oee_1'),
  ('tfr_2', 'ent_1', 'W2_ISO_DISQUALIFYING_DISPOSITION', 2026, 'oee_1');

DO $$
DECLARE fmv numeric;
DECLARE filing_status "TaxFilingStatus";
BEGIN
  SELECT "fairMarketValuePerShareAtExercise" INTO fmv FROM "OptionExerciseEvent" WHERE id = 'oee_1';
  IF fmv IS DISTINCT FROM 5.00 THEN
    RAISE EXCEPTION 'NUMERIC(24,6) precision failed on OptionExerciseEvent: expected 5.00, got %', fmv;
  END IF;
  SELECT status INTO filing_status FROM "TaxFilingRecord" WHERE id = 'tfr_1';
  IF filing_status != 'PENDING' THEN
    RAISE EXCEPTION 'Default TaxFilingStatus failed: expected PENDING, got %', filing_status;
  END IF;
  RAISE NOTICE 'PASS: OptionExerciseEvent/ShareDispositionEvent/TaxFilingRecord round-trip correctly, and TaxFilingRecord.status defaults to PENDING.';
END $$;

-- A duplicate (entityId, filingType, taxYear, exerciseEventId) obligation must be
-- rejected — the monthly report reconciles against existing rows precisely so it
-- never creates a second PENDING row for an obligation it already knows about.
DO $$
BEGIN
  BEGIN
    INSERT INTO "TaxFilingRecord" ("id", "entityId", "filingType", "taxYear", "exerciseEventId")
    VALUES ('tfr_dupe', 'ent_1', 'FORM_3921', 2026, 'oee_1');
    RAISE EXCEPTION 'SCHEMA BUG: a duplicate (entityId, filingType, taxYear, exerciseEventId) TaxFilingRecord should have been rejected, but it succeeded.';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: TaxFilingRecord UNIQUE(entityId, filingType, taxYear, exerciseEventId) correctly rejects a duplicate obligation.';
  END;
END $$;

-- Deleting an OptionExerciseEvent that a ShareDispositionEvent still references must
-- fail loudly (RESTRICT) — exactly like every other append-only event log in this
-- schema, a disposition record without the exercise it disposed of is meaningless.
DO $$
BEGIN
  BEGIN
    DELETE FROM "OptionExerciseEvent" WHERE id = 'oee_1';
    RAISE EXCEPTION 'SCHEMA BUG: deleting an OptionExerciseEvent with a dependent ShareDispositionEvent should have been blocked by RESTRICT, but it succeeded.';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: deleting an OptionExerciseEvent that a ShareDispositionEvent still references correctly fails (foreign_key_violation).';
  END;
END $$;

-- TaxFilingRecord.exerciseEventId is the one deliberate exception to this schema's
-- RESTRICT-everywhere convention (see its own ON DELETE SET NULL, matching
-- User.defaultEntityId's reasoning): losing the specific exercise a filing traces back
-- to should degrade gracefully, not block deleting an exercise event that has no
-- ShareDispositionEvent in the way. Proven here on a second, disposition-free exercise
-- event so this check is isolated from the RESTRICT proven immediately above.
INSERT INTO "OptionExerciseEvent" ("id", "instrumentId", "exerciseDate", "quantityExercised", "exercisePricePerShare", "fairMarketValuePerShareAtExercise")
VALUES ('oee_2', 'inst_1', '2026-02-01', 500, 1.00, 5.50);
INSERT INTO "TaxFilingRecord" ("id", "entityId", "filingType", "taxYear", "exerciseEventId")
VALUES ('tfr_3', 'ent_1', 'FORM_3921', 2026, 'oee_2');
DELETE FROM "OptionExerciseEvent" WHERE id = 'oee_2';
DO $$
DECLARE linked_id text;
BEGIN
  SELECT "exerciseEventId" INTO linked_id FROM "TaxFilingRecord" WHERE id = 'tfr_3';
  IF linked_id IS NOT NULL THEN
    RAISE EXCEPTION 'SCHEMA BUG: TaxFilingRecord.exerciseEventId should have been set NULL when its OptionExerciseEvent was deleted, but it is still %', linked_id;
  END IF;
  RAISE NOTICE 'PASS: deleting an OptionExerciseEvent with no dependent ShareDispositionEvent succeeds and correctly SETs NULL the TaxFilingRecord rows that traced back to it.';
END $$;

-- An ELECTION_83B_DEADLINE obligation traces to the INSTRUMENT itself (an early-
-- exercise/restricted grant), not an OptionExerciseEvent — exercised here against a
-- second STOCK_OPTION instrument to prove instrumentId works and that two such rows
-- for different instruments (both with exerciseEventId NULL) do NOT collide on the
-- UNIQUE constraint, which is exactly the scenario db/schema.sql's comment on this
-- column depends on.
INSERT INTO "Instrument" ("id", "entityId", "stakeholderId", "type", "issueDate", "currency")
VALUES ('inst_2', 'ent_1', 'sh_1', 'STOCK_OPTION', '2026-04-01', 'USD');

INSERT INTO "TaxFilingRecord" ("id", "entityId", "filingType", "taxYear", "instrumentId")
VALUES
  ('tfr_83b_1', 'ent_1', 'ELECTION_83B_DEADLINE', 2026, 'inst_1'),
  ('tfr_83b_2', 'ent_1', 'ELECTION_83B_DEADLINE', 2026, 'inst_2');

DO $$
DECLARE row_count integer;
BEGIN
  SELECT count(*) INTO row_count FROM "TaxFilingRecord"
    WHERE "entityId" = 'ent_1' AND "filingType" = 'ELECTION_83B_DEADLINE' AND "taxYear" = 2026;
  IF row_count != 2 THEN
    RAISE EXCEPTION 'Expected 2 ELECTION_83B_DEADLINE rows (one per instrument), got %', row_count;
  END IF;
  RAISE NOTICE 'PASS: two ELECTION_83B_DEADLINE rows for the same entity/year but different instruments (both exerciseEventId NULL) coexist without a UNIQUE violation.';
END $$;

-- But a genuine duplicate — same entity/year/instrument — must still be rejected.
DO $$
BEGIN
  BEGIN
    INSERT INTO "TaxFilingRecord" ("id", "entityId", "filingType", "taxYear", "instrumentId")
    VALUES ('tfr_83b_dupe', 'ent_1', 'ELECTION_83B_DEADLINE', 2026, 'inst_1');
    RAISE EXCEPTION 'SCHEMA BUG: a duplicate (entityId, filingType, taxYear, exerciseEventId, instrumentId) TaxFilingRecord should have been rejected, but it succeeded.';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: TaxFilingRecord correctly rejects a genuine duplicate ELECTION_83B_DEADLINE row for the same instrument.';
  END;
END $$;

-- Deleting an Instrument that a TaxFilingRecord still traces to (via instrumentId)
-- must degrade gracefully (SET NULL), same reasoning as exerciseEventId above — but
-- ONLY once nothing else RESTRICTs the delete first (inst_2 has no term versions,
-- schedule entries, etc., so this is a clean deletion).
DELETE FROM "Instrument" WHERE id = 'inst_2';
DO $$
DECLARE linked_id text;
BEGIN
  SELECT "instrumentId" INTO linked_id FROM "TaxFilingRecord" WHERE id = 'tfr_83b_2';
  IF linked_id IS NOT NULL THEN
    RAISE EXCEPTION 'SCHEMA BUG: TaxFilingRecord.instrumentId should have been set NULL when its Instrument was deleted, but it is still %', linked_id;
  END IF;
  RAISE NOTICE 'PASS: deleting an Instrument correctly SETs NULL the TaxFilingRecord rows that traced back to it via instrumentId.';
END $$;

-- ---------------------------------------------------------------------------
-- 8. Stakeholder self-service portal (v0.35.0): StakeholderUser / StakeholderAccess /
--    PortalInvite — a fully separate identity system from User/EntityAccess, proven
--    independently here. Uses stakeholder 'sh_1' and admin 'user_owner' from sections
--    1 and 6 above.
-- ---------------------------------------------------------------------------
INSERT INTO "StakeholderUser" ("id", "email") VALUES ('su_1', 'jane-portal@example.com');

INSERT INTO "StakeholderAccess" ("id", "stakeholderUserId", "stakeholderId")
VALUES ('sa_1', 'su_1', 'sh_1');

INSERT INTO "PortalInvite" ("id", "stakeholderId", "tokenHash", "createdByUserId", "expiresAt")
VALUES ('pi_1', 'sh_1', repeat('a', 64), 'user_owner', now() + interval '7 days');

DO $$
DECLARE access_count integer;
DECLARE stored_email text;
BEGIN
  SELECT count(*) INTO access_count FROM "StakeholderAccess" WHERE "stakeholderUserId" = 'su_1';
  SELECT email INTO stored_email FROM "StakeholderUser" WHERE id = 'su_1';
  IF access_count != 1 THEN
    RAISE EXCEPTION 'Expected su_1 to have exactly 1 StakeholderAccess row, got %', access_count;
  END IF;
  IF stored_email != 'jane-portal@example.com' THEN
    RAISE EXCEPTION 'StakeholderUser.email round-trip failed: got %', stored_email;
  END IF;
  RAISE NOTICE 'PASS: StakeholderUser/StakeholderAccess/PortalInvite round-trip correctly.';
END $$;

-- A duplicate (stakeholderUserId, stakeholderId) grant must be rejected — one login
-- should map to at most one access row per stakeholder record, same reasoning as
-- EntityAccess's UNIQUE(userId, entityId) above.
DO $$
BEGIN
  BEGIN
    INSERT INTO "StakeholderAccess" ("id", "stakeholderUserId", "stakeholderId") VALUES ('sa_dupe', 'su_1', 'sh_1');
    RAISE EXCEPTION 'SCHEMA BUG: a duplicate (stakeholderUserId, stakeholderId) StakeholderAccess row should have been rejected, but it succeeded.';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: StakeholderAccess UNIQUE(stakeholderUserId, stakeholderId) correctly rejects a duplicate grant.';
  END;
END $$;

-- A duplicate tokenHash must be rejected — two different invites can never hash to the
-- same value in practice (SHA-256 of a 256-bit random token), but the UNIQUE
-- constraint is what actually guarantees a hash can never be looked up ambiguously.
DO $$
BEGIN
  BEGIN
    INSERT INTO "PortalInvite" ("id", "stakeholderId", "tokenHash", "createdByUserId", "expiresAt")
    VALUES ('pi_dupe', 'sh_1', repeat('a', 64), 'user_owner', now() + interval '7 days');
    RAISE EXCEPTION 'SCHEMA BUG: a duplicate PortalInvite.tokenHash should have been rejected, but it succeeded.';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: PortalInvite.tokenHash UNIQUE constraint correctly rejects a duplicate hash.';
  END;
END $$;

-- Deleting a Stakeholder that still has StakeholderAccess/PortalInvite rows must fail
-- (RESTRICT) — proven against a fresh, instrument-free stakeholder so this check is
-- isolated from the Instrument-driven RESTRICT that would otherwise also block it.
INSERT INTO "Stakeholder" ("id", "entityId", "type", "name", "email")
VALUES ('sh_2', 'ent_1', 'INVESTOR', 'Portal-Only Investor', 'investor-portal@example.com');
INSERT INTO "StakeholderAccess" ("id", "stakeholderUserId", "stakeholderId") VALUES ('sa_2', 'su_1', 'sh_2');
DO $$
BEGIN
  BEGIN
    DELETE FROM "Stakeholder" WHERE id = 'sh_2';
    RAISE EXCEPTION 'SCHEMA BUG: deleting a Stakeholder with a dependent StakeholderAccess row should have been blocked by RESTRICT, but it succeeded.';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: deleting a Stakeholder who still has StakeholderAccess grants correctly fails (foreign_key_violation).';
  END;
END $$;

-- Deleting a StakeholderUser who still has a StakeholderAccess row must also fail
-- (RESTRICT) — the same "don't silently orphan an access grant" reasoning as User
-- above.
DO $$
BEGIN
  BEGIN
    DELETE FROM "StakeholderUser" WHERE id = 'su_1';
    RAISE EXCEPTION 'SCHEMA BUG: deleting a StakeholderUser with StakeholderAccess rows should have been blocked by RESTRICT, but it succeeded.';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: deleting a StakeholderUser who still has StakeholderAccess grants correctly fails (foreign_key_violation).';
  END;
END $$;

-- PortalInvite.acceptedByUserId is the one deliberate SET NULL exception here (mirrors
-- TaxFilingRecord.exerciseEventId's reasoning above): losing the specific
-- StakeholderUser an invite was accepted by should degrade gracefully, never block
-- deleting that user. Proven on a second StakeholderUser that has NO StakeholderAccess
-- row (so nothing else RESTRICTs its deletion), isolating this one behavior.
INSERT INTO "StakeholderUser" ("id", "email") VALUES ('su_2', 'accepted-then-deleted@example.com');
INSERT INTO "PortalInvite" ("id", "stakeholderId", "tokenHash", "createdByUserId", "expiresAt", "usedAt", "acceptedByUserId")
VALUES ('pi_2', 'sh_2', repeat('b', 64), 'user_owner', now() + interval '7 days', now(), 'su_2');
DELETE FROM "StakeholderUser" WHERE id = 'su_2';
DO $$
DECLARE accepted_id text;
BEGIN
  SELECT "acceptedByUserId" INTO accepted_id FROM "PortalInvite" WHERE id = 'pi_2';
  IF accepted_id IS NOT NULL THEN
    RAISE EXCEPTION 'SCHEMA BUG: PortalInvite.acceptedByUserId should have been set NULL when its StakeholderUser was deleted, but it is still %', accepted_id;
  END IF;
  RAISE NOTICE 'PASS: deleting a StakeholderUser correctly SETs NULL the PortalInvite rows it had accepted.';
END $$;

-- ---------------------------------------------------------------------------
-- 9. Board approval / consent record-keeping + board-observer portal access
--    (v0.36.0). BoardConsent/BoardConsentInstrument are a NEW pair of tables; the
--    other two checks here are new BOOLEAN columns bolted onto the existing
--    StakeholderAccess/PortalInvite tables from section 8. Reuses entity 'ent_1',
--    instrument 'inst_1', admin 'user_owner', stakeholder-user 'su_1', and
--    stakeholder 'sh_2' from sections 1, 6, and 8 above.
-- ---------------------------------------------------------------------------

-- New columns default to FALSE for a row that doesn't specify them — proven on the
-- 'sa_2'/'pi_1' rows already inserted in section 8, which predate this column and were
-- inserted without it.
DO $$
DECLARE observer_flag boolean;
DECLARE grants_flag boolean;
BEGIN
  SELECT "boardObserver" INTO observer_flag FROM "StakeholderAccess" WHERE id = 'sa_2';
  SELECT "grantsBoardObserverAccess" INTO grants_flag FROM "PortalInvite" WHERE id = 'pi_1';
  IF observer_flag IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'SCHEMA BUG: StakeholderAccess.boardObserver should default to FALSE, got %', observer_flag;
  END IF;
  IF grants_flag IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'SCHEMA BUG: PortalInvite.grantsBoardObserverAccess should default to FALSE, got %', grants_flag;
  END IF;
  RAISE NOTICE 'PASS: StakeholderAccess.boardObserver and PortalInvite.grantsBoardObserverAccess both default to FALSE.';
END $$;

-- A grant CAN be explicitly marked board-observer — the whole point of the flag. Uses a
-- fresh Stakeholder ('sh_3') so the (stakeholderUserId, stakeholderId) pair doesn't
-- collide with the 'sa_1'/'sa_2' rows section 8 already inserted for 'su_1'.
INSERT INTO "Stakeholder" ("id", "entityId", "type", "name", "email")
VALUES ('sh_3', 'ent_1', 'INVESTOR', 'Board Observer Investor', 'board-observer@example.com');
INSERT INTO "StakeholderAccess" ("id", "stakeholderUserId", "stakeholderId", "boardObserver")
VALUES ('sa_3', 'su_1', 'sh_3', true);
DO $$
DECLARE observer_flag boolean;
BEGIN
  SELECT "boardObserver" INTO observer_flag FROM "StakeholderAccess" WHERE id = 'sa_3';
  IF observer_flag IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SCHEMA BUG: expected sa_3.boardObserver = TRUE, got %', observer_flag;
  END IF;
  RAISE NOTICE 'PASS: StakeholderAccess.boardObserver can be explicitly set TRUE.';
END $$;

-- BoardConsent + BoardConsentInstrument round-trip, including the enum column.
INSERT INTO "BoardConsent" ("id", "entityId", "title", "description", "consentType", "decisionDate", "createdByUserId")
VALUES ('bc_1', 'ent_1', 'Approve Series A option pool grants', 'Board approves the option grants listed in the attached schedule.', 'WRITTEN_CONSENT', '2026-06-01', 'user_owner');

-- A fresh, otherwise-undependent instrument, so the RESTRICT check below is isolated
-- from the ScheduleEntry/JournalEntry RESTRICTs that already reference 'inst_1'
-- (sections 1-2 above) — deleting 'inst_1' would fail for those reasons regardless of
-- BoardConsentInstrument, which would prove nothing about this new constraint.
INSERT INTO "Instrument" ("id", "entityId", "stakeholderId", "type", "issueDate", "currency")
VALUES ('inst_bc_1', 'ent_1', 'sh_1', 'STOCK_OPTION', '2026-01-01', 'USD');

INSERT INTO "BoardConsentInstrument" ("id", "boardConsentId", "instrumentId")
VALUES ('bci_1', 'bc_1', 'inst_bc_1');

DO $$
DECLARE stored_type text;
DECLARE linked_count integer;
BEGIN
  SELECT "consentType"::text INTO stored_type FROM "BoardConsent" WHERE id = 'bc_1';
  SELECT count(*) INTO linked_count FROM "BoardConsentInstrument" WHERE "boardConsentId" = 'bc_1';
  IF stored_type != 'WRITTEN_CONSENT' THEN
    RAISE EXCEPTION 'BoardConsent.consentType round-trip failed: got %', stored_type;
  END IF;
  IF linked_count != 1 THEN
    RAISE EXCEPTION 'Expected bc_1 to have exactly 1 linked instrument, got %', linked_count;
  END IF;
  RAISE NOTICE 'PASS: BoardConsent/BoardConsentInstrument round-trip correctly, including the BoardConsentType enum.';
END $$;

-- A duplicate (boardConsentId, instrumentId) link must be rejected — the same
-- instrument shouldn't be attached to the same consent twice.
DO $$
BEGIN
  BEGIN
    INSERT INTO "BoardConsentInstrument" ("id", "boardConsentId", "instrumentId") VALUES ('bci_dupe', 'bc_1', 'inst_bc_1');
    RAISE EXCEPTION 'SCHEMA BUG: a duplicate (boardConsentId, instrumentId) BoardConsentInstrument row should have been rejected, but it succeeded.';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: BoardConsentInstrument UNIQUE(boardConsentId, instrumentId) correctly rejects a duplicate link.';
  END;
END $$;

-- Deleting an Entity, User, BoardConsent, or Instrument that a BoardConsent /
-- BoardConsentInstrument row still references must fail (RESTRICT) — a consent record
-- is meant to be a permanent part of the governance trail, never silently orphaned or
-- cascaded away.
DO $$
BEGIN
  BEGIN
    DELETE FROM "Entity" WHERE id = 'ent_1';
    RAISE EXCEPTION 'SCHEMA BUG: deleting an Entity with a dependent BoardConsent row should have been blocked by RESTRICT, but it succeeded.';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: deleting an Entity that still has BoardConsent rows correctly fails (foreign_key_violation).';
  END;
END $$;

DO $$
BEGIN
  BEGIN
    DELETE FROM "User" WHERE id = 'user_owner';
    RAISE EXCEPTION 'SCHEMA BUG: deleting a User with a dependent BoardConsent row should have been blocked by RESTRICT, but it succeeded.';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: deleting a User who still has created BoardConsent rows correctly fails (foreign_key_violation).';
  END;
END $$;

DO $$
BEGIN
  BEGIN
    DELETE FROM "BoardConsent" WHERE id = 'bc_1';
    RAISE EXCEPTION 'SCHEMA BUG: deleting a BoardConsent with a dependent BoardConsentInstrument row should have been blocked by RESTRICT, but it succeeded.';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: deleting a BoardConsent that still has linked instruments correctly fails (foreign_key_violation).';
  END;
END $$;

DO $$
BEGIN
  BEGIN
    DELETE FROM "Instrument" WHERE id = 'inst_bc_1';
    RAISE EXCEPTION 'SCHEMA BUG: deleting an Instrument with a dependent BoardConsentInstrument row should have been blocked by RESTRICT, but it succeeded.';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: deleting an Instrument that is still linked to a BoardConsent correctly fails (foreign_key_violation).';
  END;
END $$;

-- Roll everything back — this script is a validation exercise, not seed data. Nothing
-- from this file should be left in the database afterward.
ROLLBACK;
