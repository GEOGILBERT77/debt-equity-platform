import { Money, ISODate, Decimal } from "./types.js";
import { daysBetween, Period } from "./dateMath.js";

/** Allocates `total` straight-line across `periods` by elapsed calendar days between
 * `serviceStart` and `serviceEnd`, assigning any rounding remainder to the final
 * period so the schedule always ties out exactly to `total`. Pass only the periods
 * that actually overlap [serviceStart, serviceEnd] when allocating something that
 * doesn't span the full periods array (a graded vesting tranche, a fee tranche added
 * partway through a facility's life) — `elapsedDays` is measured from `serviceStart`
 * to each period's own end, so a period that starts before `serviceStart` is handled
 * correctly (clamped at 0), but a period entirely after `serviceEnd` should not be
 * included or it will incorrectly receive the "final period" remainder.
 *
 * Shared by vesting.ts (graded/straight-line stock comp attribution) and
 * debtAmortization.ts (straight-line deferred financing fee / commitment fee
 * amortization) — same math, different callers, worth keeping as one tested
 * implementation rather than two copies that could drift. */
export function allocateStraightLineByElapsedTime(
  total: Money,
  serviceStart: ISODate,
  serviceEnd: ISODate,
  periods: Period[]
): Money[] {
  const totalDays = daysBetween(serviceStart, serviceEnd);
  if (totalDays <= 0) throw new Error("serviceEnd must be after serviceStart");

  let previousCumulative = new Decimal(0);
  const amounts: Money[] = [];

  periods.forEach((p, i) => {
    const isLast = i === periods.length - 1;
    if (isLast) {
      amounts.push(total.minus(previousCumulative));
      return;
    }
    const elapsedDays = Math.max(0, Math.min(totalDays, daysBetween(serviceStart, p.end)));
    const cumulative = total.times(elapsedDays).div(totalDays);
    amounts.push(cumulative.minus(previousCumulative));
    previousCumulative = cumulative;
  });

  return amounts;
}
