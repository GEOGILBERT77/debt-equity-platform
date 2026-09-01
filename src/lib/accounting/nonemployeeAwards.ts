import { ISODate, ScheduleRow, JournalEntry, DecimalValue, Decimal } from "./types.js";
import { Period } from "./dateMath.js";
import { Tranche, ServiceConditionGrant, buildServiceConditionSchedule } from "./vesting.js";
import { stockCompExpenseEntry } from "./journalEntries.js";

/**
 * ASC 718-10 nonemployee share-based payment awards — post-ASU 2018-07 ("Improvements
 * to Nonemployee Share-Based Payment Accounting"), which eliminated the old, separate
 * ASC 505-50 model that required continual remeasurement of a nonemployee award's fair
 * value all the way through vesting. Today, an equity-classified nonemployee award is
 * measured ONCE, at grant date, exactly like an employee award — which is why this
 * module reuses `vesting.ts`'s existing service-condition engine rather than building
 * a second valuation/amortization model. What's genuinely different for a nonemployee
 * award, and what this module actually adds, are three narrower things:
 *
 * 1. THE REQUISITE SERVICE PERIOD PRESUMPTION (ASC 718-10-25-2C, added by ASU
 *    2018-07): absent an award condition tied specifically to the nonemployee's
 *    FUTURE performance (beyond simply providing the good or service that gave rise to
 *    the award in the first place), the requisite service period is presumed to be the
 *    vesting period. In the common case where there's no separate vesting condition at
 *    all — a consultant is paid in fully-vested stock for work already performed, for
 *    instance — that presumption collapses to full, immediate recognition on the grant
 *    date, since the good or service has already been delivered and there's nothing
 *    left to spread over time. `determineNonemployeeVestingTranches` encodes exactly
 *    that presumption; the actual expense math is still `buildServiceConditionSchedule`
 *    from `vesting.ts`, fed either the caller's explicit future-performance tranches or
 *    this module's single immediate-vesting tranche.
 *
 * 2. WHICH ACCOUNT THE EXPENSE HITS, WHICH DEPENDS ON WHO THE COUNTERPARTY IS. A
 *    nonemployee award to an ordinary vendor or consultant debits a compensation-style
 *    expense account, same shape as an employee's. But per ASU 2019-08, a
 *    share-based payment made to a CUSTOMER as consideration is measured under ASC 718
 *    (same grant-date fair value mechanics) while its INCOME STATEMENT classification
 *    follows ASC 606's "consideration payable to a customer" guidance
 *    (ASC 606-10-32-25 through 32-27) — it reduces revenue, it is not an expense line
 *    at all. `buildNonemployeeAwardRecognitionEntry` picks the account based on
 *    `counterpartyType`, reusing `journalEntries.ts`'s `stockCompExpenseEntry` (now
 *    parameterized with the account name, see that function's updated doc comment)
 *    rather than duplicating its balance-and-reversal logic in a new function.
 *
 * 3. TIMING FOR THE CUSTOMER CASE. ASC 606-10-32-27 says consideration payable to a
 *    customer reduces revenue no earlier than the LATER of when the entity recognizes
 *    revenue for the related transferred goods or services, or when the entity grants
 *    (pays or promises to pay) the consideration. `laterOfRevenueRecognitionOrGrant`
 *    computes that floor date. This module does NOT run ASC 606 revenue recognition
 *    itself — the date revenue is recognized for the related goods/services is a given
 *    input, exactly the same "flag rather than guess" boundary this codebase draws
 *    everywhere else it touches a different Topic's guidance (e.g. `taxElections.ts`
 *    taking ISO/NSO classification as a given rather than deriving it).
 *
 * DELIBERATELY OUT OF SCOPE, per this module's own reasoning above:
 *  - Liability-classified nonemployee awards (e.g. a cash-settled award to a
 *    consultant) — `stockAppreciationRights.ts`'s cash-settled engine already models
 *    the liability-remeasurement mechanics generically; nothing about being a
 *    nonemployee award changes that model, so this module doesn't duplicate it.
 *  - The ASC 718-10-30-20A practical expedient letting an entity use an award's full
 *    CONTRACTUAL term (rather than deriving a shorter expected term) as the expected
 *    term input to an option-pricing model for nonemployee equity awards. That's a
 *    policy election about which NUMBER to feed into `blackScholesCallValue`'s
 *    existing `expectedTermYears` input, not a separate computation — there's nothing
 *    for a dedicated function to do beyond restating "pass the contractual term
 *    through unchanged," so it's noted here rather than modeled as a no-op function.
 *  - Determining, from scratch, whether a given award recipient IS a nonemployee for
 *    accounting purposes (the common-law employee test in ASC 718's own scope
 *    guidance) — taken as a given classification, the same way this module takes
 *    `counterpartyType` as a given rather than inferring it from a job title or
 *    contract type.
 */

export type NonemployeeCounterpartyType = "VENDOR_OR_CONSULTANT" | "CUSTOMER";

