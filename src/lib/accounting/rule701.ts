import { Decimal, DecimalValue, Money, ISODate } from "./types.js";
import { addYears } from "./dateMath.js";

/**
 * Rule 701 (Securities Act) exempt-offering compliance tracking — v0.36.0.
 *
 * WHAT RULE 701 ACTUALLY GATES, IN PLAIN TERMS: a private company can grant equity
 * compensation (options, RSUs, restricted stock, and similar) to employees,
 * directors, consultants, and advisors without registering those securities with the
 * SEC, under Rule 701 — but only within limits, and one of those limits has a real
 * dollar trigger that's easy to blow past without anyone noticing, because it
 * accumulates silently across every grant a company makes, not just one big one.
 *
 * TWO SEPARATE THRESHOLDS, BOTH MEASURED OVER A ROLLING 12-MONTH PERIOD — DO NOT
 * CONFLATE THEM:
 *
 * 1. THE ENHANCED-DISCLOSURE TRIGGER — $10,000,000. Once the AGGREGATE SALES PRICE of
 *    everything sold under Rule 701 in any rolling 12-month period exceeds this
 *    figure, Rule 701(e) requires the company to deliver enhanced disclosure (risk
 *    factors and financial statements) to every recipient a reasonable time before
 *    the sale — this is the number most companies actually need to watch, since it's
 *    an operational disclosure obligation, not just an eligibility cutoff. Confirmed
 *    current as of SEC staff guidance issued March 6, 2026 (see this feature's
 *    delivery README for the source) — this figure was raised from $5,000,000 to
 *    $10,000,000 by a 2018-2021 rulemaking and has not changed again since, per the
 *    sources checked when this was built, but SECURITIES-LAW THRESHOLDS DO GET
 *    PERIODICALLY REVISITED — confirm this is still current before relying on it for
 *    an actual compliance determination, the same caveat this codebase already
 *    attaches to the QSBS OBBBA treatment in taxElections.ts.
 *
 * 2. THE ELIGIBILITY CEILING — the GREATER of $1,000,000, 15% of the issuer's total
 *    assets, or 15% of the outstanding amount of the class of securities being sold
 *    (each measured at the issuer's most recent balance sheet date). Exceeding THIS
 *    one means the excess sales aren't exempt under Rule 701 at all (a much more
 *    serious problem than the disclosure trigger). This module computes two of the
 *    three prongs — the flat $1,000,000 floor always, and 15% of total assets when a
 *    `totalAssets` figure is supplied (Rule 701 always uses the GREATEST of the
 *    prongs, so supplying it only ever raises the ceiling, never lowers it).
 *
 *    THE THIRD PRONG — 15% of the outstanding amount of the class — IS DELIBERATELY
 *    NOT COMPUTED HERE. Converting "15% of a share count" into a dollar figure
 *    comparable to an aggregate sales price requires a specific SEC-sanctioned
 *    valuation convention this module's research couldn't confirm with confidence
 *    (which price to apply, and whether it is measured against the WHOLE outstanding
 *    class or the class actually being offered) — rather than guess at a mechanic
 *    that could understate a real ceiling, this prong is left out entirely, and the
 *    result says so via `thirdProngNotComputed`. If this platform's numbers are
 *    anywhere near either threshold, get the real figure from securities counsel
 *    before relying on this module's ceiling as the final word.
 *
 * WHAT "AGGREGATE SALES PRICE" MEANS FOR EACH SECURITY TYPE — A DELIBERATE, FLAGGED
 * CONVENTION, NOT A SETTLED LEGAL RULE: how to value a security "sold" for no cash
 * (an option grant, an RSU) under Rule 701(e) is a genuinely debated mechanical
 * question that securities counsel disagree on in the details, and this module does
 * NOT resolve that debate — it applies one conservative, documented convention
 * consistently: for an option or warrant, the GREATER of the aggregate exercise price
 * and the aggregate fair market value of the underlying securities at grant (the more
 * conservative of the two common approaches, since it never understates); for
 * anything else (RSU, restricted stock, common stock issued directly), the aggregate
 * fair market value at grant, since no exercise price exists to compare against.
 * TREAT THIS AS A COMPLIANCE-MONITORING ESTIMATE, NOT A FILED DETERMINATION — a real
 * Rule 701 analysis (especially near either threshold) should be confirmed with
 * securities counsel, exactly as this module's own delivery README says outright.
 */

const DISCLOSURE_THRESHOLD: DecimalValue = 10_000_000;
const ELIGIBILITY_FLOOR: DecimalValue = 1_000_000;

export type Rule701SecurityType = "STOCK_OPTION" | "WARRANT" | "RSU" | "RESTRICTED_STOCK" | "COMMON_STOCK";

export interface Rule701Grant {
  id: string;
  type: Rule701SecurityType;
  /** The date this grant counts as "sold" for Rule 701 purposes — the grant date for
   * an option/RSU/restricted stock award, or the issuance date for a direct sale of
   * common stock. */
  grantDate: ISODate;
  quantity: DecimalValue;
  fairMarketValuePerUnitAtGrant: DecimalValue;
  /** Required for STOCK_OPTION/WARRANT (see the module doc comment's "greater of"
   * convention); ignored for every other type. */
  exercisePricePerUnit?: DecimalValue;
}

