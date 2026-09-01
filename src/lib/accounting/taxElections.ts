import { Decimal, Money, ISODate, DecimalValue, ScheduleRow } from "./types.js";
import { Period, addDays, addYears } from "./dateMath.js";
import { allocateStraightLineByElapsedTime } from "./allocation.js";
import { buildEffectiveInterestSchedule } from "./debtAmortization.js";

/**
 * Tax election / tax-treatment tracking — a genuinely different domain from every
 * other file in this directory. Everything else here computes GAAP accounting
 * (ASC references); this file computes tax positions (IRC references), which
 * routinely diverge from the GAAP number for the exact same instrument. Nothing in
 * this file books a journal entry — there IS no journal entry for most of what's
 * here (a tax election doesn't move an account, it changes what goes on a return) —
 * so unlike every other engine file, there are no `*Entry` mappers alongside these
 * functions.
 *
 * Five sub-modules, each its own well-defined IRC rule:
 *  1. ISO $100k rule (IRC 422(d)) — splits ISO tranches into ISO/NSO portions.
 *  2. AMT preference on ISO exercise (IRC 56(b)(3)).
 *  3. IRC 83(b) elections for restricted stock, and the no-election alternative.
 *  4. QSBS / Section 1202 gain exclusion, including the One Big Beautiful Bill Act's
 *     July 2025 changes — see that section's doc comment for a specific caution about
 *     how recent and how narrowly-sourced that provision's detail is.
 *  5. Debt-side OID (IRC 1272/1273) and market discount (IRC 1276/1278) accrual.
 */

// =============================================================================
// 1. ISO $100,000 LIMITATION — IRC 422(d)
// =============================================================================
/**
 * The aggregate fair market value (measured AT GRANT) of stock for which ISOs granted
 * to one employee first become exercisable in any calendar year cannot exceed
 * $100,000. Anything in excess is treated as NSOs, not ISOs — automatically, by
 * statute, not by anyone's election. The statute requires options to be "taken into
 * account in the order in which [they were] granted" — so when multiple grants have
 * tranches becoming exercisable in the same calendar year, the earliest-granted
 * option's tranche(s) use up the $100k cap first, and a later grant's tranche in that
 * same year absorbs however much of the cap (if any) is left.
 *
 * Each calendar year is independent — there's no carryover of unused capacity from
 * one year to the next, and no aggregation across years for a single tranche.
 */
export interface IsoTranche {
  id: string;
  /** When this tranche first becomes exercisable — usually its vest date, but not
   * always (a plan can restrict exercisability separately from vesting). */
  firstExercisableDate: ISODate;
  quantity: DecimalValue;
}

export interface IsoGrant {
  id: string;
  grantDate: ISODate;
  /** FMV per share AT GRANT — IRC 422(d) measures the $100k limit using the grant-date
   * FMV, not the FMV at whatever later date each tranche becomes exercisable. */
  grantDateFmvPerShare: DecimalValue;
  tranches: IsoTranche[];
}

export interface IsoTrancheClassification {
  grantId: string;
  trancheId: string;
  calendarYear: number;
  quantity: Money;
  /** Portion of this tranche that remains ISO-qualified. May be a fraction of the
   * tranche's shares if the $100k cap was exhausted partway through it — this
   * function reports the precise value-weighted split; rounding whole ISO shares up
   * or down per your plan administrator's own convention is left to the caller, the
   * same way every other engine in this codebase leaves cent-level presentation
   * rounding to `toFixed` at the point of display rather than baking a rounding
   * policy into the calculation itself. */
  isoQuantity: Money;
  /** Portion automatically reclassified to NSO because it exceeded the $100k cap for
   * this calendar year — this is NOT an election; IRC 422(d) makes this determination
   * automatically. */
  nsoQuantity: Money;
  valueAtGrantFmv: Money;
  cumulativeValueForYearThroughThisTranche: Money;
}

