import { ISODate, Decimal, DecimalValue, JournalEntry, assertBalanced } from "./types.js";

/**
 * ASC 718 stock option EXERCISE and RSU SETTLEMENT accounting — the event that happens
 * AFTER vesting, which this codebase did not model at all before this module existed.
 *
 * `vesting.ts` (and `restrictedStock.ts`, `stockAppreciationRights.ts`) only ever build
 * the grant-to-vest compensation EXPENSE schedule: the periodic entries that recognize
 * grant-date fair value into Additional Paid-In Capital as service is rendered. None of
 * those engines model what happens the moment an option is actually EXERCISED or an RSU
 * actually SETTLES — shares issued, cash received (or not), and, for a net/cashless
 * settlement, shares withheld to cover the exercise price and/or the employee's tax
 * withholding obligation. That is a distinct accounting event with its own journal
 * entries, and this module is where it lives.
 *
 * TWO SETTLEMENT PATHS, deliberately kept as separate functions (same reasoning as
 * vesting.ts's three condition types being three functions rather than one with a
 * flag — the math and the accounts hit are different enough that folding them into one
 * function with a mode switch would hide more than it would save):
 *
 * 1. CASH EXERCISE (`buildCashExerciseEntry`) — the option holder pays the full exercise
 *    price in cash. Total consideration for the shares issued is the cash paid PLUS the
 *    grant-date fair value already recognized as compensation cost (sitting in
 *    Additional Paid-In Capital from vesting.ts's entries) — both flow into Common
 *    Stock. Nothing is withheld; no tax-withholding entry is needed here (the employee
 *    settles their own tax liability outside this transaction in a cash exercise).
 *
 * 2. NET SHARE SETTLEMENT (`buildNetShareSettlementEntry`) — no cash changes hands from
 *    the holder. Shares are withheld to cover (a) the exercise price, for options only
 *    (an RSU has no exercise price, so this component is always zero for RSUs — see
 *    `NetShareSettlementInput.exercisePricePerUnit`), and (b) the employee's tax
 *    withholding obligation, which the company must remit in actual cash to the taxing
 *    authority even though it "collected" that value in shares, not cash. One function
 *    covers both stock options and RSUs because an RSU net settlement is exactly the
 *    option case with `exercisePricePerUnit = 0` — see the function's own doc comment.
 *
 * VALUATION BASIS, FLAGGED SIMPLIFICATION: both functions value every component of a
 * given transaction (shares issued, shares withheld, cash paid or remitted) at a SINGLE
 * per-unit price for that transaction — the exercise price for the cash-exercise
 * function, and the fair market value at settlement for the net-share-settlement
 * function. Real-world sub-ledgers sometimes track the exercise-date "excess of fair
 * value over grant-date-recognized value" as its own APIC line (a true-up between what
 * was expensed at grant and what the award was actually worth at exercise); this module
 * nets that into a single Additional Paid-In Capital relief/credit line instead, the
 * same style of simplification as `preferredStockAccretionEntry`'s single-step
 * (not two-step APIC-then-Retained-Earnings) accretion policy in journalEntries.ts.
 * Every entry still balances exactly (see the tests) — what's simplified is which
 * account absorbs the plug, not whether the books tie out.
 *
 * TAX WITHHOLDING AS A LIABILITY, NOT AN IMMEDIATE CASH LINE: `buildNetShareSettlementEntry`
 * books the value of shares withheld for taxes to "Payroll Tax Withholding Payable," not
 * directly to Cash — actual remittance to the taxing authority routinely happens on a
 * later payroll-tax deposit schedule, not the instant shares are withheld.
 * `buildTaxWithholdingRemittanceEntry` is the second, separate entry that clears that
 * liability when the cash is actually sent. This mirrors `restrictedStockEntry`'s
 * pattern of keeping a real timing difference in its own account rather than collapsing
 * it into one entry.
 *
 * DELIBERATELY NOT MODELED HERE (flagged, not silently skipped):
 *  - ISO vs. NSO tax treatment. Ordinary income, AMT preference, and withholding-rate
 *    mechanics differ by classification; `taxElections.ts` already computes the ISO
 *    $100k and AMT-preference amounts, but no terms schema stores an ISO/NSO flag yet
 *    (see INTEGRATIONS.md gap #5), so this module takes `taxWithholdingAmount` as a
 *    given dollar input rather than deriving it from grant terms.
 *  - Net settlement that would exceed the maximum individual statutory tax rate. Per
 *    ASU 2016-09, withholding above that threshold can jeopardize equity classification
 *    for the WHOLE award, not just the excess — a real, consequential edge case this
 *    module does not detect or warn about. Treat `taxWithholdingAmount` as the caller's
 *    responsibility to keep compliant.
 *  - Cash-settled SARs at their own settlement date — `stockAppreciationRights.ts`
 *    already carries a cash-settled SAR as a remeasured liability every period through
 *    to settlement; the cash payment that clears that liability at settlement is a
 *    simple one-line "Dr SAR Liability / Cr Cash" entry, not built as a named function
 *    here since it needs no new accounting logic beyond what that liability balance
 *    already is.
 */

