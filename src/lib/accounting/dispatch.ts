import { ScheduleRow, JournalEntry, DecimalValue, ISODate } from "./types.js";
import { Period, buildAnnualPeriods } from "./dateMath.js";
import { InstrumentTimeline, recomputeSchedule } from "./modificationEngine.js";
import { buildServiceConditionSchedule, ServiceConditionGrant, Tranche } from "./vesting.js";
import { buildCashSettledSarSchedule, buildStockSettledSarSchedule, CashSettledSarGrant } from "./stockAppreciationRights.js";
import {
  classifyPreferredStock,
  buildMandatorilyRedeemablePreferredSchedule,
  buildMezzanineAccretionSchedule,
  PreferredStockClassificationInputs,
  MezzanineAccretionGrant,
  CumulativeDividendGrant,
} from "./preferredStock.js";
import { buildRepurchaseRightLapseSchedule } from "./restrictedStock.js";
import {
  buildEffectiveInterestSchedule,
  TermDebtInputs,
  buildPikSchedule,
  PikDebtInputs,
  buildRevolverSchedule,
  RevolverInputs,
} from "./debtAmortization.js";
import { buildConventionalConvertibleNoteSchedule, ConventionalConvertibleNoteInputs } from "./convertibleNote.js";
import { classifyWarrant, WarrantClassificationInputs } from "./warrantAllocation.js";
import {
  buildFairValueRemeasurementSchedule,
  fairValueRemeasurementEntry,
  FairValueRemeasurementInputs,
} from "./fairValueRemeasurement.js";
import {
  stockCompExpenseEntry,
  debtInterestExpenseEntry,
  revolverFeeExpenseEntry,
  sarLiabilityExpenseEntry,
  preferredStockAccretionEntry,
  restrictedStockEntry,
} from "./journalEntries.js";

/**
 * Maps an Instrument's `type` (the Prisma enum) to the engine function that knows how
 * to compute its schedule, and wires that function through the modification/replay
 * engine so every instrument type gets versioned-modification support for free —
 * nothing type-specific needs to know about InstrumentTimeline itself.
 *
 * SCOPE: STOCK_OPTION/RSU, TERM_LOAN, PIK_NOTE, REVOLVER, CONVERTIBLE_NOTE, WARRANT,
 * SAR, PREFERRED_STOCK, and RESTRICTED_STOCK are wired up here. COMMON_STOCK still has no periodic engine
 * (it never needed one — see capTable.ts's doc comment) and falls through to the
 * `default` case's error. The pattern to extend this dispatcher for a new type is
 * identical to the cases below.
 *
 * TERM_LOAN and CONVERTIBLE_NOTE both map to `buildEffectiveInterestSchedule`-family
 * functions — the level-yield, period-boundary-only model. `debtAmortization.ts` also
 * has a separate daily-basis accrual engine (`buildDailyAccrualSchedule`) for floating-
 * rate debt with mid-period rate resets or paydowns; it isn't wired into this
 * dispatcher because its input shape (`DailyAccrualDebtInputs` — rate segments, dated
 * principal events) is genuinely different from `TermDebtInputs`, not a variant of it.
 * The same limitation is why REVOLVER below only covers fee amortization, not interest
 * on the drawn balance — see `buildRevolverSchedule`'s doc comment. A composition
 * engine that adds drawn-balance interest on top of the fee streams now exists
 * (`buildCombinedRevolverSchedule`, v0.20.0) and is fully unit-tested, but isn't wired
 * in here yet either: `RevolverInputs`/`termsValidation.ts`'s validator would both need
 * a new `drawnBalance` field before a real instrument could carry this data
 * end-to-end — see that function's own doc comment for the exact remaining gap.
 *
 * WARRANT is the one case that isn't a straight `terms -> engine -> ScheduleRow[]` call,
 * because a warrant's accounting genuinely branches on its own classification:
 *   - "equity": the relative-fair-value allocation happens once, at issuance, as a
 *     journal entry — not a periodic schedule. This returns an empty schedule on
 *     purpose; there is nothing to remeasure or amortize period over period once a
 *     warrant is equity-classified.
 *   - "liability": the warrant is marked to fair value every period (ASC 815-40) until
 *     exercise/expiration, using the same engine already built for any other fair-
 *     value-through-earnings instrument (fairValueRemeasurement.ts).
 *   - "review": `classifyWarrant` deliberately refuses to guess when down-round
 *     protection is present (ASU 2017-11 may still permit equity, but that needs a
 *     human, not a heuristic) — this throws rather than silently picking a side.
 *
 * NO RUNTIME SHAPE VALIDATION: `terms` comes out of a JSON column as `unknown`, and
 * this function trusts it matches the shape the relevant engine function expects. Add a
 * schema validator (zod or similar) at this boundary before wiring real user input to
 * it — a malformed `terms` payload should produce a 400 with a clear message, not an
 * engine-internal exception.
 */
