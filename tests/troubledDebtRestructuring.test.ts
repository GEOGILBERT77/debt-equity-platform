import { test } from "node:test";
import assert from "node:assert/strict";
import { money } from "../src/lib/accounting/types.js";
import {
  classifyTdrModification,
  buildTdrGainEntry,
  buildTdrReducedCarryingValueSchedule,
  buildTdrSettlementEntry,
} from "../src/lib/accounting/troubledDebtRestructuring.js";

test("classifyTdrModification: total future cash payments below carrying value -> immediate gain, UNDISCOUNTED comparison", () => {
  // Carrying value $1,000,000; restructured payments total only $900,000 undiscounted
  // (note: NOT present-valued, unlike debtModification.ts's 10% test).
  const result = classifyTdrModification({
    currentCarryingValue: money(1_000_000),
    restructuredCashFlows: [300_000, 300_000, 300_000], // sums to 900,000
  });
  assert.equal(result.kind, "GAIN_RECOGNIZED_IMMEDIATELY");
  if (result.kind === "GAIN_RECOGNIZED_IMMEDIATELY") {
    assert.equal(result.gain.toFixed(2), "100000.00");
    assert.equal(result.newCarryingValue.toFixed(2), "900000.00");
  }
});

test("classifyTdrModification: total future cash payments at or above carrying value -> solves for a new effective rate, no gain", () => {
  // Carrying value $95,000; a single future payment of $100,000 one period out.
  // New rate should be exactly 5000/95000 (same golden math as debtAmortization.ts's
  // own single-period effective-interest test).
  const result = classifyTdrModification({
    currentCarryingValue: money(95_000),
    restructuredCashFlows: [100_000],
  });
  assert.equal(result.kind, "NEW_EFFECTIVE_RATE_REQUIRED");
  if (result.kind === "NEW_EFFECTIVE_RATE_REQUIRED") {
    assert.equal(result.newEffectiveAnnualYield.toFixed(4), (5000 / 95000).toFixed(4));
  }
});

test("classifyTdrModification: total future cash payments exactly equal to carrying value -> new effective rate branch (0%), not the gain branch", () => {
  const result = classifyTdrModification({
    currentCarryingValue: money(500_000),
    restructuredCashFlows: [500_000],
  });
  assert.equal(result.kind, "NEW_EFFECTIVE_RATE_REQUIRED");
  if (result.kind === "NEW_EFFECTIVE_RATE_REQUIRED") {
    assert.equal(result.newEffectiveAnnualYield.toFixed(4), "0.0000");
  }
});

test("classifyTdrModification: throws on an empty restructuredCashFlows array", () => {
  assert.throws(
    () => classifyTdrModification({ currentCarryingValue: money(100_000), restructuredCashFlows: [] }),
    /at least one/
  );
});

test("buildTdrGainEntry books the write-down and gain, and balances", () => {
  const entry = buildTdrGainEntry("2027-01-01", money(1_000_000), money(900_000));
  const oldLine = entry.lines.find((l) => l.account === "Debt Payable (old carrying value)");
  const newLine = entry.lines.find((l) => l.account === "Debt Payable, Restructured (= total future cash payments)");
  const gainLine = entry.lines.find((l) => l.account === "Gain on Troubled Debt Restructuring");
  assert.equal(oldLine!.debit!.toFixed(2), "1000000.00");
  assert.equal(newLine!.credit!.toFixed(2), "900000.00");
  assert.equal(gainLine!.credit!.toFixed(2), "100000.00");
});

test("buildTdrGainEntry throws if newCarryingValue is not actually less than oldCarryingValue", () => {
  assert.throws(() => buildTdrGainEntry("2027-01-01", money(500_000), money(500_000)), /must be less than/);
  assert.throws(() => buildTdrGainEntry("2027-01-01", money(500_000), money(600_000)), /must be less than/);
});

test("buildTdrReducedCarryingValueSchedule recognizes zero interest expense every period, rolling the balance down to exactly zero", () => {
  const schedule = buildTdrReducedCarryingValueSchedule(
    money(900_000),
    [300_000, 300_000, 300_000],
    [
      { label: "Year 1", start: "2027-01-01", end: "2028-01-01" },
      { label: "Year 2", start: "2028-01-01", end: "2029-01-01" },
      { label: "Year 3", start: "2029-01-01", end: "2030-01-01" },
    ]
  );
  assert.equal(schedule.length, 3);
  for (const row of schedule) {
    assert.equal(row.amount.toFixed(2), "0.00"); // zero interest expense, every period
  }
  assert.equal(schedule[0].endingBalance!.toFixed(2), "600000.00");
  assert.equal(schedule[1].endingBalance!.toFixed(2), "300000.00");
  assert.equal(schedule[2].endingBalance!.toFixed(2), "0.00");
});

test("buildTdrReducedCarryingValueSchedule throws when cash flows and periods have different lengths", () => {
  assert.throws(
    () => buildTdrReducedCarryingValueSchedule(money(900_000), [300_000, 300_000, 300_000], [{ label: "Year 1", start: "2027-01-01", end: "2028-01-01" }]),
    /one entry per period/
  );
});

test("buildTdrSettlementEntry: consideration transferred worth less than debt carrying value -> a gain, and balances", () => {
  const { entry, gainOnRestructuring } = buildTdrSettlementEntry("2027-06-01", money(500_000), "Real Estate, at fair value", money(350_000));
  assert.equal(gainOnRestructuring.toFixed(2), "150000.00");
  const gainLine = entry.lines.find((l) => l.account === "Gain on Troubled Debt Restructuring");
  assert.equal(gainLine!.credit!.toFixed(2), "150000.00");
  const totalDebits = entry.lines.reduce((s, l) => s.plus(l.debit ?? 0), money(0));
  const totalCredits = entry.lines.reduce((s, l) => s.plus(l.credit ?? 0), money(0));
  assert.equal(totalDebits.toFixed(2), totalCredits.toFixed(2));
});

test("buildTdrSettlementEntry: consideration transferred worth MORE than debt carrying value -> a loss, and still balances", () => {
  const { entry, gainOnRestructuring } = buildTdrSettlementEntry("2027-06-01", money(300_000), "Common Stock and APIC issued to creditor", money(350_000));
  assert.equal(gainOnRestructuring.toFixed(2), "-50000.00");
  const lossLine = entry.lines.find((l) => l.account === "Loss on Troubled Debt Restructuring");
  assert.equal(lossLine!.debit!.toFixed(2), "50000.00");
  const totalDebits = entry.lines.reduce((s, l) => s.plus(l.debit ?? 0), money(0));
  const totalCredits = entry.lines.reduce((s, l) => s.plus(l.credit ?? 0), money(0));
  assert.equal(totalDebits.toFixed(2), totalCredits.toFixed(2));
});
