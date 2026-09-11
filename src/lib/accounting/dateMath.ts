import { ISODate } from "./types.js";

/** All date math here is calendar-day-based UTC arithmetic — no timezone drift. */
export function toUTCDate(d: ISODate): Date {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

export function daysBetween(a: ISODate, b: ISODate): number {
  const ms = toUTCDate(b).getTime() - toUTCDate(a).getTime();
  return Math.round(ms / 86_400_000);
}

export interface Period {
  label: string;
  start: ISODate;
  end: ISODate;
}

function toISODate(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

/** Adds `n` calendar days (negative to subtract) to an ISODate, in UTC — the building
 * block for any day-by-day iteration, notably `debtAmortization.ts`'s daily-accrual
 * engine. */
export function addDays(d: ISODate, n: number): ISODate {
  const dt = toUTCDate(d);
  dt.setUTCDate(dt.getUTCDate() + n);
  return toISODate(dt);
}

/** Adds `n` calendar months to an ISODate (same day-of-month, month/year rolled
 * forward), in UTC. Uses `Date.UTC`'s own month-overflow normalization (e.g. month 13
 * becomes January of the next year), and lets JS's day-of-month clamping happen
 * naturally for a short month (Jan 31 + 1 month lands on Mar 3, not Feb 28) — same
 * "good enough for vesting dates, not a full calendar library" posture the rest of
 * this file takes. Added for `generateStandardMonthlyTranches` (vesting.ts), which
 * needs "N months after the grant date" for every monthly vesting tranche. */
export function addMonths(d: ISODate, n: number): ISODate {
  const dt = toUTCDate(d);
  dt.setUTCMonth(dt.getUTCMonth() + n);
  return toISODate(dt);
}

/** Adds `n` calendar years to an ISODate (same month/day, year shifted), in UTC — the
 * calendar-anniversary comparison holding-period tests actually use (a "5-year
 * holding period" means "more than 5 years," measured from the exact anniversary
 * date, not a fixed 1,826-day count that would drift a day around leap years).
 * `taxElections.ts`'s QSBS/Section 1202 holding-period tests are the current user. */
export function addYears(d: ISODate, n: number): ISODate {
  const dt = toUTCDate(d);
  dt.setUTCFullYear(dt.getUTCFullYear() + n);
  return toISODate(dt);
}

/** Generates consecutive calendar-year periods from `startDate` (inclusive) to
 * `endDate` (exclusive), labeled "Year 1", "Year 2", etc. — a convenience for API
 * routes and demos; anything reporting on a fiscal calendar should build its own
 * period list aligned to that calendar instead of assuming anniversary-year periods. */
export function buildAnnualPeriods(startDate: ISODate, endDate: ISODate): Period[] {
  const periods: Period[] = [];
  let cursor = toUTCDate(startDate);
  const end = toUTCDate(endDate);
  let i = 1;
  while (cursor < end) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear() + 1, cursor.getUTCMonth(), cursor.getUTCDate()));
    const periodEnd = next < end ? next : end;
    periods.push({ label: `Year ${i}`, start: toISODate(cursor), end: toISODate(periodEnd) });
    cursor = periodEnd;
    i++;
  }
  return periods;
}

/** Generates consecutive calendar-MONTH periods from `startDate` (inclusive) to
 * `endDate` (exclusive), labeled "Month 1", "Month 2", etc. — the natural period
 * granularity for floating-rate debt reported monthly, and a convenient way to build
 * a `periods` argument that deliberately does NOT line up with a loan's rate-reset or
 * payment dates, exercising the daily-accrual engine's actual reason for existing.
 *
 * DELIBERATELY GRANT/ISSUE-DATE-ANCHORED, NOT CALENDAR-MONTH-ALIGNED: a period here
 * is "one month after the previous period," so a March 16 start produces periods
 * 3/16-4/16, 4/16-5/16, etc. — never a stub. That's the whole point of this function
 * (see the debt daily-accrual demo it was built for), but it is the WRONG period
 * builder for anything that reports "amortization for the month of March" — use
 * `buildCalendarMonthlyPeriods` below for that. Kept as-is (not repurposed) so this
 * function's existing callers and tests keep their current, intentional behavior. */
export function buildMonthlyPeriods(startDate: ISODate, endDate: ISODate): Period[] {
  const periods: Period[] = [];
  let cursor = toUTCDate(startDate);
  const end = toUTCDate(endDate);
  let i = 1;
  while (cursor < end) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate()));
    const periodEnd = next < end ? next : end;
    periods.push({ label: `Month ${i}`, start: toISODate(cursor), end: toISODate(periodEnd) });
    cursor = periodEnd;
    i++;
  }
  return periods;
}

/** Generates consecutive CALENDAR-month periods (aligned to the 1st of each month)
 * from `startDate` (inclusive) to `endDate` (exclusive) — "January," "February,"
 * etc., not "one month after the grant." The first period is a STUB running from
 * `startDate` to the 1st of the following month (a March 16 grant's first period is
 * 3/16-4/1 — 16 days of expense, not a full month's worth), and the last period is
 * likewise a stub if `endDate` doesn't itself fall on the 1st (the ordinary case for
 * a service period measured as "N years from the grant date"). Every period in
 * between is a full, ordinary calendar month.
 *
 * This is what `computeFullSchedule` (dispatch.ts) uses for the stock-comp
 * amortization schedule: an equity or debt book closes by CALENDAR month, so "how
 * much expense hit March" has to mean actual March, not "days 1-31 of this grant's
 * own private monthly clock." Nothing about the allocation math changes to support
 * this — `allocateStraightLineByElapsedTime` (allocation.ts) already recognizes
 * expense by ACTUAL ELAPSED CALENDAR DAYS to each period's end date, so simply
 * handing it calendar-aligned (rather than grant-date-anchored) periods is enough:
 * a stub period's smaller day count naturally produces a smaller, correctly
 * pro-rated expense amount, with zero changes needed to the allocation engines
 * themselves — same reasoning as computeFullSchedule's own doc comment on switching
 * from annual to monthly periods in the first place. */
export function buildCalendarMonthlyPeriods(startDate: ISODate, endDate: ISODate): Period[] {
  const periods: Period[] = [];
  let cursor = toUTCDate(startDate);
  const end = toUTCDate(endDate);
  let i = 1;
  while (cursor < end) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const periodEnd = next < end ? next : end;
    periods.push({ label: `Month ${i}`, start: toISODate(cursor), end: toISODate(periodEnd) });
    cursor = periodEnd;
    i++;
  }
  return periods;
}
