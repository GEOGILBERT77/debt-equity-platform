import { test } from "node:test";
import assert from "node:assert/strict";
import { money } from "../src/lib/accounting/types.js";
import {
  computeBeneficialConversionFeature,
  buildDebtBcfEntry,
  buildPreferredBcfEntry,
} from "../src/lib/accounting/beneficialConversionFeature.js";

test("computes a real BCF when conversion price is below commitment-date fair value", () => {
  // $1,000,000 convertible into 500,000 shares -> effective conversion price $2.00/sh.
  // Commitment-date FV is $3.00/sh -> $1.00/sh intrinsic value x 500,000 = $500,000.
  const result = computeBeneficialConversionFeature({
    proceedsAllocatedToConvertibleInstrument: money(1_000_000),
    numberOfConversionShares: 500_000,
    commitmentDateFairValuePerShare: money(3),
  });
  assert.equal(result.effectiveConversionPricePerShare.toFixed(2), "2.00");
  assert.equal(result.intrinsicValuePerShare.toFixed(2), "1.00");
  assert.equal(result.beneficialConversionFeatureAmount.toFixed(2), "500000.00");
  assert.equal(result.hasBeneficialConversionFeature, true);
});

test("no BCF when the effective conversion price equals fair value exactly", () => {
  const result = computeBeneficialConversionFeature({
    proceedsAllocatedToConvertibleInstrument: money(1_000_000),
    numberOfConversionShares: 500_000,
    commitmentDateFairValuePerShare: money(2),
  });
  assert.equal(result.intrinsicValuePerShare.toFixed(2), "0.00");
  assert.equal(result.beneficialConversionFeatureAmount.toFixed(2), "0.00");
  assert.equal(result.hasBeneficialConversionFeature, false);
});

test("no BCF (never negative) when the conversion price is ABOVE fair value", () => {
  const result = computeBeneficialConversionFeature({
    proceedsAllocatedToConvertibleInstrument: money(1_000_000),
    numberOfConversionShares: 500_000,
    commitmentDateFairValuePerShare: money(1.5),
  });
  assert.equal(result.intrinsicValuePerShare.toFixed(2), "0.00");
  assert.equal(result.beneficialConversionFeatureAmount.toFixed(2), "0.00");
  assert.equal(result.hasBeneficialConversionFeature, false);
});

test("BCF is capped at the proceeds allocated to the instrument, however deep in the money", () => {
  // Tiny proceeds ($100) allocated, huge intrinsic value if uncapped: conversion price
  // = 100/1000 = $0.10/sh vs $50/sh fair value -> raw BCF would be $49,900 but only
  // $100 was actually received for the instrument.
  const result = computeBeneficialConversionFeature({
    proceedsAllocatedToConvertibleInstrument: money(100),
    numberOfConversionShares: 1000,
    commitmentDateFairValuePerShare: money(50),
  });
  assert.equal(result.beneficialConversionFeatureAmount.toFixed(2), "100.00");
  assert.equal(result.hasBeneficialConversionFeature, true);
});

test("throws on zero or negative numberOfConversionShares", () => {
  assert.throws(
    () =>
      computeBeneficialConversionFeature({
        proceedsAllocatedToConvertibleInstrument: money(1000),
        numberOfConversionShares: 0,
        commitmentDateFairValuePerShare: money(3),
      }),
    /must be positive/
  );
  assert.throws(
    () =>
      computeBeneficialConversionFeature({
        proceedsAllocatedToConvertibleInstrument: money(1000),
        numberOfConversionShares: -10,
        commitmentDateFairValuePerShare: money(3),
      }),
    /must be positive/
  );
});

test("throws on negative allocated proceeds", () => {
  assert.throws(
    () =>
      computeBeneficialConversionFeature({
        proceedsAllocatedToConvertibleInstrument: money(-1),
        numberOfConversionShares: 100,
        commitmentDateFairValuePerShare: money(3),
      }),
    /cannot be negative/
  );
});

test("buildDebtBcfEntry books discount on debt against APIC and balances", () => {
  const entry = buildDebtBcfEntry("2027-01-01", money(500_000));
  assert.equal(entry.lines.length, 2);
  const discountLine = entry.lines.find((l) => l.account === "Discount on Debt (contra-liability)");
  assert.equal(discountLine!.debit!.toFixed(2), "500000.00");
  const apicLine = entry.lines.find((l) => l.account === "Additional Paid-In Capital");
  assert.equal(apicLine!.credit!.toFixed(2), "500000.00");
});

test("buildPreferredBcfEntry books a deemed dividend against Retained Earnings and balances", () => {
  const entry = buildPreferredBcfEntry("2027-01-01", money(250_000));
  const reLine = entry.lines.find((l) => l.account === "Retained Earnings (deemed dividend)");
  assert.equal(reLine!.debit!.toFixed(2), "250000.00");
  const apicLine = entry.lines.find((l) => l.account === "Additional Paid-In Capital");
  assert.equal(apicLine!.credit!.toFixed(2), "250000.00");
});
