import { ISODate } from "./types.js";
import { Period } from "./dateMath.js";

/**
 * v0.38.0 — SHARED PERFORMANCE CONDITION TRACKING.
 *
 * Before this, a performance-condition stock option's probability-of-vesting history
 * lived entirely inline on that one grant's own terms
 * (StockOptionPerformanceConditionTerms.probabilityAssessments — dispatch.ts), as a
 * ONE-ENTRY-PER-PERIOD array matched positionally to whatever periods that grant's
 * current term version governs. That's still exactly how a grant NOT linked to a
 * shared condition works, and still exactly what `buildPerformanceConditionSchedule`
 * (vesting.ts) and `getScheduleBuilder`'s STOCK_OPTION branch (dispatch.ts) consume —
 * neither of those changed for this feature.
 *
 * What's new: several grants can now share ONE real `PerformanceCondition` record
 * (prisma/schema.prisma) — e.g. three different employees' options that all vest on
 * the same "Apr 2026 EBITDA target" — with ONE append-only, DATED history of
 * probability calls against it (`PerformanceConditionAssessment`: "as of March 2026,
 * this looked probable"; "as of June 2026, no longer probable"), rather than each
 * grant's own copy having to be updated by hand every time the assessment changes.
 *
 * This function is the bridge between the two: it takes that dated, sparse history
 * (assessments don't need one entry per period — just one entry per time the
 * assessment actually changed) and a concrete `periods` array, and produces the
 * positional per-period array the existing engine already knows how to consume. The
 * engine itself needed ZERO changes — this only feeds it the same shape it always
 * expected, computed from a different source.
 */
export interface PerformanceConditionAssessmentInput {
  effectiveDate: ISODate;
  probable: boolean;
}

/**
 * For each period, finds the assessment most recently effective ON OR BEFORE that
 * period's END date — an assessment recorded partway through a period is treated as
 * governing that whole period, the same "period is the unit of accounting judgment"
 * granularity `buildPerformanceConditionSchedule` already applies everywhere else.
 * A period with no assessment on file yet as of its end date (before the condition's
 * very first recorded assessment, e.g. between grant date and the first quarter-end
 * review) defaults to `probable: false` — the same conservative default
 * `getScheduleBuilder`'s existing `t.probabilityAssessments[i]?.probable ?? false`
 * fallback already uses for a missing entry.
 *
 * `assessments` does not need to be pre-sorted or de-duplicated by date — this sorts
 * defensively and, when two assessments share an effective date, the LAST one in
 * input order wins (matches PerformanceConditionAssessment being append-only: a
 * corrective re-assessment recorded the same day as an earlier one supersedes it).
 */
export function resolvePerformanceConditionProbabilities(
  assessments: PerformanceConditionAssessmentInput[],
  periods: Period[]
): { date: ISODate; probable: boolean }[] {
  const sorted = [...assessments].sort((a, b) =>
    a.effectiveDate < b.effectiveDate ? -1 : a.effectiveDate > b.effectiveDate ? 1 : 0
  );

  return periods.map((period) => {
    let current: PerformanceConditionAssessmentInput | undefined;
    for (const assessment of sorted) {
      if (assessment.effectiveDate <= period.end) {
        current = assessment;
      } else {
        break;
      }
    }
    return { date: period.end, probable: current?.probable ?? false };
  });
}
