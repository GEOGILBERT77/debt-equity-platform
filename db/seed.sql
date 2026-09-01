-- Optional sample data for exploring the minimal front end after running db/schema.sql
-- against your real database (Supabase or otherwise). Not required — the app works
-- fine with zero rows, it'll just show empty lists — but there's nothing to click into
-- on a brand-new database, and there's no "create entity" UI yet (see the note in
-- src/app/page.tsx), so this exists to get you something real to look at on day one.
--
-- Safe to re-run: every INSERT uses a fixed id and ON CONFLICT (id) DO NOTHING, so
-- running this twice against the same database is a no-op the second time rather than
-- a duplicate-key error. Safe to delete afterward, too — nothing else depends on these
-- specific rows; delete stakeholders/instruments before their entity (RESTRICT
-- foreign keys mean the delete order matters — see db/schema.sql's header comment).
--
-- Three instruments, one per InstrumentType currently easiest to seed correctly:
-- STOCK_OPTION/RSU, TERM_LOAN, and PIK_NOTE. dispatch.ts now also wires up REVOLVER,
-- CONVERTIBLE_NOTE, and WARRANT (see the README's "Gaps against the original 7-point
-- scope" section) — they aren't seeded here only because their terms shapes need more
-- setup to seed meaningfully (a WARRANT needs a classification triage plus, if
-- liability-classified, fair value observations; a REVOLVER needs a commitment-fee
-- and/or deferred-fee window). SAR, PREFERRED_STOCK, and COMMON_STOCK still have no
-- engine wired up at all — seeding one would just produce "No schedule engine wired up
-- yet" on its instrument page.

BEGIN;

-- ---------------------------------------------------------------------------
-- Bootstrap user (v0.13.0+, real per-user auth) — solves the chicken-and-egg problem
-- of how the very first account ever gets created: POST /api/auth/users (which creates
-- new users) itself requires being already logged in as someone with OWNER access, so
-- there is no in-app way to create user #1. This row IS that first account.
--
-- Login:  bootstrap@example.com / changeme123!
--
-- The hash below is a real `scrypt:<saltHex>:<hashHex>` value produced by this app's
-- own src/lib/auth/passwordHashing.ts (hashPassword("changeme123!")) — not a
-- placeholder string, so this user can actually log in the moment this file is run.
-- The password is intentionally documented here in plaintext: it's a well-known seed
-- credential, not a secret, and MUST be treated as compromised by default. On any
-- database that will ever hold real client data, either change this user's password
-- immediately after first login (there's no self-service "change password" UI yet —
-- see the README's "not addressed" list — so today that means generating a new hash
-- with hashPassword and UPDATE-ing the "User" row directly) or, better, use this
-- account only to create a real first user via POST /api/auth/users and then leave it
-- disabled by changing its password to a hash nobody knows.
INSERT INTO "User" ("id", "email", "passwordHash")
VALUES ('seed_user_bootstrap', 'bootstrap@example.com', 'scrypt:f49ab6c33c480b596edcddf766d79b5f:2f166969f325e7fc3cdf42d63c1f8a422d8347051211df76c34ae01f85c559c0413a71308a5a73898b49f2d05e84e3b55d5e9555d03258ce895527c50c6a8210')
ON CONFLICT (id) DO NOTHING;

INSERT INTO "Entity" ("id", "name", "reportingCurrency")
VALUES ('seed_ent_1', 'Acme Robotics, Inc.', 'USD')
ON CONFLICT (id) DO NOTHING;

-- Without this row, seed_ent_1 would be unreachable by anyone through the app at all —
-- see prisma/schema.prisma's note on Entity/EntityAccess. Every OTHER entity-creation
-- path (POST /api/entities) creates this row for its caller automatically, in the same
-- transaction as the Entity itself; a raw SQL seed file has to do it by hand.
INSERT INTO "EntityAccess" ("id", "userId", "entityId", "role")
VALUES ('seed_access_bootstrap', 'seed_user_bootstrap', 'seed_ent_1', 'OWNER')
ON CONFLICT (id) DO NOTHING;

INSERT INTO "Stakeholder" ("id", "entityId", "type", "name", "email")
VALUES
  ('seed_sh_emp', 'seed_ent_1', 'EMPLOYEE', 'Jane Doe', 'jane@example.com'),
  ('seed_sh_lender', 'seed_ent_1', 'DEBT_HOLDER', 'Northgate Capital', 'ops@northgatecapital.example')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Instrument 1: a service-condition stock option grant (ASC 718) — same grant shape
-- (quantity, per-unit fair value, 4 annual tranches) as the golden scenario in
-- tests/closeAndReporting.test.ts, worth $24,000 total. The Year 1 figure below is
-- NOT copied from that test, though: attribution is day-weighted (see
-- allocateStraightLineByElapsedTime), so the exact split across years depends on which
-- calendar years the vesting period spans (2028 is a leap year, which shifts the
-- split slightly from a test that spans different dates). This seed's Year 1 amount
-- (5995.8932) was produced by actually running computeScheduleForInstrument against
-- this exact terms payload for the 2025-01-01..2026-01-01 period — 365 of the 1461
-- total days from 2025-01-01 to 2029-01-01 — not hand-typed or borrowed from elsewhere,
-- precisely so the "live preview" and "closed & reported" numbers agree on this page.
-- ---------------------------------------------------------------------------
INSERT INTO "Instrument" ("id", "entityId", "stakeholderId", "type", "issueDate", "currency")
VALUES ('seed_inst_options', 'seed_ent_1', 'seed_sh_emp', 'STOCK_OPTION', '2025-01-01', 'USD')
ON CONFLICT (id) DO NOTHING;

INSERT INTO "InstrumentTermVersion" ("id", "instrumentId", "effectiveDate", "label", "terms")
VALUES (
  'seed_tv_options', 'seed_inst_options', '2025-01-01', 'Original grant',
  '{"grantDate":"2025-01-01","quantity":12000,"grantDateFairValuePerUnit":2,"attributionMethod":"straight-line","tranches":[{"id":"t1","vestDate":"2026-01-01","quantity":3000},{"id":"t2","vestDate":"2027-01-01","quantity":3000},{"id":"t3","vestDate":"2028-01-01","quantity":3000},{"id":"t4","vestDate":"2029-01-01","quantity":3000}]}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- Year 1 seeded as already closed/reported, so the "Closed & reported" and "Journal
-- entries booked" sections on this instrument's page (and the entity's Reports page)
-- show something immediately, without you having to click "Close" first. Year 2
-- onward is left open on purpose -- click "Close through today" on the instrument page
-- to see a live preview period actually get persisted.
INSERT INTO "ScheduleEntry" ("id", "instrumentId", "periodStart", "periodEnd", "label", "amount", "endingBalance", "currency", "ascReference", "termVersionLabel")
VALUES ('seed_se_options_y1', 'seed_inst_options', '2025-01-01', '2026-01-01', 'Year 1', 5995.8932, 5995.8932, 'USD', 'ASC 718', 'Original grant')
ON CONFLICT (id) DO NOTHING;

INSERT INTO "JournalEntry" ("id", "instrumentId", "date", "description", "ascReference", "currency")
VALUES ('seed_je_options_y1', 'seed_inst_options', '2026-01-01', 'Stock-based compensation expense — Year 1', 'ASC 718', 'USD')
ON CONFLICT (id) DO NOTHING;

INSERT INTO "JournalLine" ("id", "journalEntryId", "account", "debit")
VALUES ('seed_jl_options_y1_debit', 'seed_je_options_y1', 'Stock Compensation Expense', 5995.8932)
ON CONFLICT (id) DO NOTHING;
INSERT INTO "JournalLine" ("id", "journalEntryId", "account", "credit")
VALUES ('seed_jl_options_y1_credit', 'seed_je_options_y1', 'Additional Paid-In Capital', 5995.8932)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Instrument 2: a term loan (ASC 835-30 effective interest method), left entirely
-- unclosed so "Close through today" on its page has something real to do.
--
-- KNOWN LIMITATION worth flagging here rather than hiding: buildEffectiveInterestSchedule
-- (debtAmortization.ts) requires inputs.cashFlows.length to exactly equal the number of
-- periods requested, and this instrument page always asks for periods "through today" —
-- so this term version's single cashFlows entry stays valid only until the next annual
-- period boundary (2027-01-01), at which point the LIVE preview on this instrument's
-- page will show a caught "cashFlows must have one entry per period" error (harmless —
-- it's a caught error, not a crash, and won't affect anything already closed). Add a new
-- InstrumentTermVersion with an additional cash flow entry when that happens, or treat
-- it as a live example of the gap noted in dispatch.ts: the dispatcher doesn't yet cap
-- periods at an instrument's own contractual maturity/cash flow count.
-- ---------------------------------------------------------------------------
INSERT INTO "Instrument" ("id", "entityId", "stakeholderId", "type", "issueDate", "currency")
VALUES ('seed_inst_loan', 'seed_ent_1', 'seed_sh_lender', 'TERM_LOAN', '2026-01-01', 'USD')
ON CONFLICT (id) DO NOTHING;

INSERT INTO "InstrumentTermVersion" ("id", "instrumentId", "effectiveDate", "label", "terms")
VALUES (
  'seed_tv_loan', 'seed_inst_loan', '2026-01-01', 'Original terms',
  '{"faceValue":500000,"netProceeds":490000,"effectiveAnnualYield":0.06,"cashFlows":[{"date":"2026-12-31","amount":15000}]}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Instrument 3: a PIK note (ASC 835-30, compounding — no cash leg), held by the same
-- lender. Unlike the term loan above, PIK's schedule builder (buildPikSchedule) takes
-- no cashFlows array at all — it just compounds the balance forward one period at a
-- time — so there's no "must exactly match today's period count" fragility here. This
-- one keeps computing a correct live preview indefinitely, not just until the next
-- New Year's Day, which makes it a better long-lived demo of the live-preview section
-- on the instrument page than the term loan is.
-- ---------------------------------------------------------------------------
INSERT INTO "Instrument" ("id", "entityId", "stakeholderId", "type", "issueDate", "currency")
VALUES ('seed_inst_pik', 'seed_ent_1', 'seed_sh_lender', 'PIK_NOTE', '2025-06-01', 'USD')
ON CONFLICT (id) DO NOTHING;

INSERT INTO "InstrumentTermVersion" ("id", "instrumentId", "effectiveDate", "label", "terms")
VALUES (
  'seed_tv_pik', 'seed_inst_pik', '2025-06-01', 'Original terms',
  '{"initialPrincipal":250000,"annualPikRate":0.10}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
