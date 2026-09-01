import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyEsppPlan,
  computeEsppDiscountOnlyFairValue,
  computeEsppLookbackFairValue,
  computeEsppGrantDateFairValue,
  buildEsppPurchaseEntry,
} from "../src/lib/accounting/espp.js";
import { blackScholesCallValue } from "../src/lib/accounting/blackScholes.js";
import { assertBalanced } from "../src/lib/accounting/types.js";

// --- classifyEsppPlan (ASC 718-50-25-1) ---

test("classifyEsppPlan: a 5% discount with no look-back and broad eligibility is noncompensatory (safe harbor)", () => {
  const result = classifyEsppPlan({
    discountPercent: 0.05,
    hasLookback: false,
    substantiallyAllEmployeesEligible: true,
  });
  assert.equal(result.kind, "NONCOMPENSATORY");
});

test("classifyEsppPlan: a 15% discount with no look-back IS noncompensatory only when justified", () => {
  const unjustified = classifyEsppPlan({
    discountPercent: 0.15,
    hasLookback: false,
    substantiallyAllEmployeesEligible: true,
  });
  assert.equal(unjustified.kind, "COMPENSATORY");

  const justified = classifyEsppPlan({
    discountPercent: 0.15,
    hasLookback: false,
    substantiallyAllEmployeesEligible: true,
    discountJustifiedAboveSafeHarbor: true,
  });
  assert.equal(justified.kind, "NONCOMPENSATORY");
});

test("classifyEsppPlan: a discount over 15% is compensatory even if 'justified'", () => {
  const result = classifyEsppPlan({
    discountPercent: 0.2,
    hasLookback: false,
    substantiallyAllEmployeesEligible: true,
    discountJustifiedAboveSafeHarbor: true,
  });
  assert.equal(result.kind, "COMPENSATORY");
});

test("classifyEsppPlan: ANY look-back feature is compensatory regardless of how small the discount is (ASC 718-50-25-1(c))", () => {
  const result = classifyEsppPlan({
    discountPercent: 0.01,
    hasLookback: true,
    substantiallyAllEmployeesEligible: true,
  });
  assert.equal(result.kind, "COMPENSATORY");
  assert.match(result.reason, /look-back/i);
});

test("classifyEsppPlan: excluding a class of employees is compensatory regardless of discount size", () => {
  const result = classifyEsppPlan({
    discountPercent: 0.05,
    hasLookback: false,
    substantiallyAllEmployeesEligible: false,
  });
  assert.equal(result.kind, "COMPENSATORY");
});

// --- computeEsppDiscountOnlyFairValue: exactly hand-computable, no option pricing involved ---

test("computeEsppDiscountOnlyFairValue: with no dividend yield, value is exactly discount * stock price (a forward, not an option)", () => {
  const value = computeEsppDiscountOnlyFairValue({
    purchaseDateReferenceStockPrice: 20,
    discountPercent: 0.15,
    offeringPeriodYears: 0.5,
    dividendYield: 0,
  });
  // Hand-computed: 0.15 * 20 = 3.00 exactly (e^0 = 1)
  assert.equal(value.toFixed(2), "3.00");
});

test("computeEsppDiscountOnlyFairValue: a dividend yield discounts the value below the raw discount amount", () => {
  const noDividend = computeEsppDiscountOnlyFairValue({
    purchaseDateReferenceStockPrice: 20,
    discountPercent: 0.15,
    offeringPeriodYears: 1,
    dividendYield: 0,
  });
  const withDividend = computeEsppDiscountOnlyFairValue({
    purchaseDateReferenceStockPrice: 20,
    discountPercent: 0.15,
    offeringPeriodYears: 1,
    dividendYield: 0.02,
  });
  // Hand-computed: 0.15 * 20 * e^(-0.02*1) = 3 * 0.9801987 = 2.9405960...
  assert.equal(withDividend.toFixed(4), "2.9406");
  assert.ok(withDividend.toNumber() < noDividend.toNumber(), "a dividend yield should reduce the forward value");
});

// --- computeEsppLookbackFairValue: verify the payoff decomposition algebra, then plausibility-test the priced result ---

test("look-back payoff decomposition Payoff = CallPayoff(K=S0) + d*S0 - d*PutPayoff(K=S0) holds for flat, up, and down outcomes", () => {
  const S0 = 100;
  const d = 0.15;
  const actualPayoff = (sT: number) => sT - (1 - d) * Math.min(S0, sT);
  const decomposedPayoff = (sT: number) => {
    const callPayoff = Math.max(sT - S0, 0);
    const putPayoff = Math.max(S0 - sT, 0);
    return callPayoff + d * S0 - d * putPayoff;
  };
  for (const sT of [100, 120, 80, 60, 150]) {
    assert.ok(
      Math.abs(actualPayoff(sT) - decomposedPayoff(sT)) < 1e-9,
      `mismatch at S_T=${sT}: actual=${actualPayoff(sT)}, decomposed=${decomposedPayoff(sT)}`
    );
  }
});

test("computeEsppLookbackFairValue: with a zero discount, the look-back value collapses to exactly the plain ATM call value", () => {
  // d=0 kills both the d*S0*e^(-rT) term and the -d*Put term, leaving only Call(K=S0,T) —
  // a direct algebraic sanity check on the formula, not just a plausibility bound.
  const call = blackScholesCallValue({
    stockPrice: 20,
    strikePrice: 20,
    riskFreeRate: 0.04,
    volatility: 0.4,
    expectedTermYears: 0.5,
    dividendYield: 0,
  });
  const lookback = computeEsppLookbackFairValue({
    grantDateStockPrice: 20,
    discountPercent: 0,
    riskFreeRate: 0.04,
    volatility: 0.4,
    offeringPeriodYears: 0.5,
    dividendYield: 0,
  });
  assert.equal(lookback.toFixed(6), call.toFixed(6));
});

