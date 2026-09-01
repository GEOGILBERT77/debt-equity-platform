import { Money, money, Decimal, DecimalValue } from "./types.js";

/**
 * ASC 470-20-25 relative fair value allocation: when debt is issued with detachable
 * warrants, total proceeds are split between the two components in proportion to
 * their standalone fair values (not their relative face/strike amounts). The debt
 * component's allocated amount, versus its face value, becomes the discount that
 * amortizes through debtAmortization.ts — this function only produces the split.
 */
export interface RelativeFairValueInputs {
  totalProceeds: DecimalValue;
  debtStandaloneFairValue: DecimalValue;
  warrantStandaloneFairValue: DecimalValue;
}

export interface RelativeFairValueAllocation {
  debtAllocation: Money;
  warrantAllocation: Money;
}

export function allocateRelativeFairValue(inputs: RelativeFairValueInputs): RelativeFairValueAllocation {
  const proceeds = new Decimal(inputs.totalProceeds);
  const debtFV = new Decimal(inputs.debtStandaloneFairValue);
  const warrantFV = new Decimal(inputs.warrantStandaloneFairValue);
  const totalFV = debtFV.plus(warrantFV);

  if (totalFV.lessThanOrEqualTo(0)) {
    throw new Error("Combined standalone fair value must be positive");
  }

  const debtAllocation = proceeds.times(debtFV).div(totalFV);
  // Assign the warrant the remainder rather than its own proportional calculation,
  // so the two allocations always sum to exactly totalProceeds with no rounding gap.
  const warrantAllocation = proceeds.minus(debtAllocation);

  return { debtAllocation: money(debtAllocation), warrantAllocation: money(warrantAllocation) };
}

/**
 * Simplified equity-vs-liability classification screen for a freestanding warrant
 * under ASC 480 / ASC 815-40. This is a triage heuristic, not a substitute for a full
 * indexation-and-settlement analysis — flag anything this function returns as
 * "liability" or "review" for a technical accounting review before relying on it, and
 * treat "equity" here as a starting hypothesis rather than a final answer. The point of
 * automating this at all is to make sure every warrant gets asked the right three
 * questions, not to remove judgment from an area that genuinely requires it.
 */
export interface WarrantClassificationInputs {
  netCashSettlementPossible: boolean; // can the holder or issuer demand net cash settlement?
  indexedToOwnStockOnly: boolean; // fixed-for-fixed: no variable strike, no FX/other index
  hasDownRoundProtection: boolean; // full-ratchet or weighted-average anti-dilution
}

export type WarrantClassification = "equity" | "liability" | "review";

export function classifyWarrant(inputs: WarrantClassificationInputs): WarrantClassification {
  if (inputs.netCashSettlementPossible) return "liability";
  if (!inputs.indexedToOwnStockOnly) return "liability";
  if (inputs.hasDownRoundProtection) return "review"; // ASU 2017-11 may still permit equity — needs judgment
  return "equity";
}
