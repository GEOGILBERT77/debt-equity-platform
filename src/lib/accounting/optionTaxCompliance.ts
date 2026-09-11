import { Decimal, Money, ISODate, DecimalValue } from "./types.js";
import { addYears, addDays } from "./dateMath.js";
import { computeIsoExerciseAmtPreference, applyIso100kLimit, IsoGrant } from "./taxElections.js";

/**
 * v0.33.0 — stock option tax/compliance reporting: turns recorded option exercises
 * and share dispositions into the specific filing OBLIGATIONS a company actually has
 * (Form 3921, W-2 flags, 83(b) deadline tracking), and assembles the data a filled
 * Form 3921 needs. See prisma/schema.prisma's doc comments on OptionExerciseEvent,
 * ShareDispositionEvent, and TaxFilingRecord for the schema this reads from/writes to.
 *
 * SCOPE, DELIBERATELY:
 *  - FEDERAL ONLY. No state-level equivalent filings (several states have their own
 *    ISO/NSO reporting or withholding requirements) are computed here.
 *  - Form 3921 (ISO exercises, IRC 6039) and the two W-2-flagging obligations (NSO
 *    exercise income, ISO disqualifying-disposition ordinary income) and 83(b)
 *    deadline tracking. Form 3922 (ESPP transfers) is NOT covered — this schema has
 *    no ESPP instrument type at all, so there's nothing to report on yet.
 *  - This module computes the ordinary-income AMOUNT an NSO exercise or a
 *    disqualifying disposition creates (so a company knows what belongs on a W-2 and
 *    roughly how large the obligation is), but it does NOT compute actual payroll
 *    withholding tax (federal income tax withholding, FICA/Medicare, state
 *    withholding) — that requires the employee's W-4 elections, YTD wages, and
 *    jurisdiction-specific rates that live in a payroll system, not a cap table
 *    platform. "Flags the obligation and the amount," per the scope George confirmed,
 *    stops at the ordinary-income figure.
 *  - No actual e-file transmission to the IRS's FIRE system or any state portal.
 *    computeForm3921Data assembles the exact data a filled form needs; getting bytes
 *    to the IRS is a separate, later integration.
 *  - The ISO $100,000 annual limitation (IRC 422(d)) is NOT recomputed in this file —
 *    it's already implemented in taxElections.ts's `applyIso100kLimit`, which needs
 *    to see every ISO grant/tranche a stakeholder holds across an entity to run
 *    correctly (a genuinely cross-instrument computation). This file's functions take
 *    the RESULT of that computation (`iso100kQualifiedQuantity` on
 *    ExerciseForCompliance) as an input, computed by whatever report/API-layer code
 *    assembles a stakeholder's full ISO grant history — never re-derived here from a
 *    single exercise in isolation, which would silently ignore the $100k rule's
 *    cross-grant, cross-year aggregation.
 */

// =============================================================================
// Plain string-union mirrors of the Prisma enums — this file has no dependency on
// @prisma/client (same "pure, DB-agnostic engine" convention as every other file in
// this directory: dispatch.ts, exitWaterfall.ts, taxElections.ts). The literal values
// must stay in sync with prisma/schema.prisma's TaxFilingType/TaxFilingStatus enums.
// =============================================================================
export type TaxFilingType =
  | "FORM_3921"
  | "W2_NSO_EXERCISE_INCOME"
  | "W2_ISO_DISQUALIFYING_DISPOSITION"
  | "ELECTION_83B_DEADLINE";

export type TaxFilingStatus = "PENDING" | "FILED" | "NOT_REQUIRED";

