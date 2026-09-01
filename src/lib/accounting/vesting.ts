import { Money, ScheduleRow, ISODate, money, Decimal, DecimalValue } from "./types.js";
import { daysBetween, Period } from "./dateMath.js";
import { allocateStraightLineByElapsedTime } from "./allocation.js";

/**
 * ASC 718 stock compensation expense engines.
 *
 * Three condition types get materially different treatment, which is why they're
 * three functions rather than one with a flag:
 *  - Service condition: recognize grant-date fair value straight-line (or graded)
 *    over the requisite service period. Reverses on actual forfeiture.
 *  - Performance condition: recognize only once achievement is PROBABLE, with a
 *    cumulative catch-up when the assessment changes, and a full reversal if it
 *    becomes improbable. This is the one genuinely stateful engine of the three.
 *  - Market condition: grant-date fair value already prices in the probability of
 *    achieving the hurdle (via the Monte Carlo/lattice model used to value it), so
 *    expense is recognized straight-line over the derived service period regardless
 *    of whether the hurdle is ultimately achieved — there is no reversal, unlike the
 *    performance-condition case. That's the single most commonly-miscoded rule in
 *    this whole domain, and it's exactly why the two functions are kept separate below.
 */

export interface Tranche {
  id: string;
  vestDate: ISODate;
  quantity: DecimalValue;
}

export interface ServiceConditionGrant {
  grantDate: ISODate;
  quantity: DecimalValue;
  grantDateFairValuePerUnit: DecimalValue;
  tranches: Tranche[];
  attributionMethod: "straight-line" | "graded";
}

export function buildServiceConditionSchedule(
  grant: ServiceConditionGrant,
  periods: Period[]
): ScheduleRow[] {
  const totalValue = new Decimal(grant.quantity).times(grant.grantDateFairValuePerUnit);
  const sortedTranches = [...grant.tranches].sort((a, b) => (a.vestDate < b.vestDate ? -1 : 1));
  const totalQty = sortedTranches.reduce((s, t) => s.plus(t.quantity), new Decimal(0));

  const perPeriodTotals = new Array(periods.length).fill(0).map(() => new Decimal(0));

  if (grant.attributionMethod === "straight-line") {
    const serviceEnd = sortedTranches[sortedTranches.length - 1].vestDate;
    const amounts = allocateStraightLineByElapsedTime(totalValue, grant.grantDate, serviceEnd, periods);
    amounts.forEach((a, i) => (perPeriodTotals[i] = perPeriodTotals[i].plus(a)));
  } else {
    // Graded / FIN 28: each tranche is its own award, vesting straight-line from the
    // grant date to that tranche's own vest date. Sum the tranches' allocations per period.
    for (const tranche of sortedTranches) {
      const trancheValue = totalValue.times(tranche.quantity).div(totalQty);
      const amounts = allocateStraightLineByElapsedTime(
        trancheValue,
        grant.grantDate,
        tranche.vestDate,
        periods.filter((p) => p.start < tranche.vestDate || p.end <= tranche.vestDate)
      );
      // amounts is only computed over the periods up to this tranche's vest date;
      // map back into the full period array by label.
      const relevantPeriods = periods.filter((p) => p.start < tranche.vestDate || p.end <= tranche.vestDate);
      relevantPeriods.forEach((p, idx) => {
        const globalIdx = periods.findIndex((gp) => gp.label === p.label);
        perPeriodTotals[globalIdx] = perPeriodTotals[globalIdx].plus(amounts[idx]);
      });
    }
  }

  return periods.map((p, i) => ({
    periodStart: p.start,
    periodEnd: p.end,
    label: p.label,
    amount: perPeriodTotals[i],
    meta: { ascReference: "ASC 718-10-35 (service condition)", attributionMethod: grant.attributionMethod },
  }));
}

export interface PerformanceConditionGrant {
  grantDate: ISODate;
  quantity: DecimalValue;
  grantDateFairValuePerUnit: DecimalValue;
  requisiteServiceEndDate: ISODate; // expected vest date if the condition is met
}

