import { Money, money, Decimal, DecimalValue, ISODate, CurrencyCode, JournalEntry, assertBalanced } from "./types.js";

/**
 * The beneficial conversion feature (BCF) — ASC 470-20-30 — the gap flagged explicitly
 * in `preferredStock.ts`'s SCOPE note and listed on its own in the task-status
 * spreadsheet for both convertible debt and convertible preferred.
 *
 * WHAT IT IS: when a convertible instrument (a convertible note, or convertible
 * preferred stock) is issued with a conversion price BELOW the commitment-date
 * (issuance-date) fair value of the stock it converts into, the holder effectively
 * received an in-the-money option for free — GAAP requires that intrinsic value to be
 * split out and recorded separately from the host instrument at issuance, rather than
 * left buried inside it.
 *
 * THE CALCULATION (ASC 470-20-30-6 through 30-8):
 *  1. Effective conversion price = proceeds actually ALLOCATED to the convertible
 *     instrument (after separating out any other components — e.g. a detachable
 *     warrant already carved out via `warrantAllocation.ts`'s relative-fair-value
 *     method — this function takes that already-allocated amount as an input, it does
 *     not do that allocation itself) divided by the number of shares the instrument
 *     converts into.
 *  2. Intrinsic value per share = commitment-date fair value per share MINUS the
 *     effective conversion price, floored at zero (no BCF, obviously, if the
 *     conversion price is at or above fair value — that's just an ordinary
 *     out-of/at-the-money conversion feature).
 *  3. The BCF itself = intrinsic value per share x number of conversion shares,
 *     CAPPED at the proceeds actually allocated to the instrument (30-8) — a BCF can
 *     never exceed what was received for the instrument it's embedded in, however
 *     deep in the money the conversion feature is.
 *
 * SUBSEQUENT ACCOUNTING DIFFERS BY HOST INSTRUMENT, which is why this module has two
 * separate journal-entry builders rather than one:
 *  - Convertible DEBT (`buildDebtBcfEntry`): the BCF is recorded as additional debt
 *    discount at issuance, credited to Additional Paid-In Capital — the exact same
 *    "Discount on Debt (contra-liability)" account `debtAmortization.ts`/
 *    `journalEntries.ts` already amortize as extra interest expense over the
 *    instrument's life via the effective interest method. A caller wiring this into a
 *    real issuance should add the BCF amount into whatever `netProceeds`/discount
 *    figure it hands `buildEffectiveInterestSchedule` — this function only produces
 *    the day-one entry, it does not re-run that amortization schedule itself.
 *  - Convertible PREFERRED (`buildPreferredBcfEntry`): recognized as a DEEMED DIVIDEND
 *    at the commitment date if the preferred is immediately convertible (the common
 *    real-world case for VC-backed preferred) — a one-time charge against Retained
 *    Earnings, not an amortized interest expense, since preferred stock has no
 *    "effective interest" concept the way debt does. This mirrors
 *    `preferredStock.ts`'s own accretion entry, which uses the identical "charge
 *    Retained Earnings, credit Additional Paid-In Capital, call it a deemed dividend
 *    that reduces income available to common for EPS" pattern — see that file's doc
 *    comment for why Retained Earnings rather than APIC is the standard first stop.
 *
 * DELIBERATELY OUT OF SCOPE:
 *  - A CONTINGENT conversion feature — one that isn't currently convertible, only upon
 *    a future event (an IPO, a qualified financing) — generally defers BCF
 *    measurement/recognition until the contingency is resolved (ASC 470-20-30-15/40-1)
 *    rather than recognizing it at issuance the way this module does. This module
 *    assumes the instrument is convertible from day one; a contingently convertible
 *    instrument needs its own, separate handling, not a variant flag bolted onto this.
 *  - A subsequent "additional BCF" from a later, separate down-round repricing of an
 *    already-issued convertible instrument (ASC 470-20-30-9 through 30-11) — this
 *    module only computes the BCF as of original issuance.
 *  - Multiple conversion prices, or a conversion ratio that varies over the
 *    instrument's life — the effective conversion price here is a single number
 *    computed once at issuance, matching every other issuance-time computation in this
 *    codebase (see e.g. `warrantAllocation.ts`'s relative fair value split).
 */