export type InstrumentTypeForDispatch =
  | "STOCK_OPTION"
  | "RSU"
  | "SAR"
  | "WARRANT"
  | "CONVERTIBLE_NOTE"
  | "TERM_LOAN"
  | "REVOLVER"
  | "PIK_NOTE"
  | "PREFERRED_STOCK"
  | "COMMON_STOCK"
  | "RESTRICTED_STOCK";

export interface TermVersionRecord {
  effectiveDate: string; // ISODate
  label: string;
  terms: unknown;
}

/**
 * The `terms` shape for a WARRANT instrument — the one type whose dispatch needs more
 * than "cast terms and call an engine function." `classification` is always required
 * (every warrant needs the ASC 480/815-40 triage run, even one you're confident is
 * equity-classified — see classifyWarrant's doc comment on why this isn't a rubber
 * stamp); `remeasurement` is only required when that classification comes back
 * "liability". `instrumentAccountName` names the balance-sheet liability account for
 * journalEntryForRow to post to (see fairValueRemeasurementEntry) — required for the
 * same reason it's a required, non-defaulted parameter there. `sharesIssuable` (the
 * number of shares the warrant is exercisable into) isn't used by anything in this
 * file — the P&L schedule/journal-entry logic above doesn't need it — but it's on this
 * type rather than invented as a separate one because capTable.ts's fully-diluted
 * rollup needs exactly this number, and a warrant's terms are the one place it
 * naturally lives. Optional because a warrant's schedule/journal entries compute fine
 * without it; the cap table rollup flags any warrant missing it as unsupported rather
 * than guessing.
 */
export interface WarrantInstrumentTerms {
  classification: WarrantClassificationInputs;
  remeasurement?: FairValueRemeasurementInputs;
  instrumentAccountName?: string;
  sharesIssuable?: DecimalValue;
}

/**
 * The `terms` shape for a SAR instrument — a discriminated union on `settlementType`,
 * the single fact that decides which of two genuinely different accounting models
 * applies (see stockAppreciationRights.ts's module doc comment for the full
 * ASC 718-10 vs. ASC 718-30 explanation). `equityTerms`/`cashTerms` are each exactly
 * the input shape their respective engine function expects — `ServiceConditionGrant`
 * (same type STOCK_OPTION/RSU use) for the stock-settled case, `CashSettledSarGrant`
 * for the cash-settled case.
 */
export type SarInstrumentTerms =
  | { settlementType: "STOCK"; equityTerms: ServiceConditionGrant }
  | { settlementType: "CASH"; cashTerms: CashSettledSarGrant };

/**
 * The `terms` shape for a PREFERRED_STOCK instrument — `classification` (the objective
 * ASC 480-10 facts, always required) is run through `classifyPreferredStock` at
 * compute time, the same "ask the facts, not the conclusion" design WARRANT already
 * uses for `classifyWarrant`. Which of `debtTerms`/`accretion` is required (or
 * whether neither produces a periodic schedule at all) depends on what that
 * classification comes back as — see preferredStock.ts's module doc comment for the
 * full explanation of each branch, including why `dividends` is accepted here for
 * completeness but NOT used by this file's getScheduleBuilder/journalEntryForRow.
 */
