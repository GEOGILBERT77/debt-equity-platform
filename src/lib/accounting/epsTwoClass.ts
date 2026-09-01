import { Money, money, Decimal, DecimalValue } from "./types.js";

/**
 * ASC 260-10-45's two-class method for EPS, for the single most common real-world
 * shape this platform's clientele actually has: common stock plus ONE class of
 * participating convertible preferred stock.
 *
 * THE TWO-CLASS METHOD (ASC 260-10-45-60 through 45-70): when a security other than
 * common stock participates in dividends with common (a "participating security" —
 * the standard case here is convertible preferred that receives dividends alongside
 * common on an as-converted basis), basic EPS can't just divide net income by common
 * shares outstanding — a slice of earnings belongs to the participating class too.
 * The mechanics: (1) subtract dividends actually declared, to both classes, from net
 * income to get "undistributed earnings"; (2) allocate the undistributed earnings
 * between common and the participating class based on their participation rights
 * (this function assumes participation pro-rata by AS-CONVERTED shares — the common
 * real-world case, but see the SCOPE note below for when that assumption breaks
 * down); (3) each class's basic EPS = (its declared dividends + its allocated share
 * of undistributed earnings) / its own weighted-average (or as-converted) share count.
 *
 * THE SINGLE MOST COMMONLY MISCODED RULE HERE (ASC 260-10-45-62, checked first, not
 * an afterthought): a NET LOSS — or a net income that doesn't even cover the
 * dividends actually declared — is NOT allocated to the participating class. All of
 * it stays with common, the same way it would for a plain, non-participating capital
 * structure. Participating securities share in the UPSIDE of undistributed earnings;
 * they don't, absent an explicit contractual obligation to share in losses (which
 * this function does not model), absorb a shortfall.
 *
 * DILUTED EPS — the IF-CONVERTED comparison (ASC 260-10-45-60/45-61): for a
 * convertible participating security, diluted EPS uses whichever of two methods is
 * MORE DILUTIVE (produces the SMALLER EPS): the two-class method's basic result
 * above, or the "if-converted" method, which assumes the participating class
 * actually converted into common at the start of the period — no separate dividend
 * carve-out for it (it's common now), and its as-converted shares simply join the
 * denominator. `computeMoreDilutiveEps` runs both and picks the smaller, per class of
 * security, the way a real EPS footnote actually has to. A net loss is NEVER further
 * diluted (ASC 260-10-45-17's anti-dilution rule) — including potentially dilutive
 * securities can't make a loss per share look smaller, so a net loss period returns
 * the basic two-class result unchanged rather than running the if-converted
 * comparison at all.
 *
 * SCOPE, FLAGGED HONESTLY — this module handles the common case, not the full
 * breadth of ASC 260:
 *  - Exactly ONE participating class. Multiple participating classes with different
 *    seniority/participation terms interacting in the same waterfall is real,
 *    separate, more complex work — not a loop around this function.
 *  - Assumes the participating class shares in undistributed earnings STRICTLY
 *    pro-rata by as-converted share count. Some real participation provisions are
 *    more complex (a participation CAP, a different per-share participation rate
 *    than as-converted parity) — those need their own allocation logic, this
 *    function's `undistributed x participatingShares / totalShares` split is not
 *    universal.
 *  - For a CUMULATIVE preferred, ASC 260-10-45-11/45-12 requires subtracting the
 *    current period's cumulative dividend from the EPS numerator whether or not it
 *    was actually declared this period — this function takes
 *    `dividendsDeclaredToParticipatingClass` as a given input and does not derive
 *    that number itself. For a cumulative participating preferred, the caller should
 *    pass the period's accrued cumulative dividend (see
 *    `preferredStock.ts`'s `buildCumulativeDividendAccrualSchedule`, which computes
 *    exactly that figure), not merely what was actually paid.
 *  - Anti-dilution sequencing across MULTIPLE potentially dilutive securities (the
 *    real EPS rule requires ranking every dilutive security from most to least
 *    dilutive and adding them one at a time) is out of scope — this function compares
 *    exactly one participating/convertible class against the two-class basic result,
 *    not a full multi-security dilution sequencing waterfall.
 */

export interface TwoClassEpsInputs {
  /** Net income (positive) or net loss (negative) for the period. */
  netIncomeOrLoss: DecimalValue;
  dividendsDeclaredToCommon: DecimalValue;
  /** For a cumulative participating preferred, this should be the period's ACCRUED
   * cumulative dividend, not merely what was actually paid — see the module SCOPE
   * note above. */
  dividendsDeclaredToParticipatingClass: DecimalValue;
  weightedAverageCommonShares: DecimalValue;
  /** The participating class's shares, on an AS-CONVERTED-TO-COMMON basis (already
   * multiplied by its conversion ratio) — the same as-converted figure
   * `capTable.ts`'s PREFERRED_STOCK branch computes via `PreferredConversionTerms`
   * (dispatch.ts), so that's the one place this number should come from. */
  participatingClassAsConvertedShares: DecimalValue;
}