export interface NonemployeeAwardTerms {
  grantDate: ISODate;
  quantity: DecimalValue;
  grantDateFairValuePerUnit: DecimalValue;
  counterpartyType: NonemployeeCounterpartyType;
  /** Explicit conditions on the nonemployee's FUTURE performance/service beyond merely
   * delivering the good or service that gave rise to the award, if any — e.g. a
   * multi-year consulting agreement with time-based tranches. Omit (or pass an empty
   * array) when the award's only condition IS delivering the good or service itself;
   * see `determineNonemployeeVestingTranches`. */
  explicitVestingTranches?: Tranche[];
}

/** ASC 718-10-25-2C's requisite service period presumption — see the module doc
 * comment. Returns the tranches to feed into `vesting.ts`'s
 * `buildServiceConditionSchedule`; this function only decides WHEN and how much,
 * that engine still does the actual straight-line/graded expense math. */
export function determineNonemployeeVestingTranches(terms: NonemployeeAwardTerms): Tranche[] {
  if (terms.explicitVestingTranches && terms.explicitVestingTranches.length > 0) {
    return terms.explicitVestingTranches;
  }
  return [{ id: "immediate", vestDate: terms.grantDate, quantity: terms.quantity }];
}

/** Builds the expense-recognition schedule for a nonemployee award, reusing
 * `vesting.ts`'s existing service-condition engine for any award with a real,
 * multi-day requisite service period — see the module doc comment for why no
 * separate amortization model is needed post-ASU 2018-07.
 *
 * The single-tranche-vesting-on-the-grant-date case (the ASC 718-10-25-2C default
 * presumption whenever there's no explicit future-performance condition — see
 * `determineNonemployeeVestingTranches`) is a ZERO-DAY requisite service period, and
 * is handled directly here rather than passed through to `buildServiceConditionSchedule`:
 * that engine's underlying `allocateStraightLineByElapsedTime` requires the service
 * period to span at least one day (a straight-line allocation over zero days of
 * service is undefined, and rightly throws rather than silently returning zero rows).
 * The correct answer to "spread this over zero days of service" is simply "recognize
 * it all now" — the full grant-date fair value is booked entirely in whichever
 * period contains the grant date. */
export function buildNonemployeeAwardExpenseSchedule(terms: NonemployeeAwardTerms, periods: Period[]): ScheduleRow[] {
  const tranches = determineNonemployeeVestingTranches(terms);

  if (tranches.length === 1 && tranches[0].vestDate === terms.grantDate) {
    const totalValue = Decimal.from(terms.quantity).times(terms.grantDateFairValuePerUnit);
    const containingPeriod = periods.find((p) => p.start <= terms.grantDate && terms.grantDate <= p.end);
    if (!containingPeriod) {
      throw new Error(
        `buildNonemployeeAwardExpenseSchedule: no period in the supplied schedule contains the grant date ${terms.grantDate}.`
      );
    }
    return periods.map((p) => ({
      periodStart: p.start,
      periodEnd: p.end,
      label: p.label,
      amount: p.label === containingPeriod.label ? totalValue : new Decimal(0),
      meta: {
        ascReference:
          "ASC 718-10-25-2C (nonemployee award with no explicit future-performance condition — recognized immediately)",
      },
    }));
  }

  const grant: ServiceConditionGrant = {
    grantDate: terms.grantDate,
    quantity: terms.quantity,
    grantDateFairValuePerUnit: terms.grantDateFairValuePerUnit,
    tranches,
    attributionMethod: "straight-line",
  };
  return buildServiceConditionSchedule(grant, periods);
}

function expenseAccountFor(counterpartyType: NonemployeeCounterpartyType): string {
  return counterpartyType === "CUSTOMER"
    ? "Reduction of Revenue (ASC 606-10-32-25, consideration payable to a customer)"
    : "Nonemployee Compensation Expense";
}

/** Thin wrapper around `journalEntries.ts`'s `stockCompExpenseEntry`, selecting the
 * debit account by counterparty type — see the module doc comment, point 2. Every
 * other mechanic (balancing, the negative-amount reversal flip) is identical to an
 * employee award's entry, so it isn't reimplemented here. */
export function buildNonemployeeAwardRecognitionEntry(row: ScheduleRow, counterpartyType: NonemployeeCounterpartyType): JournalEntry {
  return stockCompExpenseEntry(row, expenseAccountFor(counterpartyType));
}

export interface CustomerConsiderationTimingInput {
  awardGrantDate: ISODate;
  /** The date the entity recognizes revenue for the good or service the consideration
   * relates to — a given input; this module does not run ASC 606 revenue recognition
   * itself. See the module doc comment, point 3. */
  revenueRecognitionDate: ISODate;
}

/** ASC 606-10-32-27: consideration payable to a customer (which, per ASU 2019-08,
 * explicitly includes an equity-classified share-based payment to a customer) reduces
 * revenue no earlier than the LATER of when the entity recognizes revenue for the
 * related transferred goods/services, or when the entity grants the consideration.
 * ISO 8601 date strings ("YYYY-MM-DD") compare correctly with plain string comparison,
 * so no date-parsing library is needed for this. */
export function laterOfRevenueRecognitionOrGrant(input: CustomerConsiderationTimingInput): ISODate {
  return input.awardGrantDate > input.revenueRecognitionDate ? input.awardGrantDate : input.revenueRecognitionDate;
}
