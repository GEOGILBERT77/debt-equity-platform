import { ScheduleRow, ISODate, Decimal, DecimalValue } from "./types.js";
import { daysBetween, Period } from "./dateMath.js";
import { Tranche, ServiceConditionGrant, buildServiceConditionSchedule } from "./vesting.js";

/**
 * ASC 718 stock appreciation rights (SARs) — the one instrument type whose accounting
 * genuinely forks on a single fact about the award: what it settles in.
 *
 * STOCK-SETTLED SAR (ASC 718-10): equity-classified. A stock-settled SAR granted with a
 * strike price equal to the grant-date share price is economically identical, for
 * measurement purposes, to a stock option — fixed grant-date fair value (from an
 * option-pricing model; see blackScholes.ts), recognized straight-line (or graded) over
 * the requisite service period, with NO subsequent remeasurement regardless of how the
 * stock price moves afterward. That means there is nothing new to build here: this
 * module doesn't define a separate schedule function for the stock-settled case at all
 * — see dispatch.ts's SAR branch, which routes `settlementType: "STOCK"` straight to
 * `buildServiceConditionSchedule` (the exact function STOCK_OPTION/RSU already use),
 * only relabeling the ASC citation on the resulting rows so the audit trail correctly
 * says "SAR" rather than "stock option."
 *
 * CASH-SETTLED SAR (ASC 718-30, specifically 718-10-25-6 through 25-20 and
 * 718-30-35-3): liability-classified. This IS genuinely different math, which is why
 * `buildCashSettledSarSchedule` below exists: the award is remeasured to fair value at
 * EVERY reporting date — during vesting AND after, all the way to settlement — not
 * fixed at grant date. Cumulative compensation cost recognized as of any measurement
 * date equals (the portion of the requisite service period elapsed as of that date) ×
 * (the award's current fair value), and each period's expense is the change in that
 * cumulative figure. Two consequences that surprise people coming from the stock-option
 * case: (1) a period's "expense" can be negative (a credit/gain) if fair value fell,
 * even during vesting — variable/liability accounting doesn't floor at zero the way
 * forfeiture-driven reversals do; (2) UNLIKE a stock option, remeasurement doesn't stop
 * at full vesting — once the service fraction hits 100%, every subsequent fair value
 * change flows through compensation cost in full until the SAR is exercised/settled or
 * expires, which is precisely why a cash-settled SAR is a genuinely ongoing liability
 * to track, not a one-time grant-date estimate.
 *
 * FAIR VALUE INPUT MODE — same convention as fairValueRemeasurement.ts: this engine
 * takes each period's fair-value-per-unit as a given input (a Black-Scholes rerun with
 * the current stock price, or an independent valuation), not something it computes
 * itself. Using the award's INTRINSIC value (current stock price minus strike price,
 * floored at zero) instead of a full option-pricing value is a common, ASC-permitted
 * simplification for a private company without a practical way to estimate volatility
 * for a subsequent-measurement date — that's a choice made when producing each
 * observation's `fairValuePerUnit`, not something this engine needs to know about.
 *
 * SIMPLIFICATION, FLAGGED: this engine only supports STRAIGHT-LINE attribution over the
 * full requisite service period (grant date to the LAST tranche's vest date) — unlike
 * `buildServiceConditionSchedule`, there is no "graded" (FIN 28, tranche-by-tranche)
 * option here. Graded attribution for a liability award is a real, more complex
 * extension (each tranche has its own requisite service period AND its own share of
 * the fair-value remeasurement each period) that a representative slice of this
 * codebase doesn't yet cover — flagging it here rather than silently picking the
 * simpler method without saying so.
 */

export interface CashSettledSarObservation {
  /** Must equal the `end` of the period this observation belongs to — same convention,
   * and same reason, as FairValueRemeasurementInputs.observations in
   * fairValueRemeasurement.ts. */
  date: ISODate;
  /** Per-unit fair value of the SAR as of this date (already net of strike price —
   * i.e. the value of the appreciation right itself, not the underlying share price). */
  fairValuePerUnit: DecimalValue;
}