/** Rounds a share count to the nearest whole share, half-up — options and RSUs don't
 * settle in fractional shares. Uses `toFixed(0)`'s existing half-up rounding rather than
 * introducing a second rounding convention into this codebase. */
function roundShares(qty: Decimal): Decimal {
  return new Decimal(qty.toFixed(0));
}

export interface CashExerciseInput {
  exerciseDate: ISODate;
  quantityExercised: DecimalValue;
  exercisePricePerUnit: DecimalValue;
  /** The grant-date fair value per unit already recognized as compensation cost via
   * `vesting.ts` for this quantity — reclassified out of the options pool into issued
   * shares here, not re-derived. */
  grantDateFairValuePerUnit: DecimalValue;
}

export interface CashExerciseResult {
  cashReceived: Decimal;
  apicReclassified: Decimal;
  commonStockIssued: Decimal;
}

export function computeCashExercise(input: CashExerciseInput): CashExerciseResult {
  const qty = new Decimal(input.quantityExercised);
  const cashReceived = qty.times(input.exercisePricePerUnit);
  const apicReclassified = qty.times(input.grantDateFairValuePerUnit);
  return {
    cashReceived,
    apicReclassified,
    commonStockIssued: cashReceived.plus(apicReclassified),
  };
}

/** Cash exercise of a stock option: the holder pays the exercise price in cash, and the
 * grant-date compensation cost already recognized in Additional Paid-In Capital is
 * reclassified into Common Stock alongside it — total consideration for the shares
 * issued is cash paid + previously-recognized value, matching how a cash-exercised
 * option's cost basis is actually computed. */
export function buildCashExerciseEntry(input: CashExerciseInput): JournalEntry {
  const result = computeCashExercise(input);
  const lines: JournalEntry["lines"] = [];
  if (result.cashReceived.greaterThan(0)) {
    lines.push({ account: "Cash", debit: result.cashReceived });
  }
  if (result.apicReclassified.greaterThan(0)) {
    lines.push({ account: "Additional Paid-In Capital", debit: result.apicReclassified });
  }
  lines.push({ account: "Common Stock", credit: result.commonStockIssued });

  const entry: JournalEntry = {
    date: input.exerciseDate,
    description: `Stock option cash exercise — ${result.commonStockIssued.toFixed(2)} of shares issued`,
    ascReference: "ASC 718-20-35 (option exercise)",
    lines,
  };
  assertBalanced(entry);
  return entry;
}

export interface NetShareSettlementInput {
  settlementDate: ISODate;
  /** Gross quantity vesting/exercising before any shares are withheld. */
  grossQuantity: DecimalValue;
  /** Zero for an RSU (no exercise price) — see the module doc comment. Nonzero for a
   * cashless/net-exercised stock option. */
  exercisePricePerUnit: DecimalValue;
  /** Fair market value per share on the settlement/exercise date — the single valuation
   * basis this function uses for every component of the transaction (see the module
   * doc comment's flagged simplification). */
  fairMarketValuePerUnitAtSettlement: DecimalValue;
  /** Total dollar amount of the employee's tax withholding obligation this settlement
   * must cover. Zero (or omitted) if no tax withholding applies. This is a given input,
   * not derived — see the module doc comment on why ISO/NSO-specific derivation isn't
   * done here. */
  taxWithholdingAmount?: DecimalValue;
}

export interface NetShareSettlementResult {
  sharesUsedForExercisePrice: Decimal;
  sharesWithheldForTax: Decimal;
  netSharesIssued: Decimal;
  /** = (netSharesIssued + sharesWithheldForTax) * FMV — the amount relieved from
   * Additional Paid-In Capital; the exercise-price share component is deliberately
   * excluded because it's never issued as Common Stock OR remitted as cash — it's
   * simply not part of the gross quantity that becomes a real transaction line (see
   * the module doc comment for the full accounting). */
  apicRelieved: Decimal;
  commonStockIssued: Decimal;
  taxWithholdingLiability: Decimal;
}

