import { Money, money, Decimal, DecimalValue, ISODate, CurrencyCode, JournalEntry, JournalLine, assertBalanced } from "./types.js";

/**
 * SAFEs (Simple Agreements for Future Equity — the YC-originated instrument, now the
 * most common seed-stage security this platform's target clientele actually sees) —
 * a real, citable classification question, not a vague judgment call, which is why
 * this module opens with a triage the same way `warrantAllocation.ts`'s
 * `classifyWarrant` and `preferredStock.ts`'s classification do.
 *
 * THE CLASSIFICATION QUESTION: a standard SAFE takes a FIXED dollar investment today
 * in exchange for a VARIABLE number of shares at a future priced round (via a
 * valuation cap and/or discount, whichever is more favorable to the holder) — the
 * exact number of shares isn't known until that future round happens. ASC
 * 480-10-25-14 requires LIABILITY classification for a freestanding financial
 * instrument that obligates the issuer to issue a variable number of its own equity
 * shares, where the monetary value of the obligation is based SOLELY on a fixed
 * monetary amount known at inception. A standard, uncapped-in-share-count,
 * dollar-denominated SAFE matches that description directly: the investment amount
 * is fixed at inception, and the share count is whatever that fixed amount converts
 * into once a future price exists. `classifySafe` below defaults to "liability" for
 * exactly this reason, not as a conservative guess but because that's the specific,
 * literal criterion in 25-14. Two things push a SAFE the other way, toward equity:
 * a conversion price that's actually FIXED and known at inception (uncommon —
 * defeats the entire commercial point of a SAFE, but some bespoke variants do this),
 * which fails 25-14's "variable number of shares" premise entirely; or, in the
 * other direction, a holder-elected CASH settlement alternative, which independently
 * forces liability classification under ASC 815-40-25 regardless of the share-count
 * question — checked first below since it's dispositive on its own.
 *
 * SUBSEQUENT MEASUREMENT: instruments liability-classified under 25-14 are measured
 * at FAIR VALUE, both at issuance and every period thereafter, with changes run
 * through earnings (ASC 480-10-30-7 / 35-3) — exactly the fair-value-through-earnings
 * model `fairValueRemeasurement.ts` already implements for liability-classified
 * warrants, so this module reuses that engine directly rather than building a new
 * one, same "reuse over reinvention" discipline as the rest of this codebase.
 * PRACTICAL EXPEDIENT documented here because it's a real, common simplification:
 * absent a more precise valuation, the investment amount actually received is
 * typically used as the day-one fair value (no gain or loss is recognized purely
 * from having just closed the transaction) — a real 409A-style valuation of the SAFE
 * itself is comparatively rare for an early-stage instrument, though a company that
 * has one should use it instead.
 *
 * CONVERSION: when a future priced round actually triggers conversion, the SAFE
 * (liability or, in the rare fixed-price case, equity) is derecognized at its
 * then-carrying value and shares are issued — no gain or loss, since the instrument
 * converts per its own pre-agreed mechanics rather than being settled at a
 * separately-negotiated price. Structurally identical to
 * `convertibleNote.ts`'s `buildConversionEntry`, mirrored here rather than
 * imported, since a SAFE's liability/equity account name differs by classification
 * and this module wants that to be an explicit, named choice at the call site, not a
 * shared default.
 *
 * OUT OF SCOPE, DELIBERATELY:
 *  - A SAFE with a repayment/liquidation preference right that behaves like genuine
 *    debt (some non-standard variants add one) — that pushes toward the ordinary
 *    debt/mandatorily-redeemable-preferred models already in this codebase, not this
 *    module, which assumes the standard "converts or nothing" SAFE mechanics with no
 *    repayment right.
 *  - Deriving the fair value itself for the liability path's period-by-period
 *    remeasurement — same "manual entry, not computed" limitation
 *    `fairValueRemeasurement.ts`'s own doc comment already states; this module
 *    doesn't add valuation modeling on top of that engine.
 *  - Multiple SAFEs with different caps/discounts/seniority interacting in one
 *    conversion (a "stacked SAFE" waterfall) — each SAFE here is modeled and
 *    converted independently; composing several into one conversion-date waterfall
 *    is real, separate follow-on work.
 */

