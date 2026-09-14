-- v0.46.0 — "beginning balance, additions, exercises, forfeitures, etc." (George,
-- verbatim, on the new ASC 718/SEC-10-K award activity roll-forward report). Adds a
-- real, append-only event log for forfeitures/expirations — the one reduction
-- OptionExerciseEvent doesn't cover — so the roll-forward's "Forfeited"/"Expired"
-- columns are backed by real recorded data instead of a hand-entered number. See
-- InstrumentForfeitureEvent's doc comment in prisma/schema.prisma for the full
-- reasoning (why this needed a new event log rather than reusing InstrumentStatus).
--
-- Run this once against your live Supabase database via the SQL Editor (Supabase
-- dashboard → SQL Editor → paste and run). Purely additive — no existing table,
-- column, or row is touched, so this is safe to run against a database already in use.

CREATE TYPE "ForfeitureEventType" AS ENUM ('FORFEITED', 'EXPIRED');

CREATE TABLE "InstrumentForfeitureEvent" (
  "id" TEXT PRIMARY KEY,
  "instrumentId" TEXT NOT NULL REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "forfeitureDate" TIMESTAMP(3) NOT NULL,
  "quantityForfeited" NUMERIC(24,6) NOT NULL,
  "eventType" "ForfeitureEventType" NOT NULL DEFAULT 'FORFEITED',
  "reason" TEXT,
  "recordedByUserId" TEXT REFERENCES "User"("id"),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "InstrumentForfeitureEvent_instrumentId_idx" ON "InstrumentForfeitureEvent"("instrumentId");
CREATE INDEX "InstrumentForfeitureEvent_forfeitureDate_idx" ON "InstrumentForfeitureEvent"("forfeitureDate");
