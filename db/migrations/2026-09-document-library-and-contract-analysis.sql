-- v0.47.0 — George, verbatim: build "the functionality that allows users to upload a
-- contract and the platform identifies what it is... proposes accounting treatment and
-- memo justification," plus a real "document library" ("retaining all
-- contracts/agreements and linking to investors in the cap table"). See the doc
-- comments on Document/DocumentVersion/ContractAnalysis in prisma/schema.prisma for
-- the full reasoning.
--
-- Run this once against your live Supabase database via the SQL Editor. Purely
-- additive/relaxing (one column is widened from NOT NULL to nullable; everything else
-- is a new column or new table) — safe to run against a database already in use.
--
-- BEFORE this does anything useful, you also need to do two things outside the
-- database (see the README's new "Document library & contract analysis" section for
-- the full walkthrough):
--   1. Create a PRIVATE Supabase Storage bucket (Storage -> New bucket -> name it
--      "contracts" -> leave "Public" OFF) and set SUPABASE_URL/
--      SUPABASE_SERVICE_ROLE_KEY as Vercel environment variables.
--   2. Get an Anthropic API key (console.anthropic.com) and set ANTHROPIC_API_KEY as a
--      Vercel environment variable (ANTHROPIC_MODEL is optional, defaults to
--      "claude-sonnet-5").

-- Document: was vendor-pointer-only (see design note #3 at the top of schema.prisma) —
-- now also supports files this app stores itself, linked to a specific investor.
ALTER TABLE "Document" ADD COLUMN "stakeholderId" TEXT REFERENCES "Stakeholder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Document" ADD COLUMN "category" TEXT;
ALTER TABLE "Document" ADD COLUMN "uploadedByUserId" TEXT REFERENCES "User"("id");
CREATE INDEX "Document_stakeholderId_idx" ON "Document"("stakeholderId");

-- DocumentVersion: "storageUrl" was required (a vendor pointer always existed); it's
-- now optional because a self-uploaded file uses "storagePath" instead.
ALTER TABLE "DocumentVersion" ALTER COLUMN "storageUrl" DROP NOT NULL;
ALTER TABLE "DocumentVersion" ADD COLUMN "storagePath" TEXT;
ALTER TABLE "DocumentVersion" ADD COLUMN "mimeType" TEXT;
ALTER TABLE "DocumentVersion" ADD COLUMN "fileSizeBytes" INTEGER;

-- ContractAnalysis: the AI-proposed classification/treatment/memo for one uploaded
-- DocumentVersion. See its doc comment in prisma/schema.prisma — this is a proposal
-- for a qualified accountant to review, never auto-applied anywhere else in this app.
CREATE TYPE "ContractAnalysisStatus" AS ENUM ('PENDING', 'ANALYZING', 'ANALYZED', 'FAILED');

CREATE TABLE "ContractAnalysis" (
  "id" TEXT PRIMARY KEY,
  "documentVersionId" TEXT NOT NULL REFERENCES "DocumentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "entityId" TEXT NOT NULL REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "memoRequested" BOOLEAN NOT NULL DEFAULT false,
  "status" "ContractAnalysisStatus" NOT NULL DEFAULT 'PENDING',
  "identifiedInstrumentType" TEXT,
  "confidence" TEXT,
  "summary" TEXT,
  "keyTerms" JSONB,
  "ascReferences" JSONB,
  "initialTreatment" TEXT,
  "subsequentTreatment" TEXT,
  "openQuestions" JSONB,
  "memoDraft" TEXT,
  "errorMessage" TEXT,
  "requestedByUserId" TEXT REFERENCES "User"("id"),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "analyzedAt" TIMESTAMP(3)
);
CREATE INDEX "ContractAnalysis_documentVersionId_idx" ON "ContractAnalysis"("documentVersionId");
CREATE INDEX "ContractAnalysis_entityId_idx" ON "ContractAnalysis"("entityId");