// =============================================================================
// 0. ALLOCATING THE $100K RULE ACROSS REAL RECORDED EXERCISES
// =============================================================================
/**
 * `taxElections.ts`'s `applyIso100kLimit` classifies each GRANT TRANCHE (by its vest
 * date — "first becomes exercisable") into an ISO-qualified portion and a
 * recharacterized-NSO portion. That's the textbook-correct unit for the $100k rule
 * itself. But `ComplianceObligation`s are generated per recorded EXERCISE EVENT, and
 * this schema doesn't record which specific tranche(s) a given exercise drew its
 * shares from — an OptionExerciseEvent just has a quantity and a date.
 *
 * This function bridges the two, on the standard (and, absent a plan's own specific-
 * identification election on file, the ONLY reasonable default) assumption that a
 * stakeholder exercises a grant's tranches in VEST-DATE ORDER, first-vested-first-
 * exercised (FIFO) — never a later tranche before an earlier one, and never partial
 * cherry-picking across tranches by ISO/NSO status. Given that assumption, exactly
 * one FIFO consumption sequence exists per grant: walk that grant's tranches in vest
 * order, and walk that grant's exercises in exercise-date order, consuming tranche
 * quantity as exercises consume it. When an exercise straddles a tranche boundary
 * (drawing partly from one tranche, partly from the next), its ISO-qualified quantity
 * is the sum of whatever ISO-qualified share of each tranche it drew from — computed
 * exactly, not by a whole-tranche approximation.
 *
 * Grants are processed INDEPENDENTLY of each other here — each grant's own tranches
 * only ever get consumed by exercises recorded against THAT grant's instrumentId, by
 * construction. This is safe/correct even though the $100k rule aggregates value
 * ACROSS grants in the same calendar year, because that cross-grant aggregation
 * already happened inside `applyIso100kLimit` itself (called once, across every grant
 * passed in) — the ISO/NSO split each tranche below is called with was output by
 * exactly that cross-grant computation, not re-derived independently per grant.
 */
export interface IsoGrantWithTranches {
  instrumentId: string;
  grantDate: ISODate;
  /** ASC 718 grant-date fair value — used here as a stand-in for tax-purposes
   * grant-date FMV. See dispatch.ts's doc comment on
   * StockOptionServiceConditionTerms.isIncentiveStockOption for why these two numbers
   * can genuinely differ and why reconciling them is a real, separately-flagged gap,
   * not something this function silently assumes away. */
  grantDateFmvPerShare: DecimalValue;
  tranches: { id: string; vestDate: ISODate; quantity: DecimalValue }[];
}

export interface ExerciseForIso100kAllocation {
  exerciseEventId: string;
  instrumentId: string;
  exerciseDate: ISODate;
  quantityExercised: DecimalValue;
}

export interface Iso100kAllocationResult {
  exerciseEventId: string;
  /** Feed this straight into ExerciseForCompliance.iso100kQualifiedQuantity. */
  iso100kQualifiedQuantity: Money;
}

export function allocateIso100kAcrossExercises(
  grants: IsoGrantWithTranches[],
  exercises: ExerciseForIso100kAllocation[]
): Iso100kAllocationResult[] {
  const isoGrantInputs: IsoGrant[] = grants.map((g) => ({
    id: g.instrumentId,
    grantDate: g.grantDate,
    grantDateFmvPerShare: g.grantDateFmvPerShare,
    // IsoTranche's field is named `firstExercisableDate` (it's usually the vest date,
    // but a plan CAN restrict exercisability separately from vesting — see that
    // field's own doc comment in taxElections.ts); this platform doesn't model that
    // distinction separately, so the tranche's vest date is used as the best
    // available proxy, same simplification this module already documents elsewhere
    // (grant-date FMV standing in for tax-purposes FMV).
    tranches: g.tranches.map((t) => ({ id: t.id, firstExercisableDate: t.vestDate, quantity: t.quantity })),
  }));
  const classifications = applyIso100kLimit(isoGrantInputs);

  const results: Iso100kAllocationResult[] = [];

  for (const grant of grants) {
    // This grant's tranches, in vest-date order (stable sort — a true vest-date tie
    // keeps the order the caller supplied, same convention applyIso100kLimit itself
    // uses for grant-date ties).
    const tranchesInOrder = grant.tranches
      .slice()
      .sort((a, b) => (a.vestDate < b.vestDate ? -1 : a.vestDate > b.vestDate ? 1 : 0));

    // Remaining (isoQuantity, nsoQuantity) per tranche, keyed by tranche id — starts
    // as the full classified split, consumed down to zero as exercises draw on it.
    const remaining = new Map<string, { iso: Decimal; total: Decimal }>();
    for (const t of tranchesInOrder) {
      const c = classifications.find((cl) => cl.grantId === grant.instrumentId && cl.trancheId === t.id);
      if (!c) continue; // no tranche in this grant is ever unclassified in practice — applyIso100kLimit covers every tranche it's given
      remaining.set(t.id, { iso: c.isoQuantity, total: c.quantity });
    }
    let trancheCursor = 0;

    const grantExercises = exercises
      .filter((e) => e.instrumentId === grant.instrumentId)
      .slice()
      .sort((a, b) => (a.exerciseDate < b.exerciseDate ? -1 : a.exerciseDate > b.exerciseDate ? 1 : 0));

    for (const exercise of grantExercises) {
      let remainingToConsume = new Decimal(exercise.quantityExercised);
      let isoConsumed = new Decimal(0);

      while (remainingToConsume.greaterThan(0) && trancheCursor < tranchesInOrder.length) {
        const currentTranche = tranchesInOrder[trancheCursor];
        const state = remaining.get(currentTranche.id);
        if (!state || state.total.lessThanOrEqualTo(0)) {
          trancheCursor++;
          continue;
        }
        const consumeFromThisTranche = Decimal.min(remainingToConsume, state.total);
        // This exercise's ISO share of what it draws from this tranche is
        // proportional to the tranche's OWN remaining iso/total ratio — exact, not a
        // whole-tranche approximation, so an exercise straddling a tranche boundary
        // still gets the mathematically correct split.
        const isoRatio = state.total.isZero() ? new Decimal(0) : state.iso.div(state.total);
        const isoFromThisTranche = consumeFromThisTranche.times(isoRatio);

        isoConsumed = isoConsumed.plus(isoFromThisTranche);
        state.iso = state.iso.minus(isoFromThisTranche);
        state.total = state.total.minus(consumeFromThisTranche);
        remainingToConsume = remainingToConsume.minus(consumeFromThisTranche);

        if (state.total.lessThanOrEqualTo(0)) trancheCursor++;
      }
      // remainingToConsume > 0 here means the exercise claims more shares than this
      // grant's recorded tranches ever vested — over-exercise, a data-entry problem
      // this function doesn't try to paper over; whatever couldn't be matched to a
      // real tranche is simply not counted as ISO-qualified (the conservative
      // direction: understating ISO-qualified quantity flags MORE as NSO, never less).

      results.push({ exerciseEventId: exercise.exerciseEventId, iso100kQualifiedQuantity: isoConsumed });
    }
  }

  return results;
}

