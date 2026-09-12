import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { InstrumentTypeForDispatch } from "@/lib/accounting/dispatch";
import { validateInstrumentTerms, TermsValidationError } from "@/lib/accounting/termsValidation";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";
import { approveAmortizationScheduleIfApplicable } from "@/lib/db/amortizationSchedule";

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
 *
 * INTENDED to be called after POST /api/instruments/:id/modifications/preview with
 * the same `effectiveDate`/`terms` — see that route and previewModificationImpact's
 * doc comment. Not enforced (same non-enforced-but-intended relationship as
 * corrections/preview → corrections/commit), but the UI's Modify flow always calls
 * preview first and only enables this call once a preview has been shown. Committing
 * IS this modification's one required approval: right after creating the new term
 * version, this also generates and persists the resulting AmortizationScheduleApproval
 * (for types that have one) in the same request — a person who has just reviewed the
 * impact and chosen to commit it shouldn't need a THIRD click to separately "approve"
 * what they just approved by committing. See amortizationSchedule.ts's top-of-file
 * doc comment for why this differs from initial grant creation, which still requires
 * its own separate approval step.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}));
  const { effectiveDate, label, terms, performanceConditionId } = body ?? {};

  if (!effectiveDate || !label || terms === undefined) {
    return NextResponse.json({ error: "effectiveDate, label, and terms are all required" }, { status: 400 });
  }

  const instrument = await db.instrument.findUnique({ where: { id: params.id } });
  if (!instrument) {
    return NextResponse.json({ error: `No instrument found with id "${params.id}"` }, { status: 404 });
  }

  const access = await requireApiEntityAccess(req, instrument.entityId, "EDITOR");
  if (access instanceof NextResponse) return access;

  // v0.38.0 — same optional shared-PerformanceCondition link POST /api/instruments
  // accepts on origination (see that route's doc comment); a modification can link
  // this era to a (possibly different, or newly-created) condition just as freely.
  if (performanceConditionId !== undefined && performanceConditionId !== null) {
    if (typeof performanceConditionId !== "string") {
      return NextResponse.json({ error: "performanceConditionId must be a string if provided" }, { status: 400 });
    }
    const condition = await db.performanceCondition.findFirst({ where: { id: performanceConditionId, entityId: instrument.entityId } });
    if (!condition) {
      return NextResponse.json({ error: `No performance condition found with id "${performanceConditionId}" on this entity` }, { status: 400 });
    }
  }

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
      performanceConditionId: performanceConditionId ?? undefined,
    },
  });

  // See this route's doc comment above: committing (this call) is the one approval
  // this modification gets, since it's only reachable after the preview route has
  // already shown its impact. Recomputes from THIS new version (now the latest), so
  // any prior approval is superseded by a fresh one covering the amended terms.
  const amortizationSchedule = await approveAmortizationScheduleIfApplicable(params.id, access.user.id);

  // Recomputing and persisting the resulting ScheduleEntry/JournalEntry rows from here
  // (via recomputeSchedule in modificationEngine.ts) is the natural next step, deliberately
  // left as a follow-up: it needs a per-InstrumentType dispatch to the right engine
  // function (vesting vs. debt vs. warrant), which belongs in its own service module
  // rather than inline in a route handler.
  return NextResponse.json({ version, amortizationSchedule }, { status: 201 });
}