export interface CashSettledSarGrant {
  grantDate: ISODate;
  quantity: DecimalValue;
  /** Used only for context/disclosure in this module (it's baked into each
   * observation's fairValuePerUnit already) — carried on the type because it's part of
   * the award's actual terms and capTable.ts or a future disclosure note may want it. */
  strikePrice: DecimalValue;
  /** Requisite service period is derived as grantDate -> the LATEST tranche's vestDate
   * (straight-line over the whole award — see the module doc comment's flagged
   * simplification). Quantities across tranches must sum to `quantity`, checked by
   * termsValidation.ts at the API boundary, not re-checked here. */
  tranches: Tranche[];
  /** Chronological, one entry per period passed to the schedule builder — same
   * "one observation per period" contract as FairValueRemeasurementInputs. */
  observations: CashSettledSarObservation[];
}

export function buildCashSettledSarSchedule(grant: CashSettledSarGrant, periods: Period[]): ScheduleRow[] {
  if (grant.observations.length !== periods.length) {
    throw new Error("observations must have exactly one entry per period (one fair value measurement per period end)");
  }
  if (!grant.tranches || grant.tranches.length === 0) {
    throw new Error("A SAR grant must have at least one vesting tranche");
  }

  const totalQuantity = new Decimal(grant.quantity);
  const requisiteServiceEnd = grant.tranches.reduce(
    (max, t) => (t.vestDate > max ? t.vestDate : max),
    grant.tranches[0].vestDate
  );
  const totalRequisiteDays = daysBetween(grant.grantDate, requisiteServiceEnd);

  let previousCumulative = new Decimal(0);
  const rows: ScheduleRow[] = [];

  periods.forEach((p, i) => {
    const obs = grant.observations[i];
    if (obs.date !== p.end) {
      throw new Error(
        `Observation ${i} ("${p.label}") is dated ${obs.date}, but the period ends ${p.end} — observations must be dated to their own period's end`
      );
    }

    const elapsedDays = daysBetween(grant.grantDate, p.end);
    // Capped at 1 (never negative — a period ending before grantDate shouldn't occur,
    // but daysBetween returning a negative for a malformed periods array is a caller
    // bug, not something to silently clamp away here).
    const rawFraction = totalRequisiteDays <= 0 ? new Decimal(1) : new Decimal(elapsedDays).div(totalRequisiteDays);
    const serviceFraction = rawFraction.greaterThanOrEqualTo(1) ? new Decimal(1) : rawFraction;

    const fairValuePerUnit = new Decimal(obs.fairValuePerUnit);
    const cumulative = totalQuantity.times(fairValuePerUnit).times(serviceFraction);
    const periodAmount = cumulative.minus(previousCumulative);

    rows.push({
      periodStart: p.start,
      periodEnd: p.end,
      label: p.label,
      amount: periodAmount,
      endingBalance: cumulative,
      meta: {
        ascReference: "ASC 718-30-35-3 (cash-settled SAR — liability remeasured to fair value each period)",
        settlementType: "CASH",
        serviceFraction: serviceFraction.toFixed(6),
        fairValuePerUnit: fairValuePerUnit.toFixed(4),
        fullyVested: serviceFraction.equals(1),
      },
    });

    previousCumulative = cumulative;
  });

  return rows;
}

/**
 * Convenience wrapper for the STOCK-settled branch — see the module doc comment for
 * why this is just `buildServiceConditionSchedule` with the ASC citation on each row
 * relabeled to say "SAR" rather than "stock option." `grant` is exactly a
 * ServiceConditionGrant (grantDateFairValuePerUnit here is the Black-Scholes value of
 * the appreciation right, computed the same way an option's would be, using the SAR's
 * strike price as the option's strike).
 */
export function buildStockSettledSarSchedule(grant: ServiceConditionGrant, periods: Period[]): ScheduleRow[] {
  return buildServiceConditionSchedule(grant, periods).map((row) => ({
    ...row,
    meta: {
      ...row.meta,
      ascReference: "ASC 718-10-35 (stock-settled SAR, equity-classified — measured like a stock option)",
      settlementType: "STOCK",
    },
  }));
}
