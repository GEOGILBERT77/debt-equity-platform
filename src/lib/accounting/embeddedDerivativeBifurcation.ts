import { classifyWarrant } from "./warrantAllocation.js";

/**
 * ASC 815-15-25 embedded derivative bifurcation assessment for a conversion feature
 * embedded in a debt host — the single most common real-world bifurcation question,
 * and the one this module targets (see "deliberately out of scope" for what it does
 * not cover). This is the classification/triage layer, not a valuation engine — see
 * the note on that below.
 *
 * THE GENERAL TEST (ASC 815-15-25-1) requires bifurcation only when ALL three of the
 * following are true: (a) the embedded feature's economic characteristics and risks
 * are not "clearly and closely related" to the host contract's; (b) a freestanding
 * instrument with the same terms as the embedded feature would itself meet the
 * definition of a derivative; (c) the hybrid instrument is not already measured at
 * fair value with changes reported in earnings as they occur (if it already is,
 * bifurcation adds nothing — everything's already marked to fair value).
 *
 * FOR A CONVERSION FEATURE SPECIFICALLY, there's a scope exception at ASC
 * 815-10-15-74 that is almost always decisive in practice: a conversion feature
 * indexed to the ISSUER'S OWN STOCK that would be classified in stockholders' equity
 * if it were a freestanding instrument is EXCLUDED from bifurcation, full stop — this
 * is why plain-vanilla convertible debt's conversion feature is essentially never
 * bifurcated. `classifyEmbeddedConversionFeature` below reuses `warrantAllocation.ts`'s
 * existing `classifyWarrant` to answer the "would it be equity if freestanding"
 * question, rather than re-deriving the same fixed-for-fixed indexation/settlement
 * analysis a second time — a warrant and a conversion option are, for this specific
 * purpose, both just "an option to receive the issuer's own stock," and the equity-
 * classification test is identical. Reuse, not reinvention, exactly like every other
 * classification engine in this codebase.
 *
 * HOW THE OUTCOMES MAP: if `classifyWarrant` returns "equity," the ASC 815-10-15-74
 * exception applies and bifurcation is NOT required — that's a categorical carve-out,
 * not a factor to weigh against the general (a)/(b) test. If it returns "liability"
 * (net-cash-settlable, or not indexed solely to the issuer's own stock), the
 * exception does NOT apply, and bifurcation IS required — a liability-classified
 * conversion feature is, definitionally, not clearly and closely related to a plain
 * debt host, since its value moves with the issuer's stock price, a risk the host has
 * none of. If it returns "review" (down-round protection present), this module also
 * returns a "review" outcome rather than guessing which way that judgment call would
 * land — same "flag rather than guess" discipline `classifyWarrant` itself uses.
 *
 * WHAT THIS MODULE DOES NOT DO: value the bifurcated derivative once bifurcation IS
 * required. That valuation is typically a binomial lattice or Monte Carlo model
 * capturing the conversion feature's full contingent-payment structure (a reset
 * provision, a make-whole, path dependency a closed-form Black-Scholes cannot
 * represent) — a meaningfully larger undertaking than this codebase's existing
 * closed-form pricing (the same complexity boundary `blackScholes.ts`'s own doc
 * comment draws around market-condition awards), and is flagged here rather than
 * approximated with a model that would misstate it.
 *
 * DELIBERATELY OUT OF SCOPE, beyond the valuation gap above:
 *  - Embedded features other than a conversion option — interest-rate indices,
 *    inflation-linked payments, foreign-currency-linked principal, contingent
 *    put/call options — each has its own "clearly and closely related" analysis
 *    under ASC 815-15-25-24 through 25-46 that this module does not attempt.
 *  - A conversion feature indexed to something OTHER than the issuer's own stock (a
 *    formula tied to a commodity price, an index, a basket of securities) — the ASC
 *    815-10-15-74 exception only ever applies to an issuer's own stock, so this
 *    module assumes that's what it's being asked about rather than verifying it.
 *  - Multiple embedded features in the same host evaluated together (e.g. a
 *    conversion option plus a separate contingent put) — one feature at a time.
 */

export type BifurcationOutcome = "NOT_REQUIRED" | "REQUIRED" | "REVIEW";

export interface EmbeddedConversionFeatureInputs {
  netCashSettlementPossible: boolean;
  indexedToOwnStockOnly: boolean;
  hasDownRoundProtection: boolean;
  /** ASC 815-15-25-1(c) — true if the whole hybrid instrument is already measured at
   * fair value with changes reported in earnings (e.g. the issuer elected the fair
   * value option for the entire instrument). Defaults to false, the common case. */
  hybridInstrumentAlreadyAtFairValueThroughEarnings?: boolean;
}

export interface BifurcationAssessment {
  outcome: BifurcationOutcome;
  reason: string;
}

/** See the module doc comment for the full test and how it maps to `classifyWarrant`'s
 * existing three outcomes. */
export function classifyEmbeddedConversionFeature(inputs: EmbeddedConversionFeatureInputs): BifurcationAssessment {
  if (inputs.hybridInstrumentAlreadyAtFairValueThroughEarnings) {
    return {
      outcome: "NOT_REQUIRED",
      reason:
        "ASC 815-15-25-1(c): the hybrid instrument is already measured at fair value with changes reported in earnings, so bifurcation would add nothing.",
    };
  }

  const freestandingClassification = classifyWarrant({
    netCashSettlementPossible: inputs.netCashSettlementPossible,
    indexedToOwnStockOnly: inputs.indexedToOwnStockOnly,
    hasDownRoundProtection: inputs.hasDownRoundProtection,
  });

  if (freestandingClassification === "equity") {
    return {
      outcome: "NOT_REQUIRED",
      reason:
        "ASC 815-10-15-74 scope exception: a conversion feature indexed only to the issuer's own stock that would be equity-classified if freestanding is excluded from bifurcation.",
    };
  }

  if (freestandingClassification === "review") {
    return {
      outcome: "REVIEW",
      reason:
        "Down-round protection is present. Post-ASU 2017-11 this does not automatically disqualify equity classification, but it needs the same human judgment call classifyWarrant flags for a freestanding warrant with this feature.",
    };
  }

  return {
    outcome: "REQUIRED",
    reason:
      "The conversion feature would be liability-classified if freestanding (net-cash-settlable, or not indexed solely to the issuer's own stock), so it is not clearly and closely related to a plain debt host and must be bifurcated (ASC 815-15-25-1).",
  };
}
