import { Decimal, Money, ISODate, CurrencyCode, DEFAULT_CURRENCY, ScheduleRow, JournalEntry, assertBalanced } from "./types.js";

/**
 * ASC 830-20 — foreign currency transaction remeasurement.
 *
 * This is the one piece of "multi-currency support" that needs real currency-aware
 * logic, as opposed to the currency *tagging* the rest of the engine does (see the
 * scope note in types.ts). A monetary balance denominated in a currency other than the
 * entity's reporting currency — a EUR-denominated term loan, a GBP-denominated
 * receivable — has to be remeasured into the reporting currency every period, and the
 * change in that remeasured value (holding the foreign-currency face amount constant)
 * is a transaction gain or loss that hits the P&L. That is a genuinely different
 * calculation from "what does this instrument's own schedule say," which is why it's
 * its own engine rather than a parameter bolted onto debtAmortization.ts or similar —
 * the instrument's amortization schedule runs entirely in its own (foreign) currency,
 * and this module is a second, independent pass over that schedule's period-end
 * balances that produces the remeasurement entries alongside it.
 *
 * SIGN CONVENTION: `amount` on every row this produces is the P&L impact, using the
 * same convention journalEntries.ts already uses elsewhere in this codebase (see
 * stockCompExpenseEntry's forfeiture-reversal handling) — positive = loss (debit),
 * negative = gain (credit). That convention is what makes fxRemeasurementEntry's logic
 * so short: worked through below, a LOSS always credits the monetary-item leg and a
 * GAIN always debits it, regardless of whether the item is an asset or a liability.
 *
 *   - Liability, spot rate rises -> reporting-currency liability grows -> LOSS (you now
 *     owe more reporting-currency to settle the same foreign-currency debt) -> credit
 *     the liability (liabilities increase on the credit side).
 *   - Asset, spot rate rises -> reporting-currency asset grows -> GAIN (the same
 *     foreign-currency receivable is now worth more) -> debit the asset (assets
 *     increase on the debit side) -> so on a GAIN the asset leg is a debit, matching
 *     "gain = credit to the loss/gain account, debit the monetary item."
 *   - Liability, spot rate falls -> liability shrinks -> GAIN -> debit the liability.
 *   - Asset, spot rate falls -> asset shrinks -> LOSS -> credit the asset.
 *
 * NOT COVERED HERE: translation (as opposed to remeasurement) of an entire foreign
 * subsidiary's financial statements under ASC 830-30, which runs through Other
 * Comprehensive Income rather than the P&L and uses different rates for different
 * statement lines (historical for equity, average for the income statement, spot for
 * the balance sheet). That's a consolidation-level concern this platform doesn't take
 * on yet — this module is purely "one foreign-currency-denominated monetary balance,
 * remeasured into the reporting currency," which is the case every debt or receivable
 * instrument in this engine actually needs.
 */

export type MonetaryItemKind = "asset" | "liability";

export interface FxBalancePoint {
  periodStart: ISODate;
  periodEnd: ISODate;
  label: string;
  /** The balance as of `periodEnd`, denominated in `foreignCurrency` — e.g. the EUR
   * face amount of a term loan, or an EUR receivable balance. This module never
   * converts or touches the foreign-currency figure itself; it only remeasures it. */
  foreignBalance: Money;
  /** Reporting-currency units per 1 unit of foreign currency as of `periodEnd` (e.g.
   * 1.10 USD per EUR). The first entry's rate establishes the opening reporting-
   * currency carrying value; every entry after that produces a remeasurement row. */
  spotRate: Money;
}

export interface FxRemeasurementInput {
  foreignCurrency: CurrencyCode;
  /** Defaults to USD — see DEFAULT_CURRENCY in types.ts. */
  reportingCurrency?: CurrencyCode;
  instrumentKind: MonetaryItemKind;
  /** Ordered chronologically. The first point is treated as the balance's inception
   * (or the last point already remeasured, if you're extending an existing schedule) —
   * it produces a zero-amount row that just records the opening carrying value, not a
   * gain/loss, since there's no prior remeasurement to compare it against. */
  balances: FxBalancePoint[];
}

