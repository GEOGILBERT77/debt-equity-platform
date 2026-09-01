import { Decimal, DecimalValue, Money } from "./types.js";

/**
 * Exit / liquidation waterfall — how a sale or liquidation's proceeds actually split
 * across a preferred/common stack. Nothing else in this codebase computes this today:
 * `capTable.ts` deliberately stops at "how many fully-diluted shares does each
 * instrument represent" and its own doc comment (and `preferredStock.ts`'s SCOPE note)
 * says liquidation preference, seniority, and participation are NOT modeled anywhere
 * yet. This module is new, standalone waterfall math — it is NOT wired to
 * `PreferredStockInstrumentTerms` (that shape has no seniority/participation/
 * liquidation-preference-multiple fields to read), the same way `taxElections.ts`'s
 * QSBS/OID calculators take an explicit, ad hoc input object rather than reading a
 * stored instrument. Wiring this to real persisted preferred-stock terms is future
 * work that starts with extending `PreferredStockInstrumentTerms`, not something this
 * module does on its own.
 *
 * METHODOLOGY, STATED PLAINLY (this is a simplified, standard-practice model, not the
 * one true legally-exact answer for every charter's actual conversion mechanics):
 *
 *  1. CONVERSION TEST for a non-participating class: it converts to common (foregoing
 *     its stated preference) exactly when its pro-rata share of the TOTAL exit
 *     proceeds, computed as if every class (including itself) were already common,
 *     exceeds its stated per-share preference. This is the standard simplified
 *     "compare against fully-as-converted" test used by most cap-table modeling
 *     tools. It is NOT a full simultaneous-equilibrium solve across multiple
 *     non-participating classes deciding at once — in a stack with several
 *     non-participating series close to their respective thresholds, the true
 *     game-theoretic outcome can differ at the margin. Flagged here rather than
 *     silently presented as exact.
 *
 *  2. SENIORITY: preferences are paid strictly in `seniorityRank` order (lower number
 *     = paid first), fully satisfying one rank before the next rank sees anything.
 *     Classes that share a rank split pro-rata by their own preference amount if the
 *     remaining proceeds can't cover the whole rank.
 *
 *  3. PARTICIPATION: a `participating: true` class always takes its preference AND
 *     shares pro-rata in whatever residual proceeds are left after every
 *     preference-taking class (across all ranks) has been paid — that's what
 *     "participating" means, so unlike a non-participating class it never "converts
 *     away" from its preference.
 *
 *  4. PARTICIPATION CAP: if `participationCap` (a total-return-per-share ceiling,
 *     inclusive of the preference already paid) is set and the class's uncapped total
 *     (preference + pro-rata participation) would exceed `participationCap * shares`,
 *     this function clamps that class's payout down to the cap. DELIBERATE
 *     SIMPLIFICATION: the clawed-back excess is NOT reallocated to the other
 *     participants — `undistributed` in the result carries it instead. Many real
 *     charters instead require redistributing that excess (an iterative computation)
 *     or force the capped class to choose the greater of [capped participating] vs.
 *     [fully-as-converted-to-common] — neither refinement is implemented here. A
 *     result with `undistributed > 0` is this function telling you a cap bit and
 *     nothing rebalanced afterward — do not treat `undistributed` as an error.
 *
 *  5. INSUFFICIENT PROCEEDS: if total preferences exceed exit proceeds, money runs out
 *     partway through the seniority stack (see #2) and common/converted/participating
 *     residual holders can legitimately receive $0 — a real, common "underwater" exit
 *     outcome, not a bug.
 */

export interface WaterfallClassInput {
  id: string;
  name: string;
  /** Lower = paid first. Common should use a rank higher than every preferred class
   * (or simply carry a 0 `liquidationPreferencePerShare`, which makes its rank
   * irrelevant since it never receives a step-1 preference payment either way). */
  seniorityRank: number;
  /** As-converted common-equivalent share count for this class. */
  shares: DecimalValue;
  /** 0 for common / any class with no stated preference. */
  liquidationPreferencePerShare: DecimalValue;
  participating: boolean;
  /** Total return per share (preference + participation), inclusive. Ignored for a
   * non-participating class (it has no participation to cap). Undefined = uncapped. */
  participationCap?: DecimalValue;
}

export interface WaterfallClassResult {
  id: string;
  name: string;
  shares: Decimal;
  /** Did a non-participating class convert to common instead of taking its stated
   * preference? Always false for common (liquidationPreferencePerShare === 0) and for
   * participating classes (they never convert away — see methodology note #3). */
  converted: boolean;
  /** True only when a participating class's payout was reduced by its
   * `participationCap` — see methodology note #4. */
  cappedByParticipation: boolean;
  proceedsFromPreference: Money;
  proceedsFromResidual: Money;
  totalProceeds: Money;
  perShareProceeds: Money;
}

export interface ExitWaterfallResult {
  exitProceeds: Money;
  classResults: WaterfallClassResult[];
  totalDistributed: Money;
  /** Proceeds a participation cap clawed back and did NOT reallocate — see
   * methodology note #4. Zero in the overwhelmingly common case of no caps, or caps
   * that never bind. */
  undistributed: Money;
}

