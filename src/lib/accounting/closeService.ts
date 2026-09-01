import { ScheduleRow, JournalEntry } from "./types.js";
import { journalEntryForRow, InstrumentTypeForDispatch } from "./dispatch.js";

/**
 * The pure logic behind "closing" a period for an instrument — persisted separately
 * from the actual database writes (see the API route) so it can be unit-tested without
 * a live Postgres instance, and so the rule "never re-commit a period that's already
 * closed" lives in one obviously-testable place rather than being buried in a route
 * handler's query logic.
 *
 * WHY THIS EXISTS, SEPARATE FROM THE LIVE SCHEDULE ENDPOINT: the live
 * `/api/instruments/:id/schedule` route recomputes from scratch on every call — correct
 * for a preview, wrong for a report. Once a period is closed, its numbers have to stop
 * moving even if the calculation engine's logic changes later (an ASC-treatment bug fix
 * six months from now should never silently rewrite a quarter you already reported on).
 * Closing is what freezes a period's numbers into a permanent, queryable record.
 */

/** Given the full recomputed schedule and the periodEnd date of the last period
 * already committed (or null if none has been committed yet), returns only the rows
 * that are new — i.e. haven't been persisted before. Idempotent: calling this twice
 * with the same `alreadyClosedThroughPeriodEnd` and the same schedule returns nothing
 * the second time, once the caller has actually persisted the first batch and updated
 * the cutoff accordingly. */
export function determineNewPeriods(
  fullSchedule: ScheduleRow[],
  alreadyClosedThroughPeriodEnd: string | null
): ScheduleRow[] {
  if (alreadyClosedThroughPeriodEnd === null) return fullSchedule;
  return fullSchedule.filter((row) => row.periodEnd > alreadyClosedThroughPeriodEnd);
}

export interface CloseResult {
  newScheduleRows: ScheduleRow[];
  journalEntries: JournalEntry[];
}

/** Combines determineNewPeriods with the journal-entry dispatch: this is the single
 * function a "close this instrument through date X" API route should call to find out
 * exactly what needs to be written to the database. It does not touch the database
 * itself — the caller is responsible for the actual insert, ideally inside one
 * transaction so a partial close (schedule rows written, journal entries not) can
 * never happen. */
export function computeCloseBatch(
  instrumentType: InstrumentTypeForDispatch,
  fullSchedule: ScheduleRow[],
  alreadyClosedThroughPeriodEnd: string | null
): CloseResult {
  const newScheduleRows = determineNewPeriods(fullSchedule, alreadyClosedThroughPeriodEnd);
  const journalEntries = newScheduleRows.map((row) => journalEntryForRow(instrumentType, row));
  return { newScheduleRows, journalEntries };
}