/** Builds one row per balance point: the reporting-currency carrying value at that
 * point, and — for every point after the first — the remeasurement gain/loss versus
 * the prior point's reporting-currency carrying value. `currency` on every row is the
 * REPORTING currency, not the foreign currency — this schedule lives in the currency
 * the gain/loss and carrying value are actually expressed in. */
export function buildFxRemeasurementSchedule(input: FxRemeasurementInput): ScheduleRow[] {
  if (input.balances.length === 0) {
    throw new Error("buildFxRemeasurementSchedule requires at least one balance point");
  }
  const reportingCurrency = input.reportingCurrency ?? DEFAULT_CURRENCY;
  const rows: ScheduleRow[] = [];
  let priorReportingBalance: Money | null = null;

  for (const point of input.balances) {
    const newReportingBalance = point.foreignBalance.times(point.spotRate);

    if (priorReportingBalance === null) {
      rows.push({
        periodStart: point.periodStart,
        periodEnd: point.periodEnd,
        label: point.label,
        amount: new Decimal(0),
        endingBalance: newReportingBalance,
        currency: reportingCurrency,
        meta: {
          ascReference: "ASC 830-20",
          foreignCurrency: input.foreignCurrency,
          foreignBalance: point.foreignBalance.toFixed(2),
          spotRate: point.spotRate.toString(),
          note: "Initial recognition — establishes the opening reporting-currency carrying value; no remeasurement gain/loss yet.",
        },
      });
      priorReportingBalance = newReportingBalance;
      continue;
    }

    const delta = newReportingBalance.minus(priorReportingBalance);
    // See the module doc comment above for the full walk-through of this flip.
    const amount = input.instrumentKind === "liability" ? delta : delta.negated();

    rows.push({
      periodStart: point.periodStart,
      periodEnd: point.periodEnd,
      label: point.label,
      amount,
      endingBalance: newReportingBalance,
      currency: reportingCurrency,
      meta: {
        ascReference: "ASC 830-20",
        foreignCurrency: input.foreignCurrency,
        foreignBalance: point.foreignBalance.toFixed(2),
        spotRate: point.spotRate.toString(),
        priorReportingCurrencyBalance: priorReportingBalance.toFixed(2),
      },
    });
    priorReportingBalance = newReportingBalance;
  }

  return rows;
}

/** Books one remeasurement row as a balanced journal entry. `instrumentKind` is passed
 * separately rather than read off `row.meta` because a ScheduleRow on its own doesn't
 * carry the asset/liability distinction — only the schedule-builder call above knows
 * it, so the caller (whatever wires this into a close/reporting flow) is expected to
 * remember which kind of item it built the schedule for and pass the same value here. */
export function fxRemeasurementEntry(row: ScheduleRow, instrumentKind: MonetaryItemKind): JournalEntry {
  const monetaryAccount =
    instrumentKind === "liability" ? "Notes Payable (foreign-currency-denominated)" : "Foreign-Currency-Denominated Asset";
  const lossGainAccount = "Foreign Currency Transaction Gain/Loss";
  const magnitude = row.amount.abs();

  // Positive (or zero) = loss: debit the loss account, credit the monetary item —
  // whether that credit means "the liability grew" or "the asset shrank" depends on
  // instrumentKind, but the debit/credit side is the same either way (see module doc
  // comment). Negative = gain: the mirror image.
  const lines = row.amount.isNegative()
    ? [
        { account: monetaryAccount, debit: magnitude },
        { account: lossGainAccount, credit: magnitude },
      ]
    : [
        { account: lossGainAccount, debit: magnitude },
        { account: monetaryAccount, credit: magnitude },
      ];

  const entry: JournalEntry = {
    date: row.periodEnd,
    description: `Foreign currency remeasurement — ${row.label}`,
    ascReference: "ASC 830-20",
    currency: row.currency,
    lines,
  };
  assertBalanced(entry);
  return entry;
}
