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
 * payment dates, exercising the daily-accrual engine's actual reason for existing. */
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
