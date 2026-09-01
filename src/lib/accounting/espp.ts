import { Money, money, Decimal, DecimalValue, JournalEntry } from "./types.js";
import { blackScholesCallValue } from "./blackScholes.js";
import { buildCashExerciseEntry, CashExerciseInput } from "./optionSettlement.js";

/**
 * ASC 718-50 — Employee Stock Purchase Plans (ESPPs).
 *
 * Two genuinely separate questions, handled separately below rather than folded into
 * one function:
 *
 * 1. IS THE PLAN COMPENSATORY AT ALL? (`classifyEsppPlan`) ASC 718-50-25-1 lets a plan
 *    avoid recognizing ANY compensation cost — not a small amount, none — if it meets
 *    every one of: (a) essentially all employees may participate on an equitable
 *    basis; (b) the discount from market price is no greater than a discount a company
 *    could reasonably offer to any shareholder or group of shareholders, or others, in
 *    raising capital through a public stock offering — a discount of 5% or less is a
 *    safe harbor needing no further support, and a discount up to 15% CAN still
 *    qualify but only with evidence supporting the larger discount (typically, the
 *    absence of underwriting/selling costs the company would otherwise incur) — a
 *    factual, case-specific finding this module cannot make itself and takes as a
 *    given boolean input (`discountJustifiedAboveSafeHarbor`), not something it
 *    derives; and (c) the plan has no option-like features. (c) is the one most often
 *    overlooked: it categorically means a plan with a LOOK-BACK feature (purchase
 *    price based on the lower of the price at the start or the end of the offering
 *    period) is compensatory, full stop, no matter how small the stated discount is —
 *    the look-back itself IS the option-like feature, independent of the discount
 *    percentage.
 *
 * 2. FOR A COMPENSATORY PLAN, WHAT'S THE GRANT-DATE FAIR VALUE OF THE PURCHASE RIGHT?
 *    Two structures are supported explicitly, because they need genuinely different
 *    math, not because of an arbitrary split:
 *
 *    a) NO LOOK-BACK, discount-only (`computeEsppDiscountOnlyFairValue`): the purchase
 *       price is simply (1 - discount) times the stock price AT THE PURCHASE DATE —
 *       there is no optionality in this payoff at all (the employee always receives
 *       exactly `discount * purchase-date price` of value, regardless of which
 *       direction the stock moved), so this is priced as a forward, not an option:
 *       fair value = discount * S0 * e^(-dividendYield * T). No Black-Scholes call is
 *       needed here, and no volatility input is used — a common real-world mistake is
 *       running an option-pricing model on this structure when the payoff isn't
 *       optional to begin with.
 *
 *    b) LOOK-BACK (`computeEsppLookbackFairValue`): purchase price = (1 - discount) *
 *       MIN(grant-date price, purchase-date price). This genuinely is compound
 *       optionality, and this module decomposes it into a closed-form combination of
 *       Black-Scholes prices rather than reaching for a lattice/Monte Carlo model.
 *       Writing the payoff at the purchase date as `S_T - (1-d)*MIN(S0,S_T)` and using
 *       `MIN(S0,S_T) = S0 - max(S0-S_T,0)` (i.e., S0 minus a put payoff struck at S0),
 *       algebra collapses the payoff to exactly:
 *
 *           Payoff = CallPayoff(K=S0) + d*S0 - d*PutPayoff(K=S0)
 *
 *       — verified by hand for all three cases (stock flat, up, and down) in this
 *       module's test file. Taking the risk-neutral discounted expectation of each
 *       term term-by-term (Black-Scholes already IS that discounted expectation for
 *       the call/put terms; `d*S0` is a fixed amount at time T that just needs its own
 *       discount factor) gives the grant-date fair value used here:
 *
 *           FairValue = Call(K=S0,T) + d*S0*e^(-rT) - d*Put(K=S0,T)
 *
 *       The put is derived from `blackScholesCallValue` via ordinary put-call parity
 *       (`Put = Call - S0*e^(-qT) + K*e^(-rT)`, with K=S0) rather than this module
 *       writing a second, independent option-pricing implementation — same
 *       reuse-over-reinvention approach as every other engine in this codebase.
 *
 *    Both valuation functions return a per-share grant-date fair value; total
 *    compensation cost for a purchase right is that value times the number of shares
 *    expected to be purchased, which this module leaves to the caller since the
 *    number of shares actually purchased isn't known with certainty until the
 *    purchase date (payroll withholding elections can change, and IRC 423(b)(8)'s
 *    $25,000-per-year limit can cap it — see "deliberately out of scope" below).
 *
 * RECOGNITION AND PURCHASE ACCOUNTING — deliberately NOT reinvented here:
 *  - For a COMPENSATORY plan, the grant-date fair value computed above is recognized
 *    as compensation cost straight-line over the offering period exactly like a
 *    service-condition stock option — `vesting.ts`'s `buildServiceConditionSchedule`
 *    already does this (a single tranche vesting at the purchase date IS the offering
 *    period's only "vest date"); this module does not duplicate that engine.
 *  - The actual PURCHASE, when it happens, is structurally identical to a cash
 *    exercise of a stock option: the employee pays cash (the discounted purchase
 *    price) and the compensation cost already recognized in Additional Paid-In
 *    Capital over the offering period is reclassified into Common Stock alongside it.
 *    `optionSettlement.ts`'s `buildCashExerciseEntry` already models exactly that —
 *    `buildEsppPurchaseEntry` below is a thin, ESPP-flavored wrapper around it, not a
 *    new journal-entry function. For a NONCOMPENSATORY plan, pass a grant-date fair
 *    value of 0: `buildCashExerciseEntry` naturally omits the APIC reclassification
 *    line in that case (see its own source), which is exactly correct — a
 *    noncompensatory purchase books nothing but cash in for shares out, since no
 *    compensation cost was ever recognized to reclassify.
 *
 * DELIBERATELY OUT OF SCOPE, flagged rather than approximated:
 *  - Multiple purchase periods within one offering with a "reset"/rollover feature (if
 *    the stock price at a purchase date is below the original offering price, the
 *    offering automatically restarts using the new, lower price as the new floor) —
 *    a real and common provision that adds genuine path dependency this closed-form
 *    decomposition cannot capture; needs a lattice or Monte Carlo model instead.
 *  - Employee mid-offering withdrawal optionality (most plans let a participant pull
 *    contributions out before the purchase date if the stock has fallen) — this is
 *    itself a real option on top of the look-back option already modeled, and this
 *    module assumes full participation through the purchase date.
 *  - The IRC Section 423(b)(8) $25,000-per-calendar-year purchase limit, and any other
 *    plan-specific share/dollar caps — these constrain the QUANTITY of shares
 *    purchasable, which this module takes as a given input rather than deriving.
 *  - Non-Section-423 ("non-qualified") ESPPs with materially different terms (e.g., no
 *    requirement that substantially all employees be eligible) — those are always
 *    compensatory by their nature and just skip `classifyEsppPlan` entirely, going
 *    straight to the fair-value functions.
 */

