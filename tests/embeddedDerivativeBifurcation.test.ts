import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEmbeddedConversionFeature } from "../src/lib/accounting/embeddedDerivativeBifurcation.js";
import { classifyWarrant } from "../src/lib/accounting/warrantAllocation.js";

test("classifyEmbeddedConversionFeature: a plain-vanilla fixed-for-fixed conversion feature is NOT_REQUIRED to bifurcate (the common real-world case)", () => {
  const result = classifyEmbeddedConversionFeature({
    netCashSettlementPossible: false,
    indexedToOwnStockOnly: true,
    hasDownRoundProtection: false,
  });
  assert.equal(result.outcome, "NOT_REQUIRED");
  assert.match(result.reason, /815-10-15-74/);
});

test("classifyEmbeddedConversionFeature: a net-cash-settlable conversion feature IS REQUIRED to bifurcate", () => {
  const result = classifyEmbeddedConversionFeature({
    netCashSettlementPossible: true,
    indexedToOwnStockOnly: true,
    hasDownRoundProtection: false,
  });
  assert.equal(result.outcome, "REQUIRED");
});

test("classifyEmbeddedConversionFeature: a conversion feature indexed to something other than the issuer's own stock IS REQUIRED to bifurcate", () => {
  const result = classifyEmbeddedConversionFeature({
    netCashSettlementPossible: false,
    indexedToOwnStockOnly: false,
    hasDownRoundProtection: false,
  });
  assert.equal(result.outcome, "REQUIRED");
});

test("classifyEmbeddedConversionFeature: down-round protection alone flags for REVIEW rather than an automatic answer", () => {
  const result = classifyEmbeddedConversionFeature({
    netCashSettlementPossible: false,
    indexedToOwnStockOnly: true,
    hasDownRoundProtection: true,
  });
  assert.equal(result.outcome, "REVIEW");
});

test("classifyEmbeddedConversionFeature: an instrument already at fair value through earnings is NOT_REQUIRED regardless of the other flags", () => {
  const result = classifyEmbeddedConversionFeature({
    netCashSettlementPossible: true, // would otherwise be REQUIRED
    indexedToOwnStockOnly: false,
    hasDownRoundProtection: true,
    hybridInstrumentAlreadyAtFairValueThroughEarnings: true,
  });
  assert.equal(result.outcome, "NOT_REQUIRED");
  assert.match(result.reason, /815-15-25-1\(c\)/);
});

test("classifyEmbeddedConversionFeature reuses classifyWarrant's exact classification, not a re-derived copy", () => {
  const inputs = { netCashSettlementPossible: false, indexedToOwnStockOnly: true, hasDownRoundProtection: false };
  const warrantResult = classifyWarrant(inputs);
  const conversionResult = classifyEmbeddedConversionFeature(inputs);
  assert.equal(warrantResult, "equity");
  assert.equal(conversionResult.outcome, "NOT_REQUIRED");

  const liabilityInputs = { netCashSettlementPossible: true, indexedToOwnStockOnly: true, hasDownRoundProtection: false };
  assert.equal(classifyWarrant(liabilityInputs), "liability");
  assert.equal(classifyEmbeddedConversionFeature(liabilityInputs).outcome, "REQUIRED");
});
