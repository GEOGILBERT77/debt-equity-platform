import { Money, ScheduleRow, ISODate, money, Decimal, DecimalValue } from "./types.js";
import { daysBetween, addMonths, Period } from "./dateMath.js";
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
  /** Disclosure-only metadata (per-unit exercise price) — not read by any function in
   * this file. The engine only ever needs grant-date fair value to compute the ASC 718
   * expense schedule; strike price has no role in that math. Carried on this shared
   * shape (rather than a separate table) so it lives right next to the rest of a
   * grant's terms and rides along through modifications/versioning for free. Required
   * at the STOCK_OPTION API boundary (see termsValidation.ts) since an option without
   * a strike isn't a real option; left optional here, and meaningless for RSU/
   * RESTRICTED_STOCK/SAR, which don't have one. */
  strikePrice?: DecimalValue;
  /** The requisite SERVICE period's end date, when it's a fact independent of the
   * vesting schedule rather than implied by it — e.g. a grant whose shares vest over 4
   * years but which requires 6 years of service before the award is considered fully
   * earned (post-vest holding/service commitments, graded plans layered on top of a
   * fixed vesting schedule, etc.). ASC 718-10-35-8: the requisite service period is
   * whatever period the award's terms actually require, which is NOT always "grant
   * date to last vest date" — that's just the common case this field defaults to when
   * omitted.
   *
   * ONLY consulted by the straight-line branch below. Graded/FIN 28 attribution
   * inherently ties each tranche's own service period to that tranche's own vest date
   * (that's the definition of the graded method — see this file's module doc comment)
   * so there's no single "overall service end" for it to override; a grant that needs
   * an explicit service period commitment on top of graded vesting isn't representable
   * by this field today — see this field's validation in termsValidation.ts for the
   * one constraint enforced at write time (must be on or after the last tranche's vest
   * date; a service period can't end before every tranche has actually vested). */
  servicePeriodEndDate?: ISODate;
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
    const lastVestDate = sortedTranches[sortedTranches.length - 1].vestDate;
    // The requisite service period runs through the LATER of the last vest date and
    // an explicit servicePeriodEndDate, if one was given — see that field's doc
    // comment above. termsValidation.ts already rejects a servicePeriodEndDate
    // earlier than lastVestDate at write time, but this max() keeps the engine itself
    // correct even for terms that reached here some other way (a pre-existing grant
    // written before this field existed, a direct DB edit, a future caller that skips
    // validation) rather than silently truncating the recognition period.
    const serviceEnd =
      grant.servicePeriodEndDate && grant.servicePeriodEndDate > lastVestDate ? grant.servicePeriodEndDate : lastVestDate;
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

export interface StandardVestingScheduleInputs {
  grantDate: ISODate;
  quantity: DecimalValue;
  /** Total service period in months (e.g. 48 for a standard 4-year vest). */
  vestingMonths: number;
  /** Months before the first vesting event (e.g. 12 for a standard 1-year cliff).
   * 0 means no cliff — the first monthly tranche vests one month after grant. */
  cliffMonths: number;
}

/**
 * Generates a standard "N-month vest with an M-month cliff, then equal monthly
 * vesting thereafter" Tranche[] — by far the most common real-world stock option
 * vesting structure, built specifically so the bulk-upload importer (see
 * bulkUploadStockOptions.ts) only needs quantity/vestingMonths/cliffMonths per
 * grantee in a spreadsheet row, rather than a full explicit tranche list. NOT a
 * replacement for the "New transactions" form's manual tranche-by-tranche entry,
 * which still supports arbitrary, non-standard vesting (back-loaded schedules,
 * uneven tranche sizes, anything performance-linked) — this function deliberately
 * only covers the standard case.
 *
 * WHOLE-SHARE ROUNDING: `quantity / vestingMonths` almost never divides evenly.
 * Every tranche gets `Math.floor(quantity / vestingMonths)` shares EXCEPT the first
 * vesting event (the cliff, if there is one, otherwise month 1), which absorbs both
 * its own months' worth AND the entire rounding remainder — guaranteeing every
 * tranche sums to EXACTLY the granted quantity. That's not a cosmetic choice:
 * termsValidation.ts's validateServiceConditionGrant hard-rejects any grant whose
 * tranche quantities don't sum to the total, so an ordinary floor() with no
 * remainder-handling would make every generated grant fail validation.
 */
export function generateStandardMonthlyTranches(inputs: StandardVestingScheduleInputs): Tranche[] {
  const { grantDate, quantity, vestingMonths, cliffMonths } = inputs;
  if (!Number.isInteger(vestingMonths) || vestingMonths <= 0) {
    throw new Error("vestingMonths must be a positive integer");
  }
  if (!Number.isInteger(cliffMonths) || cliffMonths < 0 || cliffMonths > vestingMonths) {
    throw new Error("cliffMonths must be a non-negative integer no greater than vestingMonths");
  }
  const totalQty = Math.round(Number(quantity));
  if (!Number.isFinite(totalQty) || totalQty <= 0) {
    throw new Error("quantity must be a positive whole number of shares");
  }

  const perMonthQty = Math.floor(totalQty / vestingMonths);
  const remainder = totalQty - perMonthQty * vestingMonths;
  const tranches: Tranche[] = [];
  let trancheIndex = 1;

  if (cliffMonths > 0) {
    tranches.push({
      id: `t${trancheIndex++}`,
      vestDate: addMonths(grantDate, cliffMonths),
      quantity: perMonthQty * cliffMonths + remainder,
    });
  }

  const firstMonthlyMonth = cliffMonths > 0 ? cliffMonths + 1 : 1;
  for (let m = firstMonthlyMonth; m <= vestingMonths; m++) {
    const isFirstEventOverall = cliffMonths === 0 && m === 1;
    tranches.push({
      id: `t${trancheIndex++}`,
      vestDate: addMonths(grantDate, m),
      quantity: isFirstEventOverall ? perMonthQty + remainder : perMonthQty,
    });
  }

  return tranches;
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
