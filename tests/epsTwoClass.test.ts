import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTwoClassBasicEps, computeIfConvertedEps, computeMoreDilutiveEps } from "../src/lib/accounting/epsTwoClass.js";

test("basic two-class EPS: no declared dividends, allocation is pure as-converted parity between common and participating", () => {
  const result = computeTwoClassBasicEps({
    netIncomeOrLoss: 600_000,
    dividendsDeclaredToCommon: 0,
    dividendsDeclaredToParticipatingClass: 0,
    weightedAverageCommonShares: 800_000,
    participatingClassAsConvertedShares: 200_000,
  });
  assert.equal(result.basicEpsCommon.toFixed(2), "0.60");
  assert.equal(result.basicEpsParticipatingClass.toFixed(2), "0.60");
  assert.equal(result.lossOrInsufficientEarnings, false);
});

test("basic two-class EPS: declared dividends to common only, undistributed earnings still split pro-rata by as-converted shares", () => {
  const result = computeTwoClassBasicEps({
    netIncomeOrLoss: 500_000,
    dividendsDeclaredToCommon: 100_000,
    dividendsDeclaredToParticipatingClass: 0,
    weightedAverageCommonShares: 800_000,
    participatingClassAsConvertedShares: 200_000,
  });
  // undistributed = 500,000 - 100,000 = 400,000; participating gets 400,000*200,000/1,000,000 = 80,000
  assert.equal(result.undistributedEarningsAllocatedToParticipatingClass.toFixed(2), "80000.00");
  assert.equal(result.undistributedEarningsAllocatedToCommon.toFixed(2), "320000.00");
  // common numerator = 100,000 + 320,000 = 420,000 / 800,000 = 0.525
  assert.equal(result.basicEpsCommon.toFixed(3), "0.525");
  // participating numerator = 0 + 80,000 = 80,000 / 200,000 = 0.40
  assert.equal(result.basicEpsParticipatingClass.toFixed(2), "0.40");
});

test("basic two-class EPS: a genuine net loss allocates nothing to the participating class (ASC 260-10-45-62)", () => {
  const result = computeTwoClassBasicEps({
    netIncomeOrLoss: -200_000,
    dividendsDeclaredToCommon: 0,
    dividendsDeclaredToParticipatingClass: 0,
    weightedAverageCommonShares: 800_000,
    participatingClassAsConvertedShares: 200_000,
  });
  assert.equal(result.lossOrInsufficientEarnings, true);
  assert.equal(result.undistributedEarningsAllocatedToParticipatingClass.toFixed(2), "0.00");
  assert.equal(result.basicEpsCommon.toFixed(4), "-0.2500");
  assert.equal(result.basicEpsParticipatingClass.toFixed(2), "0.00");
});

test("basic two-class EPS: positive net income that doesn't even cover declared dividends is still the 'insufficient earnings' case, not allocated to participating", () => {
  const result = computeTwoClassBasicEps({
    netIncomeOrLoss: 50_000,
    dividendsDeclaredToCommon: 100_000,
    dividendsDeclaredToParticipatingClass: 0,
    weightedAverageCommonShares: 800_000,
    participatingClassAsConvertedShares: 200_000,
  });
  assert.equal(result.lossOrInsufficientEarnings, true);
  // undistributed = 50,000 - 100,000 = -50,000, stays entirely with common
  // common numerator = 100,000 + (-50,000) = 50,000 / 800,000 = 0.0625
  assert.equal(result.basicEpsCommon.toFixed(4), "0.0625");
});

test("basic two-class EPS: throws on zero weighted-average common shares", () => {
  assert.throws(
    () =>
      computeTwoClassBasicEps({
        netIncomeOrLoss: 100_000,
        dividendsDeclaredToCommon: 0,
        dividendsDeclaredToParticipatingClass: 0,
        weightedAverageCommonShares: 0,
        participatingClassAsConvertedShares: 100_000,
      }),
    /must be positive/
  );
});

test("computeIfConvertedEps: spreads the entire net income over the combined share base with no dividend carve-out", () => {
  const eps = computeIfConvertedEps(500_000, 800_000, 200_000);
  assert.equal(eps.toFixed(2), "0.50");
});

test("computeMoreDilutiveEps: picks IF_CONVERTED when it produces a smaller EPS than the two-class basic result", () => {
  const result = computeMoreDilutiveEps({
    netIncomeOrLoss: 500_000,
    dividendsDeclaredToCommon: 100_000,
    dividendsDeclaredToParticipatingClass: 0,
    weightedAverageCommonShares: 800_000,
    participatingClassAsConvertedShares: 200_000,
  });
  // basic (from an earlier test) = 0.525; if-converted = 500,000/1,000,000 = 0.50 -> more dilutive
  assert.equal(result.method, "IF_CONVERTED");
  assert.equal(result.dilutedEpsCommon.toFixed(2), "0.50");
});

test("computeMoreDilutiveEps: picks TWO_CLASS when the basic result is already more dilutive than if-converted", () => {
  const result = computeMoreDilutiveEps({
    netIncomeOrLoss: 1_000_000,
    dividendsDeclaredToCommon: 0,
    dividendsDeclaredToParticipatingClass: 900_000,
    weightedAverageCommonShares: 900_000,
    participatingClassAsConvertedShares: 100_000,
  });
  // basic: undistributed = 100,000; participating gets 100,000*100,000/1,000,000=10,000; common gets 90,000;
  // common EPS = (0+90,000)/900,000 = 0.10. if-converted = 1,000,000/1,000,000 = 1.00 -> basic is far more dilutive.
  assert.equal(result.method, "TWO_CLASS");
  assert.equal(result.dilutedEpsCommon.toFixed(2), "0.10");
});

test("computeMoreDilutiveEps: a net loss period never runs the if-converted comparison — always returns the basic two-class result (anti-dilution, ASC 260-10-45-17)", () => {
  const result = computeMoreDilutiveEps({
    netIncomeOrLoss: -100_000,
    dividendsDeclaredToCommon: 0,
    dividendsDeclaredToParticipatingClass: 0,
    weightedAverageCommonShares: 800_000,
    participatingClassAsConvertedShares: 200_000,
  });
  assert.equal(result.method, "TWO_CLASS");
  assert.equal(result.dilutedEpsCommon.toFixed(4), "-0.1250");
});