function toNumber(v: DecimalValue): number {
  return typeof v === "number" ? v : typeof v === "string" ? Number(v) : v.toNumber();
}

export interface EsppPlanTerms {
  discountPercent: DecimalValue; // e.g. 0.15 for a 15% discount
  hasLookback: boolean;
  substantiallyAllEmployeesEligible: boolean;
  /** Only consulted when 0.05 < discountPercent <= 0.15. A factual finding (typically,
   * evidence of reduced selling/underwriting costs vs. a public offering) that this
   * module cannot make itself — see the module doc comment. */
  discountJustifiedAboveSafeHarbor?: boolean;
}

export type EsppClassification =
  | { kind: "NONCOMPENSATORY"; reason: string }
  | { kind: "COMPENSATORY"; reason: string };

/** ASC 718-50-25-1's noncompensatory-plan test. See the module doc comment for the
 * three criteria and why a look-back feature is categorically disqualifying. */
export function classifyEsppPlan(terms: EsppPlanTerms): EsppClassification {
  if (!terms.substantiallyAllEmployeesEligible) {
    return {
      kind: "COMPENSATORY",
      reason: "ASC 718-50-25-1(a) fails: not substantially all employees are eligible to participate on an equitable basis.",
    };
  }
  if (terms.hasLookback) {
    return {
      kind: "COMPENSATORY",
      reason: "ASC 718-50-25-1(c) fails categorically: a look-back feature is an option-like feature regardless of the discount size.",
    };
  }
  const discount = Decimal.from(terms.discountPercent);
  if (discount.lessThanOrEqualTo(0.05)) {
    return {
      kind: "NONCOMPENSATORY",
      reason: `Discount of ${discount.times(100).toFixed(2)}% is within the 5% safe harbor of ASC 718-50-25-1(b) — no further justification needed.`,
    };
  }
  if (discount.lessThanOrEqualTo(0.15) && terms.discountJustifiedAboveSafeHarbor) {
    return {
      kind: "NONCOMPENSATORY",
      reason: `Discount of ${discount.times(100).toFixed(2)}% exceeds the 5% safe harbor but is within the 15% ceiling and supported by evidence of a reasonable business reason (ASC 718-50-25-1(b)).`,
    };
  }
  return {
    kind: "COMPENSATORY",
    reason:
      discount.greaterThan(0.15)
        ? `Discount of ${discount.times(100).toFixed(2)}% exceeds the 15% ceiling in ASC 718-50-25-1(b).`
        : `Discount of ${discount.times(100).toFixed(2)}% exceeds the 5% safe harbor and is not supported by evidence justifying a larger discount.`,
  };
}

