-- Run this ONCE against your already-live Supabase database (SQL Editor -> paste ->
-- Run). It adds everything the v0.35.0 "stakeholder/investor self-service portal"
-- feature needs: three brand-new tables. Nothing here touches, renames, or adds a
-- column to any existing table, so this is safe to run against a database with real
-- data in it already — nothing existing is affected until you start inviting
-- stakeholders to the portal.
--
-- These are the exact same statements now folded into db/schema.sql for anyone
-- setting up a brand-new database from scratch — see that file's comments right above
-- the matching block, and prisma/schema.prisma's doc comment on StakeholderUser for
-- the full design and why a Stakeholder row doesn't just get a password column
-- directly (one real person can be a stakeholder of more than one Entity, and needs
-- one login across all of them, mirroring how User/EntityAccess already works for
-- admins).
--
-- Safe to run alongside (before or after) db/migrations/2026-09-add-default-entity.sql,
-- db/migrations/2026-09-amortization-schedule-approval.sql, and
-- db/migrations/2026-09-option-tax-compliance.sql — none of these migrations touch
-- each other.
--
-- SECURITY NOTE: "PortalInvite"."tokenHash" stores only a SHA-256 hash of the raw,
-- high-entropy invite token — the raw token itself is never written to this database
-- (it only ever appears in the one-time URL the admin copies and sends). This mirrors
-- the at-rest-leak reasoning behind password hashing elsewhere in this schema, but
-- uses a fast hash rather than scrypt, since the input here is already a 256-bit
-- random value with no small guessable space to defend against — see
-- src/lib/auth/portalInvite.ts's doc comment for the full reasoning.

CREATE TABLE "StakeholderUser" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  "passwordHash" TEXT,
  "sessionVersion" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "StakeholderAccess" (
  "id" TEXT PRIMARY KEY,
  "stakeholderUserId" TEXT NOT NULL REFERENCES "StakeholderUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "stakeholderId" TEXT NOT NULL REFERENCES "Stakeholder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("stakeholderUserId", "stakeholderId")
);
CREATE INDEX "StakeholderAccess_stakeholderId_idx" ON "StakeholderAccess"("stakeholderId");

CREATE TABLE "PortalInvite" (
  "id" TEXT PRIMARY KEY,
  "stakeholderId" TEXT NOT NULL REFERENCES "Stakeholder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "tokenHash" TEXT NOT NULL UNIQUE,
  "createdByUserId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "acceptedByUserId" TEXT REFERENCES "StakeholderUser"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PortalInvite_stakeholderId_idx" ON "PortalInvite"("stakeholderId");