export function applyIso100kLimit(grants: IsoGrant[], annualLimit: DecimalValue = 100000): IsoTrancheClassification[] {
  type Flat = { grant: IsoGrant; tranche: IsoTranche; year: number };
  const flat: Flat[] = [];
  for (const grant of grants) {
    for (const tranche of grant.tranches) {
      flat.push({ grant, tranche, year: Number(tranche.firstExercisableDate.slice(0, 4)) });
    }
  }

  // Group by calendar year, and within a year, process strictly in grant-date order
  // (true ties keep their original relative order — Array.prototype.sort is stable).
  const sorted = [...flat].sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    if (a.grant.grantDate !== b.grant.grantDate) return a.grant.grantDate < b.grant.grantDate ? -1 : 1;
    return 0;
  });

  const limit = new Decimal(annualLimit);
  const cumulativeByYear = new Map<number, Decimal>();
  const results: IsoTrancheClassification[] = [];

  for (const { grant, tranche, year } of sorted) {
    const quantity = new Decimal(tranche.quantity);
    const value = quantity.times(grant.grantDateFmvPerShare);
    const priorCumulative = cumulativeByYear.get(year) ?? new Decimal(0);
    const newCumulative = priorCumulative.plus(value);
    cumulativeByYear.set(year, newCumulative);

    let isoValue: Decimal;
    if (newCumulative.lessThanOrEqualTo(limit)) {
      isoValue = value; // the whole tranche fits under the cap
    } else if (priorCumulative.greaterThanOrEqualTo(limit)) {
      isoValue = new Decimal(0); // the cap was already exhausted before this tranche
    } else {
      isoValue = limit.minus(priorCumulative); // this tranche straddles the cap
    }
    const isoQuantity = value.isZero() ? new Decimal(0) : quantity.times(isoValue).div(value);
    const nsoQuantity = quantity.minus(isoQuantity);

    results.push({
      grantId: grant.id,
      trancheId: tranche.id,
      calendarYear: year,
      quantity,
      isoQuantity,
      nsoQuantity,
      valueAtGrantFmv: value,
      cumulativeValueForYearThroughThisTranche: newCumulative,
    });
  }
  return results;
}

// =============================================================================
// 2. AMT PREFERENCE ON ISO EXERCISE — IRC 56(b)(3)
// =============================================================================
/**
 * Exercising an ISO (and holding the shares — see below) creates an AMT adjustment
 * equal to the "bargain element" (FMV at exercise minus the exercise price) even
 * though no income is recognized for REGULAR tax purposes at exercise. The one
 * exception: if the same shares are sold in a disqualifying disposition within the
 * SAME CALENDAR YEAR as the exercise, no AMT adjustment is required — the bargain
 * element is instead picked up as ordinary income for regular tax purposes on the
 * disqualifying disposition, and the AMT preference would otherwise double-count it.
 * A disqualifying disposition in a LATER year does NOT retroactively undo the AMT
 * preference already reported for the exercise year.
 */
export interface IsoExerciseEvent {
  exerciseDate: ISODate;
  quantity: DecimalValue;
  exercisePricePerShare: DecimalValue;
  fmvPerShareAtExercise: DecimalValue;
  disqualifyingDispositionSameCalendarYear?: boolean;
}

export interface IsoExerciseAmtResult {
  exerciseDate: ISODate;
  bargainElement: Money;
  amtPreferenceItem: Money;
  note: string;
}

export function computeIsoExerciseAmtPreference(event: IsoExerciseEvent): IsoExerciseAmtResult {
  const quantity = new Decimal(event.quantity);
  const bargainElement = new Decimal(event.fmvPerShareAtExercise).minus(event.exercisePricePerShare).times(quantity);
  const amtPreferenceItem = event.disqualifyingDispositionSameCalendarYear ? new Decimal(0) : bargainElement;
  return {
    exerciseDate: event.exerciseDate,
    bargainElement,
    amtPreferenceItem,
    note: event.disqualifyingDispositionSameCalendarYear
      ? "No AMT preference: the shares were disposed of in a disqualifying disposition within the same calendar year as exercise (IRC 56(b)(3)) — the bargain element is instead ordinary income for regular tax on that disposition."
      : "Full bargain element is an AMT preference item for the year of exercise under IRC 56(b)(3).",
  };
}