export interface TwoClassEpsResult {
  basicEpsCommon: Money;
  basicEpsParticipatingClass: Money;
  undistributedEarningsAllocatedToCommon: Money;
  undistributedEarningsAllocatedToParticipatingClass: Money;
  /** True when the net-loss/insufficient-earnings rule applied (ASC 260-10-45-62) —
   * i.e. no undistributed earnings were allocated to the participating class this
   * period, regardless of why. */
  lossOrInsufficientEarnings: boolean;
}

export function computeTwoClassBasicEps(inputs: TwoClassEpsInputs): TwoClassEpsResult {
  const commonShares = Decimal.from(inputs.weightedAverageCommonShares);
  if (!commonShares.greaterThan(0)) {
    throw new Error(`weightedAverageCommonShares must be positive (got ${commonShares.toString()}).`);
  }
  const participatingShares = Decimal.from(inputs.participatingClassAsConvertedShares);
  if (participatingShares.isNegative()) {
    throw new Error("participatingClassAsConvertedShares cannot be negative.");
  }

  const netIncome = Decimal.from(inputs.netIncomeOrLoss);
  const divCommon = Decimal.from(inputs.dividendsDeclaredToCommon);
  const divParticipating = Decimal.from(inputs.dividendsDeclaredToParticipatingClass);
  const undistributed = netIncome.minus(divCommon).minus(divParticipating);

  let undistributedToCommon: Decimal;
  let undistributedToParticipating: Decimal;
  const lossOrInsufficientEarnings = !undistributed.greaterThan(0);

  if (lossOrInsufficientEarnings) {
    // ASC 260-10-45-62 — see module doc comment. All of it (including a genuine net
    // loss, i.e. undistributed < 0) stays with common; nothing is allocated to the
    // participating class.
    undistributedToCommon = undistributed;
    undistributedToParticipating = new Decimal(0);
  } else {
    const totalShares = commonShares.plus(participatingShares);
    undistributedToParticipating = participatingShares.greaterThan(0)
      ? undistributed.times(participatingShares).div(totalShares)
      : new Decimal(0);
    undistributedToCommon = undistributed.minus(undistributedToParticipating);
  }

  const commonNumerator = divCommon.plus(undistributedToCommon);
  const participatingNumerator = divParticipating.plus(undistributedToParticipating);

  return {
    basicEpsCommon: money(commonNumerator.div(commonShares)),
    basicEpsParticipatingClass: participatingShares.greaterThan(0) ? money(participatingNumerator.div(participatingShares)) : money(0),
    undistributedEarningsAllocatedToCommon: money(undistributedToCommon),
    undistributedEarningsAllocatedToParticipatingClass: money(undistributedToParticipating),
    lossOrInsufficientEarnings,
  };
}

/** The "if-converted" alternative: assumes the participating class converted into
 * common at the start of the period, so the ENTIRE net income (no separate dividend
 * carve-out) is spread over the combined share base. Exposed on its own — not just
 * inlined into `computeMoreDilutiveEps` — since a caller may want to show both
 * candidate figures, not just the winner. */
export function computeIfConvertedEps(
  netIncomeOrLoss: DecimalValue,
  weightedAverageCommonShares: DecimalValue,
  participatingClassAsConvertedShares: DecimalValue
): Money {
  const totalShares = Decimal.from(weightedAverageCommonShares).plus(participatingClassAsConvertedShares);
  if (!totalShares.greaterThan(0)) {
    throw new Error("Combined common + as-converted participating shares must be positive.");
  }
  return money(Decimal.from(netIncomeOrLoss).div(totalShares));
}

export interface DilutedEpsResult {
  method: "TWO_CLASS" | "IF_CONVERTED";
  dilutedEpsCommon: Money;
}

/** Runs both candidate methods and returns whichever is MORE DILUTIVE for common
 * stock (ASC 260-10-45-60/45-61) — except in a net-loss period, where diluted EPS
 * always equals the basic two-class result unchanged (ASC 260-10-45-17's
 * anti-dilution rule: a loss per share can never be shown as smaller than it actually
 * is by assuming conversion of a potentially dilutive security). */
export function computeMoreDilutiveEps(inputs: TwoClassEpsInputs): DilutedEpsResult {
  const basic = computeTwoClassBasicEps(inputs);
  const netIncome = Decimal.from(inputs.netIncomeOrLoss);

  if (!netIncome.greaterThan(0)) {
    return { method: "TWO_CLASS", dilutedEpsCommon: basic.basicEpsCommon };
  }

  const ifConverted = computeIfConvertedEps(
    inputs.netIncomeOrLoss,
    inputs.weightedAverageCommonShares,
    inputs.participatingClassAsConvertedShares
  );

  if (ifConverted.lessThan(basic.basicEpsCommon)) {
    return { method: "IF_CONVERTED", dilutedEpsCommon: ifConverted };
  }
  return { method: "TWO_CLASS", dilutedEpsCommon: basic.basicEpsCommon };
}
