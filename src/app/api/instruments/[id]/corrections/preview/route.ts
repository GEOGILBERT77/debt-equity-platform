import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { previewCorrection } from "@/lib/accounting/correctionService";
import { getScheduleBuilder, buildVisiblePeriods, InstrumentTypeForDispatch } from "@/lib/accounting/dispatch";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

/**
 * POST /api/instruments/:id/corrections/preview
 *   { "targetEffectiveDate": "YYYY-MM-DD", "correctedTerms": {...}, "reason": "...", "through": "YYYY-MM-DD" }
 *
 * Computes the impact of a correction WITHOUT writing anything to the database — this
 * is the "run it and view the impact" step from the actual ask. Nothing here is
 * persisted; the response is what a human uses to make the materiality call and elect
 * PROSPECTIVE or RETROSPECTIVE before calling the commit route below with the same
 * inputs plus their election.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}));
  const { targetEffectiveDate, correctedTerms, through } = body ?? {};

  if (!targetEffectiveDate || correctedTerms === undefined) {
    return NextResponse.json({ error: "targetEffectiveDate and correctedTerms are both required" }, { status: 400 });
  }

  const instrument = await db.instrument.findUnique({
    where: { id: params.id },
    include: { termVersions: { orderBy: { effectiveDate: "asc" } } },
  });
  if (!instrument) {
    return NextResponse.json({ error: `No instrument found with id "${params.id}"` }, { status: 404 });
  }

  // Corrections are an EDITOR-or-above workflow end to end — the preview step exposes
  // exactly the same restated numbers the commit step would book, so it gets the same
  // bar rather than being treated as a plain read.
  const access = await requireApiEntityAccess(req, instrument.entityId, "EDITOR");
  if (access instanceof NextResponse) return access;

  const lastClosed = await db.scheduleEntry.findFirst({
    where: { instrumentId: instrument.id, supersededByCorrectionId: null },
    orderBy: { periodEnd: "desc" },
  });
  if (!lastClosed) {
    return NextResponse.json(
      { error: "This instrument has no closed periods yet — there's nothing to correct. Use /close for periods that haven't been reported on yet." },
      { status: 409 }
    );
  }
  const alreadyClosedThroughPeriodEnd = lastClosed.periodEnd.toISOString().slice(0, 10);

  try {
    const type = instrument.type as InstrumentTypeForDispatch;
    const termVersions = instrument.termVersions.map((v) => ({
      effectiveDate: v.effectiveDate.toISOString().slice(0, 10),
      label: v.label,
      terms: v.terms,
    }));
    // buildVisiblePeriods (not a manually-truncated buildAnnualPeriods) — see
    // dispatch.ts's CORRECTNESS NOTE. previewCorrection compares the original and
    // corrected schedules only up through alreadyClosedThroughPeriodEnd, but the
    // periods array itself still needs to extend to the instrument's true natural end
    // (or a remainder-allocation engine's comparison would be corrupted the same way
    // computeVisibleSchedule's would), and still needs alreadyClosedThroughPeriodEnd
    // itself split out as an exact period boundary (in case `through` doesn't land
    // exactly there) so the closed-vs-not-yet-closed split is unambiguous.
    const periods = buildVisiblePeriods(type, termVersions, through ?? new Date().toISOString().slice(0, 10), [
      alreadyClosedThroughPeriodEnd,
    ]);
    const builder = getScheduleBuilder(type);
    const preview = previewCorrection(
      termVersions,
      targetEffectiveDate,
      correctedTerms,
      periods,
      alreadyClosedThroughPeriodEnd,
      builder
    );

    return NextResponse.json({
      perPeriodDeltas: preview.perPeriodDeltas.map((d) => ({
        label: d.label,
        periodEnd: d.periodEnd,
        originalAmount: d.originalAmount.toFixed(2),
        correctedAmount: d.correctedAmount.toFixed(2),
        delta: d.delta.toFixed(2),
      })),
      cumulativeDelta: preview.cumulativeDelta.toFixed(2),
      // Echoed back so the commit call doesn't have to recompute it, and so the
      // Correction.previewSnapshot written at commit time is exactly what was shown here.
      correctionInputs: { targetEffectiveDate, correctedTerms, through: through ?? null },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute correction preview" }, { status: 400 });
  }
}