// =============================================================================
// 3. IRC 83(b) ELECTIONS
// =============================================================================
/**
 * An 83(b) election lets the recipient of substantially non-vested property (most
 * commonly early-exercised/restricted stock) elect to recognize ordinary income NOW,
 * on the spread at the transfer date, rather than as the property vests. The upside:
 * the capital-gains holding period starts at transfer instead of at each vesting
 * date, and if FMV rises between transfer and vesting, that appreciation is converted
 * from ordinary income into capital gain. The deadline is absolute: the election MUST
 * be filed within 30 days of the transfer, with no extensions and no exceptions for
 * late filing (courts have consistently enforced this literally) — miss it by even a
 * day and the election has no effect whatsoever; income reverts to the default,
 * vest-by-vest treatment.
 */
export interface Section83bScenario {
  transferDate: ISODate;
  fmvPerShareAtTransfer: DecimalValue;
  purchasePricePerShare: DecimalValue;
  quantity: DecimalValue;
}

export interface Section83bElectionResult {
  deadline: ISODate;
  filedDate: ISODate;
  isTimely: boolean;
  ordinaryIncomeAtTransfer: Money;
  note: string;
}

export function evaluateSection83bElection(scenario: Section83bScenario, filedDate: ISODate): Section83bElectionResult {
  const deadline = addDays(scenario.transferDate, 30);
  const isTimely = filedDate <= deadline;
  const quantity = new Decimal(scenario.quantity);
  const ordinaryIncomeAtTransfer = isTimely
    ? new Decimal(scenario.fmvPerShareAtTransfer).minus(scenario.purchasePricePerShare).times(quantity)
    : new Decimal(0);

  return {
    deadline,
    filedDate,
    isTimely,
    ordinaryIncomeAtTransfer,
    note: isTimely
      ? "Timely IRC 83(b) election: ordinary income recognized now on the spread at transfer; the capital-gains holding period begins at the transfer date."
      : `NOT TIMELY — IRC 83(b) elections must be filed within 30 days of transfer (deadline was ${deadline}), with no extensions or exceptions. This election has no effect; income is instead recognized at each vesting date (see computeOrdinaryIncomeWithoutSection83b).`,
  };
}

export interface RestrictedStockTranche {
  vestDate: ISODate;
  quantity: DecimalValue;
  fmvPerShareAtVest: DecimalValue;
  purchasePricePerShare: DecimalValue;
}

/** The DEFAULT outcome absent a timely 83(b) election: ordinary income is recognized
 * separately at EACH vesting date, using that date's OWN FMV — not the FMV at
 * transfer. Deliberately exposed as its own function, alongside
 * `evaluateSection83bElection`, rather than one function with a flag — running both
 * and comparing the total income and its timing is the actual decision a person needs
 * to make, the same preview-both-paths pattern `correctionService.ts` uses elsewhere
 * in this codebase for a different kind of decision. */
export function computeOrdinaryIncomeWithoutSection83b(
  tranches: RestrictedStockTranche[]
): { vestDate: ISODate; ordinaryIncome: Money }[] {
  return tranches.map((t) => ({
    vestDate: t.vestDate,
    ordinaryIncome: new Decimal(t.fmvPerShareAtVest).minus(t.purchasePricePerShare).times(t.quantity),
  }));
}

