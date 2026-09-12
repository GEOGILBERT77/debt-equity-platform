-- Run this ONCE against your already-live Supabase database (SQL Editor -> paste ->
-- Run). It adds everything v0.38.0's "shared performance-condition tracking" feature
-- needs: two new tables, and one new nullable column on the existing
-- "InstrumentTermVersion" table.
--
-- WHY THIS EXISTS: previously, a performance- or market-condition stock award's
-- "probability of vesting" lived only as free text typed into that one grant's own
-- terms. There was no way to say "these three grants all share the same EBITDA
-- performance condition, so assessing it once should apply to all of them." This
-- migration creates a real, reusable "PerformanceCondition" record (e.g. "Apr 2026
-- EBITDA Perf") per entity, plus an append-only history of dated probability calls
-- against it ("PerformanceConditionAssessment"), and lets a grant's term version opt
-- into tracking against one of these shared records instead of (or alongside) its own
-- inline probability data.
--
-- Deliberately scoped to PERFORMANCE conditions only, not market conditions. Under
-- ASC 718-10-25, a market condition's probability of achievement is priced into the
-- award's grant-date fair value (via a Monte Carlo simulation or lattice model), so a
-- market-condition award's expense is recognized on a fixed schedule regardless of
-- whether the condition is later assessed as probable — there is no "adjust
-- amortization based on updated probability" step for market conditions the way there
-- is for performance conditions. Market-condition awards keep their existing
-- description/code fields as informational-only free text; nothing about how they're
-- amortized changes. See prisma/schema.prisma's doc comments on PerformanceCondition
-- and PerformanceConditionAssessment for the full design reasoning.
--
-- SAFE TO RUN against a database with real data in it already:
--   - Both new tables start empty, so they affect nothing until you start creating
--     PerformanceCondition records and linking grants to them.
--   - The new "performanceConditionId" column on "InstrumentTermVersion" is NULLABLE
--     with no default, so every existing row picks up NULL automatically and no
--     existing grant's amortization schedule changes as a result of running this.
--   - Nothing here renames or removes anything.
--
-- These are the exact same statements now folded into db/schema.sql for anyone
-- setting up a brand-new database from scratch — see that file's comments right above
-- the matching block.
--
-- Safe to run alongside (before or after) any other migration in this folder — this
-- migration only touches "PerformanceCondition", "PerformanceConditionAssessment", and
-- "InstrumentTermVersion", and does not depend on any of the other 2026-09-*.sql
-- migrations having been run first. It DOES require "InstrumentTermVersion",
-- "Entity", and "User" to already exist, which they do on any database that has run
-- the original db/schema.sql.

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
  -- Nullable for the same reason InstrumentTermVersion."createdByUserId" is: a
  -- direct-SQL insert (e.g. a future re-seed) can legitimately skip it, and there's
  -- nothing to backfill it from for any row inserted that way.
  "createdByUserId" TEXT REFERENCES "User"("id"),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PerformanceConditionAssessment_conditionId_effectiveDate_idx" ON "PerformanceConditionAssessment"("performanceConditionId", "effectiveDate");

ALTER TABLE "InstrumentTermVersion" ADD COLUMN "performanceConditionId" TEXT REFERENCES "PerformanceCondition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