// =============================================================================
// 1. DISQUALIFYING-DISPOSITION CLASSIFICATION — IRC 422(a)(1)
// =============================================================================
/**
 * An ISO disposition is QUALIFYING only if it happens MORE THAN 2 years after the
 * option was GRANTED and MORE THAN 1 year after the shares were EXERCISED — both
 * conditions, not either. "More than" is strict: disposing of the shares exactly on
 * an anniversary date does not qualify (same strict-inequality convention
 * taxElections.ts's QSBS holding-period test uses for the same reason: courts and the
 * IRS read "more than N years" literally). Any earlier disposition is disqualifying,
 * which converts the lesser of (a) the gain on sale or (b) the bargain element at
 * exercise into ordinary income (see `computeDisqualifyingDispositionOrdinaryIncome`
 * below) — everything beyond that is capital gain/loss, which this platform does not
 * compute (it has no cost-basis-of-sale-proceeds tracking beyond what's passed in
 * here for this one purpose).
 */
export interface DispositionClassificationInput {
  grantDate: ISODate;
  exerciseDate: ISODate;
  dispositionDate: ISODate;
}

export interface DispositionClassificationResult {
  qualifying: boolean;
  twoYearFromGrantMark: ISODate;
  oneYearFromExerciseMark: ISODate;
  note: string;
}

export function classifyDisposition(input: DispositionClassificationInput): DispositionClassificationResult {
  const twoYearFromGrantMark = addYears(input.grantDate, 2);
  const oneYearFromExerciseMark = addYears(input.exerciseDate, 1);
  const pastGrantMark = input.dispositionDate > twoYearFromGrantMark;
  const pastExerciseMark = input.dispositionDate > oneYearFromExerciseMark;
  const qualifying = pastGrantMark && pastExerciseMark;
  return {
    qualifying,
    twoYearFromGrantMark,
    oneYearFromExerciseMark,
    note: qualifying
      ? "Qualifying disposition (IRC 422(a)(1)): more than 2 years after grant and more than 1 year after exercise. No compensation income from this disposition — any gain is capital gain."
      : `Disqualifying disposition: ${
          !pastGrantMark ? `on or before the 2-year-from-grant mark (${twoYearFromGrantMark})` : ""
        }${!pastGrantMark && !pastExerciseMark ? " and " : ""}${
          !pastExerciseMark ? `on or before the 1-year-from-exercise mark (${oneYearFromExerciseMark})` : ""
        }. Some or all of the gain is ordinary income (IRC 421(b)) — see computeDisqualifyingDispositionOrdinaryIncome.`,
  };
}

/**
 * The ordinary-income portion of a disqualifying disposition is the LESSER of:
 *  (a) the bargain element at exercise (FMV at exercise minus exercise price), or
 *  (b) the actual gain realized on sale (sale price minus exercise price) — if the
 *      stock has DROPPED in value since exercise, the ordinary income is capped at
 *      the real economic gain, per IRC 421(b) and Treas. Reg. 1.421-2(b). Anything
 *      realized beyond (a) is capital gain, not computed here.
 * A sale at or below the exercise price produces ZERO ordinary income (and a capital
 * loss, likewise not computed here) — ordinary income from a disqualifying
 * disposition can never be negative.
 */
