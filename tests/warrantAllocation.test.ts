import test from "node:test";
import assert from "node:assert/strict";
import { allocateRelativeFairValue, classifyWarrant } from "../src/lib/accounting/warrantAllocation.js";

/**
 * GOLDEN SCENARIO (ASC 470-20-25 relative fair value method): $500,000 of total
 * proceeds from debt issued with detachable warrants. Standalone fair value of the
 * debt component alone (without warrants) is $460,000; standalone fair value of the
 * warrants alone is $60,000.
 *
 * Hand check: total standalone FV = 460,000 + 60,000 = 520,000
 *   debt allocation    = 500,000 * (460,000/520,000) = 500,000 * 0.884615... = $442,307.69
 *   warrant allocation = 500,000 - 442,307.69 (remainder, not its own rounded calc)
 *                       = $57,692.31
 * The two must always sum to exactly $500,000.00 — that's the point of computing the
 * warrant side as a remainder rather than its own proportional rounding.
 */
test("relative fair value allocation splits proceeds proportionally and sums back exactly", () => {
  const result = allocateRelativeFairValue({
    totalProceeds: 500000,
    debtStandaloneFairValue: 460000,
    warrantStandaloneFairValue: 60000,
  });

  assert.equal(result.debtAllocation.toFixed(2), "442307.69");
  assert.equal(result.warrantAllocation.toFixed(2), "57692.31");
  assert.equal(result.debtAllocation.plus(result.warrantAllocation).toFixed(2), "500000.00");
});

test("warrant classification: net-cash-settlement possibility forces liability regardless of other terms", () => {
  const result = classifyWarrant({
    netCashSettlementPossible: true,
    indexedToOwnStockOnly: true,
    hasDownRoundProtection: false,
  });
  assert.equal(result, "liability");
});

test("warrant classification: variable indexation (not fixed-for-fixed) forces liability", () => {
  const result = classifyWarrant({
    netCashSettlementPossible: false,
    indexedToOwnStockOnly: false,
    hasDownRoundProtection: false,
  });
  assert.equal(result, "liability");
});

test("warrant classification: down-round protection alone flags for review, not an automatic answer", () => {
  const result = classifyWarrant({
    netCashSettlementPossible: false,
    indexedToOwnStockOnly: true,
    hasDownRoundProtection: true,
  });
  assert.equal(result, "review");
});

test("warrant classification: a clean fixed-for-fixed warrant with no disqualifying terms is equity", () => {
  const result = classifyWarrant({
    netCashSettlementPossible: false,
    indexedToOwnStockOnly: true,
    hasDownRoundProtection: false,
  });
  assert.equal(result, "equity");
});
