import { ScheduleRow, JournalEntry, Decimal, assertBalanced } from "./types.js";

/** Stock compensation expense entry for one schedule period (any of the three ASC 718
 * vesting engines produce rows in this same shape, so one mapper covers all of them).
 *
 * `expenseAccountName` defaults to "Stock Compensation Expense" (every existing caller
 * omits it and gets identical behavior to before this parameter existed). It exists so
 * `nonemployeeAwards.ts` (v0.20.0) can reuse this exact function for a nonemployee
 * award's recognition entry, which needs a DIFFERENT debit account — either
 * "Nonemployee Compensation Expense" or, for an award to a customer,
 * "Reduction of Revenue" per ASC 606-10-32-25 — without duplicating the
 * balance-and-reversal logic below. */
export function stockCompExpenseEntry(row: ScheduleRow, expenseAccountName: string = "Stock Compensation Expense"): JournalEntry {
  const entry: JournalEntry = {
    date: row.periodEnd,
    description: `Stock-based compensation expense — ${row.label}`,
    ascReference: (row.meta?.ascReference as string) ?? "ASC 718",
    currency: row.currency,
    lines: [
      { account: expenseAccountName, debit: row.amount.isNegative() ? undefined : row.amount },
      { account: "Additional Paid-In Capital", credit: row.amount.isNegative() ? undefined : row.amount },
    ],
  };
  // A negative amount is a reversal (forfeiture or a performance condition that
  // became improbable) — flip debit/credit rather than posting a negative number,
  // since a negative-valued JE line reads as a data error to anyone reviewing it.
  if (row.amount.isNegative()) {
    entry.lines = [
      { account: "Additional Paid-In Capital", debit: row.amount.abs() },
      { account: expenseAccountName, credit: row.amount.abs() },
    ];
  }
  assertBalanced(entry);
  return entry;
}

/** Cash-settled SAR compensation expense entry (ASC 718-30) — structurally identical
 * to stockCompExpenseEntry's debit/credit-flip-on-reversal pattern, but crediting a
 * liability account rather than equity, since a cash-settled SAR is liability-
 * classified: the company owes cash at settlement, it never issues shares. */
export function sarLiabilityExpenseEntry(row: ScheduleRow): JournalEntry {
  const magnitude = row.amount.abs();
  const lines: JournalEntry["lines"] = row.amount.isNegative()
    ? [
        { account: "SAR Liability", debit: magnitude },
        { account: "SAR Compensation Expense", credit: magnitude },
      ]
    : [
        { account: "SAR Compensation Expense", debit: magnitude },
        { account: "SAR Liability", credit: magnitude },
      ];

  const entry: JournalEntry = {
    date: row.periodEnd,
    description: `Cash-settled SAR compensation expense — ${row.label}`,
    ascReference: (row.meta?.ascReference as string) ?? "ASC 718-30",
    currency: row.currency,
    lines,
  };
  assertBalanced(entry);
  return entry;
}

/** Mezzanine-classified preferred stock accretion entry (ASC 480-10-S99-3A) — moves
 * the instrument's carrying value toward its stated redemption value. Debited against
 * Retained Earnings (a "deemed dividend," reducing income available to common
 * shareholders for EPS) rather than Additional Paid-In Capital — some companies elect
 * to charge APIC first and only Retained Earnings once APIC is exhausted; that
 * two-step policy isn't modeled here, a real, flagged simplification, same spirit as
 * `revolverFeeExpenseEntry`'s commitment-fee-paid-in-cash assumption. A negative
 * amount (redemption value below issue price — unusual, but not impossible) flips
 * debit/credit rather than posting a negative line, same pattern as
 * `stockCompExpenseEntry`. */
