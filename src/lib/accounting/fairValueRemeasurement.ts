import { Decimal, ISODate, DecimalValue, ScheduleRow, JournalEntry, assertBalanced } from "./types.js";
import { Period } from "./dateMath.js";
import { MonetaryItemKind } from "./fxTranslation.js";

/**
 * Fair-value remeasurement for anything liability-classified (or, less commonly here,
 * asset-classified) that has to be marked to fair value each reporting period with the
 * change run through earnings — a bifurcated embedded derivative, a liability-
 * classified warrant (ASC 815-40), a mandatorily redeemable financial instrument
 * measured at fair value (ASC 480-10-35), or anything else carried under the fair
 * value option (ASC 825-10-25). What's common across all of those, and the entire
 * reason this is one engine rather than three: once you're in a fair-value-through-
 * earnings model, the period's P&L impact is always just this period's ending fair
 * value minus the prior period's, however that number was arrived at.
 *
 * INPUT MODE — MANUAL ENTRY ONLY: this version takes the fair value at each
 * measurement date as a given input, entered by the client/CPA (or copied from an
 * independent valuation report), not computed by this engine. A public-company
 * market-data auto-feed for Black-Scholes-style inputs, and a private-company 409A
 * vendor marketplace, are both explicitly deferred, separate pieces of later work —
 * see the project notes. This module doesn't know or care where the number came from;
 * it only knows how to roll it forward correctly and book the resulting gain/loss. The
 * `source`/`hierarchyLevel` fields on each observation exist purely to preserve that
 * provenance for the ASC 820 disclosures that describe it, not to influence the math.
 *
 * SIGN CONVENTION — same as fxTranslation.ts, deliberately: `amount` is the P&L
 * impact, positive = loss (debit), negative = gain (credit). For a LIABILITY, fair
 * value increasing is a loss (you now owe more); for an ASSET, the same increase is a
 * gain. See fxTranslation.ts's doc comment for the full walk-through if that flip
 * isn't intuitive — it's the identical mechanism, just driven by a fair value
 * observation instead of an FX spot rate.
 *
 * ONE IMPORTANT DIFFERENCE FROM fxTranslation.ts: there, the very first row is always
 * a zero-impact "establish the opening balance" row, because inception and initial
 * recognition happen at the same instant — no time has elapsed, so there's nothing to
 * remeasure yet. Here, real time DOES elapse between `inceptionFairValue` (as of
 * issuance/bifurcation) and the first measurement date, so the first period's
 * gain/loss is a genuine, recognizable remeasurement — not a placeholder.
 */

export interface FairValueObservation {
  /** Must equal the `end` of the period this observation belongs to — see the
   * per-period validation in `buildFairValueRemeasurementSchedule`. */
  date: ISODate;
  fairValue: DecimalValue;
  /** Free-form provenance ("independent third-party valuation as of 12/31/2025",
   * "internal Black-Scholes model") — disclosure-only, carried through to `meta`,
   * never used in the calculation. Worth recording at entry time regardless, since
   * it's much harder to reconstruct later than to capture now. */
  source?: string;
  /** ASC 820 fair value hierarchy level (1, 2, or 3) — same disclosure-only purpose. */
  hierarchyLevel?: 1 | 2 | 3;
}

export interface FairValueRemeasurementInputs {
  inceptionDate: ISODate;
  inceptionFairValue: DecimalValue;
  /** Chronological, one entry per period passed to the schedule builder. */
  observations: FairValueObservation[];
  /** Which ASC guidance is the reason this particular instrument is fair-valued each
   * period — the roll-forward math is identical regardless, but the citation matters
   * for the audit trail. Common answers: "ASC 815-40 (bifurcated embedded derivative /
   * liability-classified warrant, remeasured through earnings)", "ASC 480-10-35
   * (mandatorily redeemable financial instrument)", "ASC 825-10-25 (fair value option
   * election)". Defaults to a generic ASC 820 citation if omitted — always better to
   * pass the specific reason. */
  ascReference?: string;
}

export function buildFairValueRemeasurementSchedule(
  inputs: FairValueRemeasurementInputs,
  instrumentKind: MonetaryItemKind,
  periods: Period[]
): ScheduleRow[] {
  if (inputs.observations.length !== periods.length) {
    throw new Error("observations must have exactly one entry per period (one fair value measurement per period end)");
  }
  const ascReference = inputs.ascReference ?? "ASC 820 (fair value remeasurement)";

  let priorFairValue = new Decimal(inputs.inceptionFairValue);
  let priorMeasurementDate = inputs.inceptionDate;

  return periods.map((p, i) => {
    const obs = inputs.observations[i];
    if (obs.date !== p.end) {
      throw new Error(
        `Observation ${i} ("${p.label}") is dated ${obs.date}, but the period ends ${p.end} — observations must be dated to their own period's end`
      );
    }
    const newFairValue = new Decimal(obs.fairValue);
    const delta = newFairValue.minus(priorFairValue);
    // See the module doc comment for the full sign-convention walk-through.
    const amount = instrumentKind === "liability" ? delta : delta.negated();

    const row: ScheduleRow = {
      periodStart: p.start,
      periodEnd: p.end,
      label: p.label,
      amount,
      endingBalance: newFairValue,
      meta: {
        ascReference,
        priorFairValue: priorFairValue.toFixed(2),
        newFairValue: newFairValue.toFixed(2),
        priorMeasurementDate,
        source: obs.source,
        hierarchyLevel: obs.hierarchyLevel,
      },
    };
    priorFairValue = newFairValue;
    priorMeasurementDate = obs.date;
    return row;
  });
}

/** Books one remeasurement row. `instrumentAccountName` is required rather than
 * defaulted because the correct balance-sheet line genuinely varies by instrument
 * ("Warrant Liability", "Contingent Consideration Liability", "Bifurcated Derivative
 * Liability", "Mandatorily Redeemable Preferred Stock") and guessing one would be
 * worse than forcing the caller to say which it is. `instrumentKind` must match
 * whatever was passed to `buildFairValueRemeasurementSchedule` for this same
 * instrument — it isn't recoverable from the row alone, the same limitation
 * `fxRemeasurementEntry` documents for the same reason. */
export function fairValueRemeasurementEntry(
  row: ScheduleRow,
  instrumentKind: MonetaryItemKind,
  instrumentAccountName: string,
  gainLossAccountName = "Change in Fair Value of Liability"
): JournalEntry {
  const magnitude = row.amount.abs();

  // Positive (or zero) = loss: debit the loss account, credit the instrument account —
  // whether that credit means "the liability grew" or "the asset shrank" depends on
  // instrumentKind, but the debit/credit side is the same either way. Negative = gain:
  // the mirror image. Identical logic to fxRemeasurementEntry, by design.
  const lines = row.amount.isNegative()
    ? [
        { account: instrumentAccountName, debit: magnitude },
        { account: gainLossAccountName, credit: magnitude },
      ]
    : [
        { account: gainLossAccountName, debit: magnitude },
        { account: instrumentAccountName, credit: magnitude },
      ];

  const entry: JournalEntry = {
    date: row.periodEnd,
    description: `Fair value remeasurement — ${row.label}`,
    ascReference: (row.meta?.ascReference as string) ?? "ASC 820",
    currency: row.currency,
    lines,
  };
  assertBalanced(entry);
  return entry;
}