export interface EsppDiscountOnlyValuationInputs {
  purchaseDateReferenceStockPrice: DecimalValue; // S0 — best current estimate of the price the payoff is a fraction of
  discountPercent: DecimalValue;
  offeringPeriodYears: DecimalValue;
  dividendYield?: DecimalValue;
}

/** No look-back: the payoff (`discount * purchase-date price`) isn't optional, so this
 * is priced as a forward, not an option — see the module doc comment. */
export function computeEsppDiscountOnlyFairValue(inputs: EsppDiscountOnlyValuationInputs): Money {
  const S0 = toNumber(inputs.purchaseDateReferenceStockPrice);
  const d = toNumber(inputs.discountPercent);
  const q = toNumber(inputs.dividendYield ?? 0);
  const T = toNumber(inputs.offeringPeriodYears);
  const value = d * S0 * Math.exp(-q * T);
  return money(Math.max(value, 0));
}

export interface EsppLookbackValuationInputs {
  grantDateStockPrice: DecimalValue; // S0
  discountPercent: DecimalValue; // d
  riskFreeRate: DecimalValue;
  volatility: DecimalValue;
  offeringPeriodYears: DecimalValue; // T
  dividendYield?: DecimalValue;
}

/** Look-back: purchase price = (1-discount) * MIN(grant-date price, purchase-date
 * price). See the module doc comment for the closed-form decomposition into
 * Call(K=S0,T) + d*S0*e^(-rT) - d*Put(K=S0,T), with the put derived via put-call
 * parity from the same `blackScholesCallValue` every other grant-date valuation in
 * this codebase already uses. */