export interface PreferredStockInstrumentTerms {
  classification: PreferredStockClassificationInputs;
  /** Required when classification resolves to "liability" (mandatorily redeemable) —
   * the same TermDebtInputs shape TERM_LOAN uses (faceValue = mandatory redemption
   * amount, netProceeds = issuance proceeds, cashFlows = dividend payments treated as
   * interest cash flows). */
  debtTerms?: TermDebtInputs;
  /** Used when classification resolves to "mezzanine" AND a redemption date/value is
   * determinable. Omit for a mezzanine preferred with no fixed redemption terms yet
   * (a contingent event with no known date) or for permanent-equity preferred — either
   * way, there is no periodic schedule to compute (see the module doc comment). */
  accretion?: MezzanineAccretionGrant;
  /** Cumulative dividend terms, for a future disclosure-only view — see
   * preferredStock.ts's module doc comment for why this is accepted but not wired into
   * this dispatcher's schedule/journal-entry functions. */
  dividends?: CumulativeDividendGrant;
  /** v0.20.0 — as-converted share count for CAP TABLE purposes only (capTable.ts);
   * NOT used by this dispatcher's own schedule/journal-entry functions, the same
   * "accepted here, consumed elsewhere" shape `dividends` above already has. Omit
   * entirely for non-convertible preferred (most mandatorily-redeemable/liability
   * preferred has no conversion feature at all) — capTable.ts falls back to its
   * existing "unsupported, no conversion ratio modeled" flag when this is absent on a
   * mezzanine/permanent-equity preferred, same behavior as before this field existed. */
  conversionTerms?: PreferredConversionTerms;
}

/** How many PREFERRED shares are outstanding, and how many COMMON shares each one
 * converts into — the two numbers `capTable.ts` needs to compute an as-converted
 * share count for convertible preferred stock (ASC 260-10-45's two-class method uses
 * this same as-converted share count for participating-security EPS allocation, via
 * epsTwoClass.ts's `participatingClassAsConvertedShares` input — this is the one
 * place that number should be computed from, not re-derived separately). */
export interface PreferredConversionTerms {
  quantity: DecimalValue;
  /** Common shares issued per ONE preferred share on conversion. Most VC-backed
   * preferred converts 1:1 absent an anti-dilution adjustment; a ratio other than 1
   * usually means a down-round (broad-based weighted-average or full-ratchet)
   * adjustment has already been applied to it. */
  conversionRatio: DecimalValue;
}

/**
 * The `terms` shape for a RESTRICTED_STOCK instrument (early-exercised options and
 * restricted stock — see restrictedStock.ts's module doc comment for why these are
 * one type). ONE shared `tranches` array drives both halves of the accounting: the
 * compensation expense (via `buildServiceConditionSchedule` — literally the same
 * function STOCK_OPTION/RSU use, since the expense math is identical) and the
 * repurchase-right-lapse reclassification (via `buildRepurchaseRightLapseSchedule`),
 * so the two can never drift out of sync the way two separately-specified tranche
 * arrays could.
 */
export interface RestrictedStockInstrumentTerms {
  grantDate: ISODate;
  quantity: DecimalValue;
  /** Fair value at grant MINUS whatever price the holder paid, per unit — the
   * compensation expense basis (usually the full FMV for a nominal-price restricted
   * grant, or the Black-Scholes option value for an early-exercised option). */
  grantDateFairValuePerUnit: DecimalValue;
  /** What the holder actually paid per share — drives the liability-to-equity
   * reclassification amount, which is independent of the expense basis above. */
  purchasePricePerShare: DecimalValue;
  tranches: Tranche[];
  attributionMethod: "straight-line" | "graded";
}

// (Tranche is imported from vesting.js above rather than redefined here — the
// RESTRICTED_STOCK terms shape above intentionally reuses ServiceConditionGrant's
// tranches field type so the two schedules the RESTRICTED_STOCK case below builds from
// it can never disagree about tranche shape.)

