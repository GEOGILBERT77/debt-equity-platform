import { ScheduleRow, ISODate, Money, money, Decimal, DecimalValue } from "./types.js";
import { Period } from "./dateMath.js";

/**
 * Generic modification/replay engine — this is the piece of infrastructure the
 * "Modification Handling" requirement was actually asking for. It doesn't know
 * anything about vesting or debt; it just enforces the four architecture rules on
 * whatever instrument-specific schedule builder you hand it:
 *
 *   1. Version the terms, never overwrite them        -> InstrumentTimeline is append-only
 *   2. Recompute by replay, not by patching            -> re-invokes `scheduleBuilder` per era
 *   3. History stays closed, only the future changes   -> earlier eras are never re-passed
 *      periods governed by a later version
 *   4. The modification date is an input, not a branch -> effectiveDate just shifts the
 *      period grouping boundary, no new code path per modification
 *
 * ASSUMPTION: modification effective dates align to a period boundary (a period's
 * `start` date). A modification effective mid-period is a real scenario (pro-rating a
 * partial period across two term versions) but is out of scope here — flag it rather
 * than silently misallocating a partial period.
 */
export interface TermVersion<T> {
  effectiveDate: ISODate;
  terms: T;
  /** Free-form label for audit trail — e.g. "Original grant", "Repricing 2027-03-01" */
  label: string;
}

export class InstrumentTimeline<T> {
  private versions: TermVersion<T>[];

  constructor(initialTerms: T, effectiveDate: ISODate, label = "Original terms") {
    this.versions = [{ effectiveDate, terms: initialTerms, label }];
  }

  /** Append-only: the original terms and every prior modification remain exactly as
   * recorded. This throws rather than silently reordering if a caller tries to insert
   * a modification earlier than one already on file. */
  applyModification(terms: T, effectiveDate: ISODate, label: string): void {
    const last = this.versions[this.versions.length - 1];
    if (effectiveDate <= last.effectiveDate) {
      throw new Error(
        `Modification effective date (${effectiveDate}) must be after the most recent version (${last.effectiveDate}). ` +
          `Amendments are recorded in chronological order, never inserted retroactively.`
      );
    }
    this.versions.push({ effectiveDate, terms, label });
  }

  getVersions(): readonly TermVersion<T>[] {
    return [...this.versions];
  }

  /** Builds a timeline from an already-known, already-ordered list of versions —
   * used by correctionService.ts to construct a hypothetical "as corrected" timeline
   * for comparison against the real one, without going through applyModification's
   * one-at-a-time chronological-order dance. Still enforces strictly increasing
   * effective dates, since a timeline with two versions on the same date is exactly
   * the ambiguity `versionActiveOn` isn't designed to resolve. */
  static fromVersions<T>(versions: TermVersion<T>[]): InstrumentTimeline<T> {
    if (versions.length === 0) throw new Error("A timeline needs at least one term version");
    const [first, ...rest] = versions;
    const timeline = new InstrumentTimeline<T>(first.terms, first.effectiveDate, first.label);
    for (const v of rest) timeline.applyModification(v.terms, v.effectiveDate, v.label);
    return timeline;
  }

  versionActiveOn(date: ISODate): TermVersion<T> {
    let active = this.versions[0];
    for (const v of this.versions) {
      if (v.effectiveDate <= date) active = v;
      else break;
    }
    return active;
  }
}

/** Splits `periods` into contiguous runs, one per term version that governs them,
 * based on each period's start date. */
function groupPeriodsByVersion<T>(
  timeline: InstrumentTimeline<T>,
  periods: Period[]
): { version: TermVersion<T>; periods: Period[] }[] {
  const groups: { version: TermVersion<T>; periods: Period[] }[] = [];
  for (const period of periods) {
    const version = timeline.versionActiveOn(period.start);
    const currentGroup = groups[groups.length - 1];
    if (currentGroup && currentGroup.version === version) {
      currentGroup.periods.push(period);
    } else {
      groups.push({ version, periods: [period] });
    }
  }
  return groups;
}

/** Replays the schedule across every term version in the timeline, calling
 * `scheduleBuilder` once per contiguous era with that era's own terms and only the
 * periods it governs. Concatenates the results in order — periods already computed
 * under an earlier version are never recomputed once a later version takes over. */
export function recomputeSchedule<T>(
  timeline: InstrumentTimeline<T>,
  periods: Period[],
  scheduleBuilder: (terms: T, periodsForEra: Period[]) => ScheduleRow[]
): ScheduleRow[] {
  const groups = groupPeriodsByVersion(timeline, periods);
  return groups.flatMap((group) =>
    scheduleBuilder(group.version.terms, group.periods).map((row) => ({
      ...row,
      meta: { ...row.meta, termVersionLabel: group.version.label },
    }))
  );
}

/** ASC 718-20-35: a modification that increases an award's fair value recognizes the
 * incremental value over the remaining service period; a modification that decreases
 * fair value is NOT reversed — the original grant-date value keeps being recognized. */
export function computeIncrementalFairValue(originalFairValue: DecimalValue, modifiedFairValue: DecimalValue): Money {
  const incremental = new Decimal(modifiedFairValue).minus(originalFairValue);
  return money(Decimal.max(incremental, 0));
}