export interface DisqualifyingDispositionIncomeInputs {
  exercisePricePerShare: DecimalValue;
  fairMarketValuePerShareAtExercise: DecimalValue;
  salePricePerShare: DecimalValue;
  quantitySold: DecimalValue;
}

export interface DisqualifyingDispositionIncomeResult {
  bargainElementPerShare: Money;
  actualGainPerShare: Money;
  ordinaryIncomePerShare: Money;
  totalOrdinaryIncome: Money;
  note: string;
}

export function computeDisqualifyingDispositionOrdinaryIncome(
  inputs: DisqualifyingDispositionIncomeInputs
): DisqualifyingDispositionIncomeResult {
  const exercisePrice = new Decimal(inputs.exercisePricePerShare);
  const fmvAtExercise = new Decimal(inputs.fairMarketValuePerShareAtExercise);
  const salePrice = new Decimal(inputs.salePricePerShare);
  const quantity = new Decimal(inputs.quantitySold);

  const bargainElementPerShare = fmvAtExercise.minus(exercisePrice);
  const actualGainPerShare = salePrice.minus(exercisePrice);
  const lesserPerShare = Decimal.min(bargainElementPerShare, actualGainPerShare);
  const ordinaryIncomePerShare = Decimal.max(new Decimal(0), lesserPerShare);
  const totalOrdinaryIncome = ordinaryIncomePerShare.times(quantity);

  return {
    bargainElementPerShare,
    actualGainPerShare,
    ordinaryIncomePerShare,
    totalOrdinaryIncome,
    note:
      ordinaryIncomePerShare.isZero() && !bargainElementPerShare.isZero()
        ? "Sale price at or below the exercise price: ordinary income from this disqualifying disposition is zero (IRC 421(b) caps it at the actual gain, which is not positive here); any loss is a separate capital-loss matter this platform does not compute."
        : "Ordinary income = the lesser of the bargain element at exercise and the actual gain on sale (IRC 421(b)); any excess gain is capital gain, not computed here.",
  };
}

// =============================================================================
// 2. NSO EXERCISE ORDINARY INCOME — flag only, no withholding computation
// =============================================================================
/**
 * Exercising an NSO is ordinary compensation income equal to the bargain element at
 * exercise (FMV at exercise minus exercise price), recognized immediately — no
 * holding-period test, unlike an ISO. This is a real payroll-withholding trigger
 * (federal income tax, FICA/Medicare, and often state withholding), but see this
 * module's doc comment: this function computes and flags the INCOME AMOUNT only, not
 * the withholding tax itself.
 */
export interface NsoExerciseIncomeInputs {
  exercisePricePerShare: DecimalValue;
  fairMarketValuePerShareAtExercise: DecimalValue;
  quantityExercised: DecimalValue;
}

export interface NsoExerciseIncomeResult {
  bargainElementPerShare: Money;
  totalOrdinaryIncome: Money;
}

export function computeNsoExerciseOrdinaryIncome(inputs: NsoExerciseIncomeInputs): NsoExerciseIncomeResult {
  const bargainElementPerShare = new Decimal(inputs.fairMarketValuePerShareAtExercise).minus(inputs.exercisePricePerShare);
  const totalOrdinaryIncome = Decimal.max(new Decimal(0), bargainElementPerShare).times(inputs.quantityExercised);
  return { bargainElementPerShare, totalOrdinaryIncome };
}

// =============================================================================
// 3. FORM 3921 DATA ASSEMBLY — IRC 6039
// =============================================================================
/**
 * Field layout confirmed directly against the IRS's own Form 3921 (Rev. April 2025,
 * irs.gov/pub/irs-pdf/f3921.pdf) and its instructions (irs.gov/pub/irs-pdf/i3921.pdf):
 * TRANSFEROR'S name/address/TIN, EMPLOYEE'S (recipient's) name/address/TIN, then
 * boxes 1-6. Box 6 ("If other than TRANSFEROR, name/address/TIN of corporation whose
 * stock is being transferred") is for the case where a PARENT corporation's stock is
 * being transferred under a SUBSIDIARY's plan — this platform has no parent/
 * subsidiary entity relationship modeled, so box 6 is always left blank/undefined
 * here; a multi-entity corporate-family structure is out of scope.
 *
 * DEADLINES (confirmed via IRS-adjacent secondary sources, since the instructions PDF
 * itself defers to the general "Instructions for Certain Information Returns" for the
 * exact dates): furnish Copy B to the employee by January 31 of the year following
 * the exercise; file with the IRS by February 28 (paper) or March 31 (electronic) of
 * that same following year. If any of these falls on a weekend/federal holiday, the
 * real deadline moves to the next business day — NOT adjusted for here (this function
 * returns the calendar-date rule; a caller presenting these to a user should note the
 * business-day rounding separately rather than have this pure date-math function
 * depend on a holiday calendar).
 */