/** Returns the engine function that knows how to build a schedule for this instrument
 * type — pulled out as its own export so correctionService.ts's `previewCorrection`
 * (which needs the raw builder, not a pre-run timeline) and
 * `computeScheduleForInstrument` below share exactly one place that knows this mapping. */
export function getScheduleBuilder(type: InstrumentTypeForDispatch): (terms: unknown, periods: Period[]) => ScheduleRow[] {
  switch (type) {
    case "STOCK_OPTION":
    case "RSU":
      return (terms, periods) => buildServiceConditionSchedule(terms as ServiceConditionGrant, periods);
    case "TERM_LOAN":
      return (terms, periods) => buildEffectiveInterestSchedule(terms as TermDebtInputs, periods);
    case "PIK_NOTE":
      return (terms, periods) => buildPikSchedule(terms as PikDebtInputs, periods);
    case "REVOLVER":
      return (terms, periods) => buildRevolverSchedule(terms as RevolverInputs, periods);
    case "CONVERTIBLE_NOTE":
      return (terms, periods) => buildConventionalConvertibleNoteSchedule(terms as ConventionalConvertibleNoteInputs, periods);
    case "SAR":
      return (terms, periods) => {
        const s = terms as SarInstrumentTerms;
        if (s.settlementType === "STOCK") {
          return buildStockSettledSarSchedule(s.equityTerms, periods);
        }
        return buildCashSettledSarSchedule(s.cashTerms, periods);
      };
    case "PREFERRED_STOCK":
      return (terms, periods) => {
        const p = terms as PreferredStockInstrumentTerms;
        const classification = classifyPreferredStock(p.classification);
        if (classification === "liability") {
          if (!p.debtTerms) {
            throw new Error(
              'This preferred stock classified as "liability" (mandatorily redeemable — ASC 480-10-25-4) but has no ' +
                "`debtTerms` — see PreferredStockInstrumentTerms in dispatch.ts."
            );
          }
          return buildMandatorilyRedeemablePreferredSchedule(p.debtTerms, periods);
        }
        if (classification === "mezzanine" && p.accretion) {
          return buildMezzanineAccretionSchedule(p.accretion, periods);
        }
        // Mezzanine with no determinable redemption terms yet, or permanent-equity
        // preferred: no periodic schedule to compute — see preferredStock.ts's module
        // doc comment. Empty schedule, same as an equity-classified WARRANT.
        return [];
      };
    case "RESTRICTED_STOCK":
      return (terms, periods) => {
        // Both schedules are built from the SAME `tranches` array (see
        // RestrictedStockInstrumentTerms's doc comment above), so they always come out
        // the same length — the merge below can zip them together by index rather than
        // needing to match rows up by date.
        const r = terms as RestrictedStockInstrumentTerms;
        const expenseRows = buildServiceConditionSchedule(r as ServiceConditionGrant, periods);
        const reclassRows = buildRepurchaseRightLapseSchedule(
          { quantity: r.quantity, purchasePricePerShare: r.purchasePricePerShare, tranches: r.tranches },
          periods
        );
        return expenseRows.map((row, i) => ({
          ...row,
          meta: {
            ...row.meta,
            repurchaseRightLapseAmount: reclassRows[i].amount.toString(),
            cumulativeReclassifiedToEquity: reclassRows[i].endingBalance?.toString(),
          },
        }));
      };
    case "WARRANT":
      return (terms, periods) => {
        const w = terms as WarrantInstrumentTerms;
        const classification = classifyWarrant(w.classification);
        if (classification === "review") {
          throw new Error(
            "This warrant's classification requires human review before a schedule can be computed " +
              "(down-round protection is present — ASU 2017-11 may still permit equity treatment, but " +
              "that needs a technical accounting judgment call, not this heuristic). See classifyWarrant's " +
              "doc comment in warrantAllocation.ts."
          );
        }
        if (classification === "equity") {
          // No periodic schedule for an equity-classified warrant — see this file's
          // WARRANT scope note above. The one-time issuance-date allocation
          // (allocateRelativeFairValue) is a separate, one-off journal entry, not a
          // per-period row.
          return [];
        }
        if (!w.remeasurement) {
          throw new Error(
            'This warrant classified as "liability" but has no `remeasurement` fair value observations — ' +
              "see FairValueRemeasurementInputs in fairValueRemeasurement.ts."
          );
        }
        const instrumentAccountName = w.instrumentAccountName ?? "Warrant Liability";
        return buildFairValueRemeasurementSchedule(w.remeasurement, "liability", periods).map((row) => ({
          ...row,
          meta: { ...row.meta, instrumentAccountName },
        }));
      };
    default:
      throw new Error(
        `No schedule engine wired up yet for instrument type "${type}" — see the SCOPE note in dispatch.ts for how to add one.`
      );
  }
}

