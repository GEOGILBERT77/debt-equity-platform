import { test } from "node:test";
import assert from "node:assert/strict";
import {
  determineNonemployeeVestingTranches,
  buildNonemployeeAwardExpenseSchedule,
  buildNonemployeeAwardRecognitionEntry,
  laterOfRevenueRecognitionOrGrant,
} from "../src/lib/accounting/nonemployeeAwards.js";
import { money, assertBalanced } from "../src/lib/accounting/types.js";
import { buildAnnualPeriods } from "../src/lib/accounting/dateMath.js";

// --- determineNonemployeeVestingTranches (ASC 718-10-25-2C presumption) ---

test("determineNonemployeeVestingTranches: with no explicit future-performance condition, the award vests immediately on the grant date", () => {
  const tranches = determineNonemployeeVestingTranches({
    grantDate: "2026-01-01",
    quantity: 1000,
    grantDateFairValuePerUnit: 5,
    counterpartyType: "VENDOR_OR_CONSULTANT",
  });
  assert.equal(tranches.length, 1);
  assert.equal(tranches[0].vestDate, "2026-01-01");
  assert.equal(tranches[0].quantity, 1000);
});

test("determineNonemployeeVestingTranches: an explicit future-performance condition is passed through unchanged", () => {
  const explicit = [
    { id: "y1", vestDate: "2027-01-01", quantity: 500 },
    { id: "y2", vestDate: "2028-01-01", quantity: 500 },
  ];
  const tranches = determineNonemployeeVestingTranches({
    grantDate: "2026-01-01",
    quantity: 1000,
    grantDateFairValuePerUnit: 5,
    counterpartyType: "VENDOR_OR_CONSULTANT",
    explicitVestingTranches: explicit,
  });
  assert.deepEqual(tranches, explicit);
});

// --- buildNonemployeeAwardExpenseSchedule (reuses vesting.ts) ---

test("buildNonemployeeAwardExpenseSchedule: an immediately-vested award recognizes its full grant-date fair value in the period containing the grant date", () => {
  const periods = buildAnnualPeriods("2026-01-01", "2027-01-01");
  const schedule = buildNonemployeeAwardExpenseSchedule(
    {
      grantDate: "2026-01-01",
      quantity: 1000,
      grantDateFairValuePerUnit: 5,
      counterpartyType: "VENDOR_OR_CONSULTANT",
    },
    periods
  );
  const total = schedule.reduce((sum, r) => sum.plus(r.amount), money(0));
  // Hand-computed: 1000 shares * $5 = $5,000 total, all recognized immediately since
  // there is no future service left to spread it over.
  assert.equal(total.toFixed(2), "5000.00");
});

test("buildNonemployeeAwardExpenseSchedule: an explicit two-year vesting condition spreads the expense straight-line, same math as an employee grant", () => {
  const periods = buildAnnualPeriods("2026-01-01", "2028-01-01");
  const schedule = buildNonemployeeAwardExpenseSchedule(
    {
      grantDate: "2026-01-01",
      quantity: 1000,
      grantDateFairValuePerUnit: 10,
      counterpartyType: "VENDOR_OR_CONSULTANT",
      explicitVestingTranches: [{ id: "final", vestDate: "2028-01-01", quantity: 1000 }],
    },
    periods
  );
  const total = schedule.reduce((sum, r) => sum.plus(r.amount), money(0));
  // Hand-computed: 1000 * $10 = $10,000 total value, straight-line over exactly 2
  // full annual periods = $5,000/year.
  assert.equal(total.toFixed(2), "10000.00");
  assert.equal(schedule.length, 2);
  assert.equal(schedule[0].amount.toFixed(2), "5000.00");
  assert.equal(schedule[1].amount.toFixed(2), "5000.00");
});

// --- buildNonemployeeAwardRecognitionEntry (account selection by counterparty) ---

test("buildNonemployeeAwardRecognitionEntry: a vendor/consultant award debits Nonemployee Compensation Expense and balances", () => {
  const row = { periodStart: "2026-01-01", periodEnd: "2027-01-01", label: "Y1", amount: money(5000) };
  const entry = buildNonemployeeAwardRecognitionEntry(row, "VENDOR_OR_CONSULTANT");
  assert.equal(entry.lines[0].account, "Nonemployee Compensation Expense");
  assert.equal(entry.lines[0].debit?.toFixed(2), "5000.00");
  assert.equal(entry.lines[1].account, "Additional Paid-In Capital");
  assertBalanced(entry);
});

test("buildNonemployeeAwardRecognitionEntry: a customer award debits a Reduction of Revenue account instead of an expense account", () => {
  const row = { periodStart: "2026-01-01", periodEnd: "2027-01-01", label: "Y1", amount: money(5000) };
  const entry = buildNonemployeeAwardRecognitionEntry(row, "CUSTOMER");
  assert.match(entry.lines[0].account, /Reduction of Revenue/);
  assert.equal(entry.lines[0].debit?.toFixed(2), "5000.00");
  assertBalanced(entry);
});

test("buildNonemployeeAwardRecognitionEntry: a reversal still flips debit/credit correctly for the customer account name", () => {
  const row = { periodStart: "2026-01-01", periodEnd: "2027-01-01", label: "Y1 reversal", amount: money(-2000) };
  const entry = buildNonemployeeAwardRecognitionEntry(row, "CUSTOMER");
  assert.equal(entry.lines[0].account, "Additional Paid-In Capital");
  assert.equal(entry.lines[0].debit?.toFixed(2), "2000.00");
  assert.match(entry.lines[1].account, /Reduction of Revenue/);
  assert.equal(entry.lines[1].credit?.toFixed(2), "2000.00");
  assertBalanced(entry);
});

// --- laterOfRevenueRecognitionOrGrant (ASC 606-10-32-27) ---

test("laterOfRevenueRecognitionOrGrant: returns the grant date when it's later than revenue recognition", () => {
  const result = laterOfRevenueRecognitionOrGrant({ awardGrantDate: "2026-06-01", revenueRecognitionDate: "2026-01-01" });
  assert.equal(result, "2026-06-01");
});

test("laterOfRevenueRecognitionOrGrant: returns the revenue recognition date when it's later than the grant date", () => {
  const result = laterOfRevenueRecognitionOrGrant({ awardGrantDate: "2026-01-01", revenueRecognitionDate: "2026-06-01" });
  assert.equal(result, "2026-06-01");
});

test("laterOfRevenueRecognitionOrGrant: returns the (shared) date when both are identical", () => {
  const result = laterOfRevenueRecognitionOrGrant({ awardGrantDate: "2026-03-15", revenueRecognitionDate: "2026-03-15" });
  assert.equal(result, "2026-03-15");
});

// --- stockCompExpenseEntry backward compatibility (existing callers omit the new second arg) ---

test("stockCompExpenseEntry: omitting the new expenseAccountName argument still defaults to 'Stock Compensation Expense'", async () => {
  const { stockCompExpenseEntry } = await import("../src/lib/accounting/journalEntries.js");
  const entry = stockCompExpenseEntry({ periodStart: "2026-01-01", periodEnd: "2027-01-01", label: "Y1", amount: money(1234.56) });
  assert.equal(entry.lines[0].account, "Stock Compensation Expense");
  assertBalanced(entry);
});
