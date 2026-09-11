import { Decimal, DecimalValue, Money, money } from "./types.js";
import { buildExitWaterfall, WaterfallClassInput, WaterfallClassResult } from "./exitWaterfall.js";

/**
 * v0.32.0 — the two analyses George specifically asked for after seeing what Carta and
 * Pulley ship on top of a plain "type in an exit value, see the split" waterfall
 * calculator: sensitivity analysis (a payout curve for every class across a RANGE of
 * exit values, not a handful of hand-picked scenarios) and breakpoint analysis (the
 * specific exit values at which a class's behavior actually changes — when it starts
 * seeing any money at all, when a non-participating class flips from taking its
 * preference to converting to common, and when a participation cap kicks in).
 *
 * DELIBERATELY BUILT ON TOP OF `buildExitWaterfall`, NOT A SEPARATE RE-DERIVATION: a
 * hand-derived closed-form breakpoint formula would have to reproduce the seniority/
 * conversion/participation/cap logic a second time, and a subtle mismatch between that
 * formula and the actual waterfall (a tie in seniority rank, an unusual combination of
 * caps) would silently produce a wrong breakpoint that looks plausible. Every number
 * this module returns instead comes from calling the same, already-tested
 * `buildExitWaterfall` — sensitivity analysis just calls it many times across a range;
 * breakpoint analysis bisection-searches for the exact exit value where one of its
 * outputs flips. Slower than a closed-form formula, but it can never drift from what
 * the waterfall itself actually does.
 */

export interface SensitivityPoint {
  exitProceeds: Money;
  classResults: WaterfallClassResult[];
}

/**
 * Runs the SAME class stack at `steps + 1` evenly spaced exit values from `min` to
 * `max` (inclusive of both ends) — the data behind "a line graph of payouts by class
 * across a range of exit values," Carta's own description of their sensitivity view.
 * Each point is an entirely independent `buildExitWaterfall` call, same reasoning
 * `buildExitWaterfallScenarios` already documents: the conversion test depends on the
 * exit value itself, so points can't share intermediate work.
 */
export function buildWaterfallSensitivity(
  classes: WaterfallClassInput[],
  range: { min: DecimalValue; max: DecimalValue; steps: number }
): SensitivityPoint[] {
  if (!Number.isInteger(range.steps) || range.steps < 1) {
    throw new Error("range.steps must be a positive integer");
  }
  const min = new Decimal(range.min);
  const max = new Decimal(range.max);
  if (max.lessThan(min)) {
    throw new Error("range.max must be >= range.min");
  }
  const span = max.minus(min);
  const points: SensitivityPoint[] = [];
  for (let i = 0; i <= range.steps; i++) {
    const exitProceeds = min.plus(span.times(i).div(range.steps));
    const result = buildExitWaterfall(exitProceeds, classes);
    points.push({ exitProceeds: result.exitProceeds, classResults: result.classResults });
  }
  return points;
}

export interface ClassBreakpoints {
  id: string;
  name: string;
  /** Smallest exit value (within the searched range) at which this class's total
   * proceeds first become greater than zero — "what exit valuation would this class
   * need for it to participate in payouts at all," Carta's own framing. Null if it
   * still receives nothing even at `maxExitProceeds` (raise the search ceiling) or
   * already receives something at $0 (only possible in a degenerate all-zero-exit
   * edge case). */
  breakevenExitProceeds: Money | null;
  /** Only computed for a non-participating class with a nonzero stated preference —
   * the exit value at which it flips from taking that preference to converting to
   * common (see exitWaterfall.ts methodology note #1). Always null for a participating
   * class or a zero-preference (common) class, neither of which ever makes this
   * decision; null for any other class if it doesn't convert within the searched
   * range. */
  conversionBreakpointExitProceeds: Money | null;
  /** Only computed for a participating class with a `participationCap` set — the exit
   * value at which its uncapped total (preference + pro-rata residual) first exceeds
   * the cap. Null if not applicable, or if the cap never binds within the searched
   * range. */
  participationCapBreakpointExitProceeds: Money | null;
}