export function computeEsppLookbackFairValue(inputs: EsppLookbackValuationInputs): Money {
  const S0 = toNumber(inputs.grantDateStockPrice);
  const d = toNumber(inputs.discountPercent);
  const r = toNumber(inputs.riskFreeRate);
  const q = toNumber(inputs.dividendYield ?? 0);
  const T = toNumber(inputs.offeringPeriodYears);

  const callValue = blackScholesCallValue({
    stockPrice: S0,
    strikePrice: S0,
    riskFreeRate: r,
    volatility: inputs.volatility,
    expectedTermYears: T,
    dividendYield: q,
  }).toNumber();

  // Put-call parity, K = S0: Put = Call - S0*e^(-qT) + K*e^(-rT)
  const putValueRaw = callValue - S0 * Math.exp(-q * T) + S0 * Math.exp(-r * T);
  const putValue = Math.max(putValueRaw, 0); // defensive only — parity shouldn't yield negative here

  const discountPV = d * S0 * Math.exp(-r * T);
  const value = callValue + discountPV - d * putValue;
  return money(Math.max(value, 0));
}

export interface EsppFairValueInputs {
  hasLookback: boolean;
  grantDateStockPrice: DecimalValue;
  discountPercent: DecimalValue;
  riskFreeRate: DecimalValue;
  /** Required when `hasLookback` is true; ignored for the discount-only path (see the
   * module doc comment on why no-lookback pricing needs no volatility input at all). */
  volatility?: DecimalValue;
  offeringPeriodYears: DecimalValue;
  dividendYield?: DecimalValue;
}

/** Dispatches to the look-back or discount-only valuation based on `hasLookback` —
 * convenience wrapper for callers (e.g. the API route) that don't want to pick the
 * function themselves. */
export function computeEsppGrantDateFairValue(inputs: EsppFairValueInputs): Money {
  if (inputs.hasLookback) {
    if (inputs.volatility === undefined) {
      throw new Error("computeEsppGrantDateFairValue: volatility is required when hasLookback is true.");
    }
    return computeEsppLookbackFairValue({
      grantDateStockPrice: inputs.grantDateStockPrice,
      discountPercent: inputs.discountPercent,
      riskFreeRate: inputs.riskFreeRate,
      volatility: inputs.volatility,
      offeringPeriodYears: inputs.offeringPeriodYears,
      dividendYield: inputs.dividendYield,
    });
  }
  return computeEsppDiscountOnlyFairValue({
    purchaseDateReferenceStockPrice: inputs.grantDateStockPrice,
    discountPercent: inputs.discountPercent,
    offeringPeriodYears: inputs.offeringPeriodYears,
    dividendYield: inputs.dividendYield,
  });
}

export interface EsppPurchaseInput {
  purchaseDate: string;
  quantityPurchased: DecimalValue;
  /** The actual discounted price the employee paid per share. */
  purchasePricePerUnit: DecimalValue;
  /** The grant-date fair value per unit already recognized as compensation cost over
   * the offering period (0 for a noncompensatory plan — see the module doc comment). */
  grantDateFairValuePerUnit: DecimalValue;
}

/** Thin ESPP-flavored wrapper around `optionSettlement.ts`'s `buildCashExerciseEntry`
 * — an ESPP purchase and a cash option exercise are the same accounting shape (cash
 * paid + already-recognized APIC comp cost = shares issued), so this reuses that
 * function directly rather than reimplementing it. See the module doc comment. */
export function buildEsppPurchaseEntry(input: EsppPurchaseInput): JournalEntry {
  const cashExerciseInput: CashExerciseInput = {
    exerciseDate: input.purchaseDate,
    quantityExercised: input.quantityPurchased,
    exercisePricePerUnit: input.purchasePricePerUnit,
    grantDateFairValuePerUnit: input.grantDateFairValuePerUnit,
  };
  const entry = buildCashExerciseEntry(cashExerciseInput);
  return {
    ...entry,
    description: `ESPP purchase — ${Decimal.from(input.quantityPurchased).toFixed(2)} shares`,
    ascReference: "ASC 718-50 (employee stock purchase plan)",
  };
}