export interface Form3921TransferorInfo {
  name: string;
  address: string;
  employerIdentificationNumber: string;
}

export interface Form3921RecipientInfo {
  name: string;
  address: string;
  taxIdNumber: string;
}

export interface Form3921Data {
  transferor: Form3921TransferorInfo;
  recipient: Form3921RecipientInfo;
  /** Box 1. */
  dateOptionGranted: ISODate;
  /** Box 2. */
  dateOptionExercised: ISODate;
  /** Box 3. */
  exercisePricePerShare: Money;
  /** Box 4. */
  fairMarketValuePerShareOnExerciseDate: Money;
  /** Box 5. Note this is the ISO-QUALIFIED share count, not necessarily the whole
   * exercise — see this module's doc comment on the $100k rule: a caller that ran
   * `applyIso100kLimit` and found some of the exercised shares were recharacterized
   * to NSO must pass only the ISO-qualified portion here, since those recharacterized
   * shares were never really an ISO exercise for Form 3921 purposes. */
  sharesTransferred: Money;
  taxYear: number;
  furnishToEmployeeDeadline: ISODate;
  irsPaperFilingDeadline: ISODate;
  irsElectronicFilingDeadline: ISODate;
}

export interface ComputeForm3921DataParams {
  entity: { name: string; address: string | null; employerIdentificationNumber: string | null };
  stakeholder: { name: string; address: string | null; taxIdNumber: string | null };
  grantDate: ISODate;
  exerciseDate: ISODate;
  exercisePricePerShare: DecimalValue;
  fairMarketValuePerShareAtExercise: DecimalValue;
  /** ISO-qualified share count for THIS exercise — see Form3921Data.sharesTransferred. */
  isoQualifiedSharesTransferred: DecimalValue;
}

export type ComputeForm3921DataResult =
  | { ok: true; data: Form3921Data }
  /** Refuses to assemble a Form 3921 with a silently-blank EIN/TIN/address on a real
   * tax document — see Entity.employerIdentificationNumber's schema doc comment.
   * Lists every missing field so a UI can show one actionable message, not a vague
   * failure the user has to guess at. */
  | { ok: false; missingFields: string[] };

export function computeForm3921Data(params: ComputeForm3921DataParams): ComputeForm3921DataResult {
  const missingFields: string[] = [];
  if (!params.entity.employerIdentificationNumber) missingFields.push("Entity.employerIdentificationNumber (transferor EIN)");
  if (!params.entity.address) missingFields.push("Entity.address (transferor address)");
  if (!params.stakeholder.taxIdNumber) missingFields.push("Stakeholder.taxIdNumber (recipient TIN)");
  if (!params.stakeholder.address) missingFields.push("Stakeholder.address (recipient address)");
  if (missingFields.length > 0) return { ok: false, missingFields };

  const exerciseYear = Number(params.exerciseDate.slice(0, 4));
  const followingYear = exerciseYear + 1;
  const pad2 = (n: number) => String(n).padStart(2, "0");

  const data: Form3921Data = {
    transferor: {
      name: params.entity.name,
      address: params.entity.address as string,
      employerIdentificationNumber: params.entity.employerIdentificationNumber as string,
    },
    recipient: {
      name: params.stakeholder.name,
      address: params.stakeholder.address as string,
      taxIdNumber: params.stakeholder.taxIdNumber as string,
    },
    dateOptionGranted: params.grantDate,
    dateOptionExercised: params.exerciseDate,
    exercisePricePerShare: new Decimal(params.exercisePricePerShare),
    fairMarketValuePerShareOnExerciseDate: new Decimal(params.fairMarketValuePerShareAtExercise),
    sharesTransferred: new Decimal(params.isoQualifiedSharesTransferred),
    taxYear: exerciseYear,
    furnishToEmployeeDeadline: `${followingYear}-01-31`,
    irsPaperFilingDeadline: `${followingYear}-02-28`,
    irsElectronicFilingDeadline: `${followingYear}-03-31`,
  };
  return { ok: true, data };
}