/** `probableAsOf[i]` is the probability assessment as of `periods[i].end` — true if
 * vesting is probable as of that date. The engine recognizes a cumulative catch-up
 * the first period it flips to true, and a full reversal if it flips back to false. */
export function buildPerformanceConditionSchedule(
  grant: PerformanceConditionGrant,
  probableAsOf: boolean[],
  periods: Period[]
): ScheduleRow[] {
  if (probableAsOf.length !== periods.length) {
    throw new Error("probableAsOf must have one entry per period");
  }
  const totalValue = new Decimal(grant.quantity).times(grant.grantDateFairValuePerUnit);
  const totalDays = daysBetween(grant.grantDate, grant.requisiteServiceEndDate);

  let previousRecognized = new Decimal(0);
  const rows: ScheduleRow[] = [];

  periods.forEach((p, i) => {
    const elapsedDays = Math.max(0, Math.min(totalDays, daysBetween(grant.grantDate, p.end)));
    const cumulativeIfProbable = totalValue.times(elapsedDays).div(totalDays);
    const targetCumulative = probableAsOf[i] ? cumulativeIfProbable : new Decimal(0);
    const periodAmount = targetCumulative.minus(previousRecognized);
    rows.push({
      periodStart: p.start,
      periodEnd: p.end,
      label: p.label,
      amount: periodAmount,
      endingBalance: targetCumulative,
      meta: {
        ascReference: "ASC 718-10-25 (performance condition, probable-outcome method)",
        probable: probableAsOf[i],
      },
    });
    previousRecognized = targetCumulative;
  });

  return rows;
}

export interface MarketConditionGrant {
  grantDate: ISODate;
  quantity: DecimalValue;
  /** Fair value per unit as produced by an external Monte Carlo / lattice valuation —
   * this engine does not compute it. See blackScholes.ts for why. */
  grantDateFairValuePerUnit: DecimalValue;
  /** The derived service period from the same valuation model, not necessarily the
   * stated contractual term. */
  derivedServiceEndDate: ISODate;
}

/** Market-condition awards recognize expense straight-line over the derived service
 * period with NO reversal if the market condition is never achieved — the grant-date
 * fair value already embeds that probability. */
export function buildMarketConditionSchedule(grant: MarketConditionGrant, periods: Period[]): ScheduleRow[] {
  const totalValue = new Decimal(grant.quantity).times(grant.grantDateFairValuePerUnit);
  const amounts = allocateStraightLineByElapsedTime(
    totalValue,
    grant.grantDate,
    grant.derivedServiceEndDate,
    periods
  );
  return periods.map((p, i) => ({
    periodStart: p.start,
    periodEnd: p.end,
    label: p.label,
    amount: amounts[i],
    meta: { ascReference: "ASC 718-10-25 (market condition — no reversal)" },
  }));
}

/** Reverses all previously-recognized-but-unvested expense for a forfeited quantity,
 * under the "recognize forfeitures as they occur" policy election (ASU 2016-09). The
 * alternative election — estimate forfeitures at grant and true up — is a documented
 * extension point, not implemented here: it changes the total quantity assumption
 * inside every schedule above rather than being a post-hoc adjustment, so it belongs
 * in the grant setup, not bolted on after the fact. */
export function reverseForfeitedExpense(
  scheduleSoFar: ScheduleRow[],
  forfeitureDate: ISODate,
  forfeitedFractionOfGrant: DecimalValue
): ScheduleRow {
  const cumulativeRecognized = scheduleSoFar.reduce((s, r) => s.plus(r.amount), new Decimal(0));
  const reversal = cumulativeRecognized.times(forfeitedFractionOfGrant).negated();
  return {
    periodStart: forfeitureDate,
    periodEnd: forfeitureDate,
    label: "Forfeiture reversal",
    amount: reversal,
    meta: { ascReference: "ASC 718-10-35 (forfeiture, recognize-as-incurred policy)" },
  };
}
