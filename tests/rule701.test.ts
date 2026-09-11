import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRule701GrantSalesPrice, computeRule701RollingWindow, Rule701Grant } from "../src/lib/accounting/rule701.js";

test("computeRule701GrantSalesPrice: for an option, takes the GREATER of aggregate exercise price and aggregate FMV", () => {
  const cheapExercise: Rule701Grant = {
    id: "g1",
    type: "STOCK_OPTION",
    grantDate: "2026-01-01",
    quantity: 10000,
    exercisePricePerUnit: 1, // aggregate exercise = $10,000
    fairMarketValuePerUnitAtGrant: 5, // aggregate FMV = $50,000 -> this should govern
  };
  const result = computeRule701GrantSalesPrice(cheapExercise);
  assert.equal(result.aggregateSalesPrice.toFixed(2), "50000.00");
  assert.equal(result.basis, "fair market value");
});

test("computeRule701GrantSalesPrice: an option with exercise price ABOVE FMV uses exercise price instead", () => {
  const result = computeRule701GrantSalesPrice({
    id: "g2",
    type: "STOCK_OPTION",
    grantDate: "2026-01-01",
    quantity: 1000,
    exercisePricePerUnit: 10, // aggregate exercise = $10,000 -> governs
    fairMarketValuePerUnitAtGrant: 2, // aggregate FMV = $2,000
  });
  assert.equal(result.aggregateSalesPrice.toFixed(2), "10000.00");
  assert.equal(result.basis, "exercise price");
});

test("computeRule701GrantSalesPrice: an option missing exercisePricePerUnit throws rather than silently defaulting", () => {
  assert.throws(() =>
    computeRule701GrantSalesPrice({
      id: "g3",
      type: "STOCK_OPTION",
      grantDate: "2026-01-01",
      quantity: 1000,
      fairMarketValuePerUnitAtGrant: 2,
    })
  );
});

test("computeRule701GrantSalesPrice: RSU/restricted stock/common stock always use aggregate FMV, no exercise-price comparison", () => {
  for (const type of ["RSU", "RESTRICTED_STOCK", "COMMON_STOCK"] as const) {
    const result = computeRule701GrantSalesPrice({
      id: `g-${type}`,
      type,
      grantDate: "2026-01-01",
      quantity: 100,
      fairMarketValuePerUnitAtGrant: 3,
    });
    assert.equal(result.aggregateSalesPrice.toFixed(2), "300.00");
    assert.equal(result.basis, "fair market value");
  }
});

test("computeRule701RollingWindow: only counts grants within the trailing 12 months of asOfDate, both ends inclusive", () => {
  const grants: Rule701Grant[] = [
    { id: "in-window-start", type: "RSU", grantDate: "2025-09-11", quantity: 1000, fairMarketValuePerUnitAtGrant: 1 }, // exactly on the window start boundary
    { id: "in-window-middle", type: "RSU", grantDate: "2026-03-01", quantity: 1000, fairMarketValuePerUnitAtGrant: 1 },
    { id: "on-as-of-date", type: "RSU", grantDate: "2026-09-11", quantity: 1000, fairMarketValuePerUnitAtGrant: 1 }, // exactly on asOfDate
    { id: "too-old", type: "RSU", grantDate: "2025-09-10", quantity: 1000, fairMarketValuePerUnitAtGrant: 1 }, // one day before the window
    { id: "in-the-future", type: "RSU", grantDate: "2026-09-12", quantity: 1000, fairMarketValuePerUnitAtGrant: 1 }, // one day after asOfDate
  ];
  const result = computeRule701RollingWindow({ asOfDate: "2026-09-11", grants });
  const includedIds = result.grantsInWindow.map((g) => g.grantId);
  assert.deepEqual(includedIds, ["in-window-start", "in-window-middle", "on-as-of-date"]);
  assert.equal(result.aggregateSalesPriceInWindow.toFixed(2), "3000.00");
  assert.equal(result.windowStart, "2025-09-11");
});

test("computeRule701RollingWindow: flags exceeding the $10M disclosure threshold and reports negative headroom", () => {
  const grants: Rule701Grant[] = [
    { id: "big-grant", type: "RSU", grantDate: "2026-01-01", quantity: 2_000_000, fairMarketValuePerUnitAtGrant: 6 }, // $12,000,000
  ];
  const result = computeRule701RollingWindow({ asOfDate: "2026-09-11", grants });
  assert.equal(result.aggregateSalesPriceInWindow.toFixed(2), "12000000.00");
  assert.equal(result.exceedsDisclosureThreshold, true);
  assert.equal(result.headroomBeforeDisclosureThreshold.toFixed(2), "-2000000.00");
});

test("computeRule701RollingWindow: under the threshold reports positive headroom and no breach", () => {
  const grants: Rule701Grant[] = [{ id: "small-grant", type: "RSU", grantDate: "2026-01-01", quantity: 1000, fairMarketValuePerUnitAtGrant: 1 }];
  const result = computeRule701RollingWindow({ asOfDate: "2026-09-11", grants });
  assert.equal(result.exceedsDisclosureThreshold, false);
  assert.equal(result.headroomBeforeDisclosureThreshold.toFixed(2), "9999000.00");
});

test("computeRule701RollingWindow: eligibility ceiling defaults to the flat $1,000,000 floor without totalAssets", () => {
  const result = computeRule701RollingWindow({ asOfDate: "2026-09-11", grants: [] });
  assert.equal(result.eligibilityCeiling.toFixed(2), "1000000.00");
  assert.equal(result.eligibilityCeilingBasis, "flat $1,000,000 floor");
  assert.equal(result.thirdProngNotComputed, true);
});

test("computeRule701RollingWindow: 15% of total assets raises the ceiling above the $1M floor when it's the larger prong", () => {
  const result = computeRule701RollingWindow({ asOfDate: "2026-09-11", grants: [], totalAssets: 20_000_000 }); // 15% = $3M > $1M
  assert.equal(result.eligibilityCeiling.toFixed(2), "3000000.00");
  assert.equal(result.eligibilityCeilingBasis, "15% of total assets");
});

test("computeRule701RollingWindow: 15% of total assets BELOW $1M leaves the flat floor as the governing prong", () => {
  const result = computeRule701RollingWindow({ asOfDate: "2026-09-11", grants: [], totalAssets: 2_000_000 }); // 15% = $300,000 < $1M
  assert.equal(result.eligibilityCeiling.toFixed(2), "1000000.00");
  assert.equal(result.eligibilityCeilingBasis, "flat $1,000,000 floor");
});