// =============================================================================
// 4. QSBS / SECTION 1202 GAIN EXCLUSION
// =============================================================================
/**
 * IRC 1202 lets a noncorporate taxpayer exclude some or all gain on the sale of
 * Qualified Small Business Stock held for the required period. This got a MAJOR
 * overhaul from the One Big Beautiful Bill Act (P.L. 119-21, enacted July 4, 2025),
 * and the two regimes are genuinely different, not a simple rate change:
 *
 *  PRE-OBBBA (stock ACQUIRED on or before 7/4/2025 — fully grandfathered, no partial
 *  blending): a cliff 5-year holding period (anything less = 0% exclusion), with the
 *  exclusion PERCENTAGE set by the ACQUISITION date: 50% if acquired on or before
 *  2/17/2009, 75% if acquired 2/18/2009-9/27/2010, 100% if acquired on or after
 *  9/28/2010. Cap: greater of $10,000,000 or 10x adjusted basis. AMT preference: 7% of
 *  the excluded gain, EXCEPT the 100%-exclusion tier carries NO AMT preference at all.
 *  Gross assets test: issuer's aggregate gross assets couldn't exceed $50,000,000 at
 *  issuance.
 *
 *  POST-OBBBA (stock ACQUIRED after 7/4/2025): a tiered holding period instead of a
 *  cliff — 3 years held = 50% exclusion, 4 years = 75%, 5+ years = 100%. Cap: greater
 *  of $15,000,000 or 10x adjusted basis (indexed for inflation starting 2027). Gross
 *  assets test: raised to $75,000,000, but — and this is a genuinely separate trigger
 *  from the holding-period rules, confirmed across multiple sources — that higher
 *  threshold applies based on when the stock was ISSUED, not when THIS taxpayer
 *  acquired it. A taxpayer who buys already-issued QSBS on the secondary market can
 *  have an acquisition date under the new regime while the issuer is still tested
 *  against the old $50M threshold, if the stock itself was issued before 7/4/2025.
 *  That's why `issuanceDate` and `acquisitionDate` are separate inputs below.
 *
 * CAVEAT WORTH FLAGGING EXPLICITLY: the claim that excluded gain under the NEW
 * (post-OBBBA) tiers remains a 7% AMT preference item — unlike the old law's 100%
 * tier, which was expressly carved out of the AMT preference — comes from a single
 * class of secondary sources (law-firm/accounting-firm alerts) published shortly
 * after enactment, not yet from IRS regulations or case law. This function encodes
 * that reading and flags it in the result; verify against the statute or updated
 * guidance before relying on it for anything filed. Everything else in this section
 * is corroborated across multiple independent sources.
 *
 * OUT OF SCOPE, DELIBERATELY: this function computes the exclusion for a SINGLE
 * disposition. The $10M/$15M cap is actually a per-taxpayer, PER-ISSUER, LIFETIME
 * cap across every disposition of that issuer's stock — tracking cumulative prior
 * exclusions used against the same issuer (so a second sale's cap is reduced by what
 * a first sale already used) needs to be done by the caller across calls to this
 * function, not inside it. This function also does not verify QSBS eligibility
 * itself (original-issuance requirement, C-corp status, active qualified-trade-or-
 * business test) or the gross assets test — those are taken as given booleans, the
 * same separation-of-concerns choice `blackScholes.ts` makes for fair value inputs.
 */
const OBBBA_EFFECTIVE_DATE: ISODate = "2025-07-04";

export interface QsbsHolding {
  /** When the corporation issued the stock — drives the $50M vs. $75M gross-assets
   * threshold, per the issued-vs-acquired distinction explained above. */
  issuanceDate: ISODate;
  /** When THIS taxpayer acquired it, if different from issuance (e.g. a secondary
   * purchase). Defaults to `issuanceDate` for the common case of an original holder. */
  acquisitionDate?: ISODate;
  dispositionDate: ISODate;
  adjustedBasis: DecimalValue;
  amountRealized: DecimalValue;
  /** Whether the issuer met the applicable aggregate gross assets test AT ISSUANCE —
   * a balance-sheet eligibility question this function doesn't verify itself. */
  metGrossAssetsTest: boolean;
  /** Whether this is otherwise Qualified Small Business Stock under IRC 1202(c) —
   * likewise assumed, not verified, here. */
  isQualifiedSmallBusinessStock: boolean;
}

export interface QsbsExclusionResult {
  regime: "pre-OBBBA" | "post-OBBBA";
  eligible: boolean;
  ineligibilityReason?: string;
  gain: Money;
  exclusionPercentage: number;
  exclusionCap: Money;
  excludableGain: Money;
  taxableGain: Money;
  amtPreferenceItem: Money;
  grossAssetsTestThresholdApplicable: string;
  note: string;
}