const DEFAULT_BISECTION_ITERATIONS = 60; // 2^-60 of the search range — far finer than a cent on any realistic exit value.

/** Bisection-searches [0, maxExitProceeds] for the smallest exit value at which
 * `predicate` first becomes true for the named class's result — valid ONLY because
 * every predicate this module uses is monotonic non-decreasing in exit proceeds (see
 * the module doc comment: once a class starts receiving money, converts, or hits its
 * cap, it stays that way at every higher exit value — verified case-by-case in the
 * three call sites below, not assumed in general). */
function findBreakpoint(
  classes: WaterfallClassInput[],
  classId: string,
  maxExitProceeds: Decimal,
  predicate: (result: WaterfallClassResult) => boolean,
  iterations = DEFAULT_BISECTION_ITERATIONS
): Decimal | null {
  const resultAt = (proceeds: Decimal) => {
    const r = buildExitWaterfall(proceeds, classes).classResults.find((c) => c.id === classId);
    if (!r) throw new Error(`Class "${classId}" not found in waterfall result — check the class list passed in.`);
    return r;
  };

  if (predicate(resultAt(new Decimal(0)))) return new Decimal(0);
  if (!predicate(resultAt(maxExitProceeds))) return null; // never flips within the searched range

  let lo = new Decimal(0);
  let hi = maxExitProceeds;
  for (let i = 0; i < iterations; i++) {
    const mid = lo.plus(hi).div(2);
    if (predicate(resultAt(mid))) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}

/**
 * Finds, for every class in the stack, the exit-value thresholds at which its
 * treatment changes — see `ClassBreakpoints`'s field-level doc comments for exactly
 * what each one means. `maxExitProceeds` is a search ceiling, not a real assumption
 * about the entity's value: pick something comfortably above the highest exit value
 * you'd ever plausibly model (the report page defaults this to several multiples of
 * the largest scenario the caller already entered).
 */
export function findWaterfallBreakpoints(classes: WaterfallClassInput[], maxExitProceeds: DecimalValue): ClassBreakpoints[] {
  const max = new Decimal(maxExitProceeds);
  if (max.lessThanOrEqualTo(0)) {
    throw new Error("maxExitProceeds must be positive");
  }

  return classes.map((c) => {
    const breakeven = findBreakpoint(classes, c.id, max, (r) => r.totalProceeds.greaterThan(0));

    const pref = new Decimal(c.liquidationPreferencePerShare);
    let conversionBreakpoint: Decimal | null = null;
    if (!c.participating && pref.greaterThan(0)) {
      // Monotonic: as exit proceeds rise, the as-converted value/share
      // (proceeds ÷ total FD shares) rises too, so once it exceeds this class's own
      // preference/share it stays exceeded — `converted` flips false->true at most once.
      conversionBreakpoint = findBreakpoint(classes, c.id, max, (r) => r.converted === true);
    }

    let participationCapBreakpoint: Decimal | null = null;
    if (c.participating && c.participationCap !== undefined && c.participationCap !== null) {
      // Monotonic: this class's uncapped total (preference + pro-rata residual) is
      // non-decreasing in exit proceeds, so once it exceeds a fixed cap it stays
      // exceeded — `cappedByParticipation` flips false->true at most once.
      participationCapBreakpoint = findBreakpoint(classes, c.id, max, (r) => r.cappedByParticipation === true);
    }

    return {
      id: c.id,
      name: c.name,
      breakevenExitProceeds: breakeven !== null ? money(breakeven) : null,
      conversionBreakpointExitProceeds: conversionBreakpoint !== null ? money(conversionBreakpoint) : null,
      participationCapBreakpointExitProceeds: participationCapBreakpoint !== null ? money(participationCapBreakpoint) : null,
    };
  });
}