export interface BeneficialConversionFeatureInputs {
  /** Proceeds already allocated to the convertible instrument itself — i.e. AFTER
   * carving out any separately-valued components (a detachable warrant, for instance).
   * For a plain convertible note/preferred with no other components, this is simply
   * the full issuance proceeds. */
  proceedsAllocatedToConvertibleInstrument: Money;
  /** Number of shares issuable upon conversion of the ENTIRE instrument (not per unit) —
   * a share count, kept as a Decimal like every other share count in this codebase for
   * fractional-share precision. */
  numberOfConversionShares: DecimalValue;
  /** Fair value per share of the underlying stock on the commitment (issuance) date —
   * an input, not something this function derives; typically the same 409A/valuation
   * figure used elsewhere for that same date. */
  commitmentDateFairValuePerShare: Money;
}

export interface BeneficialConversionFeatureResult {
  effectiveConversionPricePerShare: Money;
  /** Floored at zero — a conversion price at or above fair value has no BCF, not a
   * "negative" one. */
  intrinsicValuePerShare: Money;
  /** The actual amount to record — already capped at
   * `proceedsAllocatedToConvertibleInstrument` per ASC 470-20-30-8. */
  beneficialConversionFeatureAmount: Money;
  hasBeneficialConversionFeature: boolean;
}

export function computeBeneficialConversionFeature(
  input: BeneficialConversionFeatureInputs
): BeneficialConversionFeatureResult {
  const shares = Decimal.from(input.numberOfConversionShares);
  if (!shares.greaterThan(0)) {
    throw new Error(`numberOfConversionShares must be positive (got ${shares.toString()}).`);
  }
  if (input.proceedsAllocatedToConvertibleInstrument.isNegative()) {
    throw new Error("proceedsAllocatedToConvertibleInstrument cannot be negative.");
  }

  const effectiveConversionPricePerShare = input.proceedsAllocatedToConvertibleInstrument.div(shares);
  const intrinsicValuePerShare = Decimal.max(
    0,
    input.commitmentDateFairValuePerShare.minus(effectiveConversionPricePerShare)
  );
  const rawBcf = intrinsicValuePerShare.times(shares);
  const beneficialConversionFeatureAmount = Decimal.min(rawBcf, input.proceedsAllocatedToConvertibleInstrument);

  return {
    effectiveConversionPricePerShare,
    intrinsicValuePerShare,
    beneficialConversionFeatureAmount,
    hasBeneficialConversionFeature: beneficialConversionFeatureAmount.greaterThan(0),
  };
}

/** Records the BCF on a convertible NOTE as additional debt discount at issuance —
 * see the module doc comment for why this feeds the same discount-amortization
 * machinery the rest of the debt engine already has, rather than its own schedule. */
export function buildDebtBcfEntry(date: ISODate, beneficialConversionFeatureAmount: Money, currency?: CurrencyCode): JournalEntry {
  const entry: JournalEntry = {
    date,
    description: "Beneficial conversion feature on convertible debt, recorded as additional debt discount",
    ascReference: "ASC 470-20-30",
    currency,
    lines: [
      { account: "Discount on Debt (contra-liability)", debit: beneficialConversionFeatureAmount },
      { account: "Additional Paid-In Capital", credit: beneficialConversionFeatureAmount },
    ],
  };
  assertBalanced(entry);
  return entry;
}

/** Records the BCF on convertible PREFERRED stock as an immediate deemed dividend —
 * only correct for a preferred that is immediately (unconditionally) convertible; see
 * the module doc comment for why a contingently convertible instrument needs
 * different handling this function does not attempt. */
export function buildPreferredBcfEntry(date: ISODate, beneficialConversionFeatureAmount: Money, currency?: CurrencyCode): JournalEntry {
  const entry: JournalEntry = {
    date,
    description: "Beneficial conversion feature on convertible preferred stock, recognized as a deemed dividend",
    ascReference: "ASC 470-20-30",
    currency,
    lines: [
      { account: "Retained Earnings (deemed dividend)", debit: beneficialConversionFeatureAmount },
      { account: "Additional Paid-In Capital", credit: beneficialConversionFeatureAmount },
    ],
  };
  assertBalanced(entry);
  return entry;
}

// Re-exported for money(0)-style zero comparisons in callers/tests without importing
// types.ts directly for just that.
export { money };
