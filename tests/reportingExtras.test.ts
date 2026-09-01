import { test } from "node:test";
import assert from "node:assert/strict";
import { money, JournalEntry } from "../src/lib/accounting/types.js";
import { buildAccountRollForward, buildStockCompDisclosure, StockCompInstrumentInput } from "../src/lib/accounting/reporting.js";

/**
 * Financial-statement reporting extensions added in v0.19.0 (the "reporting
 * functionality" phase) — roll-forwards built on top of the existing
 * `summarizeByAccount`, and the ASC 718 unrecognized-compensation-cost disclosure. All
 * numbers below are hand-computed; see each test's inline arithmetic.
 */

function entry(date: string, lines: { account: string; debit?: number; credit?: number }[]): JournalEntry {
  return {
    date,
    description: "test entry",
    lines: lines.map((l) => ({
      account: l.account,
      debit: l.debit !== undefined ? money(l.debit) : undefined,
      credit: l.credit !== undefined ? money(l.credit) : undefined,
    })),
  };
}

test("buildAccountRollForward: beginning balance carries prior-period activity, ending = beginning + period", () => {
  const entries: JournalEntry[] = [
    // Prior period (before periodStart): $100 debit to Discount, building a $100 beginning balance.
    entry("2025-01-01", [{ account: "Debt Discount", debit: 100 }, { account: "Cash", credit: 100 }]),
    // In-period: another $40 debit.
    entry("2025-06-30", [{ account: "Debt Discount", debit: 40 }, { account: "Cash", credit: 40 }]),
    // After the period end: should be excluded entirely.
    entry("2026-01-01", [{ account: "Debt Discount", debit: 999 }, { account: "Cash", credit: 999 }]),
  ];

  const rows = buildAccountRollForward(entries, "2025-06-01", "2025-12-31");
  const discount = rows.find((r) => r.account === "Debt Discount")!;
  const cash = rows.find((r) => r.account === "Cash")!;

  assert.equal(discount.beginningBalance.toFixed(2), "100.00");
  assert.equal(discount.periodActivity.toFixed(2), "40.00");
  assert.equal(discount.endingBalance.toFixed(2), "140.00");

  // Cash is credit-heavy, so its debit-normal net is negative throughout.
  assert.equal(cash.beginningBalance.toFixed(2), "-100.00");
  assert.equal(cash.periodActivity.toFixed(2), "-40.00");
  assert.equal(cash.endingBalance.toFixed(2), "-140.00");
});

test("buildAccountRollForward: an account with no prior activity gets a zero beginning balance, not an omitted row", () => {
  const entries: JournalEntry[] = [entry("2025-03-01", [{ account: "New Account", debit: 25 }, { account: "Cash", credit: 25 }])];
  const rows = buildAccountRollForward(entries, "2025-01-01", "2025-12-31");
  const row = rows.find((r) => r.account === "New Account")!;
  assert.equal(row.beginningBalance.toFixed(2), "0.00");
  assert.equal(row.periodActivity.toFixed(2), "25.00");
  assert.equal(row.endingBalance.toFixed(2), "25.00");
});

test("buildAccountRollForward: segregates currencies into separate rows, never sums across them", () => {
  const entries: JournalEntry[] = [
    { ...entry("2025-02-01", [{ account: "Cash", debit: 100 }, { account: "Revenue", credit: 100 }]), currency: "USD" },
    { ...entry("2025-02-01", [{ account: "Cash", debit: 50 }, { account: "Revenue", credit: 50 }]), currency: "EUR" },
  ];
  const rows = buildAccountRollForward(entries, "2025-01-01", "2025-12-31");
  const usdCash = rows.find((r) => r.account === "Cash" && r.currency === "USD")!;
  const eurCash = rows.find((r) => r.account === "Cash" && r.currency === "EUR")!;
  assert.equal(usdCash.endingBalance.toFixed(2), "100.00");
  assert.equal(eurCash.endingBalance.toFixed(2), "50.00");
});