export function computeScheduleForInstrument(
  type: InstrumentTypeForDispatch,
  termVersions: TermVersionRecord[],
  periods: Period[]
): ScheduleRow[] {
  if (termVersions.length === 0) {
    throw new Error("An instrument must have at least one term version to compute a schedule from");
  }
  const [first, ...rest] = termVersions;
  const builder = getScheduleBuilder(type);

  const timeline = new InstrumentTimeline<unknown>(first.terms, first.effectiveDate, first.label);
  for (const v of rest) timeline.applyModification(v.terms, v.effectiveDate, v.label);
  return recomputeSchedule(timeline, periods, builder);
}

/**
 * CORRECTNESS NOTE (found while building the front end, not caught by any existing
 * test — every existing test hands engines the correct full periods array directly,
 * bypassing the bug described here entirely): some schedule builders allocate a FIXED
 * TOTAL across whatever `periods` array they're given, with the remainder absorbed by
 * the LAST period in that array (see `allocateStraightLineByElapsedTime`'s doc comment
 * in allocation.ts — used by service-condition vesting's straight-line attribution and
 * by `buildDeferredFeeSchedule`/`buildRevolverFeeSchedule`). Those builders assume the
 * `periods` array you hand them spans the instrument's ENTIRE natural life
 * (grant-to-final-vest, or the fee's full amortization window) — if you instead
 * truncate `periods` at some interim cutoff (like "today," for a live preview), the
 * LAST period in that truncated array wrongly absorbs the ENTIRE remaining
 * not-yet-recognized amount, drastically overstating that period's expense. Concretely:
 * a 4-year, $24,000 grant, previewed 1.67 years in, should show roughly $9,986
 * cumulative recognized — building `periods` as `buildAnnualPeriods(issueDate, today)`
 * and feeding that straight to `computeScheduleForInstrument` instead shows the ENTIRE
 * $24,000 recognized, because the truncated array's last (partial, current) period
 * absorbs all $18,004 that hadn't actually been earned yet.
 *
 * `buildEffectiveInterestSchedule`/`buildPikSchedule`/`buildFairValueRemeasurementSchedule`
 * (TERM_LOAN, CONVERTIBLE_NOTE, PIK_NOTE, WARRANT) do NOT have this problem — each is a
 * period-by-period roll-forward where a given period's row depends only on the prior
 * period's ending balance, never on "how many periods come after this one," so handing
 * them a truncated `periods` array is completely safe (that's exactly how the live
 * preview is supposed to work for those types: compute only what's elapsed so far).
 *
 * `naturalScheduleEndDate` returns the true end of an instrument's allocation window
 * for the types that need one (from the LATEST term version's terms — a reasonable
 * simplification when an instrument has been modified more than once), or `null` for
 * every type that doesn't need special handling. `computeVisibleSchedule` is the
 * function every caller (the close route, the front end) should actually use instead
 * of calling `buildAnnualPeriods` + `computeScheduleForInstrument` directly: it always
 * computes against the FULL correct window, then filters the result down to whatever's
 * actually elapsed as of `through` — giving you a correct "as of today" (or "as of any
 * cutoff") view without ever corrupting the underlying allocation math.
 *
 * `buildVisiblePeriods` is the lower-level piece `computeVisibleSchedule` is built on,
 * exported separately for correctionService.ts's `previewCorrection` — that function
 * legitimately needs the raw `periods: Period[]` array itself (it runs the SAME
 * periods through two different timelines — original vs. corrected terms — using a raw
 * scheduleBuilder function, not the `(type, termVersions) -> filtered schedule` shape
 * `computeVisibleSchedule` returns), so it can't just call `computeVisibleSchedule` and
 * use the result directly. What it must NOT do is fall back to a naive
 * `buildAnnualPeriods(issueDate, through)` call to get that array, because that
 * reintroduces the exact truncation bug described above into the correction workflow:
 * if a correction's `through` (or, just as easily, the instrument's
 * already-closed-through cutoff) lands before the instrument's natural end, the
 * resulting periods array's last element would again wrongly absorb the entire
 * not-yet-earned remainder. `buildVisiblePeriods` gives correctionService.ts (and
 * close/route.ts, for a related but distinct reason below) a periods array that's
 * always extended out to the natural end first, so that never happens.
 *
 * `extraSplitBoundaries` on both functions exists for one specific, easy-to-miss
 * failure mode: closing (or previewing a correction for) the SAME instrument more than
 * once inside the same not-yet-complete natural period. `determineNewPeriods` in
 * closeService.ts (and `previewCorrection`'s own closed/original comparison) decides
 * what's "new" purely by comparing `periodEnd` against the previous cutoff — it has no
 * idea a period's `periodStart` might predate that cutoff too. If a second close's
 * `through` lands later in the same year as the first close, splitting only at the new
 * `through` produces a period spanning from the YEAR'S start (not the previous
 * close's cutoff) to the new `through` — which `determineNewPeriods` would then treat
 * as entirely new, re-booking everything already recognized in the first close on top
 * of the new amount. Passing the previous cutoff as an extra split boundary keeps that
 * exact date as a period edge across every recomputation, so only the true incremental
 * slice since the last close is ever produced. (This close-workflow idempotency
 * subtlety is independent of the remainder-absorption bug above; it exists as soon as
 * period boundaries are allowed to move between calls at all, which is inherent to
 * "close as of whatever date you ask for" rather than a fixed reporting calendar.)
 */