export function computeQsbsExclusion(holding: QsbsHolding): QsbsExclusionResult {
  const acquisitionDate = holding.acquisitionDate ?? holding.issuanceDate;
  const gain = new Decimal(holding.amountRealized).minus(holding.adjustedBasis);
  const basis = new Decimal(holding.adjustedBasis);
  const postObbba = acquisitionDate > OBBBA_EFFECTIVE_DATE;
  const grossAssetsTestThresholdApplicable =
    holding.issuanceDate > OBBBA_EFFECTIVE_DATE
      ? "$75,000,000 (post-OBBBA — stock issued after 7/4/2025)"
      : "$50,000,000 (pre-OBBBA — stock issued on or before 7/4/2025)";
  const regime: "pre-OBBBA" | "post-OBBBA" = postObbba ? "post-OBBBA" : "pre-OBBBA";

  const ineligible = (reason: string): QsbsExclusionResult => ({
    regime,
    eligible: false,
    ineligibilityReason: reason,
    gain,
    exclusionPercentage: 0,
    exclusionCap: new Decimal(0),
    excludableGain: new Decimal(0),
    taxableGain: gain.greaterThan(0) ? gain : new Decimal(0),
    amtPreferenceItem: new Decimal(0),
    grossAssetsTestThresholdApplicable,
    note: reason,
  });

  if (!holding.isQualifiedSmallBusinessStock) return ineligible("Not qualified small business stock under IRC 1202(c).");
  if (!holding.metGrossAssetsTest) {
    return ineligible(`Issuer did not meet the aggregate gross assets test (${grossAssetsTestThresholdApplicable}) at issuance.`);
  }
  if (!gain.greaterThan(0)) return ineligible("No gain on disposition — the exclusion only applies to gain, and none exists here.");

  let exclusionPercentage: number;
  let cap: Decimal;
  let amtPreferenceItem: Decimal;

  if (postObbba) {
    const threeYearMark = addYears(acquisitionDate, 3);
    const fourYearMark = addYears(acquisitionDate, 4);
    const fiveYearMark = addYears(acquisitionDate, 5);
    if (holding.dispositionDate >= fiveYearMark) exclusionPercentage = 1;
    else if (holding.dispositionDate >= fourYearMark) exclusionPercentage = 0.75;
    else if (holding.dispositionDate >= threeYearMark) exclusionPercentage = 0.5;
    else {
      return ineligible(
        "Does not meet the minimum 3-year holding period required for any exclusion under the post-OBBBA tiered rules (IRC 1202(a), as amended)."
      );
    }
    cap = Decimal.max(new Decimal(15_000_000), basis.times(10));
    const rawExclusion = gain.times(exclusionPercentage);
    const excludableGain = rawExclusion.greaterThan(cap) ? cap : rawExclusion;
    // See the module-level CAVEAT above — this treats ALL post-OBBBA tiers as
    // carrying the 7% AMT preference, per the (not yet regulation-confirmed) reading
    // in the secondary sources reviewed when this was built.
    amtPreferenceItem = excludableGain.times(0.07);
    const taxableGain = gain.minus(excludableGain);
    return {
      regime,
      eligible: true,
      gain,
      exclusionPercentage,
      exclusionCap: cap,
      excludableGain,
      taxableGain,
      amtPreferenceItem,
      grossAssetsTestThresholdApplicable,
      note: "Post-OBBBA tiered exclusion (IRC 1202(a), as amended by P.L. 119-21). See this module's doc comment for the AMT-preference caveat — verify against current guidance before relying on it.",
    };
  }

  // Pre-OBBBA: cliff 5-year holding period, exclusion tier set by ACQUISITION date.
  const fiveYearMark = addYears(acquisitionDate, 5);
  if (holding.dispositionDate <= fiveYearMark) {
    return ineligible("Does not meet the more-than-5-year holding period required under pre-OBBBA IRC 1202(b)(2).");
  }
  if (acquisitionDate <= "2009-02-17") exclusionPercentage = 0.5;
  else if (acquisitionDate <= "2010-09-27") exclusionPercentage = 0.75;
  else exclusionPercentage = 1.0;

  cap = Decimal.max(new Decimal(10_000_000), basis.times(10));
  const rawExclusion = gain.times(exclusionPercentage);
  const excludableGain = rawExclusion.greaterThan(cap) ? cap : rawExclusion;
  // The 100%-exclusion tier (stock acquired after 9/27/2010, under old law) is
  // expressly carved out of the AMT preference entirely — this is well-settled, unlike
  // the post-OBBBA caveat above.
  amtPreferenceItem = exclusionPercentage === 1 ? new Decimal(0) : excludableGain.times(0.07);
  const taxableGain = gain.minus(excludableGain);

  return {
    regime,
    eligible: true,
    gain,
    exclusionPercentage,
    exclusionCap: cap,
    excludableGain,
    taxableGain,
    amtPreferenceItem,
    grossAssetsTestThresholdApplicable,
    note: "Pre-OBBBA exclusion tier and cap (IRC 1202 prior to amendment by P.L. 119-21).",
  };
}