test("buildStockCompDisclosure: unrecognized cost and weighted-average remaining period, hand-computed", () => {
  const inputs: StockCompInstrumentInput[] = [
    {
      instrumentId: "opt-1",
      stakeholderName: "Alice",
      type: "STOCK_OPTION",
      totalGrantDateFairValue: 400000,
      cumulativeExpenseRecognized: 100000, // unrecognized = 300,000
      serviceEndDate: "2027-01-01", // exactly 2 years from asOfDate below
      asOfDate: "2025-01-01",
    },
    {
      instrumentId: "rsu-1",
      stakeholderName: "Bob",
      type: "RSU",
      totalGrantDateFairValue: 100000,
      cumulativeExpenseRecognized: 90000, // unrecognized = 10,000
      serviceEndDate: "2026-01-01", // exactly 1 year from asOfDate
      asOfDate: "2025-01-01",
    },
  ];

  const result = buildStockCompDisclosure(inputs);

  assert.equal(result.rows[0].unrecognizedCompCost.toFixed(2), "300000.00");
  assert.equal(result.rows[1].unrecognizedCompCost.toFixed(2), "10000.00");
  // 2025-01-01 -> 2027-01-01 is 731 days (2025, 2026 span one leap day: 2027 isn't a
  // leap year but the range includes Feb 29 2028? No — daysBetween(2025-01-01,
  // 2027-01-01) = 365 + 365 = 730 (2025 and 2026 are both non-leap years) -> /365.25.
  assert.equal(result.rows[0].remainingRecognitionYears.toFixed(4), (730 / 365.25).toFixed(4));
  assert.equal(result.rows[1].remainingRecognitionYears.toFixed(4), (365 / 365.25).toFixed(4));

  assert.equal(result.totalUnrecognizedCompCost.toFixed(2), "310000.00");
  // Weighted average = (300,000 * (730/365.25) + 10,000 * (365/365.25)) / 310,000
  const expected = (300000 * (730 / 365.25) + 10000 * (365 / 365.25)) / 310000;
  assert.ok(Math.abs(result.weightedAverageRemainingYears - expected) < 1e-9);
});

test("buildStockCompDisclosure: a fully-vested award (service end in the past) contributes zero remaining years", () => {
  const inputs: StockCompInstrumentInput[] = [
    {
      instrumentId: "opt-2",
      stakeholderName: "Carol",
      type: "STOCK_OPTION",
      totalGrantDateFairValue: 50000,
      cumulativeExpenseRecognized: 50000,
      serviceEndDate: "2020-01-01",
      asOfDate: "2025-01-01",
    },
  ];
  const result = buildStockCompDisclosure(inputs);
  assert.equal(result.rows[0].remainingRecognitionYears, 0);
  assert.equal(result.rows[0].unrecognizedCompCost.toFixed(2), "0.00");
  assert.equal(result.weightedAverageRemainingYears, 0);
});

test("buildStockCompDisclosure: empty input returns zeroed summary, not an error", () => {
  const result = buildStockCompDisclosure([]);
  assert.equal(result.rows.length, 0);
  assert.equal(result.totalUnrecognizedCompCost.toFixed(2), "0.00");
  assert.equal(result.weightedAverageRemainingYears, 0);
});

// --- v0.20.0: settlement/exercise activity disclosure rollup ---------------------

import { buildSettlementActivityDisclosure, SettlementActivityInput } from "../src/lib/accounting/reporting.js";

test("settlement activity disclosure: aggregates a mix of cash exercises and net settlements", () => {
  const inputs: SettlementActivityInput[] = [
    { instrumentId: "opt-1", stakeholderName: "Alice", type: "CASH_EXERCISE", sharesIssued: 10_000, cashReceivedFromExercise: 20_000 },
    { instrumentId: "rsu-1", stakeholderName: "Bob", type: "NET_SHARE_SETTLEMENT", sharesIssued: 6_300, taxWithholdingAmount: 37_000 },
    { instrumentId: "opt-2", stakeholderName: "Carol", type: "NET_SHARE_SETTLEMENT", sharesIssued: 2_667, taxWithholdingAmount: 18_000 },
  ];
  const summary = buildSettlementActivityDisclosure(inputs);

  assert.equal(summary.totalSharesIssued.toFixed(0), "18967"); // 10,000 + 6,300 + 2,667
  assert.equal(summary.totalCashReceivedFromExercise.toFixed(2), "20000.00");
  assert.equal(summary.totalTaxWithholdingAmount.toFixed(2), "55000.00"); // 37,000 + 18,000
  assert.equal(summary.transactionCountByType.CASH_EXERCISE, 1);
  assert.equal(summary.transactionCountByType.NET_SHARE_SETTLEMENT, 2);
  assert.equal(summary.rows.length, 3);
});

test("settlement activity disclosure: a cash exercise row defaults its tax-withholding field to zero", () => {
  const summary = buildSettlementActivityDisclosure([
    { instrumentId: "opt-1", stakeholderName: "Alice", type: "CASH_EXERCISE", sharesIssued: 1_000, cashReceivedFromExercise: 5_000 },
  ]);
  assert.equal(summary.rows[0].taxWithholdingAmount.toFixed(2), "0.00");
});

test("settlement activity disclosure: empty input returns zeroed totals, not an error", () => {
  const summary = buildSettlementActivityDisclosure([]);
  assert.equal(summary.totalSharesIssued.toFixed(2), "0.00");
  assert.equal(summary.totalCashReceivedFromExercise.toFixed(2), "0.00");
  assert.equal(summary.totalTaxWithholdingAmount.toFixed(2), "0.00");
  assert.equal(summary.transactionCountByType.CASH_EXERCISE, 0);
  assert.equal(summary.transactionCountByType.NET_SHARE_SETTLEMENT, 0);
});
