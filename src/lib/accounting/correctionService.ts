import { ScheduleRow, JournalEntry, Decimal, Money } from "./types.js";
import { Period } from "./dateMath.js";
import { InstrumentTimeline, TermVersion, recomputeSchedule } from "./modificationEngine.js";
import { journalEntryForRow, InstrumentTypeForDispatch } from "./dispatch.js";

/**
 * Error correction is a DIFFERENT concept from a modification, even though both touch
 * an instrument's term history, and they deliberately go through different code paths:
 *
 *  - A modification (modificationEngine.ts) is a real change in terms that happened at
 *    a point in time — a repricing, an amendment. It's always forward-dated, and the
 *    original terms stay correct for everything before that date, because they WERE
 *    correct at the time.
 *  - A correction is fixing a mistake in what was recorded — the original terms were
 *    wrong from the start. There's no new "as of" date; the fix applies to the same
 *    effective date the erroneous version already occupied.
 *
 * The workflow this file supports, per the actual ask: compute the impact of a
 * correction WITHOUT committing anything (`previewCorrection`), so a human can look at
 * the size of the impact and make the materiality call themselves — this engine
 * deliberately does not embed a materiality threshold, because that's a professional
 * judgment call, not a number to hardcode — and only then choose how to book it:
 * `buildProspectiveCorrectionEntry` (fix the cumulative effect in the current open
 * period, closed periods stay exactly as reported) or `buildRetrospectiveCorrectionBatch`
 * (per ASC 250: restate the affected closed periods themselves). Neither commit path
 * touches a database — see the API routes for how the persistence layer keeps the
 * original (superseded) rows alongside the new ones rather than overwriting anything,
 * which is what makes "retrospective" mean restatement and not silent history rewriting.
 */

export interface PeriodDelta {
  label: string;
  periodEnd: string;
  originalAmount: Money;
  correctedAmount: Money;
  delta: Money;
}

export interface CorrectionPreview {
  /** One row per already-closed period, showing exactly what would change. This is
   * the "run it and view the impact" step — nothing here is persisted. */
  perPeriodDeltas: PeriodDelta[];
  /** Sum of every closed period's delta — the number that would be booked as a single
   * adjusting entry if the correction is elected as prospective. */
  cumulativeDelta: Money;
  /** The corrected schedule rows for the closed periods, ready to hand to
   * `buildRetrospectiveCorrectionBatch` if the correction is elected as retrospective —
   * computed once here so the commit step doesn't have to recompute it. */
  correctedClosedRows: ScheduleRow[];
}

/** Replaces the version at `targetEffectiveDate` with `correctedTerms`, in a NEW array
 * — the original `versions` array is untouched, since it represents what was actually
 * recorded and reported, and stays available for the audit trail regardless of what
 * gets elected. Throws if no version exists at that exact date, since a correction
 * targets a specific recorded mistake, not a new point in time. */
function buildCorrectedVersions<T>(versions: readonly TermVersion<T>[], targetEffectiveDate: string, correctedTerms: T): TermVersion<T>[] {
  const targetIndex = versions.findIndex((v) => v.effectiveDate === targetEffectiveDate);
  if (targetIndex === -1) {
    throw new Error(`No term version found with effectiveDate "${targetEffectiveDate}" to correct`);
  }
  return versions.map((v, i) => (i === targetIndex ? { ...v, terms: correctedTerms, label: `${v.label} (corrected)` } : v));
}

export function previewCorrection<T>(
  originalVersions: TermVersion<T>[],
  targetEffectiveDate: string,
  correctedTerms: T,
  periods: Period[],
  alreadyClosedThroughPeriodEnd: string,
  scheduleBuilder: (terms: T, periodsForEra: Period[]) => ScheduleRow[]
): CorrectionPreview {
  const originalTimeline = InstrumentTimeline.fromVersions(originalVersions);
  const originalSchedule = recomputeSchedule(originalTimeline, periods, scheduleBuilder);

  const correctedVersions = buildCorrectedVersions(originalVersions, targetEffectiveDate, correctedTerms);
  const correctedTimeline = InstrumentTimeline.fromVersions(correctedVersions);
  const correctedSchedule = recomputeSchedule(correctedTimeline, periods, scheduleBuilder);

  const closedOriginal = originalSchedule.filter((r) => r.periodEnd <= alreadyClosedThroughPeriodEnd);
  const closedCorrected = correctedSchedule.filter((r) => r.periodEnd <= alreadyClosedThroughPeriodEnd);

  if (closedOriginal.length !== closedCorrected.length) {
    // A correction should never change which periods exist, only their amounts — if
    // it does, the corrected terms describe a different instrument, not a fix.
    throw new Error("Corrected terms produced a different number of closed periods than the original — refusing to preview");
  }

  const perPeriodDeltas: PeriodDelta[] = closedOriginal.map((original, i) => {
    const corrected = closedCorrected[i];
    return {
      label: original.label,
      periodEnd: original.periodEnd,
      originalAmount: original.amount,
      correctedAmount: corrected.amount,
      delta: corrected.amount.minus(original.amount),
    };
  });

  const cumulativeDelta = perPeriodDeltas.reduce((sum, d) => sum.plus(d.delta), new Decimal(0));

  return { perPeriodDeltas, cumulativeDelta, correctedClosedRows: closedCorrected };
}

/** Prospective election: one adjusting entry for the cumulative effect, dated in the
 * current still-open period. Every already-closed ScheduleEntry/JournalEntry stays
 * exactly as originally committed — this function doesn't touch them, and the API
 * route built on top of it shouldn't either. */
export function buildProspectiveCorrectionEntry(
  instrumentType: InstrumentTypeForDispatch,
  cumulativeDelta: Money,
  currentOpenPeriodEnd: string,
  reason: string
): JournalEntry {
  const syntheticRow: ScheduleRow = {
    periodStart: currentOpenPeriodEnd,
    periodEnd: currentOpenPeriodEnd,
    label: "Out-of-period correction (prospective)",
    amount: cumulativeDelta,
    meta: { ascReference: "ASC 250 (correction of an error, immaterial — current period)", reason },
  };
  return journalEntryForRow(instrumentType, syntheticRow);
}

export interface RetrospectiveCorrectionBatch {
  restatedScheduleRows: ScheduleRow[];
  restatedJournalEntries: JournalEntry[];
}

/** Retrospective election: the closed periods themselves get restated. This function
 * only computes what the NEW rows should be — marking the OLD rows as superseded
 * (rather than deleting them) is a database-layer concern, done in the API route, so
 * that the original as-reported numbers stay in the audit trail per ASC 250 rather
 * than disappearing. */
export function buildRetrospectiveCorrectionBatch(
  instrumentType: InstrumentTypeForDispatch,
  correctedClosedRows: ScheduleRow[]
): RetrospectiveCorrectionBatch {
  return {
    restatedScheduleRows: correctedClosedRows,
    restatedJournalEntries: correctedClosedRows.map((row) => journalEntryForRow(instrumentType, row)),
  };
}