test("computeEsppLookbackFairValue: a look-back plan is always worth at least as much as the equivalent discount-only plan (strictly more once there's any volatility)", () => {
  const lookback = computeEsppLookbackFairValue({
    grantDateStockPrice: 20,
    discountPercent: 0.15,
    riskFreeRate: 0.04,
    volatility: 0.4,
    offeringPeriodYears: 0.5,
    dividendYield: 0,
  });
  const discountOnly = computeEsppDiscountOnlyFairValue({
    purchaseDateReferenceStockPrice: 20,
    discountPercent: 0.15,
    offeringPeriodYears: 0.5,
    dividendYield: 0,
  });
  assert.ok(
    lookback.toNumber() > discountOnly.toNumber(),
    "the look-back feature adds strictly positive extra value beyond the flat discount"
  );
});

test("computeEsppLookbackFairValue: higher volatility increases the value (more optionality), and the value stays below the full stock price", () => {
  const lowVol = computeEsppLookbackFairValue({
    grantDateStockPrice: 20,
    discountPercent: 0.15,
    riskFreeRate: 0.04,
    volatility: 0.2,
    offeringPeriodYears: 0.5,
    dividendYield: 0,
  });
  const highVol = computeEsppLookbackFairValue({
    grantDateStockPrice: 20,
    discountPercent: 0.15,
    riskFreeRate: 0.04,
    volatility: 0.6,
    offeringPeriodYears: 0.5,
    dividendYield: 0,
  });
  assert.ok(highVol.toNumber() > lowVol.toNumber(), "higher volatility should increase the look-back value");
  assert.ok(highVol.toNumber() < 20, "the purchase right can never be worth more than the underlying share itself");
});

// --- computeEsppGrantDateFairValue: dispatcher ---

test("computeEsppGrantDateFairValue: dispatches to the look-back formula when hasLookback is true", () => {
  const viaDispatcher = computeEsppGrantDateFairValue({
    hasLookback: true,
    grantDateStockPrice: 20,
    discountPercent: 0.15,
    riskFreeRate: 0.04,
    volatility: 0.4,
    offeringPeriodYears: 0.5,
    dividendYield: 0,
  });
  const direct = computeEsppLookbackFairValue({
    grantDateStockPrice: 20,
    discountPercent: 0.15,
    riskFreeRate: 0.04,
    volatility: 0.4,
    offeringPeriodYears: 0.5,
    dividendYield: 0,
  });
  assert.equal(viaDispatcher.toFixed(6), direct.toFixed(6));
});

test("computeEsppGrantDateFairValue: dispatches to the discount-only formula when hasLookback is false, ignoring volatility", () => {
  const viaDispatcher = computeEsppGrantDateFairValue({
    hasLookback: false,
    grantDateStockPrice: 20,
    discountPercent: 0.15,
    riskFreeRate: 0.04,
    offeringPeriodYears: 0.5,
    dividendYield: 0,
  });
  assert.equal(viaDispatcher.toFixed(2), "3.00");
});

test("computeEsppGrantDateFairValue: throws if hasLookback is true but volatility is missing", () => {
  assert.throws(() =>
    computeEsppGrantDateFairValue({
      hasLookback: true,
      grantDateStockPrice: 20,
      discountPercent: 0.15,
      riskFreeRate: 0.04,
      offeringPeriodYears: 0.5,
    })
  );
});

// --- buildEsppPurchaseEntry ---

test("buildEsppPurchaseEntry: a compensatory purchase debits cash and APIC, credits Common Stock, and balances", () => {
  const entry = buildEsppPurchaseEntry({
    purchaseDate: "2026-06-30",
    quantityPurchased: 100,
    purchasePricePerUnit: 17, // discounted price actually paid
    grantDateFairValuePerUnit: 3, // compensation cost already recognized over the offering period
  });
  assertBalanced(entry);
  const cashLine = entry.lines.find((l) => l.account === "Cash");
  const apicLine = entry.lines.find((l) => l.account === "Additional Paid-In Capital");
  const commonStockLine = entry.lines.find((l) => l.account === "Common Stock");
  assert.equal(cashLine?.debit?.toFixed(2), "1700.00"); // 100 * 17
  assert.equal(apicLine?.debit?.toFixed(2), "300.00"); // 100 * 3
  assert.equal(commonStockLine?.credit?.toFixed(2), "2000.00"); // 100 * 20 (FMV)
  assert.equal(entry.ascReference, "ASC 718-50 (employee stock purchase plan)");
});

test("buildEsppPurchaseEntry: a noncompensatory purchase (zero recognized fair value) has no APIC line — just cash for shares", () => {
  const entry = buildEsppPurchaseEntry({
    purchaseDate: "2026-06-30",
    quantityPurchased: 100,
    purchasePricePerUnit: 19,
    grantDateFairValuePerUnit: 0,
  });
  assertBalanced(entry);
  const apicLine = entry.lines.find((l) => l.account === "Additional Paid-In Capital");
  assert.equal(apicLine, undefined, "no compensation cost was ever recognized, so there's nothing to reclassify");
  const cashLine = entry.lines.find((l) => l.account === "Cash");
  const commonStockLine = entry.lines.find((l) => l.account === "Common Stock");
  assert.equal(cashLine?.debit?.toFixed(2), "1900.00");
  assert.equal(commonStockLine?.credit?.toFixed(2), "1900.00");
});
