import { FixedDecimal, DecimalValue } from "./decimal.js";

/**
 * All monetary and share-count math in this engine goes through this Decimal type
 * rather than native JS numbers. Native floating point is not safe for
 * financial calculations that get reconciled against a ledger — rounding
 * drift of a fraction of a cent compounds across hundreds of periods and
 * shows up as an out-of-balance journal entry. Every function in this
 * package accepts and returns Decimal (or Decimal-based) values; convert
 * at the API/DB boundary, not inside the engine.
 *
 * See decimal.ts for why this is a hand-rolled type rather than decimal.js.
 */
export { FixedDecimal as Decimal } from "./decimal.js";
export type { DecimalValue } from "./decimal.js";
export type Money = FixedDecimal;
export const money = (v: DecimalValue): Money => FixedDecimal.from(v);

export type ISODate = string; // "YYYY-MM-DD" — treat dates as calendar dates, not timestamps

/** ISO 4217 currency code, e.g. "USD", "EUR". Kept as a plain string rather than an
 * enum — the set of currencies a client might need is a data problem, not a type-safety
 * one, and a hardcoded enum would need a code change every time a new currency shows up. */
export type CurrencyCode = string;

/** Every amount in this codebase that doesn't specify a currency is assumed to be in
 * this one. Existing engine code and tests predate multi-currency support and don't set
 * `currency` anywhere — treating "unset" as USD rather than as an error keeps all of
 * that working unchanged, on the reasonable assumption that a single-currency client
 * (almost everyone, at least at first) never has to think about this at all. */
export const DEFAULT_CURRENCY: CurrencyCode = "USD";

export function currencyOf(x: { currency?: CurrencyCode }): CurrencyCode {
  return x.currency ?? DEFAULT_CURRENCY;
}

/**
 * IMPORTANT SCOPE NOTE ON WHAT MULTI-CURRENCY MEANS HERE: `currency` below tags an
 * amount with the currency it's ALREADY denominated in — it does not make the Decimal
 * arithmetic itself currency-aware. Nothing stops code from calling `.plus()` on a USD
 * FixedDecimal and a EUR FixedDecimal and getting a meaningless number back; that would
 * be a further, more invasive change touching every engine file. What IS enforced here
 * is the place that actually matters in practice: `reporting.ts` groups and reconciles
 * by currency rather than silently summing amounts from different currencies together,
 * which is the failure mode that would otherwise produce a "balanced" trial balance
 * that's actually nonsense. See fxTranslation.ts for the one thing that DOES need real
 * currency-aware logic: remeasuring a foreign-currency-denominated monetary balance
 * into the entity's reporting currency.
 */

/** One row of a computed schedule (vesting, amortization, or fair-value roll-forward). */
export interface ScheduleRow {
  periodStart: ISODate;
  periodEnd: ISODate;
  /** Human/UI label, e.g. "Year 1", "Tranche 2", "FY2027-Q1" */
  label: string;
  /** The primary P&L or balance-sheet driven amount for this row (expense, interest, FV change). */
  amount: Money;
  /** Running balance where applicable (e.g. carrying value of debt, cumulative expense recognized). */
  endingBalance?: Money;
  /** The currency `amount`/`endingBalance` are denominated in. Defaults to USD when
   * unset — see DEFAULT_CURRENCY above. */
  currency?: CurrencyCode;
  /** Free-form metadata for downstream reporting (ASC citation, instrument id, etc). */
  meta?: Record<string, unknown>;
}

/** A single leg of a journal entry. */
export interface JournalLine {
  account: string;
  debit?: Money;
  credit?: Money;
  memo?: string;
}

export interface JournalEntry {
  date: ISODate;
  description: string;
  lines: JournalLine[];
  /** ASC reference this entry implements, for audit trail / reviewer context. */
  ascReference?: string;
  /** The currency every line of this entry is denominated in. A single journal entry
   * is always one currency — a transaction doesn't book half in USD and half in EUR —
   * so this lives on the entry, not per-line. Defaults to USD when unset. */
  currency?: CurrencyCode;
}

/** Validates that a journal entry actually balances. Throws if it doesn't — this should
 * never fail silently, since an unbalanced JE is the single worst failure mode for this product. */
export function assertBalanced(entry: JournalEntry, tolerance = new FixedDecimal("0.01")): void {
  const totalDebits = entry.lines.reduce((sum, l) => sum.plus(l.debit ?? 0), new FixedDecimal(0));
  const totalCredits = entry.lines.reduce((sum, l) => sum.plus(l.credit ?? 0), new FixedDecimal(0));
  const diff = totalDebits.minus(totalCredits).abs();
  if (diff.greaterThan(tolerance)) {
    throw new Error(
      `Journal entry does not balance: debits=${totalDebits.toFixed(2)} credits=${totalCredits.toFixed(2)} ("${entry.description}")`
    );
  }
}
