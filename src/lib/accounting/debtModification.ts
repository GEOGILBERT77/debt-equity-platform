import { Money, money, Decimal, DecimalValue, ISODate, CurrencyCode, JournalEntry, JournalLine, assertBalanced } from "./types.js";

/**
 * ASC 470-50 debt modification vs. extinguishment — the "10% cash flow test" — plus
 * the fee/cost accounting that follows from whichever side of the line a change in
 * terms lands on.
 *
 * THE TEST (ASC 470-50-40-10 through 40-13): when a borrower and lender change the
 * terms of an existing debt instrument (a new rate, a new maturity, a principal
 * change, etc.), compare the present value of the cash flows under the NEW terms to
 * the present value of the REMAINING cash flows under the OLD terms — both streams
 * discounted at the ORIGINAL debt's effective interest rate, never the new terms' own
 * rate (40-12). If the two present values differ by 10% or more, the change is
 * accounted for as an EXTINGUISHMENT of the old debt and issuance of new debt (old
 * debt derecognized at a gain/loss, new debt recorded at fair value). Below 10%, it's
 * a MODIFICATION: no gain or loss, the old debt stays on the books, and the change
 * only affects the prospective effective interest rate and how fees are treated (see
 * below).
 *
 * PERIOD-BASED DISCOUNTING, NOT CALENDAR-DATE DISCOUNTING: this engine discounts by
 * integer period count (period 1, 2, 3, ... from the modification date), exactly like
 * `debtAmortization.ts`'s effective-interest engine, rather than by calendar days.
 * `FixedDecimal.pow` deliberately only supports non-negative integer exponents (see
 * decimal.ts) — a real fixed-point decimal library, not floating point, and this
 * codebase's Decimal type is a hand-rolled stand-in for one (no npm registry access in
 * this sandbox). Callers supply `originalEffectiveRatePerPeriod` matching whatever
 * cash-flow frequency they're using (annual cash flows -> annual rate, monthly cash
 * flows -> monthly rate) — same convention every other schedule-based engine here uses.
 *
 * FEES (ASC 470-50-40-17/40-18): fees paid BY THE BORROWER TO THE LENDER as part of a
 * modification or exchange are folded into the 10% test itself (40-12) — included in
 * the NEW cash flows here, not netted out or ignored — and then, once the
 * classification is known, treated one of two ways: as part of the extinguished debt's
 * reacquisition price if the change is an extinguishment (`buildExtinguishmentEntry`),
 * or capitalized as additional debt discount amortized over the remaining term if it's
 * a modification (`buildModificationLenderFeeEntry`). Third-party fees and costs (legal
 * fees, etc., paid to anyone other than the lender) are expensed as incurred either
 * way (`buildThirdPartyCostExpenseEntry`) — they never enter the 10% test and are never
 * capitalized.
 *
 * OUT OF SCOPE, DELIBERATELY:
 *  - Troubled debt restructurings (ASC 470-60) — a substantively different model
 *    (often no gain/loss even on a big change, because the creditor is granting a
 *    concession due to the debtor's financial difficulty, and the modification test
 *    itself compares UNDISCOUNTED cash flows to carrying value rather than this
 *    module's discounted-PV comparison) — now built as its own module,
 *    `troubledDebtRestructuring.ts` (v0.20.0), not a variant of this one.
 *  - Line-by-line testing across a syndicate of multiple lenders on one facility
 *    (470-50-40-10 requires testing creditor-by-creditor when a syndication isn't
 *    treated as a single instrument) — this engine tests one creditor relationship at
 *    a time; a syndicated facility needs one call per lender with each lender's own
 *    share of the cash flows.
 *  - A change so large it's substantially a NEW instrument in substance even before
 *    running the numeric test (e.g., a fundamentally different instrument type) —
 *    judgment calls like that happen before this engine is invoked, not inside it.
 */

export interface ModificationCashFlow {
  /** 1-based period index counted from the modification/testing date — period 1 is the
   * first cash flow after modification, period 2 the second, and so on. See the module
   * doc comment for why this engine discounts by period count rather than calendar
   * date. */
  period: number;
  /** Cash paid by the borrower in this period (principal + interest, and — for the
   * `newCashFlows` stream specifically — any fees paid to the lender in that period;
   * see the module doc comment on fees). */
  amount: Money;
  label?: string;
}