export function naturalScheduleEndDate(type: InstrumentTypeForDispatch, terms: unknown): ISODate | null {
  switch (type) {
    case "STOCK_OPTION":
    case "RSU": {
      const grant = terms as ServiceConditionGrant;
      if (!grant.tranches || grant.tranches.length === 0) return null;
      return grant.tranches.reduce((max, t) => (t.vestDate > max ? t.vestDate : max), grant.tranches[0].vestDate);
    }
    case "REVOLVER": {
      const r = terms as RevolverInputs;
      const ends: ISODate[] = [];
      if (r.commitmentFee) ends.push(r.commitmentFee.commitmentEnd);
      if (r.deferredFees) for (const f of r.deferredFees) ends.push(f.amortizationEnd);
      if (ends.length === 0) return null;
      return ends.reduce((max, d) => (d > max ? d : max));
    }
    case "SAR": {
      // Only the STOCK-settled branch needs this — it's a straight-line remainder-
      // allocation engine (buildServiceConditionSchedule) with the exact same
      // truncation hazard as STOCK_OPTION/RSU above. The CASH-settled branch is a
      // period-by-period fair-value roll-forward (like WARRANT's liability case,
      // TERM_LOAN, PIK_NOTE) with no fixed total to allocate, so it has no natural end
      // to report here — falls through to null, same as those types.
      const s = terms as SarInstrumentTerms;
      if (s.settlementType !== "STOCK") return null;
      const tranches = s.equityTerms.tranches;
      if (!tranches || tranches.length === 0) return null;
      return tranches.reduce((max, t) => (t.vestDate > max ? t.vestDate : max), tranches[0].vestDate);
    }
    case "PREFERRED_STOCK": {
      // Only the "mezzanine with a determinable redemption" branch uses the
      // remainder-allocation math (allocateStraightLineByElapsedTime, via
      // buildMezzanineAccretionSchedule) that this truncation-safety mechanism exists
      // for. The "liability" branch is a period-by-period effective-interest
      // roll-forward (like TERM_LOAN) with no fixed total to allocate, and there's no
      // schedule at all for the remaining cases — both correctly fall through to null.
      const p = terms as PreferredStockInstrumentTerms;
      if (!p || !p.classification) return null; // malformed/placeholder terms — nothing to derive an end date from
      const classification = classifyPreferredStock(p.classification);
      if (classification === "mezzanine" && p.accretion) return p.accretion.redemptionDate;
      return null;
    }
    case "RESTRICTED_STOCK": {
      // The expense half reuses buildServiceConditionSchedule — the exact same
      // straight-line/graded remainder-allocation engine STOCK_OPTION/RSU use — so it
      // has the identical truncation hazard and needs the identical fix: the latest
      // tranche vest date. (buildRepurchaseRightLapseSchedule, the OTHER half of this
      // instrument's schedule, has no such hazard — see restrictedStock.ts's trailing
      // note — but naturalScheduleEndDate only needs to report ONE end date per type,
      // and the expense engine's requirement is the binding one here since both halves
      // are built over the same `periods` array.)
      const r = terms as RestrictedStockInstrumentTerms;
      if (!r || !r.tranches || r.tranches.length === 0) return null;
      return r.tranches.reduce((max, t) => (t.vestDate > max ? t.vestDate : max), r.tranches[0].vestDate);
    }
    default:
      return null;
  }
}