export function preferredStockAccretionEntry(row: ScheduleRow): JournalEntry {
  const magnitude = row.amount.abs();
  const lines: JournalEntry["lines"] = row.amount.isNegative()
    ? [
        { account: "Preferred Stock (temporary equity)", debit: magnitude },
        { account: "Retained Earnings (accretion — deemed dividend)", credit: magnitude },
      ]
    : [
        { account: "Retained Earnings (accretion — deemed dividend)", debit: magnitude },
        { account: "Preferred Stock (temporary equity)", credit: magnitude },
      ];

  const entry: JournalEntry = {
    date: row.periodEnd,
    description: `Preferred stock accretion to redemption value — ${row.label}`,
    ascReference: (row.meta?.ascReference as string) ?? "ASC 480-10-S99-3A",
    currency: row.currency,
    lines,
  };
  assertBalanced(entry);
  return entry;
}

/** Restricted stock / early-exercised-option journal entry for one period of
 * `getScheduleBuilder`'s RESTRICTED_STOCK output (dispatch.ts) — always four lines (two
 * pairs), because the period genuinely has two independent things happening that must
 * never be netted into one number: compensation expense (`row.amount`, from
 * `buildServiceConditionSchedule` — a real P&L item, straight-line/graded over service,
 * same as any other ASC 718 award) and the repurchase-right-lapse reclassification
 * (`row.meta.repurchaseRightLapseAmount`, from `buildRepurchaseRightLapseSchedule` — a
 * zero-net-effect balance-sheet reclass of already-received cash from a liability into
 * real equity as tranches vest). Both pairs post even when one side is $0 for a given
 * period, matching `stockCompExpenseEntry`'s existing zero-value convention — the two
 * numbers are unrelated in magnitude (comp expense depends on grant-date fair value net
 * of purchase price; reclassification depends only on purchase price paid), so there's
 * no meaningful "netted" version of this entry. See restrictedStock.ts's module doc
 * comment for the full accounting rationale. */
export function restrictedStockEntry(row: ScheduleRow): JournalEntry {
  const compExpenseLines: JournalEntry["lines"] = row.amount.isNegative()
    ? [
        { account: "Additional Paid-In Capital", debit: row.amount.abs() },
        { account: "Stock Compensation Expense", credit: row.amount.abs() },
      ]
    : [
        { account: "Stock Compensation Expense", debit: row.amount },
        { account: "Additional Paid-In Capital", credit: row.amount },
      ];

  const reclass = row.meta?.repurchaseRightLapseAmount !== undefined
    ? new Decimal(row.meta.repurchaseRightLapseAmount as string)
    : new Decimal(0);
  const reclassLines: JournalEntry["lines"] = [
    { account: "Early Exercise Liability (unvested shares subject to repurchase)", debit: reclass },
    { account: "Common Stock / Additional Paid-In Capital", credit: reclass },
  ];

  const entry: JournalEntry = {
    date: row.periodEnd,
    description: `Restricted stock / early-exercise compensation expense and repurchase-right lapse — ${row.label}`,
    ascReference: (row.meta?.ascReference as string) ?? "ASC 718-10-35",
    currency: row.currency,
    lines: [...compExpenseLines, ...reclassLines],
  };
  assertBalanced(entry);
  return entry;
}

/** Debt interest expense entry for one effective-interest (or PIK) schedule period. */
export function debtInterestExpenseEntry(row: ScheduleRow): JournalEntry {
  const cashPaid = row.meta?.cashPaid as Decimal | undefined;
  const lines: JournalEntry["lines"] = [{ account: "Interest Expense", debit: row.amount }];

  if (cashPaid && cashPaid.greaterThan(0)) {
    lines.push({ account: "Cash", credit: cashPaid });
    const discountAmortization = row.amount.minus(cashPaid);
    if (discountAmortization.greaterThan(0)) {
      lines.push({ account: "Discount on Debt (contra-liability)", credit: discountAmortization });
    } else if (discountAmortization.isNegative()) {
      lines.push({ account: "Premium on Debt (contra-liability)", debit: discountAmortization.abs() });
    }
  } else {
    // PIK — no cash leg, the full interest accrues to the liability.
    lines.push({ account: "Notes Payable (PIK accrual)", credit: row.amount });
  }

  const entry: JournalEntry = {
    date: row.periodEnd,
    description: `Interest expense — ${row.label}`,
    ascReference: (row.meta?.ascReference as string) ?? "ASC 835-30",
    currency: row.currency,
    lines,
  };
  assertBalanced(entry);
  return entry;
}