// =============================================================================
// 5. DEBT-SIDE: OID (IRC 1272/1273) AND MARKET DISCOUNT (IRC 1276/1278)
// =============================================================================
/**
 * OID is an ISSUER-side concept fixed at original issuance: the excess of a debt
 * instrument's stated redemption price at maturity over its issue price, required to
 * accrue into income under the constant-yield method (IRC 1272(a)) UNLESS it falls
 * under the de minimis exception (IRC 1273(a)(3)) — OID smaller than 0.25% of the
 * stated redemption price at maturity, multiplied by the number of complete years to
 * maturity, is treated as zero; nobody is required to accrue it.
 *
 * REUSE NOTE: constant-yield OID accrual is the same formula as the GAAP effective-
 * interest method already in `debtAmortization.ts` — this wraps
 * `buildEffectiveInterestSchedule` rather than re-implementing it, and re-tags the
 * result with the IRC citation. The GAAP and tax schedules are computed by the same
 * math here but are kept as separate outputs on purpose: they don't have to stay
 * equal (a fee capitalized for GAAP but not includible in the tax issue price would
 * make them diverge), and this function doesn't attempt to reconcile that.
 */
export interface TaxOidInputs {
  issuePrice: DecimalValue;
  statedRedemptionPriceAtMaturity: DecimalValue;
  /** Annual effective yield — solve it first with `solveEffectiveYield` if you don't
   * already have it, same as `buildEffectiveInterestSchedule` itself. */
  yieldToMaturity: DecimalValue;
  completeYearsToMaturity: number;
  cashFlows: { date: ISODate; amount: DecimalValue }[];
}

export interface TaxOidResult {
  totalOid: Money;
  deMinimisThreshold: Money;
  isDeMinimis: boolean;
  /** Empty if de minimis — nothing required to accrue. */
  schedule: ScheduleRow[];
}

export function computeTaxOid(inputs: TaxOidInputs, periods: Period[]): TaxOidResult {
  const issuePrice = new Decimal(inputs.issuePrice);
  const redemptionPrice = new Decimal(inputs.statedRedemptionPriceAtMaturity);
  const totalOid = redemptionPrice.minus(issuePrice);
  const deMinimisThreshold = redemptionPrice.times(0.0025).times(inputs.completeYearsToMaturity);
  const isDeMinimis = totalOid.lessThan(deMinimisThreshold);

  if (isDeMinimis) {
    return { totalOid, deMinimisThreshold, isDeMinimis, schedule: [] };
  }

  const rawSchedule = buildEffectiveInterestSchedule(
    {
      faceValue: inputs.statedRedemptionPriceAtMaturity,
      netProceeds: inputs.issuePrice,
      effectiveAnnualYield: inputs.yieldToMaturity,
      cashFlows: inputs.cashFlows,
    },
    periods
  );
  const schedule = rawSchedule.map((row) => ({
    ...row,
    meta: { ...row.meta, ascReference: undefined, ircReference: "IRC 1272(a) (constant-yield OID accrual)" },
  }));
  return { totalOid, deMinimisThreshold, isDeMinimis, schedule };
}