export interface DebtModificationTestInput {
  /** The remaining contractual cash flows under the ORIGINAL terms, from the
   * modification date forward — not the original cash flows from origination. */
  originalCashFlows: ModificationCashFlow[];
  /** Cash flows under the NEW (modified) terms, same period numbering, INCLUDING any
   * fees paid to the lender as part of the modification (ASC 470-50-40-12) — add them
   * into whichever period they're actually paid, do not omit them. */
  newCashFlows: ModificationCashFlow[];
  /** The ORIGINAL debt's effective interest rate, per period (matching the cash-flow
   * frequency above). Both streams are discounted at this SAME rate — never at the new
   * terms' own rate, which is a common real-world mistake this signature is meant to
   * make hard to make by accident. */
  originalEffectiveRatePerPeriod: DecimalValue;
}

export interface DebtModificationTestResult {
  presentValueOriginal: Money;
  presentValueNew: Money;
  /** |PV_new - PV_original| / PV_original, as a decimal fraction (0.15 = 15%). */
  percentDifference: Decimal;
  classification: "EXTINGUISHMENT" | "MODIFICATION";
  /** 0.10 — exposed so a caller/UI reports the actual threshold rather than
   * hardcoding "10%" somewhere else and risking the two drifting apart. */
  threshold: Decimal;
}

/** Present value of a set of period-indexed cash flows at a constant per-period rate.
 * Exposed on its own (not just inlined into the test) because callers reasonably want
 * "what's the PV of the new terms" as a number in its own right, e.g. to also compare
 * against a fair-value estimate for `buildExtinguishmentEntry`'s `newDebtFairValue`. */
export function presentValue(cashFlows: ModificationCashFlow[], ratePerPeriod: DecimalValue): Money {
  const onePlusRate = Decimal.from(ratePerPeriod).plus(1);
  let total = money(0);
  for (const cf of cashFlows) {
    if (!Number.isInteger(cf.period) || cf.period < 1) {
      throw new Error(`Cash flow period must be a positive integer (got ${cf.period}${cf.label ? `, "${cf.label}"` : ""}).`);
    }
    total = total.plus(cf.amount.div(onePlusRate.pow(cf.period)));
  }
  return total;
}

/** Runs the ASC 470-50-40 10% cash flow test. Throws rather than returning a
 * meaningless result if there are no original cash flows at all (nothing to test a
 * change against) or if their present value is exactly zero (the percentage
 * difference — a ratio against that value — is undefined, not "0% different"). */
export function runDebtModificationTest(input: DebtModificationTestInput): DebtModificationTestResult {
  if (input.originalCashFlows.length === 0) {
    throw new Error(
      "originalCashFlows must contain at least one remaining cash flow — there is nothing to test a modification against."
    );
  }

  const presentValueOriginal = presentValue(input.originalCashFlows, input.originalEffectiveRatePerPeriod);
  const presentValueNew = presentValue(input.newCashFlows, input.originalEffectiveRatePerPeriod);

  if (presentValueOriginal.isZero()) {
    throw new Error(
      "Present value of the original remaining cash flows is zero — the 10% test (a ratio against this value) is undefined."
    );
  }

  const percentDifference = presentValueNew.minus(presentValueOriginal).abs().div(presentValueOriginal);
  const threshold = Decimal.from("0.10");
  const classification: DebtModificationTestResult["classification"] = percentDifference.greaterThanOrEqualTo(threshold)
    ? "EXTINGUISHMENT"
    : "MODIFICATION";

  return { presentValueOriginal, presentValueNew, percentDifference, classification, threshold };
}

export interface ExtinguishmentAccountingInput {
  date: ISODate;
  /** Net carrying value of the OLD debt at the extinguishment date — already net of
   * any unamortized discount/premium and issuance costs, matching this codebase's
   * existing convention of presenting those as a single netted contra-liability (see
   * debtAmortization.ts's module doc comment). */
  oldDebtCarryingValue: Money;
  /** Fair value of the NEW debt recorded on extinguishment (ASC 405-20-40-1) — this is
   * an input, not something this engine derives; it typically comes from discounting
   * the new terms' cash flows at a current market rate for similar debt, which may or
   * may not be the same rate used in the 10% test above. */
  newDebtFairValue: Money;
  /** Fees paid to the SAME lender as part of extinguishing the old debt — part of the
   * reacquisition price of the old debt, not a separate capitalized cost (ASC
   * 405-20-40-1 / 470-50-40-2). Omit or pass zero if none. */
  lenderFeesPaid?: Money;
  currency?: CurrencyCode;
}