export interface Rule701GrantSalesPrice {
  grantId: string;
  grantDate: ISODate;
  aggregateSalesPrice: Money;
  /** Which figure governed — "exercise price" or "fair market value" for an option/
   * warrant (whichever was greater), or always "fair market value" for everything
   * else — surfaced so a reviewer can see WHY a number came out the way it did, not
   * just the final figure. */
  basis: "exercise price" | "fair market value";
}

/** Computes one grant's contribution to the rolling-window aggregate — see the module
 * doc comment for the convention this applies. */
export function computeRule701GrantSalesPrice(grant: Rule701Grant): Rule701GrantSalesPrice {
  const quantity = new Decimal(grant.quantity);
  const aggregateFmv = quantity.times(grant.fairMarketValuePerUnitAtGrant);

  if (grant.type === "STOCK_OPTION" || grant.type === "WARRANT") {
    if (grant.exercisePricePerUnit === undefined) {
      throw new Error(`Rule701Grant "${grant.id}": exercisePricePerUnit is required for a ${grant.type}.`);
    }
    const aggregateExercise = quantity.times(grant.exercisePricePerUnit);
    if (aggregateExercise.greaterThan(aggregateFmv)) {
      return { grantId: grant.id, grantDate: grant.grantDate, aggregateSalesPrice: aggregateExercise, basis: "exercise price" };
    }
    return { grantId: grant.id, grantDate: grant.grantDate, aggregateSalesPrice: aggregateFmv, basis: "fair market value" };
  }

  return { grantId: grant.id, grantDate: grant.grantDate, aggregateSalesPrice: aggregateFmv, basis: "fair market value" };
}

export interface Rule701RollingWindowInputs {
  /** The date to evaluate the trailing 12-month window against — typically today, or
   * the date of a specific grant being checked before it's made. */
  asOfDate: ISODate;
  grants: Rule701Grant[];
  /** Optional — sharpens the eligibility ceiling's "15% of total assets" prong. See
   * the module doc comment for why the third prong (15% of the outstanding class)
   * has no equivalent input here. */
  totalAssets?: DecimalValue;
}

export interface Rule701RollingWindowResult {
  windowStart: ISODate;
  windowEnd: ISODate;
  grantsInWindow: Rule701GrantSalesPrice[];
  aggregateSalesPriceInWindow: Money;
  disclosureThreshold: Money;
  exceedsDisclosureThreshold: boolean;
  /** How much room is left before the disclosure trigger — negative once exceeded,
   * so a caller can render "headroom" either way without a separate sign check. */
  headroomBeforeDisclosureThreshold: Money;
  eligibilityCeiling: Money;
  eligibilityCeilingBasis: "flat $1,000,000 floor" | "15% of total assets";
  /** Always true today — see the module doc comment on why the third statutory prong
   * (15% of the outstanding class) is never computed here. A caller should treat
   * `eligibilityCeiling` as a FLOOR on the real ceiling, never the final word. */
  thirdProngNotComputed: true;
  exceedsEligibilityCeiling: boolean;
}

/**
 * Sums every grant whose `grantDate` falls within the rolling 12-month window ending
 * on `asOfDate` (inclusive of both ends — a grant made exactly on the window's start
 * date still counts, since it's within the trailing 12 months as of `asOfDate`), and
 * compares that total against both Rule 701 thresholds. See the module doc comment
 * for what each threshold means and the valuation convention this applies.
 */
export function computeRule701RollingWindow(inputs: Rule701RollingWindowInputs): Rule701RollingWindowResult {
  const windowStart = addYears(inputs.asOfDate, -1);
  const grantsInWindow = inputs.grants
    .filter((g) => g.grantDate >= windowStart && g.grantDate <= inputs.asOfDate)
    .map(computeRule701GrantSalesPrice)
    .sort((a, b) => (a.grantDate < b.grantDate ? -1 : a.grantDate > b.grantDate ? 1 : 0));

  const aggregateSalesPriceInWindow = grantsInWindow.reduce(
    (sum, g) => sum.plus(g.aggregateSalesPrice),
    new Decimal(0)
  );

  const disclosureThreshold = new Decimal(DISCLOSURE_THRESHOLD);
  const exceedsDisclosureThreshold = aggregateSalesPriceInWindow.greaterThan(disclosureThreshold);
  const headroomBeforeDisclosureThreshold = disclosureThreshold.minus(aggregateSalesPriceInWindow);

  let eligibilityCeiling = new Decimal(ELIGIBILITY_FLOOR);
  let eligibilityCeilingBasis: Rule701RollingWindowResult["eligibilityCeilingBasis"] = "flat $1,000,000 floor";
  if (inputs.totalAssets !== undefined) {
    const fifteenPercentOfAssets = new Decimal(inputs.totalAssets).times(0.15);
    if (fifteenPercentOfAssets.greaterThan(eligibilityCeiling)) {
      eligibilityCeiling = fifteenPercentOfAssets;
      eligibilityCeilingBasis = "15% of total assets";
    }
  }
  const exceedsEligibilityCeiling = aggregateSalesPriceInWindow.greaterThan(eligibilityCeiling);

  return {
    windowStart,
    windowEnd: inputs.asOfDate,
    grantsInWindow,
    aggregateSalesPriceInWindow,
    disclosureThreshold,
    exceedsDisclosureThreshold,
    headroomBeforeDisclosureThreshold,
    eligibilityCeiling,
    eligibilityCeilingBasis,
    thirdProngNotComputed: true,
    exceedsEligibilityCeiling,
  };
}
