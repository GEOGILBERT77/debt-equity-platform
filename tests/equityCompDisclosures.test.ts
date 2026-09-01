import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAwardActivityRollforward, computeIntrinsicValueRealized } from "../src/lib/accounting/reporting.js";

// --- buildAwardActivityRollforward: the (c) piece of the pinned ASC 718 disclosure gap ---

test("buildAwardActivityRollforward: hand-computed rollforward with no price tracking", () => {
  const result = buildAwardActivityRollforward(10000, [
    { type: "GRANTED", quantity: 2000 },
    { type: "EXERCISED_OR_SETTLED", quantity: 1500 },
    { type: "FORFEITED", quantity: 300 },
    { type: "EXPIRED", quantity: 200 },
  ]);
  // Hand-computed: 10000 + 2000 - 1500 - (300+200) = 10000
  assert.equal(result.outstandingAtStart.toFixed(2), "10000.00");
  assert.equal(result.granted.toFixed(2), "2000.00");
  assert.equal(result.exercisedOrSettled.toFixed(2), "1500.00");
  assert.equal(result.forfeitedOrExpired.toFixed(2), "500.00");
  assert.equal(result.outstandingAtEnd.toFixed(2), "10000.00");
  assert.equal(result.weightedAverageExercisePriceAtStart, undefined);
});

test("buildAwardActivityRollforward: weighted-average exercise price rolls by dollar balance, not a simple average of prices", () => {
  // Start: 1,000 options @ $10 WAEP = $10,000 dollar balance.
  // Grant: 500 new options @ $20 => +$10,000 => $20,000 balance, 1,500 shares.
  // Exercise: 200 of the OLD $10 options => -$2,000 => $18,000 balance, 1,300 shares.
  // Ending WAEP = 18000 / 1300 = 13.846153...
  const result = buildAwardActivityRollforward(
    1000,
    [
      { type: "GRANTED", quantity: 500, weightedAverageExercisePrice: 20 },
      { type: "EXERCISED_OR_SETTLED", quantity: 200, weightedAverageExercisePrice: 10 },
    ],
    10
  );
  assert.equal(result.outstandingAtEnd.toFixed(2), "1300.00");
  assert.equal(result.weightedAverageExercisePriceAtStart?.toFixed(2), "10.00");
  // Hand-computed: 18000 / 1300 = 13.8461538...
  assert.equal(result.weightedAverageExercisePriceAtEnd?.toFixed(4), "13.8462");
});

test("buildAwardActivityRollforward: a fully-exercised/forfeited pool ending at zero shares reports a zero WAEP rather than dividing by zero", () => {
  const result = buildAwardActivityRollforward(
    100,
    [{ type: "EXERCISED_OR_SETTLED", quantity: 100, weightedAverageExercisePrice: 5 }],
    5
  );
  assert.equal(result.outstandingAtEnd.toFixed(2), "0.00");
  assert.equal(result.weightedAverageExercisePriceAtEnd?.toFixed(2), "0.00");
});

// --- computeIntrinsicValueRealized: the (e) piece of the pinned ASC 718 disclosure gap ---

test("computeIntrinsicValueRealized: hand-computed intrinsic value across multiple exercise events, including an RSU with no exercise price", () => {
  const result = computeIntrinsicValueRealized([
    { quantity: 100, exercisePricePerUnit: 5, fairMarketValuePerUnitAtExercise: 20 }, // intrinsic 1500
    { quantity: 50, exercisePricePerUnit: 0, fairMarketValuePerUnitAtExercise: 20 }, // RSU: intrinsic 1000
  ]);
  // Hand-computed: 100*(20-5) + 50*(20-0) = 1500 + 1000 = 2500
  assert.equal(result.toFixed(2), "2500.00");
});

test("computeIntrinsicValueRealized: an empty event list returns zero", () => {
  const result = computeIntrinsicValueRealized([]);
  assert.equal(result.toFixed(2), "0.00");
});

test("computeIntrinsicValueRealized: a single event matches the same per-unit math optionSettlement.ts's computeCashExercise uses", () => {
  // quantity 300 @ exercise price 8, FMV 25 => intrinsic = 300 * (25-8) = 5100
  const result = computeIntrinsicValueRealized([{ quantity: 300, exercisePricePerUnit: 8, fairMarketValuePerUnitAtExercise: 25 }]);
  assert.equal(result.toFixed(2), "5100.00");
});
