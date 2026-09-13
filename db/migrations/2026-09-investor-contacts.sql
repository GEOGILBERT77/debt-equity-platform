-- Run this ONCE against your already-live Supabase database (SQL Editor -> paste ->
-- Run). It adds everything the v0.44.0 "Investor Contacts" feature needs: one new
-- enum and two new nullable columns on the existing "Stakeholder" table. Nothing here
-- renames or removes anything, and the new columns are nullable with no default
-- required, so this is safe to run against a database with real stakeholders already
-- in it — every existing row just gets NULL for both new columns until someone fills
-- them in via the "Edit" control on the cap table's stakeholder table (or the "New
-- stakeholder" form for a new one).
--
-- These are the exact same statements now folded into db/schema.sql for anyone
-- setting up a brand-new database from scratch — see that file's comments right above
-- the matching lines, and prisma/schema.prisma's doc comments on the InvestorType enum
-- and on Stakeholder.investorType/contactName for the full reasoning (why this is a
-- separate enum from StakeholderType, and why an institution needs its own
-- `contactName` distinct from its `name`).
--
-- Safe to run alongside (before or after) every other migration in this folder — none
-- of them touch the "Stakeholder" table's investorType/contactName columns.

CREATE TYPE "InvestorType" AS ENUM ('INDIVIDUAL', 'INSTITUTION');

ALTER TABLE "Stakeholder" ADD COLUMN "investorType" "InvestorType";
ALTER TABLE "Stakeholder" ADD COLUMN "contactName" TEXT;
