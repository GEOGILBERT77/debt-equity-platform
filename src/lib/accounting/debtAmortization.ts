import { Money, ScheduleRow, ISODate, money, Decimal, DecimalValue } from "./types.js";
import { Period, addDays } from "./dateMath.js";
import { allocateStraightLineByElapsedTime } from "./allocation.js";

/**
 * Effective-interest-method amortization for term debt, per ASC 835-30. Issuance
 * costs and any discount/premium are presented as a single contra-liability netted
 * against the face amount (no separate asset for issuance costs), and both amortize
 * through interest expense via the effective yield — never straight-line. Straight-line
 * amortization of debt costs is the most common mistake here; it's only acceptable for
 * revolving lines of credit, which get their own function below because the shape of
 * that schedule is genuinely different, not just a simplification of this one.
 */
export interface TermDebtInputs {
  faceValue: DecimalValue;
  /** Net cash proceeds actually received, after issuance costs and any discount. */
  netProceeds: DecimalValue;
  /** Effective annual yield. If you don't have this yet, solve for it with
   * `solveEffectiveYield` below from the stated cash flows, then pass it in here —
   * kept as two steps so the amortization engine itself stays a pure, testable function
   * of a known yield. */
  effectiveAnnualYield: DecimalValue;
  /** Contractual cash payments due at each period end (coupon + any principal). */
  cashFlows: { date: ISODate; amount: DecimalValue }[];
}

export function buildEffectiveInterestSchedule(inputs: TermDebtInputs, periods: Period[]): ScheduleRow[] {
  if (inputs.cashFlows.length !== periods.length) {
    throw new Error("cashFlows must have one entry per period");
  }
  const yieldPerPeriod = new Decimal(inputs.effectiveAnnualYield); // assumes periods are annual;
  // for sub-annual periods, pass the yield already converted to a per-period rate.

  let carrying = new Decimal(inputs.netProceeds);
  const rows: ScheduleRow[] = [];

  periods.forEach((p, i) => {
    const interestExpense = carrying.times(yieldPerPeriod);
    const cashPaid = new Decimal(inputs.cashFlows[i].amount);
    // Discount/premium amortization for the period is simply the plug between the
    // effective-yield interest expense and the contractual cash paid — it doesn't need
    // its own formula, it falls out of the carrying-value roll-forward below.
    const discountAmortization = interestExpense.minus(cashPaid);
    const endingBalance = carrying.plus(interestExpense).minus(cashPaid);
    rows.push({
      periodStart: p.start,
      periodEnd: p.end,
      label: p.label,
      amount: interestExpense,
      endingBalance,
      meta: {
        ascReference: "ASC 835-30 (effective interest method)",
        beginningBalance: carrying,
        cashPaid,
        discountAmortization,
      },
    });
    carrying = endingBalance;
  });

  return rows;
}

/** Solves for the effective annual yield implied by a net-proceeds amount and a series
 * of contractual cash flows, via bisection (robust for the monotonic, well-behaved
 * cash-flow patterns debt instruments produce — no need for Newton's method here). */