export interface SafeClassificationInputs {
  /** True only if the SAFE's conversion price is fixed and stated in the agreement
   * itself, not dependent on a future priced round. Uncommon — defaults to false for
   * a standard cap/discount SAFE. */
  conversionPriceFixedAtInception: boolean;
  /** True if the holder can elect cash settlement instead of conversion into shares
   * (uncommon for a standard SAFE) — checked first, since it forces liability
   * classification (ASC 815-40-25) independent of the share-count question below. */
  holderCanElectCashSettlement: boolean;
}

export type SafeClassification = "liability" | "equity";

export function classifySafe(inputs: SafeClassificationInputs): SafeClassification {
  if (inputs.holderCanElectCashSettlement) return "liability";
  if (!inputs.conversionPriceFixedAtInception) return "liability";
  return "equity";
}

/** Records a liability-classified SAFE at issuance, at the investment amount received
 * as the day-one fair value (see the module doc comment's PRACTICAL EXPEDIENT note —
 * pass a different `initialFairValue` if a more precise valuation exists). When a
 * passed-in `initialFairValue` DOES differ from cash received, the difference is a
 * real day-one remeasurement gain/loss and is booked as its own line rather than left
 * as a silent imbalance. */
export function buildLiabilitySafeIssuanceEntry(
  date: ISODate,
  investmentAmountReceived: Money,
  currency?: CurrencyCode,
  initialFairValue?: Money
): JournalEntry {
  const fairValue = initialFairValue ?? investmentAmountReceived;
  const dayOneDifference = fairValue.minus(investmentAmountReceived);

  const lines: JournalLine[] = [
    { account: "Cash", debit: investmentAmountReceived },
    { account: "SAFE Liability", credit: fairValue },
  ];
  if (dayOneDifference.greaterThan(0)) {
    lines.push({ account: "Loss on Day-One SAFE Measurement", debit: dayOneDifference });
  } else if (dayOneDifference.isNegative()) {
    lines.push({ account: "Gain on Day-One SAFE Measurement", credit: dayOneDifference.abs() });
  }

  const entry: JournalEntry = {
    date,
    description: "SAFE issuance, liability-classified (ASC 480-10-25-14)",
    ascReference: "ASC 480-10-25-14 / 480-10-30-7",
    currency,
    lines,
  };
  assertBalanced(entry);
  return entry;
}

/** Records an equity-classified SAFE at issuance — the uncommon fixed-conversion-price
 * case; see `classifySafe`. No periodic remeasurement applies once classified equity. */
export function buildEquitySafeIssuanceEntry(date: ISODate, investmentAmountReceived: Money, currency?: CurrencyCode): JournalEntry {
  const entry: JournalEntry = {
    date,
    description: "SAFE issuance, equity-classified (fixed conversion price at inception)",
    ascReference: "ASC 480-10-25 (not within scope of 25-14 — conversion terms fixed at inception)",
    currency,
    lines: [
      { account: "Cash", debit: investmentAmountReceived },
      { account: "Additional Paid-In Capital (SAFE)", credit: investmentAmountReceived },
    ],
  };
  assertBalanced(entry);
  return entry;
}

/** Conversion event: derecognizes the SAFE (liability or equity — pass whichever
 * account name matches how it was carried) at its carrying value as of the conversion
 * date, and issues shares — no gain or loss, since it converts per its own pre-agreed
 * mechanics. `safeAccountName` should match the account credited at issuance above
 * ("SAFE Liability" or "Additional Paid-In Capital (SAFE)") so this debit actually
 * closes out the same balance. */
export function buildSafeConversionEntry(
  date: ISODate,
  safeAccountName: string,
  carryingValueAtConversion: Money,
  sharesIssued: DecimalValue,
  parValuePerShare: DecimalValue = 0,
  currency?: CurrencyCode
): JournalEntry {
  const parTotal = Decimal.from(parValuePerShare).times(sharesIssued);
  const apic = carryingValueAtConversion.minus(parTotal);
  const entry: JournalEntry = {
    date,
    description: "Conversion of SAFE into equity upon a qualifying future financing",
    ascReference: "ASC 480-10 / ASC 815-40 (conversion per original terms — no gain/loss)",
    currency,
    lines: [
      { account: safeAccountName, debit: carryingValueAtConversion },
      { account: "Common Stock, par value", credit: money(parTotal) },
      { account: "Additional Paid-In Capital", credit: money(apic) },
    ],
  };
  assertBalanced(entry);
  return entry;
}