// =============================================================================
// 4. 83(b) ELECTION DEADLINE OBLIGATION — wraps taxElections.ts's
//    evaluateSection83bElection into the same ComplianceObligation shape as the
//    other three filing types, so buildMonthlyComplianceReport can treat all four
//    uniformly.
// =============================================================================
export interface Restricted83bTransfer {
  instrumentId: string;
  stakeholderId: string;
  transferDate: ISODate;
}

// =============================================================================
// 5. COMPLIANCE OBLIGATIONS + THE MONTHLY REPORT
// =============================================================================
/**
 * One filing OBLIGATION this platform has detected, independent of whether a
 * TaxFilingRecord row exists for it yet — buildMonthlyComplianceReport reconciles a
 * freshly-computed list of these against persisted TaxFilingRecord rows (see that
 * function's own doc comment).
 */
export interface ComplianceObligation {
  filingType: TaxFilingType;
  taxYear: number;
  /** Set for FORM_3921 / W2_NSO_EXERCISE_INCOME / W2_ISO_DISQUALIFYING_DISPOSITION;
   * undefined for ELECTION_83B_DEADLINE (see instrumentId instead). */
  exerciseEventId?: string;
  /** Set for ELECTION_83B_DEADLINE; also carried (redundantly, for convenience) on
   * every other obligation type since every exercise traces to exactly one
   * instrument. */
  instrumentId: string;
  stakeholderId: string;
  description: string;
  amount?: Money;
  deadline?: ISODate;
}

/** One real exercise, with everything buildMonthlyComplianceReport needs to evaluate
 * every obligation it can create — assembled by the caller (a report/API route) from
 * OptionExerciseEvent + its parent Instrument's terms + any ShareDispositionEvent rows
 * against it. See this module's doc comment for why `iso100kQualifiedQuantity` is
 * computed by the caller, not here. */
export interface ExerciseForCompliance {
  exerciseEventId: string;
  instrumentId: string;
  stakeholderId: string;
  isIncentiveStockOption: boolean;
  grantDate: ISODate;
  exerciseDate: ISODate;
  quantityExercised: DecimalValue;
  exercisePricePerShare: DecimalValue;
  fairMarketValuePerShareAtExercise: DecimalValue;
  /** Portion of quantityExercised still ISO-qualified after the $100k rule
   * (taxElections.ts's applyIso100kLimit) has been applied across every ISO grant
   * this stakeholder holds. Defaults to the full quantityExercised when omitted —
   * i.e. "assume the $100k rule is not implicated" — callers that HAVE done the
   * cross-grant computation should always pass this explicitly rather than rely on
   * that default. Ignored when isIncentiveStockOption is false (the whole exercise is
   * NSO in that case, by construction). */
  iso100kQualifiedQuantity?: DecimalValue;
  dispositions: { dispositionDate: ISODate; quantitySold: DecimalValue; salePricePerShare: DecimalValue }[];
}

/**
 * Evaluates every obligation a single recorded exercise (plus whatever dispositions
 * are recorded against it) creates. Pure function — no persistence, no reconciliation
 * against existing TaxFilingRecord rows (that's buildMonthlyComplianceReport, below).
 */
