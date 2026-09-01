import { Money, JournalEntry, ISODate, money, assertBalanced, Decimal, DecimalValue } from "./types.js";
import { buildEffectiveInterestSchedule, TermDebtInputs } from "./debtAmortization.js";
import { Period } from "./dateMath.js";

/**
 * Conventional convertible note — fixed conversion ratio, indexed to the issuer's own
 * stock, no cash-settlement option or other feature disqualifying it from the
 * post-ASU 2020-06 single-instrument model. Accounted for as ordinary debt via the
 * effective-interest engine; the conversion feature itself carries no separate
 * accounting entry until conversion actually happens.
 *
 * OUT OF SCOPE, DELIBERATELY: notes requiring bifurcation (variable conversion price,
 * a redemption feature not clearly and closely related to the host) need the embedded
 * derivative fair-valued separately under ASC 815-15 — that's a distinct instrument
 * type with its own valuation dependency, not a variant of this function. Don't extend
 * this module to "handle" that case; route it to a fair-value-option or bifurcation
 * workflow instead once one exists.
 */
export interface ConventionalConvertibleNoteInputs extends TermDebtInputs {
  conversionPricePerShare: DecimalValue;
}

export function buildConventionalConvertibleNoteSchedule(
  inputs: ConventionalConvertibleNoteInputs,
  periods: Period[]
) {
  // Conversion terms are carried as metadata alongside an ordinary debt schedule —
  // they don't change the amortization math itself.
  return buildEffectiveInterestSchedule(inputs, periods).map((row) => ({
    ...row,
    meta: { ...row.meta, conversionPricePerShare: new Decimal(inputs.conversionPricePerShare) },
  }));
}

/** Conversion event: extinguish the debt liability at its carrying value and issue
 * shares — no gain or loss, since the note converts per its own pre-agreed terms
 * rather than being settled at fair value. */
export function buildConversionEntry(
  date: ISODate,
  carryingValueAtConversion: Money,
  sharesIssued: DecimalValue,
  parValuePerShare: DecimalValue = 0
): JournalEntry {
  const parTotal = new Decimal(parValuePerShare).times(sharesIssued);
  const apic = carryingValueAtConversion.minus(parTotal);
  const entry: JournalEntry = {
    date,
    description: "Conversion of convertible note into common stock",
    ascReference: "ASC 470-20 (conversion per original terms — no gain/loss)",
    lines: [
      { account: "Convertible Note Payable", debit: carryingValueAtConversion },
      { account: "Common Stock, par value", credit: money(parTotal) },
      { account: "Additional Paid-In Capital", credit: money(apic) },
    ],
  };
  assertBalanced(entry);
  return entry;
}
