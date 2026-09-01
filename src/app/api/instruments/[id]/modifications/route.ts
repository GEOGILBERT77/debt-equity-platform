import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { InstrumentTypeForDispatch } from "@/lib/accounting/dispatch";
import { validateInstrumentTerms, TermsValidationError } from "@/lib/accounting/termsValidation";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

/**
 * POST /api/instruments/:id/modifications
 * Records a modification as a NEW InstrumentTermVersion row — this route is the API
 * surface of the "modification handling" architecture requirement: it only ever
 * inserts, never updates an existing term version, and it enforces the same
 * chronological-order rule that InstrumentTimeline.applyModification enforces in the
 * calculation engine (src/lib/accounting/modificationEngine.ts). Keeping the guard in
 * both places is deliberate — the API shouldn't trust the engine to be the only thing
 * standing between a client and a backdated modification.
 *
 * VALIDATES `terms` against the instrument's own type before inserting — see
 * termsValidation.ts. A modification's terms must match the same shape the original
 * terms did (the instrument's type never changes), so this looks up the instrument
 * just to read its `type`, same as every other route that computes or validates
 * against terms. Requires at least EDITOR on the instrument's entity — the instrument
 * has to be looked up first regardless (to read its type/entityId), so the access
 * check and the "does this even exist" 404 share one query below.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}));
  const { effectiveDate, label, terms } = body ?? {};

  if (!effectiveDate || !label || terms === undefined) {
    return NextResponse.json({ error: "effectiveDate, label, and terms are all required" }, { status: 400 });
  }

  const instrument = await db.instrument.findUnique({ where: { id: params.id } });
  if (!instrument) {
    return NextResponse.json({ error: `No instrument found with id "${params.id}"` }, { status: 404 });
  }

  const access = await requireApiEntityAccess(req, instrument.entityId, "EDITOR");
  if (access instanceof NextResponse) return access;

  try {
    validateInstrumentTerms(instrument.type as InstrumentTypeForDispatch, terms);
  } catch (err) {
    if (err instanceof TermsValidationError) {
      return NextResponse.json({ error: err.message, issues: err.issues }, { status: 400 });
    }
    throw err;
  }

  const latest = await db.instrumentTermVersion.findFirst({
    where: { instrumentId: params.id },
    orderBy: { effectiveDate: "desc" },
  });

  const newEffectiveDate = new Date(effectiveDate);
  if (latest && newEffectiveDate <= latest.effectiveDate) {
    return NextResponse.json(
      {
        error: `Modification effective date must be after the most recent version (${latest.effectiveDate.toISOString()}). Amendments are recorded chronologically, never inserted retroactively.`,
      },
      { status: 409 }
    );
  }

  const version = await db.instrumentTermVersion.create({
    data: {
      instrumentId: params.id,
      effectiveDate: newEffectiveDate,
      label,
      terms,
      // v0.19.0 audit-trail attribution — see prisma/schema.prisma's doc comment.
      createdByUserId: access.user.id,
    },
  });

  // Recomputing and persisting the resulting ScheduleEntry/JournalEntry rows from here
  // (via recomputeSchedule in modificationEngine.ts) is the natural next step, deliberately
  // left as a follow-up: it needs a per-InstrumentType dispatch to the right engine
  // function (vesting vs. debt vs. warrant), which belongs in its own service module
  // rather than inline in a route handler.
  return NextResponse.json({ version }, { status: 201 });
}