export function classifyExerciseForFiling(exercise: ExerciseForCompliance): ComplianceObligation[] {
  const obligations: ComplianceObligation[] = [];
  const quantityExercised = new Decimal(exercise.quantityExercised);
  const exerciseYear = Number(exercise.exerciseDate.slice(0, 4));

  const isoQuantity = exercise.isIncentiveStockOption
    ? new Decimal(exercise.iso100kQualifiedQuantity ?? exercise.quantityExercised)
    : new Decimal(0);
  const nsoQuantity = quantityExercised.minus(isoQuantity);

  if (isoQuantity.greaterThan(0)) {
    // Same-calendar-year disqualifying disposition exempts the bargain element from
    // the AMT preference (IRC 56(b)(3)) — see taxElections.ts's
    // computeIsoExerciseAmtPreference doc comment. Reused here, not re-derived, per
    // this module's doc comment on why the $100k rule itself is likewise reused
    // rather than recomputed.
    const disqualifyingSameYear = exercise.dispositions.some((d) => {
      if (Number(d.dispositionDate.slice(0, 4)) !== exerciseYear) return false;
      return !classifyDisposition({
        grantDate: exercise.grantDate,
        exerciseDate: exercise.exerciseDate,
        dispositionDate: d.dispositionDate,
      }).qualifying;
    });
    const amt = computeIsoExerciseAmtPreference({
      exerciseDate: exercise.exerciseDate,
      quantity: isoQuantity,
      exercisePricePerShare: exercise.exercisePricePerShare,
      fmvPerShareAtExercise: exercise.fairMarketValuePerShareAtExercise,
      disqualifyingDispositionSameCalendarYear: disqualifyingSameYear,
    });
    obligations.push({
      filingType: "FORM_3921",
      taxYear: exerciseYear,
      exerciseEventId: exercise.exerciseEventId,
      instrumentId: exercise.instrumentId,
      stakeholderId: exercise.stakeholderId,
      description: `Form 3921 for the exercise of ${isoQuantity.toString()} ISO share(s) on ${exercise.exerciseDate} (IRC 6039). ${amt.note}`,
      amount: amt.amtPreferenceItem,
      deadline: `${exerciseYear + 1}-01-31`,
    });
  }

  if (nsoQuantity.greaterThan(0)) {
    const nsoIncome = computeNsoExerciseOrdinaryIncome({
      exercisePricePerShare: exercise.exercisePricePerShare,
      fairMarketValuePerShareAtExercise: exercise.fairMarketValuePerShareAtExercise,
      quantityExercised: nsoQuantity,
    });
    obligations.push({
      filingType: "W2_NSO_EXERCISE_INCOME",
      taxYear: exerciseYear,
      exerciseEventId: exercise.exerciseEventId,
      instrumentId: exercise.instrumentId,
      stakeholderId: exercise.stakeholderId,
      description: exercise.isIncentiveStockOption
        ? `NSO exercise income on ${nsoQuantity.toString()} share(s) recharacterized from ISO under the $100k rule (exercised ${exercise.exerciseDate}) — ordinary income requiring W-2 reporting and withholding.`
        : `NSO exercise income on ${nsoQuantity.toString()} share(s) exercised ${exercise.exerciseDate} — ordinary income requiring W-2 reporting and withholding.`,
      amount: nsoIncome.totalOrdinaryIncome,
    });
  }

  // Disqualifying dispositions only apply to the ISO-qualified portion of this
  // exercise — an already-NSO share has no qualifying/disqualifying distinction.
  if (isoQuantity.greaterThan(0)) {
    for (const disposition of exercise.dispositions) {
      const classification = classifyDisposition({
        grantDate: exercise.grantDate,
        exerciseDate: exercise.exerciseDate,
        dispositionDate: disposition.dispositionDate,
      });
      if (classification.qualifying) continue;

      // A disposition can only be disqualifying with respect to shares that were
      // actually ISO shares — cap the quantity considered at the ISO-qualified count,
      // in case more shares from this exercise were sold than remained ISO-qualified
      // (the excess is simply an NSO-share sale, already fully taxed at exercise).
      const quantityConsidered = Decimal.min(new Decimal(disposition.quantitySold), isoQuantity);
      if (quantityConsidered.lessThanOrEqualTo(0)) continue;

      const income = computeDisqualifyingDispositionOrdinaryIncome({
        exercisePricePerShare: exercise.exercisePricePerShare,
        fairMarketValuePerShareAtExercise: exercise.fairMarketValuePerShareAtExercise,
        salePricePerShare: disposition.salePricePerShare,
        quantitySold: quantityConsidered,
      });
      const dispositionYear = Number(disposition.dispositionDate.slice(0, 4));
      obligations.push({
        filingType: "W2_ISO_DISQUALIFYING_DISPOSITION",
        taxYear: dispositionYear,
        exerciseEventId: exercise.exerciseEventId,
        instrumentId: exercise.instrumentId,
        stakeholderId: exercise.stakeholderId,
        description: `Disqualifying disposition of ${quantityConsidered.toString()} ISO share(s) on ${disposition.dispositionDate} (granted ${exercise.grantDate}, exercised ${exercise.exerciseDate}) — ${classification.note}`,
        amount: income.totalOrdinaryIncome,
      });
    }
  }

  return obligations;
}

/** Evaluates the 83(b) deadline obligation for one restricted-stock/early-exercise
 * transfer. Always produces exactly one ELECTION_83B_DEADLINE obligation per
 * transfer — whether or not the election was actually filed is state a human
 * supplies via the persisted TaxFilingRecord's status, not something this function
 * can know. */
