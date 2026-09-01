import { test } from "node:test";
import assert from "node:assert/strict";
import { money } from "../src/lib/accounting/types.js";
import {
  presentValue,
  runDebtModificationTest,
  buildExtinguishmentEntry,
  buildModificationLenderFeeEntry,
  buildThirdPartyCostExpenseEntry,
} from "../src/lib/accounting/debtModification.js";

test("presentValue discounts a single cash flow one period back correctly", () => {
  // $1,100 one period out at 10%/period should be worth exactly $1,000 today.
  const pv = presentValue([{ period: 1, amount: money(1100) }], "0.10");
  assert.equal(pv.toFixed(2), "1000.00");
});

test("presentValue sums multiple periods, each discounted by its own period count", () => {
  const pv = presentValue(
    [
      { period: 1, amount: money(100) },
      { period: 2, amount: money(1100) },
    ],
    "0.10"
  );
  // 100/1.1 + 1100/1.21 = 90.909... + 909.090... = 1000.00
  assert.equal(pv.toFixed(2), "1000.00");
});

test("presentValue rejects a non-positive-integer period", () => {
  assert.throws(() => presentValue([{ period: 0, amount: money(100) }], "0.10"), /positive integer/);
  assert.throws(() => presentValue([{ period: 1.5, amount: money(100) }], "0.10"), /positive integer/);
});

test("10% test: identical cash flows classify as a MODIFICATION with 0% difference", () => {
  const cashFlows = [
    { period: 1, amount: money(100) },
    { period: 2, amount: money(1100) },
  ];
  const result = runDebtModificationTest({
    originalCashFlows: cashFlows,
    newCashFlows: cashFlows,
    originalEffectiveRatePerPeriod: "0.10",
  });
  assert.equal(result.classification, "MODIFICATION");
  assert.equal(result.percentDifference.toFixed(4), "0.0000");
  assert.equal(result.presentValueOriginal.toFixed(2), result.presentValueNew.toFixed(2));
});

test("10% test: a small change (just under the threshold) still classifies as MODIFICATION", () => {
  // Original: PV = 1000.00 at 10%. New: bump the final payment just enough to move
  // PV by under 10% (< $100 of the $1000 PV).
  const original = [
    { period: 1, amount: money(100) },
    { period: 2, amount: money(1100) },
  ];
  const modified = [
    { period: 1, amount: money(100) },
    { period: 2, amount: money(1199) }, // PV shift = 99/1.21 = 81.8 -> 8.18% of 1000
  ];
  const result = runDebtModificationTest({
    originalCashFlows: original,
    newCashFlows: modified,
    originalEffectiveRatePerPeriod: "0.10",
  });
  assert.equal(result.classification, "MODIFICATION");
  assert.ok(result.percentDifference.lessThan(result.threshold));
});

test("10% test: a large change (at or over the threshold) classifies as EXTINGUISHMENT", () => {
  const original = [
    { period: 1, amount: money(100) },
    { period: 2, amount: money(1100) },
  ];
  const modified = [
    { period: 1, amount: money(100) },
    { period: 2, amount: money(1400) }, // PV shift = 300/1.21 = 247.9 -> ~24.8% of 1000
  ];
  const result = runDebtModificationTest({
    originalCashFlows: original,
    newCashFlows: modified,
    originalEffectiveRatePerPeriod: "0.10",
  });
  assert.equal(result.classification, "EXTINGUISHMENT");
  assert.ok(result.percentDifference.greaterThanOrEqualTo(result.threshold));
});

test("10% test: exactly a 10.00% difference classifies as EXTINGUISHMENT (>= threshold, not strictly >)", () => {
  // Original PV at 10%: single period-1 cash flow of 1100 -> PV = 1000 exactly.
  // New: 1210 at period 1 -> PV = 1100 exactly -> (1100-1000)/1000 = 0.10 exactly.
  const result = runDebtModificationTest({
    originalCashFlows: [{ period: 1, amount: money(1100) }],
    newCashFlows: [{ period: 1, amount: money(1210) }],
    originalEffectiveRatePerPeriod: "0.10",
  });
  assert.equal(result.percentDifference.toFixed(4), "0.1000");
  assert.equal(result.classification, "EXTINGUISHMENT");
});

test("10% test: fees paid to the lender, folded into newCashFlows, can tip the classification", () => {
  // Same cash flows both ways, but a lender fee added to the new terms' first period
  // is large enough on its own to cross the 10% line.
  const original = [{ period: 1, amount: money(1100) }];
  const newWithFee = [{ period: 1, amount: money(1100 + 150) }]; // +150/1.1 = 136.4 -> 13.6% of 1000
  const result = runDebtModificationTest({
    originalCashFlows: original,
    newCashFlows: newWithFee,
    originalEffectiveRatePerPeriod: "0.10",
  });
  assert.equal(result.classification, "EXTINGUISHMENT");
});

