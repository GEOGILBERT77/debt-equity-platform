import test from "node:test";
import assert from "node:assert/strict";
import { stockCompExpenseEntry, debtInterestExpenseEntry } from "../src/lib/accounting/journalEntries.js";
import { buildConversionEntry } from "../src/lib/accounting/convertibleNote.js";
import { blackScholesCallValue } from "../src/lib/accounting/blackScholes.js";
import { money, assertBalanced } from "../src/lib/accounting/types.js";
import { buildEffectiveInterestSchedule } from "../src/lib/accounting/debtAmortization.js";

test("stockCompExpenseEntry: a positive expense debits expense and credits APIC, and balances", () => {
  const entry = stockCompExpenseEntry({
    periodStart: "2025-01-01",
    periodEnd: "2026-01-01",
    label: "Y1",
    amount: money(5995.89),
  });
  assert.equal(entry.lines[0].account, "Stock Compensation Expense");
  assert.equal(entry.lines[0].debit?.toFixed(2), "5995.89");
  assertBalanced(entry); // throws if it doesn't tie out — this is the actual assertion
});

test("stockCompExpenseEntry: a reversal (negative amount) flips debit/credit rather than posting a negative number", () => {
  const entry = stockCompExpenseEntry({
    periodStart: "2026-01-01",
    periodEnd: "2027-01-01",
    label: "Y2 reversal",
    amount: money(-5000),
  });
  assert.equal(entry.lines[0].account, "Additional Paid-In Capital");
  assert.equal(entry.lines[0].debit?.toFixed(2), "5000.00");
  assert.ok(entry.lines.every((l) => !l.debit?.isNegative() && !l.credit?.isNegative()));
  assertBalanced(entry);
});

test("debtInterestExpenseEntry: a cash-pay period books interest, cash, and discount amortization in balance", () => {
  const [row] = buildEffectiveInterestSchedule(
    {
      faceValue: 100000,
      netProceeds: 95000,
      effectiveAnnualYield: 5000 / 95000,
      cashFlows: [{ date: "2026-01-01", amount: 100000 }],
    },
    [{ label: "Year 1", start: "2025-01-01", end: "2026-01-01" }]
  );
  const entry = debtInterestExpenseEntry(row);
  assertBalanced(entry);
});

test("buildConversionEntry: converting a note extinguishes it into common stock + APIC with no gain/loss", () => {
  const entry = buildConversionEntry("2027-06-01", money(100000), 20000, 0.001);
  assertBalanced(entry);
  const parLine = entry.lines.find((l) => l.account.startsWith("Common Stock"));
  assert.equal(parLine?.credit?.toFixed(2), "20.00"); // 20,000 shares * $0.001 par
});

test("blackScholesCallValue: an at-the-money call has a plausible fair value between zero and the stock price", () => {
  const value = blackScholesCallValue({
    stockPrice: 10,
    strikePrice: 10,
    riskFreeRate: 0.045,
    volatility: 0.55,
    expectedTermYears: 6,
  });
  const v = value.toNumber();
  assert.ok(v > 0 && v < 10, `expected a plausible option value between 0 and 10, got ${v}`);
  // Deep-in-the-money-vs-time sanity check: a longer expected term should never be
  // worth less than a shorter one, all else equal (time value only adds optionality).
  const shorterTerm = blackScholesCallValue({
    stockPrice: 10,
    strikePrice: 10,
    riskFreeRate: 0.045,
    volatility: 0.55,
    expectedTermYears: 1,
  }).toNumber();
  assert.ok(v > shorterTerm, "a 6-year expected term should be worth more than a 1-year term");
});