/** Interest expense entry for one period of `buildDailyAccrualSchedule`'s output
 * (debtAmortization.ts). Deliberately a SEPARATE mapper from `debtInterestExpenseEntry`
 * above rather than a shared one: that function's cash-vs-accrual plug is discount or
 * premium amortization, which only makes sense for effective-interest debt carrying an
 * OID/premium. A daily-accrual floating-rate facility (no discount to amortize) has the
 * same kind of plug for a completely different reason — timing mismatch between when
 * interest accrues and when it's actually paid — so the plug belongs in Accrued
 * Interest Payable, not a contra-liability discount/premium account. Booking a
 * daily-accrual row through the wrong mapper would misstate the balance sheet even
 * though the P&L interest expense line would happen to come out the same. */
export function dailyAccrualInterestEntry(row: ScheduleRow): JournalEntry {
  const cashPaid = (row.meta?.cashPaid as Decimal | undefined) ?? new Decimal(0);
  const lines: JournalEntry["lines"] = [{ account: "Interest Expense", debit: row.amount }];

  if (cashPaid.greaterThan(0)) {
    lines.push({ account: "Cash", credit: cashPaid });
  }
  // Whatever accrued this period but wasn't paid in cash builds up (or, if cash paid
  // exceeded this period's accrual, pays down) Accrued Interest Payable — the correct
  // home for a pure timing difference, as opposed to discount/premium amortization.
  const accruedDelta = row.amount.minus(cashPaid);
  if (accruedDelta.greaterThan(0)) {
    lines.push({ account: "Accrued Interest Payable", credit: accruedDelta });
  } else if (accruedDelta.isNegative()) {
    lines.push({ account: "Accrued Interest Payable", debit: accruedDelta.abs() });
  }

  const entry: JournalEntry = {
    date: row.periodEnd,
    description: `Interest expense (daily accrual) — ${row.label}`,
    ascReference: (row.meta?.ascReference as string) ?? "ASC 835-30",
    currency: row.currency,
    lines,
  };
  assertBalanced(entry);
  return entry;
}

/** Journal entry for one period of `buildRevolverSchedule`'s output (debtAmortization.ts)
 * — a revolver's unused-commitment fee and/or deferred financing fee amortization, kept
 * as separate line pairs so each posts to the account that actually matches its nature:
 * the commitment fee is assumed paid in cash as billed (a real simplification — some
 * facilities accrue and settle it less often than every reporting period; adjust the
 * credit side to an accrued-fee-payable account if that's the case for a given
 * facility), while the deferred fee amortization runs against the deferred asset itself,
 * not cash, since that cash already left at closing. See buildRevolverSchedule's doc
 * comment for what this deliberately excludes (drawn-balance interest). */
export function revolverFeeExpenseEntry(row: ScheduleRow): JournalEntry {
  const commitmentFee = row.meta?.commitmentFeeAmount ? new Decimal(row.meta.commitmentFeeAmount as string) : new Decimal(0);
  const deferredAmortization = row.meta?.deferredFeeAmortization
    ? new Decimal(row.meta.deferredFeeAmortization as string)
    : new Decimal(0);

  const lines: JournalEntry["lines"] = [];
  if (commitmentFee.greaterThan(0)) {
    lines.push({ account: "Commitment Fee Expense", debit: commitmentFee });
    lines.push({ account: "Cash", credit: commitmentFee });
  }
  if (deferredAmortization.greaterThan(0)) {
    lines.push({ account: "Amortization of Deferred Financing Costs", debit: deferredAmortization });
    lines.push({ account: "Deferred Financing Costs (contra-liability)", credit: deferredAmortization });
  }

  const entry: JournalEntry = {
    date: row.periodEnd,
    description: `Revolver fee expense — ${row.label}`,
    ascReference: (row.meta?.ascReference as string) ?? "ASC 470 / ASC 835-30-45-3",
    currency: row.currency,
    lines,
  };
  assertBalanced(entry);
  return entry;
}