/**
 * Splits any period in `periods` that `boundary` falls strictly inside into two
 * back-to-back periods at exactly `boundary` — a no-op for periods `boundary` doesn't
 * fall inside (already aligned, or elsewhere entirely). Needed because
 * `buildAnnualPeriods(issueDate, naturalEnd)` alone produces full calendar-year
 * periods with no boundary at `through` at all: if `through` lands mid-year, the
 * "current" year's row would otherwise span the WHOLE year (including months that
 * haven't happened yet), and get entirely filtered out by `computeVisibleSchedule`'s
 * `periodEnd <= through` check below — silently dropping everything actually earned
 * so far this year, not just the not-yet-earned remainder. Splitting first means the
 * elapsed slice of the current year survives that filter on its own.
 */
function splitPeriodsAt(periods: Period[], boundary: ISODate): Period[] {
  const result: Period[] = [];
  for (const p of periods) {
    if (boundary > p.start && boundary < p.end) {
      result.push({ label: `${p.label} (elapsed to date)`, start: p.start, end: boundary });
      result.push({ label: `${p.label} (remaining)`, start: boundary, end: p.end });
    } else {
      result.push(p);
    }
  }
  return result;
}

/**
 * Builds the periods array for "this instrument's schedule as visible as of `through`"
 * — extended out to the instrument's true natural end (so remainder-allocation engines
 * never see a truncated array) and split at `through` plus every date in
 * `extraSplitBoundaries` (so none of those cutoffs ever falls silently inside a single
 * period). See the big doc comment above `naturalScheduleEndDate` for why both of
 * these matter and who needs this directly (correctionService.ts) versus through
 * `computeVisibleSchedule` below.
 */
export function buildVisiblePeriods(
  type: InstrumentTypeForDispatch,
  termVersions: TermVersionRecord[],
  through: ISODate,
  extraSplitBoundaries: ISODate[] = []
): Period[] {
  if (termVersions.length === 0) {
    throw new Error("An instrument must have at least one term version to compute a schedule from");
  }
  const latestTerms = termVersions[termVersions.length - 1].terms;
  const naturalEnd = naturalScheduleEndDate(type, latestTerms);
  const candidateEnds = [through, ...extraSplitBoundaries];
  if (naturalEnd) candidateEnds.push(naturalEnd);
  const periodsEnd = candidateEnds.reduce((max, d) => (d > max ? d : max));

  const fullPeriods = buildAnnualPeriods(termVersions[0].effectiveDate, periodsEnd);
  let periods = fullPeriods;
  for (const boundary of [...extraSplitBoundaries, through]) {
    periods = splitPeriodsAt(periods, boundary);
  }
  return periods;
}