test("10% test: throws on empty originalCashFlows", () => {
  assert.throws(
    () =>
      runDebtModificationTest({
        originalCashFlows: [],
        newCashFlows: [{ period: 1, amount: money(100) }],
        originalEffectiveRatePerPeriod: "0.10",
      }),
    /at least one/
  );
});

test("10% test: throws when the original present value is zero", () => {
  assert.throws(
    () =>
      runDebtModificationTest({
        originalCashFlows: [{ period: 1, amount: money(0) }],
        newCashFlows: [{ period: 1, amount: money(100) }],
        originalEffectiveRatePerPeriod: "0.10",
      }),
    /undefined/
  );
});

test("buildExtinguishmentEntry balances and records a LOSS when reacquisition price exceeds old carrying value", () => {
  const { entry, gainOrLoss } = buildExtinguishmentEntry({
    date: "2027-01-01",
    oldDebtCarryingValue: money(1000),
    newDebtFairValue: money(1150),
  });
  assert.equal(gainOrLoss.toFixed(2), "-150.00");
  const lossLine = entry.lines.find((l) => l.account === "Loss on Extinguishment of Debt");
  assert.ok(lossLine);
  assert.equal(lossLine!.debit!.toFixed(2), "150.00");
  const totalDebits = entry.lines.reduce((s, l) => s.plus(l.debit ?? 0), money(0));
  const totalCredits = entry.lines.reduce((s, l) => s.plus(l.credit ?? 0), money(0));
  assert.equal(totalDebits.toFixed(2), totalCredits.toFixed(2));
});

test("buildExtinguishmentEntry balances and records a GAIN when old carrying value exceeds reacquisition price", () => {
  const { entry, gainOrLoss } = buildExtinguishmentEntry({
    date: "2027-01-01",
    oldDebtCarryingValue: money(1000),
    newDebtFairValue: money(800),
  });
  assert.equal(gainOrLoss.toFixed(2), "200.00");
  const gainLine = entry.lines.find((l) => l.account === "Gain on Extinguishment of Debt");
  assert.ok(gainLine);
  assert.equal(gainLine!.credit!.toFixed(2), "200.00");
});

test("buildExtinguishmentEntry folds lender fees into the reacquisition price, still balances", () => {
  const { entry, gainOrLoss } = buildExtinguishmentEntry({
    date: "2027-01-01",
    oldDebtCarryingValue: money(1000),
    newDebtFairValue: money(900),
    lenderFeesPaid: money(50),
  });
  // Reacquisition price = 900 + 50 = 950; gain = 1000 - 950 = 50.
  assert.equal(gainOrLoss.toFixed(2), "50.00");
  const feeLine = entry.lines.find((l) => l.account === "Cash (fees paid to lender at extinguishment)");
  assert.ok(feeLine);
  assert.equal(feeLine!.credit!.toFixed(2), "50.00");
  const totalDebits = entry.lines.reduce((s, l) => s.plus(l.debit ?? 0), money(0));
  const totalCredits = entry.lines.reduce((s, l) => s.plus(l.credit ?? 0), money(0));
  assert.equal(totalDebits.toFixed(2), totalCredits.toFixed(2));
});

test("buildExtinguishmentEntry omits the gain/loss line entirely when reacquisition price exactly equals carrying value", () => {
  const { entry, gainOrLoss } = buildExtinguishmentEntry({
    date: "2027-01-01",
    oldDebtCarryingValue: money(1000),
    newDebtFairValue: money(1000),
  });
  assert.equal(gainOrLoss.toFixed(2), "0.00");
  assert.ok(!entry.lines.some((l) => l.account.includes("Gain") || l.account.includes("Loss")));
});

test("buildModificationLenderFeeEntry capitalizes the fee as additional debt discount and balances", () => {
  const entry = buildModificationLenderFeeEntry("2027-01-01", money(25));
  assert.equal(entry.lines.length, 2);
  const discountLine = entry.lines.find((l) => l.account === "Discount on Debt (contra-liability)");
  assert.equal(discountLine!.debit!.toFixed(2), "25.00");
  const cashLine = entry.lines.find((l) => l.account === "Cash");
  assert.equal(cashLine!.credit!.toFixed(2), "25.00");
});

test("buildThirdPartyCostExpenseEntry expenses the cost immediately and balances", () => {
  const entry = buildThirdPartyCostExpenseEntry("2027-01-01", money(15));
  const expenseLine = entry.lines.find((l) => l.account === "Debt Modification/Extinguishment Expense");
  assert.equal(expenseLine!.debit!.toFixed(2), "15.00");
  const cashLine = entry.lines.find((l) => l.account === "Cash");
  assert.equal(cashLine!.credit!.toFixed(2), "15.00");
});