export function solveEffectiveYield(
  netProceeds: DecimalValue,
  cashFlows: DecimalValue[],
  tolerance = new Decimal("0.00001")
): Money {
  const proceeds = new Decimal(netProceeds);
  const pv = (r: Decimal) =>
    cashFlows.reduce(
      (sum, cf, i) => sum.plus(new Decimal(cf).div(r.plus(1).pow(i + 1))),
      new Decimal(0)
    );

  let lo = new Decimal(0);
  let hi = new Decimal(2); // 200% annual yield as a practical upper bound
  for (let iter = 0; iter < 200; iter++) {
    const mid = lo.plus(hi).div(2);
    const diff = pv(mid).minus(proceeds);
    if (diff.abs().lessThan(tolerance)) return money(mid);
    // pv(r) is strictly decreasing in r for positive cash flows
    if (diff.greaterThan(0)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return money(lo.plus(hi).div(2));
}

/**
 * Delayed-draw term loan (DDTL): a facility drawn in more than one tranche over time,
 * where each draw carries its own deferred financing fees and its own effective yield.
 * A NEW draw's issuance costs net against THAT draw's own carrying value and amortize
 * at THAT draw's own effective yield — they don't retroactively change the yield
 * already locked in on an earlier draw. That's not a simplification; each draw is
 * genuinely a separate unit of account under ASC 835-30 that merely happens to share a
 * facility agreement and a reporting calendar with the others.
 *
 * This runs `buildEffectiveInterestSchedule` independently per tranche, then sums the
 * results period-by-period into one combined schedule — same ScheduleRow shape as
 * every other engine function here, so it drops straight into `journalEntries.ts`'s
 * existing `debtInterestExpenseEntry` mapper without a new one, and the per-tranche
 * detail is preserved in `meta.tranches` for audit.
 *
 * NOT the right tool for a REVOLVER's fees, even though a revolver and a DDTL often
 * live in the same credit agreement — see `buildDeferredFeeSchedule` below for why
 * revolver-related fees are straight-line, not netted-and-amortized like this.
 *
 * LIMITATION: every tranche is assumed to run from its own draw date through the same
 * final period as every other tranche (i.e. all draws share the facility's overall
 * maturity). A tranche independently repaid before the facility's overall maturity
 * isn't supported here — that's a documented extension point, not silently wrong: it
 * would show up as a length mismatch between a tranche's `cashFlows` and the periods
 * it's asked to run over, which throws (via `buildEffectiveInterestSchedule`'s own
 * check) rather than producing a wrong number.
 */
export interface TermDebtTranche extends TermDebtInputs {
  id: string;
  /** Must exactly match the `start` of one of the periods passed to
   * `buildMultiTrancheEffectiveInterestSchedule` — the period this tranche is first
   * drawn and starts accruing interest. `cashFlows` above must have exactly one entry
   * per period from THIS period through the end of the schedule (not one per entry in
   * the full periods array) — the same requirement `buildEffectiveInterestSchedule`
   * itself enforces, just against a shorter, tranche-specific period list. */
  drawDate: ISODate;
}

export function buildMultiTrancheEffectiveInterestSchedule(tranches: TermDebtTranche[], periods: Period[]): ScheduleRow[] {
  const perPeriodInterest = periods.map(() => new Decimal(0));
  const perPeriodEndingBalance = periods.map(() => new Decimal(0));
  const perPeriodCashPaid = periods.map(() => new Decimal(0));
  const tranchesByPeriod: Record<string, unknown>[] = periods.map(() => ({}));

  for (const tranche of tranches) {
    const drawIdx = periods.findIndex((p) => p.start === tranche.drawDate);
    if (drawIdx === -1) {
      throw new Error(`Tranche "${tranche.id}": drawDate ${tranche.drawDate} doesn't match the start of any period in the schedule`);
    }
    const relevantPeriods = periods.slice(drawIdx);
    const trancheRows = buildEffectiveInterestSchedule(tranche, relevantPeriods);

    trancheRows.forEach((row, i) => {
      const globalIdx = drawIdx + i;
      perPeriodInterest[globalIdx] = perPeriodInterest[globalIdx].plus(row.amount);
      perPeriodEndingBalance[globalIdx] = perPeriodEndingBalance[globalIdx].plus(row.endingBalance ?? new Decimal(0));
      perPeriodCashPaid[globalIdx] = perPeriodCashPaid[globalIdx].plus((row.meta?.cashPaid as Decimal | undefined) ?? new Decimal(0));
      tranchesByPeriod[globalIdx][tranche.id] = {
        interestExpense: row.amount.toFixed(2),
        endingBalance: row.endingBalance?.toFixed(2),
      };
    });
  }

  return periods.map((p, i) => ({
    periodStart: p.start,
    periodEnd: p.end,
    label: p.label,
    amount: perPeriodInterest[i],
    endingBalance: perPeriodEndingBalance[i],
    meta: {
      ascReference: "ASC 835-30 (multi-tranche effective interest — delayed-draw term loan)",
      cashPaid: perPeriodCashPaid[i],
      tranches: tranchesByPeriod[i],
    },
  }));
}

/**
 * Revolving line of credit: unused-commitment fees are recognized straight-line over
 * the commitment/draw period, not via the effective-interest method — there's no
 * discount to accrete because there's no fixed principal drawn yet. This is a
 * deliberately different shape from `buildEffectiveInterestSchedule`, not a variant of it.
 */
export interface RevolverFeeInputs {
  totalCommitmentFee: DecimalValue;
  commitmentStart: ISODate;
  commitmentEnd: ISODate;
}

/**
 * FIXED (v0.17.0) — this used to divide the total fee EQUALLY by period COUNT rather
 * than day-weighting it like `allocateStraightLineByElapsedTime` (used by
 * buildDeferredFeeSchedule below and by buildServiceConditionSchedule in vesting.ts).
 * That was a fine simplification as long as every period in `periods` was the same
 * length (the normal case: a run of annual periods), but it stopped being fine the
 * moment `periods` contained an unequal-length period — which is exactly what
 * dispatch.ts's `splitPeriodsAt` introduces when computing a "visible as of today"
 * schedule mid-year (it splits the current annual period into an "elapsed to date"
 * slice and a "remaining" slice so the elapsed portion isn't lost). Equal-by-count
 * division gave that short "elapsed to date" slice the same dollar amount as a
 * full-length prior year, overstating the fee recognized for that partial period. Now
 * day-weighted via the same `allocateStraightLineByElapsedTime` helper
 * `buildDeferredFeeSchedule` already used, over the fee's own `commitmentStart`/
 * `commitmentEnd` window — the two components of a REVOLVER's combined schedule
 * (this one and the deferred-fee one) now use identical day-weighting, so
 * `computeVisibleSchedule`'s truncation-safety mechanism covers both correctly. One
 * side effect worth calling out, not a regression: for a facility split into calendar
 * quarters (which aren't exactly equal-length — 90, 91, 92, or 92 days in a non-leap
 * year), day-weighting no longer produces an identical dollar figure every quarter the
 * way equal-by-count division did; each quarter now gets its own actual-day-count
 * share of the total, which is the more accurate result (real unused-commitment fees
 * accrue on actual days outstanding), not a less precise one.
 */
export function buildRevolverFeeSchedule(inputs: RevolverFeeInputs, periods: Period[]): ScheduleRow[] {
  const total = new Decimal(inputs.totalCommitmentFee);
  const amounts = allocateStraightLineByElapsedTime(total, inputs.commitmentStart, inputs.commitmentEnd, periods);
  return periods.map((p, i) => ({
    periodStart: p.start,
    periodEnd: p.end,
    label: p.label,
    amount: amounts[i],
    meta: { ascReference: "ASC 470 (revolver commitment fee, straight-line)" },
  }));
}

/**
 * Deferred financing fees / upsize / accordion fees on a REVOLVING facility — as
 * distinct from `buildRevolverFeeSchedule` above (which handles the unused-commitment
 * fee specifically) and from `buildMultiTrancheEffectiveInterestSchedule` above (which
 * handles a DDTL's per-draw fees). Generalizes `buildRevolverFeeSchedule`'s straight-
 * line math to multiple fee tranches, each with its own start/end date, because that's
 * exactly what a revolver's fee history usually looks like in practice: an original
 * deferred financing fee at closing, then another fee whenever the facility is
 * upsized, extended, or amended — each amortizing only over what was actually
 * remaining WHEN IT WAS INCURRED, without touching any tranche already partway through
 * amortizing.
 *
 * Straight-line (not effective-interest) is the correct GAAP treatment here per ASU
 * 2015-15 (codified in ASC 835-30-45-3): a revolver's outstanding balance isn't a
 * fixed, known repayment schedule, so there's no discount to accrete against via the
 * effective-interest method the way `buildEffectiveInterestSchedule` does for term
 * debt — revolver-related fees are capitalized as a deferred charge (asset) and
 * expensed straight-line over the commitment period instead. If what you're
 * amortizing is a DDTL draw's own issuance costs rather than a revolver's, use
 * `buildMultiTrancheEffectiveInterestSchedule` instead — that's a genuinely different
 * accounting model, not an alternate input shape for this same one.
 */
export interface DeferredFeeTranche {
  id: string;
  amount: DecimalValue;
  /** When this fee starts amortizing — typically the closing, upsize, or amendment
   * date it relates to. */
  amortizationStart: ISODate;
  /** When this fee finishes amortizing — typically the facility's maturity or
   * termination date at the time the fee was incurred. Doesn't have to match other
   * tranches: an upsize fee added two years into a five-year facility still amortizes
   * only over the three years actually remaining. */
  amortizationEnd: ISODate;
}

export function buildDeferredFeeSchedule(tranches: DeferredFeeTranche[], periods: Period[]): ScheduleRow[] {
  const perPeriodExpense = periods.map(() => new Decimal(0));
  const perPeriodUnamortized = periods.map(() => new Decimal(0));
  const perPeriodTranches: Record<string, string>[] = periods.map(() => ({}));

  for (const tranche of tranches) {
    const amount = new Decimal(tranche.amount);
    const relevantPeriods = periods.filter((p) => p.start < tranche.amortizationEnd && p.end > tranche.amortizationStart);
    if (relevantPeriods.length === 0) continue;

    const amounts = allocateStraightLineByElapsedTime(amount, tranche.amortizationStart, tranche.amortizationEnd, relevantPeriods);

    let cumulativeAmortized = new Decimal(0);
    relevantPeriods.forEach((p, idx) => {
      const globalIdx = periods.findIndex((gp) => gp.label === p.label);
      perPeriodExpense[globalIdx] = perPeriodExpense[globalIdx].plus(amounts[idx]);
      cumulativeAmortized = cumulativeAmortized.plus(amounts[idx]);
      perPeriodUnamortized[globalIdx] = perPeriodUnamortized[globalIdx].plus(amount.minus(cumulativeAmortized));
      perPeriodTranches[globalIdx][tranche.id] = amounts[idx].toFixed(2);
    });
  }

  return periods.map((p, i) => ({
    periodStart: p.start,
    periodEnd: p.end,
    label: p.label,
    amount: perPeriodExpense[i],
    endingBalance: perPeriodUnamortized[i],
    meta: {
      ascReference: "ASC 835-30-45-3 / ASU 2015-15 (revolving facility deferred fees, straight-line)",
      tranches: perPeriodTranches[i],
    },
  }));
}

/**
 * A revolving facility's periodic schedule, composed from the two straight-line fee
 * engines above. Exists because dispatch.ts's per-InstrumentType schedule builder
 * needs exactly one function of shape `(terms, periods) => ScheduleRow[]` per type,
 * and a real revolver's "schedule" is usually more than one fee stream — an unused-
 * commitment fee AND deferred financing costs from closing (plus any upsize/amendment
 * fees), both amortizing over their own windows.
 *
 * DELIBERATELY DOES NOT INCLUDE interest on the drawn balance. A revolver's drawn
 * balance fluctuates mid-period (draws and paydowns), which is exactly the case
 * `buildDailyAccrualSchedule` above exists for — but that function's input shape
 * (dated rate segments and principal events) is genuinely different from this
 * dispatcher's fixed `(terms, periods)` contract, the same reason dispatch.ts's SCOPE
 * note gives for not wiring daily accrual in generally. Composing "commitment fee +
 * deferred fees + daily-accrual drawn interest" into one combined instrument view is
 * real, separate follow-on work — don't extend this function to fake it by treating
 * the drawn balance as a fixed-rate constant, that would misstate interest expense
 * for the exact instrument type (a revolver) that most needs the daily-accrual
 * engine's precision. If you need a fully-drawn, never-paid-down revolving line that
 * genuinely behaves like fixed-rate term debt, model it as a TERM_LOAN instead — that
 * is what `buildEffectiveInterestSchedule` is for.
 */
export interface RevolverInputs {
  commitmentFee?: RevolverFeeInputs;
  deferredFees?: DeferredFeeTranche[];
}

export function buildRevolverSchedule(inputs: RevolverInputs, periods: Period[]): ScheduleRow[] {
  if (!inputs.commitmentFee && (!inputs.deferredFees || inputs.deferredFees.length === 0)) {
    throw new Error(
      "A revolver's schedule needs at least a commitmentFee or a deferredFees entry — see buildRevolverSchedule's doc comment for what this deliberately doesn't model (drawn-balance interest)."
    );
  }

  const feeRows = inputs.commitmentFee ? buildRevolverFeeSchedule(inputs.commitmentFee, periods) : null;
  const deferredRows =
    inputs.deferredFees && inputs.deferredFees.length > 0 ? buildDeferredFeeSchedule(inputs.deferredFees, periods) : null;

  return periods.map((p, i) => {
    const commitmentFeeAmount = feeRows ? feeRows[i].amount : new Decimal(0);
    const deferredFeeAmortization = deferredRows ? deferredRows[i].amount : new Decimal(0);
    const deferredEndingBalance = deferredRows ? deferredRows[i].endingBalance : undefined;

    return {
      periodStart: p.start,
      periodEnd: p.end,
      label: p.label,
      amount: commitmentFeeAmount.plus(deferredFeeAmortization),
      endingBalance: deferredEndingBalance,
      meta: {
        ascReference: "ASC 470 / ASC 835-30-45-3 (revolver commitment fee + deferred financing fee amortization)",
        commitmentFeeAmount: commitmentFeeAmount.toFixed(4),
        deferredFeeAmortization: deferredFeeAmortization.toFixed(4),
        note: "Excludes interest on the drawn balance — see this function's doc comment.",
      },
    };
  });
}

/**
 * The "real, separate follow-on work" `buildRevolverSchedule`'s own doc comment
 * flagged: composes that function's two straight-line fee streams with
 * `buildDailyAccrualSchedule`'s daily-basis interest on the drawn balance into one
 * combined per-period schedule, closing the "revolver drawn-balance interest" gap
 * that was Not Started in the task-status spreadsheet.
 *
 * Backward compatible by construction: omitting `drawnBalance` produces EXACTLY
 * `buildRevolverSchedule`'s output (fees only) — this function is a strict superset,
 * not a replacement with different defaults, so anywhere already calling
 * `buildRevolverSchedule` can switch to this one with no behavior change until
 * `drawnBalance` is actually supplied.
 *
 * Two DIFFERENT balances are in play here, which is why both are surfaced separately
 * rather than collapsed into one number: the deferred financing fees' unamortized
 * balance (an asset/contra-liability being written off) and the drawn balance itself
 * (the actual liability outstanding). `endingBalance` on the returned row is the DRAWN
 * balance — the more decision-relevant number for a revolver's period-end position,
 * consistent with every other debt engine in this file using `endingBalance` for the
 * principal/carrying balance, not a deferred-cost asset. The deferred fees'
 * unamortized balance is still available in full at `meta.deferredFeeUnamortizedBalance`.
 *
 * NOT YET wired into `dispatch.ts`'s `getScheduleBuilder` — same status as
 * `buildDailyAccrualSchedule`/`buildMultiTrancheEffectiveInterestSchedule` above (built
 * engines the close workflow doesn't call yet): REVOLVER's terms shape
 * (`RevolverInputs`) and `termsValidation.ts`'s validator would both need a new
 * `drawnBalance` field added and validated before a real instrument could carry this
 * data end-to-end, which is real, separate front-end/validation work beyond this
 * calculation engine itself.
 */
export interface CombinedRevolverInputs extends RevolverInputs {
  /** Omit for a revolver with no drawn-balance interest to model yet (e.g. never
   * drawn) — see this function's doc comment on why that reduces to exactly
   * `buildRevolverSchedule`'s existing fee-only output. */
  drawnBalance?: DailyAccrualDebtInputs;
}

export function buildCombinedRevolverSchedule(inputs: CombinedRevolverInputs, periods: Period[]): ScheduleRow[] {
  const feeSchedule = buildRevolverSchedule(inputs, periods);
  if (!inputs.drawnBalance) return feeSchedule;

  const interestSchedule = buildDailyAccrualSchedule(inputs.drawnBalance, periods);
  if (interestSchedule.length !== feeSchedule.length) {
    throw new Error("Internal error: fee schedule and drawn-balance interest schedule produced a different number of periods.");
  }

  return periods.map((p, i) => {
    const feeRow = feeSchedule[i];
    const interestRow = interestSchedule[i];
    return {
      periodStart: p.start,
      periodEnd: p.end,
      label: p.label,
      amount: feeRow.amount.plus(interestRow.amount),
      endingBalance: interestRow.endingBalance,
      meta: {
        ascReference: "ASC 470 / ASC 835-30-45-3 / ASC 835-30 (revolver: commitment fee + deferred financing fee amortization + daily-accrual drawn-balance interest)",
        commitmentFeeAmount: feeRow.meta?.commitmentFeeAmount,
        deferredFeeAmortization: feeRow.meta?.deferredFeeAmortization,
        deferredFeeUnamortizedBalance: feeRow.endingBalance,
        drawnBalanceInterest: interestRow.amount.toFixed(4),
        drawnBalanceEnding: interestRow.endingBalance,
        dayCountConvention: interestRow.meta?.dayCountConvention,
        rateChangesInPeriod: interestRow.meta?.rateChangesInPeriod,
        principalEventsInPeriod: interestRow.meta?.principalEventsInPeriod,
      },
    };
  });
}

/**
 * PIK (payment-in-kind) debt: interest accrues to principal rather than being paid in
 * cash, so the carrying balance compounds each period instead of being reduced by a
 * cash payment.
 */
export interface PikDebtInputs {
  initialPrincipal: DecimalValue;
  annualPikRate: DecimalValue;
}

export function buildPikSchedule(inputs: PikDebtInputs, periods: Period[]): ScheduleRow[] {
  let balance = new Decimal(inputs.initialPrincipal);
  const rate = new Decimal(inputs.annualPikRate);
  return periods.map((p) => {
    const accrued = balance.times(rate);
    const endingBalance = balance.plus(accrued);
    const row: ScheduleRow = {
      periodStart: p.start,
      periodEnd: p.end,
      label: p.label,
      amount: accrued,
      endingBalance,
      meta: { ascReference: "ASC 835-30 (PIK interest, compounding)" },
    };
    balance = endingBalance;
    return row;
  });
}

/**
 * ===========================================================================
 * DAILY-BASIS ACCRUAL — for floating-rate debt (and any other facility) where
 * interest has to be computed on the actual outstanding balance for each
 * calendar day, not assumed constant across a whole reporting period.
 * ===========================================================================
 *
 * `buildEffectiveInterestSchedule` above assumes one constant per-period yield
 * applied to a balance that only changes at period boundaries — correct for
 * fixed-rate term debt amortizing a discount/premium to a level yield. It is
 * NOT correct when either the rate can change mid-period (a floating-rate loan
 * resetting off SOFR/Prime on a date that doesn't line up with reporting
 * period boundaries) or the principal balance changes mid-period (a scheduled
 * or voluntary paydown, or a revolver draw, on a date that isn't the period
 * end). In both cases, applying one period-level rate/balance either overstates
 * or understates interest expense — the true expense depends on exactly which
 * balance was outstanding, at which rate, on each specific day.
 *
 * This computes interest the way a real credit agreement does: simple daily
 * interest on the actual balance outstanding each calendar day, at whatever
 * rate was in effect that day, using the day-count convention (Actual/360 or
 * Actual/365 Fixed) the agreement specifies. Both are "Fixed" conventions in
 * the sense that matters here — the divisor (360 or 365) never changes for a
 * leap year. That's different from the calendar-day-weighted attribution
 * `vesting.ts` uses elsewhere in this codebase, which intentionally DOES vary
 * by the actual number of days in the year it's allocating across — don't
 * reuse that logic here, it solves a different problem.
 *
 * CONVENTION (documented because credit agreements vary on this and it changes
 * the numbers): a rate reset or principal event dated `D` takes effect
 * starting on day `D` itself — that day's interest is computed using the NEW
 * rate/balance, not the old one. If your actual agreement instead excludes the
 * change date (interest at the old rate/balance through end-of-day on the
 * change date, new terms starting the next day), shift the event dates passed
 * in by one day to match.
 */

export type DayCountConvention = "ACT/360" | "ACT/365";

function dayCountDivisor(convention: DayCountConvention): number {
  return convention === "ACT/360" ? 360 : 365;
}

export interface RateSegment {
  /** First calendar day this rate applies, inclusive. */
  effectiveDate: ISODate;
  /** Annual rate as a decimal, e.g. 0.065 for 6.50%. */
  annualRate: DecimalValue;
}

export interface PrincipalEvent {
  /** The day this change takes effect — see the CONVENTION note above. */
  date: ISODate;
  /** Signed: positive = draw (increases the balance), negative = payment/paydown
   * (decreases it). Signed rather than a separate draw/payment enum so applying it
   * is always just `balance.plus(event.amount)`, with nothing to get backwards. */
  amount: DecimalValue;
}

export interface InterestCashPayment {
  /** The day the cash was actually paid. */
  date: ISODate;
  amount: DecimalValue;
}

export interface DailyAccrualDebtInputs {
  initialPrincipal: DecimalValue;
  /** First day interest starts accruing, inclusive. */
  startDate: ISODate;
  /** Must include one segment with `effectiveDate <= startDate` to establish the rate
   * in effect at inception; any others are mid-schedule resets. Order doesn't matter —
   * sorted internally. */
  rateSegments: RateSegment[];
  /** Mid-schedule draws/paydowns, dated. Omit for a bullet loan with no principal
   * activity before maturity. */
  principalEvents?: PrincipalEvent[];
  /** Cash actually paid against interest, dated. Used only to compute the cash-vs-
   * accrual plug per reporting period (`meta.cashPaid` on the output rows, which
   * `dailyAccrualInterestEntry` in journalEntries.ts reads) — does NOT affect the
   * principal balance or the interest calculation itself. */
  interestPayments?: InterestCashPayment[];
  /** Defaults to ACT/360, the more common convention in commercial credit agreements;
   * use ACT/365 for facilities that specify Actual/365 Fixed. */
  dayCountConvention?: DayCountConvention;
}

export interface DailyAccrualDay {
  date: ISODate;
  /** Principal balance in effect for this day — after any principal event dated this
   * same day has already been applied (see the CONVENTION note above). */
  balance: Money;
  annualRate: Money;
  interest: Money;
}

/** Day-by-day detail from `inputs.startDate` (inclusive) through `throughDate`
 * (EXCLUSIVE) — the same half-open convention `Period.start`/`Period.end` use
 * elsewhere in this codebase. Exposed as its own function, rather than folded
 * silently into the per-period rollup below, so a CPA can dump the full daily detail
 * and hand-verify any specific day's balance and rate before trusting the rollup. */
export function buildDailyAccrualDetail(inputs: DailyAccrualDebtInputs, throughDate: ISODate): DailyAccrualDay[] {
  const convention = inputs.dayCountConvention ?? "ACT/360";
  const divisor = new Decimal(dayCountDivisor(convention));

  const rateSegments = [...inputs.rateSegments].sort((a, b) => (a.effectiveDate < b.effectiveDate ? -1 : a.effectiveDate > b.effectiveDate ? 1 : 0));
  if (rateSegments.length === 0 || rateSegments[0].effectiveDate > inputs.startDate) {
    throw new Error("rateSegments must include a segment effective on or before startDate");
  }
  const principalEvents = [...(inputs.principalEvents ?? [])].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let balance = new Decimal(inputs.initialPrincipal);
  let rateIdx = 0;
  let currentRate = new Decimal(rateSegments[0].annualRate);
  let eventIdx = 0;

  const days: DailyAccrualDay[] = [];
  let cursor = inputs.startDate;

  while (cursor < throughDate) {
    // Same-day principal events and rate resets both apply before this day's interest
    // is computed — order between the two doesn't matter, they affect independent
    // variables, but both have to happen before the `balance.times(currentRate)` below.
    while (eventIdx < principalEvents.length && principalEvents[eventIdx].date === cursor) {
      balance = balance.plus(principalEvents[eventIdx].amount);
      eventIdx++;
    }
    while (rateIdx + 1 < rateSegments.length && rateSegments[rateIdx + 1].effectiveDate <= cursor) {
      rateIdx++;
      currentRate = new Decimal(rateSegments[rateIdx].annualRate);
    }

    const interest = balance.times(currentRate).div(divisor);
    days.push({ date: cursor, balance, annualRate: currentRate, interest });
    cursor = addDays(cursor, 1);
  }

  return days;
}

/** Rolls the day-by-day detail up into the given reporting periods — this is what
 * actually feeds journalEntries.ts/closeService.ts, in the same ScheduleRow shape
 * every other engine function in this file produces. Periods may be any length
 * (monthly, quarterly, or genuinely irregular) and don't need to line up with rate
 * reset or principal event dates; that's the entire point of computing on a daily
 * basis rather than a period-level one. */
export function buildDailyAccrualSchedule(inputs: DailyAccrualDebtInputs, periods: Period[]): ScheduleRow[] {
  if (periods.length === 0) return [];
  const allDays = buildDailyAccrualDetail(inputs, periods[periods.length - 1].end);
  const interestPayments = inputs.interestPayments ?? [];
  const principalEvents = inputs.principalEvents ?? [];

  return periods.map((p) => {
    const daysInPeriod = allDays.filter((d) => d.date >= p.start && d.date < p.end);
    if (daysInPeriod.length === 0) {
      throw new Error(
        `No accrual days found for period "${p.label}" (${p.start} to ${p.end}) — check that it falls within the loan's accrual horizon (starting ${inputs.startDate})`
      );
    }

    const interestAccrued = daysInPeriod.reduce((sum, d) => sum.plus(d.interest), new Decimal(0));
    const endingBalance = daysInPeriod[daysInPeriod.length - 1].balance;

    const cashPaid = interestPayments
      .filter((ip) => ip.date >= p.start && ip.date < p.end)
      .reduce((sum, ip) => sum.plus(ip.amount), new Decimal(0));

    // Audit-trail metadata: exactly which rate segments and principal events fell
    // inside this period, so a reviewer doesn't have to re-derive them from the full
    // daily detail to see why a given month's interest looks the way it does.
    const rateChangesInPeriod = daysInPeriod
      .filter((d, i) => i === 0 || !d.annualRate.equals(daysInPeriod[i - 1].annualRate))
      .map((d) => ({ effectiveDate: d.date, annualRate: d.annualRate.toString() }));
    const principalEventsInPeriod = principalEvents.filter((e) => e.date >= p.start && e.date < p.end);

    const row: ScheduleRow = {
      periodStart: p.start,
      periodEnd: p.end,
      label: p.label,
      amount: interestAccrued,
      endingBalance,
      meta: {
        ascReference: "ASC 835-30 (daily accrual — actual balance, actual rate, actual/day-count basis)",
        dayCountConvention: inputs.dayCountConvention ?? "ACT/360",
        cashPaid,
        rateChangesInPeriod,
        principalEventsInPeriod,
      },
    };
    return row;
  });
}

/**
 * Projecting FUTURE floating-rate resets, for forecasting — cash-flow projections,
 * covenant-compliance modeling, or feeding a fair-value model — never for booking
 * actual expense. Booked interest must always run on realized/contractual rates known
 * as of each reset date; this function exists to extend a client's known rate history
 * out across resets that haven't happened yet, under an explicit, documented election,
 * so a forecast doesn't quietly assume "today's rate forever" without anyone choosing
 * that on purpose.
 *
 * Two elections, matching how floating-rate facilities are actually modeled:
 *  - "lockLatestReset": hold the most recently KNOWN reset rate flat for every future
 *    reset date. The simple, conservative default — no forward-curve data required.
 *  - "forwardCurve": look up each future reset date against a client-supplied forward
 *    curve (e.g. derived from SOFR forward-starting swap/futures pricing). The curve
 *    is held flat between its own points using the exact same step-function
 *    convention `RateSegment` itself uses — one rate-lookup idea to reason about, not
 *    two. A reset date outside the curve's coverage throws rather than extrapolating —
 *    an incomplete curve is a data problem to fix upstream, not a guess to paper over.
 *
 * Returns a combined `RateSegment[]` (known history + projected resets) ready to hand
 * straight to `buildDailyAccrualDetail`/`buildDailyAccrualSchedule` — nothing about
 * those functions needs to know or care that some of the segments are projections
 * rather than realized fixings. Tag anything built from projected segments clearly in
 * whatever report consumes it; this function has no way to do that tagging for you.
 */
export type RateProjectionMethod =
  | { type: "lockLatestReset" }
  | { type: "forwardCurve"; curve: { date: ISODate; rate: DecimalValue }[] };

export function buildProjectedRateSegments(
  knownRateSegments: RateSegment[],
  futureResetDates: ISODate[],
  method: RateProjectionMethod,
  /** Added to whichever base rate the projection produces (curve point or locked
   * rate). Pass this when the curve/lock is an INDEX rate (e.g. plain SOFR) rather
   * than the loan's own all-in rate; leave the default 0 when the known segments and
   * the curve are already expressed as all-in rates. */
  spread: DecimalValue = 0
): RateSegment[] {
  const known = [...knownRateSegments].sort((a, b) => (a.effectiveDate < b.effectiveDate ? -1 : a.effectiveDate > b.effectiveDate ? 1 : 0));
  if (known.length === 0) {
    throw new Error("buildProjectedRateSegments requires at least one known rate segment to project forward from");
  }
  const lastKnown = known[known.length - 1];
  const spreadDecimal = new Decimal(spread);

  const sortedCurve = method.type === "forwardCurve" ? [...method.curve].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) : [];

  const projected: RateSegment[] = [...futureResetDates].sort().map((resetDate) => {
    if (resetDate <= lastKnown.effectiveDate) {
      throw new Error(
        `Projected reset date ${resetDate} is not after the latest known reset (${lastKnown.effectiveDate}) — only future resets should be projected`
      );
    }
    if (method.type === "lockLatestReset") {
      return { effectiveDate: resetDate, annualRate: new Decimal(lastKnown.annualRate).plus(spreadDecimal) };
    }
    const applicablePoint = [...sortedCurve].reverse().find((c) => c.date <= resetDate);
    if (!applicablePoint) {
      throw new Error(`No forward curve point on or before reset date ${resetDate} — the curve doesn't cover this date`);
    }
    return { effectiveDate: resetDate, annualRate: new Decimal(applicablePoint.rate).plus(spreadDecimal) };
  });

  return [...known, ...projected];
}
