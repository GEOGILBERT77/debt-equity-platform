import { test } from "node:test";
import assert from "node:assert/strict";
import { money } from "../src/lib/accounting/types.js";
import {
  classifySafe,
  buildLiabilitySafeIssuanceEntry,
  buildEquitySafeIssuanceEntry,
  buildSafeConversionEntry,
} from "../src/lib/accounting/safe.js";
import { buildFairValueRemeasurementSchedule } from "../src/lib/accounting/fairValueRemeasurement.js";

test("classifySafe: a standard cap/discount SAFE (variable share count) classifies as liability", () => {
  const result = classifySafe({ conversionPriceFixedAtInception: false, holderCanElectCashSettlement: false });
  assert.equal(result, "liability");
});

test("classifySafe: a fixed-conversion-price SAFE with no cash settlement classifies as equity", () => {
  const result = classifySafe({ conversionPriceFixedAtInception: true, holderCanElectCashSettlement: false });
  assert.equal(result, "equity");
});

test("classifySafe: a holder cash-settlement election forces liability regardless of fixed conversion price", () => {
  const result = classifySafe({ conversionPriceFixedAtInception: true, holderCanElectCashSettlement: true });
  assert.equal(result, "liability");
});

test("buildLiabilitySafeIssuanceEntry defaults initial fair value to the investment amount received, balances", () => {
  const entry = buildLiabilitySafeIssuanceEntry("2027-01-01", money(250_000));
  const cashLine = entry.lines.find((l) => l.account === "Cash");
  const liabilityLine = entry.lines.find((l) => l.account === "SAFE Liability");
  assert.equal(cashLine!.debit!.toFixed(2), "250000.00");
  assert.equal(liabilityLine!.credit!.toFixed(2), "250000.00");
});

test("buildLiabilitySafeIssuanceEntry books a day-one loss when an explicit fair value exceeds cash received, and balances", () => {
  const entry = buildLiabilitySafeIssuanceEntry("2027-01-01", money(250_000), undefined, money(260_000));
  const liabilityLine = entry.lines.find((l) => l.account === "SAFE Liability");
  assert.equal(liabilityLine!.credit!.toFixed(2), "260000.00");
  const lossLine = entry.lines.find((l) => l.account === "Loss on Day-One SAFE Measurement");
  assert.equal(lossLine!.debit!.toFixed(2), "10000.00");
  const totalDebits = entry.lines.reduce((s, l) => s.plus(l.debit ?? 0), money(0));
  const totalCredits = entry.lines.reduce((s, l) => s.plus(l.credit ?? 0), money(0));
  assert.equal(totalDebits.toFixed(2), totalCredits.toFixed(2));
});

test("buildLiabilitySafeIssuanceEntry books a day-one gain when an explicit fair value is below cash received, and balances", () => {
  const entry = buildLiabilitySafeIssuanceEntry("2027-01-01", money(250_000), undefined, money(240_000));
  const gainLine = entry.lines.find((l) => l.account === "Gain on Day-One SAFE Measurement");
  assert.equal(gainLine!.credit!.toFixed(2), "10000.00");
  const totalDebits = entry.lines.reduce((s, l) => s.plus(l.debit ?? 0), money(0));
  const totalCredits = entry.lines.reduce((s, l) => s.plus(l.credit ?? 0), money(0));
  assert.equal(totalDebits.toFixed(2), totalCredits.toFixed(2));
});

test("buildEquitySafeIssuanceEntry books straight to APIC and balances", () => {
  const entry = buildEquitySafeIssuanceEntry("2027-01-01", money(100_000));
  const cashLine = entry.lines.find((l) => l.account === "Cash");
  const apicLine = entry.lines.find((l) => l.account === "Additional Paid-In Capital (SAFE)");
  assert.equal(cashLine!.debit!.toFixed(2), "100000.00");
  assert.equal(apicLine!.credit!.toFixed(2), "100000.00");
});

test("buildSafeConversionEntry derecognizes the SAFE and splits par/APIC on the shares issued, balances", () => {
  const entry = buildSafeConversionEntry("2027-06-01", "SAFE Liability", money(250_000), 50_000, "0.0001");
  const safeLine = entry.lines.find((l) => l.account === "SAFE Liability");
  assert.equal(safeLine!.debit!.toFixed(2), "250000.00");
  const parLine = entry.lines.find((l) => l.account === "Common Stock, par value");
  assert.equal(parLine!.credit!.toFixed(2), "5.00"); // 50,000 x $0.0001
  const apicLine = entry.lines.find((l) => l.account === "Additional Paid-In Capital");
  assert.equal(apicLine!.credit!.toFixed(2), "249995.00");
  const totalDebits = entry.lines.reduce((s, l) => s.plus(l.debit ?? 0), money(0));
  const totalCredits = entry.lines.reduce((s, l) => s.plus(l.credit ?? 0), money(0));
  assert.equal(totalDebits.toFixed(2), totalCredits.toFixed(2));
});

test("buildSafeConversionEntry defaults par value to zero when omitted", () => {
  const entry = buildSafeConversionEntry("2027-06-01", "SAFE Liability", money(100_000), 10_000);
  const parLine = entry.lines.find((l) => l.account === "Common Stock, par value");
  assert.equal(parLine!.credit!.toFixed(2), "0.00");
  const apicLine = entry.lines.find((l) => l.account === "Additional Paid-In Capital");
  assert.equal(apicLine!.credit!.toFixed(2), "100000.00");
});

test("a liability-classified SAFE's fair value roll-forward reuses fairValueRemeasurement.ts directly", () => {
  const schedule = buildFairValueRemeasurementSchedule(
    {
      inceptionDate: "2027-01-01",
      inceptionFairValue: 250_000,
      observations: [
        { date: "2027-06-30", fairValue: 300_000 },
        { date: "2027-12-31", fairValue: 280_000 },
      ],
      ascReference: "ASC 480-10-25-14 (SAFE, liability-classified)",
    },
    "liability",
    [
      { label: "H1", start: "2027-01-01", end: "2027-06-30" },
      { label: "H2", start: "2027-06-30", end: "2027-12-31" },
    ]
  );
  // Fair value went up (worse for the issuer as a liability) then down.
  assert.equal(schedule[0].amount.toFixed(2), "50000.00"); // loss
  assert.equal(schedule[1].amount.toFixed(2), "-20000.00"); // gain
  assert.equal(schedule[1].endingBalance!.toFixed(2), "280000.00");
});