export function buildExitWaterfall(exitProceeds: DecimalValue, classes: WaterfallClassInput[]): ExitWaterfallResult {
  const proceeds = new Decimal(exitProceeds);
  const totalFullyDilutedShares = classes.reduce((sum, c) => sum.plus(c.shares), new Decimal(0));

  // Step 1: decide, for each non-participating class with a nonzero preference,
  // whether it converts (methodology note #1). Participating classes and common
  // (liquidationPreferencePerShare === 0) never go through this test.
  type Working = WaterfallClassInput & { convertsToCommon: boolean };
  const working: Working[] = classes.map((c) => {
    const pref = new Decimal(c.liquidationPreferencePerShare);
    if (c.participating || pref.isZero()) {
      return { ...c, convertsToCommon: pref.isZero() }; // common "converts" trivially; participating never does
    }
    const asConvertedPerShare = totalFullyDilutedShares.isZero() ? new Decimal(0) : proceeds.div(totalFullyDilutedShares);
    return { ...c, convertsToCommon: asConvertedPerShare.greaterThan(pref) };
  });

  // Step 2: pay preferences, strictly in seniority-rank order, to every class that is
  // still taking its preference (non-converting non-participating classes, and every
  // participating class).
  const preferenceOwed = new Map<string, Decimal>();
  for (const c of working) {
    if (c.convertsToCommon) {
      preferenceOwed.set(c.id, new Decimal(0));
    } else {
      preferenceOwed.set(c.id, new Decimal(c.liquidationPreferencePerShare).times(c.shares));
    }
  }

  const ranksAscending = [...new Set(working.map((c) => c.seniorityRank))].sort((a, b) => a - b);
  const preferencePaid = new Map<string, Decimal>(working.map((c) => [c.id, new Decimal(0)]));
  let remaining = proceeds;

  for (const rank of ranksAscending) {
    if (remaining.lessThanOrEqualTo(0)) break;
    const classesInRank = working.filter((c) => c.seniorityRank === rank);
    const totalDueInRank = classesInRank.reduce((sum, c) => sum.plus(preferenceOwed.get(c.id)!), new Decimal(0));
    if (totalDueInRank.isZero()) continue;

    if (remaining.greaterThanOrEqualTo(totalDueInRank)) {
      for (const c of classesInRank) preferencePaid.set(c.id, preferenceOwed.get(c.id)!);
      remaining = remaining.minus(totalDueInRank);
    } else {
      // Insufficient proceeds for this whole rank — split pro-rata by each class's own
      // preference amount (methodology note #2).
      for (const c of classesInRank) {
        const due = preferenceOwed.get(c.id)!;
        const share = due.isZero() ? new Decimal(0) : remaining.times(due).div(totalDueInRank);
        preferencePaid.set(c.id, share);
      }
      remaining = new Decimal(0);
    }
  }

  // Step 3: the residual pool — common, converted-to-common preferred, and every
  // participating class not already excluded — shares whatever is left, pro-rata by
  // shares.
  const residualPoolMembers = working.filter((c) => c.convertsToCommon || c.participating);
  const residualPoolShares = residualPoolMembers.reduce((sum, c) => sum.plus(c.shares), new Decimal(0));
  const perShareResidual = residualPoolShares.isZero() || remaining.isZero() ? new Decimal(0) : remaining.div(residualPoolShares);

  // Step 4: assemble results, applying participation caps (methodology note #4) —
  // clawed-back excess is tracked in `undistributed`, never silently redistributed.
  let undistributed = new Decimal(0);
  const classResults: WaterfallClassResult[] = working.map((c) => {
    const fromPreference = preferencePaid.get(c.id)!;
    const inResidualPool = c.convertsToCommon || c.participating;
    let fromResidual = inResidualPool ? perShareResidual.times(c.shares) : new Decimal(0);
    let cappedByParticipation = false;

    if (c.participating && c.participationCap !== undefined) {
      const capTotal = new Decimal(c.participationCap).times(c.shares);
      const uncappedTotal = fromPreference.plus(fromResidual);
      if (uncappedTotal.greaterThan(capTotal)) {
        const allowedResidual = Decimal.max(new Decimal(0), capTotal.minus(fromPreference));
        undistributed = undistributed.plus(fromResidual.minus(allowedResidual));
        fromResidual = allowedResidual;
        cappedByParticipation = true;
      }
    }

    const totalProceeds = fromPreference.plus(fromResidual);
    const shares = new Decimal(c.shares);
    return {
      id: c.id,
      name: c.name,
      shares,
      converted: c.convertsToCommon && !new Decimal(c.liquidationPreferencePerShare).isZero(),
      cappedByParticipation,
      proceedsFromPreference: fromPreference,
      proceedsFromResidual: fromResidual,
      totalProceeds,
      perShareProceeds: shares.isZero() ? new Decimal(0) : totalProceeds.div(shares),
    };
  });

  const totalDistributed = classResults.reduce((sum, r) => sum.plus(r.totalProceeds), new Decimal(0));

  return { exitProceeds: proceeds, classResults, totalDistributed, undistributed };
}