/**
 * Computes an instrument's schedule as it should actually appear as of `through`:
 * correct regardless of whether the underlying engine is remainder-allocation-based
 * (see the note above) or a period-by-period roll-forward. This is what
 * `computeScheduleForInstrument` + a manually-truncated `buildAnnualPeriods` call
 * should always be replaced with at every call site that means "give me the schedule
 * as of this date," rather than "give me the complete, all-future-periods-included
 * schedule." Pass `extraSplitBoundaries` (typically `[alreadyClosedThroughPeriodEnd]`)
 * when the caller also needs the result to line up cleanly with a previous cutoff —
 * see the note above on why close/route.ts needs this and correctionService.ts's
 * `previewCorrection` doesn't call this function directly but needs the exact same
 * `buildVisiblePeriods` underneath it.
 */
export function computeVisibleSchedule(
  type: InstrumentTypeForDispatch,
  termVersions: TermVersionRecord[],
  through: ISODate,
  extraSplitBoundaries: ISODate[] = []
): ScheduleRow[] {
  const periods = buildVisiblePeriods(type, termVersions, through, extraSplitBoundaries);
  const fullSchedule = computeScheduleForInstrument(type, termVersions, periods);
  return fullSchedule.filter((row) => row.periodEnd <= through);
}

/**
 * Maps an Instrument's `type` to the journal-entry mapper for one of its schedule
 * rows. Kept as a parallel dispatcher to `computeScheduleForInstrument` rather than
 * folded into it, because "compute the schedule" and "book it" are genuinely separate
 * steps in the close process below — a schedule can be previewed without ever
 * generating a journal entry from it.
 *
 * WARRANT rows carry `instrumentAccountName` in their own `meta` (stashed by
 * getScheduleBuilder above) rather than this function taking an extra parameter —
 * every other case here has the fixed `(type, row) => JournalEntry` shape, and reusing
 * `meta` (the same place termVersionLabel/ascReference/etc. already live) avoids a
 * one-off signature just for this instrument type.
 */
export function journalEntryForRow(type: InstrumentTypeForDispatch, row: ScheduleRow): JournalEntry {
  switch (type) {
    case "STOCK_OPTION":
    case "RSU":
      return stockCompExpenseEntry(row);
    case "TERM_LOAN":
    case "PIK_NOTE":
    case "CONVERTIBLE_NOTE":
      return debtInterestExpenseEntry(row);
    case "REVOLVER":
      return revolverFeeExpenseEntry(row);
    case "SAR":
      // Branches on the discriminator each SAR builder stamps into meta.settlementType
      // (see stockAppreciationRights.ts) rather than needing `terms` here — same
      // "meta carries what the mapper needs" pattern WARRANT uses for
      // instrumentAccountName below.
      return row.meta?.settlementType === "CASH" ? sarLiabilityExpenseEntry(row) : stockCompExpenseEntry(row);
    case "PREFERRED_STOCK":
      // Branches on the classification discriminator both PREFERRED_STOCK builders
      // stamp into meta (see preferredStock.ts) — same pattern as SAR's
      // settlementType and WARRANT's instrumentAccountName above. The "liability"
      // branch reuses debtInterestExpenseEntry directly (mandatorily redeemable
      // preferred IS debt, accounting-wise); anything else here is the mezzanine
      // accretion entry.
      return row.meta?.classification === "liability" ? debtInterestExpenseEntry(row) : preferredStockAccretionEntry(row);
    case "RESTRICTED_STOCK":
      return restrictedStockEntry(row);
    case "WARRANT": {
      const instrumentAccountName = (row.meta?.instrumentAccountName as string) ?? "Warrant Liability";
      return fairValueRemeasurementEntry(row, "liability", instrumentAccountName);
    }
    default:
      throw new Error(
        `No journal-entry mapper wired up yet for instrument type "${type}" — see dispatch.ts's SCOPE note.`
      );
  }
}