export function computeNetShareSettlement(input: NetShareSettlementInput): NetShareSettlementResult {
  const gross = new Decimal(input.grossQuantity);
  const fmv = new Decimal(input.fairMarketValuePerUnitAtSettlement);
  if (fmv.lessThanOrEqualTo(0)) {
    throw new Error("fairMarketValuePerUnitAtSettlement must be positive — cannot convert a dollar withholding amount into a share count at a zero or negative price");
  }
  const exercisePrice = new Decimal(input.exercisePricePerUnit);
  const taxWithholdingAmount = new Decimal(input.taxWithholdingAmount ?? 0);

  const sharesUsedForExercisePrice = exercisePrice.greaterThan(0)
    ? roundShares(gross.times(exercisePrice).div(fmv))
    : new Decimal(0);
  const sharesWithheldForTax = taxWithholdingAmount.greaterThan(0)
    ? roundShares(taxWithholdingAmount.div(fmv))
    : new Decimal(0);

  const netSharesIssued = gross.minus(sharesUsedForExercisePrice).minus(sharesWithheldForTax);
  if (netSharesIssued.isNegative()) {
    throw new Error(
      `Net share settlement would issue a negative share count (${netSharesIssued.toFixed(4)}) — the exercise price and/or tax withholding amount exceeds the gross award's value at this fair market value`
    );
  }

  return {
    sharesUsedForExercisePrice,
    sharesWithheldForTax,
    netSharesIssued,
    apicRelieved: netSharesIssued.plus(sharesWithheldForTax).times(fmv),
    commonStockIssued: netSharesIssued.times(fmv),
    taxWithholdingLiability: sharesWithheldForTax.times(fmv),
  };
}

/** Net (cashless) share settlement of a stock option, or net settlement of an RSU
 * (pass `exercisePricePerUnit: 0`) — no cash changes hands from the holder. Shares are
 * withheld to cover the exercise price (options only) and/or the tax withholding
 * obligation; the tax-withholding portion is booked as a liability here, not cash — see
 * `buildTaxWithholdingRemittanceEntry` for the entry that clears it when actually paid. */
export function buildNetShareSettlementEntry(input: NetShareSettlementInput): JournalEntry {
  const result = computeNetShareSettlement(input);
  const lines: JournalEntry["lines"] = [];
  if (result.apicRelieved.greaterThan(0)) {
    lines.push({ account: "Additional Paid-In Capital", debit: result.apicRelieved });
  }
  if (result.commonStockIssued.greaterThan(0)) {
    lines.push({ account: "Common Stock", credit: result.commonStockIssued });
  }
  if (result.taxWithholdingLiability.greaterThan(0)) {
    lines.push({ account: "Payroll Tax Withholding Payable", credit: result.taxWithholdingLiability });
  }

  const entry: JournalEntry = {
    date: input.settlementDate,
    description: `Net share settlement — ${result.netSharesIssued.toFixed(2)} shares issued of ${new Decimal(input.grossQuantity).toFixed(2)} gross`,
    ascReference: "ASC 718-10-25-9 (net share settlement, ASU 2016-09)",
    lines,
  };
  assertBalanced(entry);
  return entry;
}

/** Clears the "Payroll Tax Withholding Payable" liability `buildNetShareSettlementEntry`
 * created, on the date the withheld amount is actually remitted to the taxing
 * authority — kept as its own entry rather than folded into settlement itself because
 * remittance routinely happens on a later payroll-tax deposit schedule, a genuine
 * timing difference (same reasoning as `dailyAccrualInterestEntry`'s Accrued Interest
 * Payable in journalEntries.ts). */
export function buildTaxWithholdingRemittanceEntry(remittanceDate: ISODate, amount: DecimalValue): JournalEntry {
  const amt = new Decimal(amount);
  const entry: JournalEntry = {
    date: remittanceDate,
    description: "Remittance of equity-settlement tax withholding to taxing authority",
    ascReference: "ASC 718-10-25-9 (net share settlement, ASU 2016-09)",
    lines: [
      { account: "Payroll Tax Withholding Payable", debit: amt },
      { account: "Cash", credit: amt },
    ],
  };
  assertBalanced(entry);
  return entry;
}