/**
 * Market discount is a HOLDER-side concept: it arises when a taxpayer buys an
 * EXISTING debt instrument in the secondary market for less than its revised
 * (adjusted) issue price — not necessarily less than the ORIGINAL issue price. Same
 * de minimis formula as OID (IRC 1278(a)(2)(C)), applied to years remaining from
 * purchase to maturity.
 *
 * DEFAULT vs. ELECTION: absent an election, accrued market discount is NOT included
 * in income as it accrues — it's recognized as ORDINARY income only on disposition or
 * retirement (capped at the accrued market discount; anything beyond that is capital
 * gain), per IRC 1276(a). A taxpayer MAY instead elect under IRC 1278(b) to include
 * market discount CURRENTLY as it accrues, using either the ratable or constant-yield
 * method (the taxpayer's choice, IRC 1276(b)) — once made, that election applies to
 * EVERY market discount bond acquired thereafter, not just this one, which is worth
 * flagging to whoever is deciding since it's a bigger commitment than one bond's
 * numbers alone would suggest. This function computes both methods' schedules so
 * they can be compared side by side before advising on the election — the same
 * preview-both-paths pattern as `evaluateSection83bElection` above.
 */
export interface MarketDiscountInputs {
  purchaseDate: ISODate;
  purchasePrice: DecimalValue;
  /** The bond's adjusted issue price as of the purchase date (original issue price
   * plus any OID accrued to that point) — NOT the original issue price itself. */
  revisedIssuePriceAtPurchase: DecimalValue;
  statedRedemptionPriceAtMaturity: DecimalValue;
  maturityDate: ISODate;
  yieldToMaturity: DecimalValue;
  /** Complete years remaining to maturity, counted from the purchase date. */
  completeYearsToMaturity: number;
  cashFlows: { date: ISODate; amount: DecimalValue }[];
}

export interface MarketDiscountResult {
  totalMarketDiscount: Money;
  deMinimisThreshold: Money;
  isDeMinimis: boolean;
  /** Both empty if there's no market discount at all, or if it's de minimis. */
  ratableSchedule: ScheduleRow[];
  constantYieldSchedule: ScheduleRow[];
}

export function computeMarketDiscount(inputs: MarketDiscountInputs, periods: Period[]): MarketDiscountResult {
  const revisedIssuePrice = new Decimal(inputs.revisedIssuePriceAtPurchase);
  const purchasePrice = new Decimal(inputs.purchasePrice);
  const totalMarketDiscount = Decimal.max(new Decimal(0), revisedIssuePrice.minus(purchasePrice));
  const redemptionPrice = new Decimal(inputs.statedRedemptionPriceAtMaturity);
  const deMinimisThreshold = redemptionPrice.times(0.0025).times(inputs.completeYearsToMaturity);

  if (totalMarketDiscount.isZero()) {
    return { totalMarketDiscount, deMinimisThreshold, isDeMinimis: false, ratableSchedule: [], constantYieldSchedule: [] };
  }
  if (totalMarketDiscount.lessThan(deMinimisThreshold)) {
    return { totalMarketDiscount, deMinimisThreshold, isDeMinimis: true, ratableSchedule: [], constantYieldSchedule: [] };
  }

  const ratableAmounts = allocateStraightLineByElapsedTime(totalMarketDiscount, inputs.purchaseDate, inputs.maturityDate, periods);
  const ratableSchedule: ScheduleRow[] = periods.map((p, i) => ({
    periodStart: p.start,
    periodEnd: p.end,
    label: p.label,
    amount: ratableAmounts[i],
    meta: { ircReference: "IRC 1276(b)(1) (ratable accrual method, if IRC 1278(b) elected)" },
  }));

  const constantYieldRaw = buildEffectiveInterestSchedule(
    {
      faceValue: inputs.statedRedemptionPriceAtMaturity,
      netProceeds: inputs.purchasePrice,
      effectiveAnnualYield: inputs.yieldToMaturity,
      cashFlows: inputs.cashFlows,
    },
    periods
  );
  const constantYieldSchedule = constantYieldRaw.map((row) => ({
    ...row,
    meta: { ...row.meta, ascReference: undefined, ircReference: "IRC 1276(b)(2) (constant-yield accrual method, if IRC 1278(b) elected)" },
  }));

  return { totalMarketDiscount, deMinimisThreshold, isDeMinimis: false, ratableSchedule, constantYieldSchedule };
}