export interface ExtinguishmentAccountingResult {
  entry: JournalEntry;
  /** Positive = gain, negative = loss, from the borrower's perspective. Gain arises
   * when the old debt's carrying value exceeds what it actually cost (in new debt fair
   * value plus lender fees) to retire it; loss is the reverse. */
  gainOrLoss: Money;
}

/** Derecognizes the old debt, records the new debt at fair value, and plugs the
 * difference (net of any fees paid to the lender to extinguish the old debt, which are
 * part of what was paid to retire it) as a gain or loss on extinguishment. */
export function buildExtinguishmentEntry(input: ExtinguishmentAccountingInput): ExtinguishmentAccountingResult {
  const lenderFees = input.lenderFeesPaid ?? money(0);
  const reacquisitionPrice = input.newDebtFairValue.plus(lenderFees);
  const gainOrLoss = input.oldDebtCarryingValue.minus(reacquisitionPrice);

  const lines: JournalLine[] = [{ account: "Old Debt (carrying value)", debit: input.oldDebtCarryingValue }];
  lines.push({ account: "New Debt (fair value)", credit: input.newDebtFairValue });
  if (lenderFees.greaterThan(0)) {
    lines.push({ account: "Cash (fees paid to lender at extinguishment)", credit: lenderFees });
  }
  if (gainOrLoss.isNegative()) {
    lines.push({ account: "Loss on Extinguishment of Debt", debit: gainOrLoss.abs() });
  } else if (gainOrLoss.greaterThan(0)) {
    lines.push({ account: "Gain on Extinguishment of Debt", credit: gainOrLoss });
  }

  const entry: JournalEntry = {
    date: input.date,
    description: "Debt extinguishment — old debt derecognized, new debt recorded at fair value",
    ascReference: "ASC 470-50-40 / ASC 405-20-40",
    currency: input.currency,
    lines,
  };
  assertBalanced(entry);
  return { entry, gainOrLoss };
}

/** Fees paid to the lender in a MODIFICATION (not an extinguishment) are capitalized
 * as additional debt discount and amortized as a yield adjustment over the remaining
 * term via the effective interest method (ASC 470-50-40-17) — they are never expensed
 * immediately. Uses the same "Discount on Debt (contra-liability)" account
 * `debtAmortization.ts`/`journalEntries.ts` already amortize, so this rolls straight
 * into the existing amortization schedule rather than needing a new account tracked
 * separately. */
export function buildModificationLenderFeeEntry(date: ISODate, lenderFeesPaid: Money, currency?: CurrencyCode): JournalEntry {
  const entry: JournalEntry = {
    date,
    description: "Debt modification — fees paid to lender capitalized as additional discount",
    ascReference: "ASC 470-50-40-17",
    currency,
    lines: [
      { account: "Discount on Debt (contra-liability)", debit: lenderFeesPaid },
      { account: "Cash", credit: lenderFeesPaid },
    ],
  };
  assertBalanced(entry);
  return entry;
}

/** Third-party costs (legal fees, etc. — anyone other than the lender) are expensed as
 * incurred whether the change turns out to be a modification or an extinguishment
 * (ASC 470-50-40-18 / 40-2) — they never enter the 10% test and are never capitalized
 * either way, unlike lender fees, whose treatment depends on the classification. */
export function buildThirdPartyCostExpenseEntry(date: ISODate, amount: Money, currency?: CurrencyCode): JournalEntry {
  const entry: JournalEntry = {
    date,
    description: "Third-party costs on debt modification/extinguishment, expensed as incurred",
    ascReference: "ASC 470-50-40-18",
    currency,
    lines: [
      { account: "Debt Modification/Extinguishment Expense", debit: amount },
      { account: "Cash", credit: amount },
    ],
  };
  assertBalanced(entry);
  return entry;
}