export function classifyRestrictedTransferForFiling(transfer: Restricted83bTransfer): ComplianceObligation {
  const deadline = addDays(transfer.transferDate, 30);
  const taxYear = Number(transfer.transferDate.slice(0, 4));
  return {
    filingType: "ELECTION_83B_DEADLINE",
    taxYear,
    instrumentId: transfer.instrumentId,
    stakeholderId: transfer.stakeholderId,
    description: `IRC 83(b) election deadline for the restricted stock/early-exercise transfer on ${transfer.transferDate} — must be filed by the employee (not this company) by ${deadline}, with no extensions.`,
    deadline,
  };
}

/** A previously-persisted TaxFilingRecord row, as much of it as the reconciliation
 * logic needs — deliberately NOT the full Prisma row shape, to keep this file free of
 * any @prisma/client dependency. */
export interface PersistedTaxFilingRecord {
  id: string;
  filingType: TaxFilingType;
  taxYear: number;
  exerciseEventId: string | null;
  instrumentId: string | null;
  status: TaxFilingStatus;
}

/** One row of the monthly compliance report: a freshly-computed obligation,
 * reconciled against whatever TaxFilingRecord already exists for it. */
export interface MonthlyComplianceReportRow {
  obligation: ComplianceObligation;
  /** The matching persisted row, if one already exists (matched on filingType +
   * taxYear + exerciseEventId + instrumentId — the same dedupe key the two partial
   * unique indexes in db/schema.sql enforce). undefined means this obligation has
   * never been seen before and needs a new PENDING TaxFilingRecord created for it. */
  existingRecord?: PersistedTaxFilingRecord;
  /** True when this obligation's deadline (or, for FORM_3921, its earliest deadline)
   * falls within the report's target month — the actual answer to "what do I need to
   * file this month," as opposed to every obligation on file regardless of when it's
   * due. */
  dueThisMonth: boolean;
  overdue: boolean;
}

export interface MonthlyComplianceReport {
  targetMonth: string; // "YYYY-MM"
  rows: MonthlyComplianceReportRow[];
  /** Rows whose deadline falls within targetMonth and whose existingRecord is
   * missing or still PENDING — the actionable "what do I need to file this month" list. */
  actionableThisMonth: MonthlyComplianceReportRow[];
}

function matchRecord(
  obligation: ComplianceObligation,
  records: PersistedTaxFilingRecord[]
): PersistedTaxFilingRecord | undefined {
  return records.find((r) => {
    if (r.filingType !== obligation.filingType || r.taxYear !== obligation.taxYear) return false;
    if (obligation.exerciseEventId !== undefined) return r.exerciseEventId === obligation.exerciseEventId;
    return r.instrumentId === obligation.instrumentId;
  });
}

/**
 * Reconciles every obligation computed from an entity's exercises/dispositions/
 * restricted transfers against its already-persisted TaxFilingRecord rows, and
 * reports which ones are due (or overdue) in `targetMonth`. Deliberately does NOT
 * create or update any TaxFilingRecord rows itself — this is a pure function; the
 * API route layer is responsible for persisting a new PENDING row for every
 * obligation this function reports with no `existingRecord`, exactly the pattern
 * every other report in this codebase already follows (compute in a pure lib
 * function, persist/mutate in the route).
 */
export function buildMonthlyComplianceReport(
  targetMonth: string,
  exercises: ExerciseForCompliance[],
  restrictedTransfers: Restricted83bTransfer[],
  existingRecords: PersistedTaxFilingRecord[]
): MonthlyComplianceReport {
  const obligations: ComplianceObligation[] = [
    ...exercises.flatMap(classifyExerciseForFiling),
    ...restrictedTransfers.map(classifyRestrictedTransferForFiling),
  ];

  const monthStart = `${targetMonth}-01`;
  // First day of the FOLLOWING month, via simple string month arithmetic — safe here
  // since we only need a half-open [monthStart, nextMonthStart) comparison, not a
  // real calendar date to return.
  const [y, m] = targetMonth.split("-").map(Number);
  const nextMonthStart = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const today = new Date().toISOString().slice(0, 10);

  const rows: MonthlyComplianceReportRow[] = obligations.map((obligation) => {
    const existingRecord = matchRecord(obligation, existingRecords);
    const deadline = obligation.deadline;
    const dueThisMonth = deadline !== undefined && deadline >= monthStart && deadline < nextMonthStart;
    const overdue = deadline !== undefined && deadline < today && (!existingRecord || existingRecord.status === "PENDING");
    return { obligation, existingRecord, dueThisMonth, overdue };
  });

  const actionableThisMonth = rows.filter(
    (row) => (row.dueThisMonth || row.overdue) && (!row.existingRecord || row.existingRecord.status === "PENDING")
  );

  return { targetMonth, rows, actionableThisMonth };
}
