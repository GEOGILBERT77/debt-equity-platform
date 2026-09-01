import test from "node:test";
import assert from "node:assert/strict";
import { determineNewPeriods, computeCloseBatch } from "../src/lib/accounting/closeService.js";
import { summarizeByAccount, checkReconciliation } from "../src/lib/accounting/reporting.js";
import { buildServiceConditionSchedule } from "../src/lib/accounting/vesting.js";
import { money } from "../src/lib/accounting/types.js";

const fourYearGrantSchedule = buildServiceConditionSchedule(
  {
    grantDate: "2025-01-01",
    quantity: 12000,
    grantDateFairValuePerUnit: 2,
    attributionMethod: "straight-line",
    tranches: [
      { id: "t1", vestDate: "2026-01-01", quantity: 3000 },
      { id: "t2", vestDate: "2027-01-01", quantity: 3000 },
      { id: "t3", vestDate: "2028-01-01", quantity: 3000 },
      { id: "t4", vestDate: "2029-01-01", quantity: 3000 },
    ],
  },
  [
    { label: "Y1", start: "2025-01-01", end: "2026-01-01" },
    { label: "Y2", start: "2026-01-01", end: "2027-01-01" },
    { label: "Y3", start: "2027-01-01", end: "2028-01-01" },
    { label: "Y4", start: "2028-01-01", end: "2029-01-01" },
  ]
);

test("determineNewPeriods: with no prior close, every period is new", () => {
  const result = determineNewPeriods(fourYearGrantSchedule, null);
  assert.equal(result.length, 4);
});

test("determineNewPeriods: only periods ending after the cutoff are new — this is what makes closing idempotent", () => {
  const result = determineNewPeriods(fourYearGrantSchedule, "2027-01-01"); // Y1, Y2 already closed
  assert.equal(result.length, 2);
  assert.equal(result[0].label, "Y3");
  assert.equal(result[1].label, "Y4");

  // Calling it again with the new cutoff (as the real close flow would after
  // persisting) returns nothing further — the actual idempotency guarantee.
  const secondCall = determineNewPeriods(fourYearGrantSchedule, "2029-01-01");
  assert.equal(secondCall.length, 0);
});

test("computeCloseBatch: produces one balanced journal entry per new period, and nothing for already-closed periods", () => {
  const batch = computeCloseBatch("STOCK_OPTION", fourYearGrantSchedule, "2027-01-01");
  assert.equal(batch.newScheduleRows.length, 2);
  assert.equal(batch.journalEntries.length, 2);

  // Every entry computeCloseBatch produces must already be internally balanced —
  // journalEntryForRow calls into mappers that assertBalanced at construction time,
  // so this is really testing that no entry silently slipped through unbalanced.
  const reconciliation = checkReconciliation(batch.journalEntries);
  assert.equal(reconciliation.length, 1); // one currency (the default, USD) in play
  assert.equal(reconciliation[0].balanced, true);
});

test("computeCloseBatch: refuses to compute entries for an instrument type with no journal-entry mapper", () => {
  // WARRANT, SAR, and PREFERRED_STOCK used to be the example here in turn, before
  // dispatch.ts wired each of them up (see dispatch.test.ts for their coverage now) —
  // COMMON_STOCK is genuinely still unwired for a periodic schedule/journal entry: it
  // never needed one (see capTable.ts's doc comment), so there's no engine module for
  // it at all, not just a missing dispatch.ts case.
  assert.throws(() => computeCloseBatch("COMMON_STOCK", fourYearGrantSchedule, null), /No journal-entry mapper/);
});

test("summarizeByAccount: aggregates debits and credits per account across multiple entries", () => {
  const batch = computeCloseBatch("STOCK_OPTION", fourYearGrantSchedule, null);
  const summary = summarizeByAccount(batch.journalEntries);

  const expenseLine = summary.find((s) => s.account === "Stock Compensation Expense");
  const apicLine = summary.find((s) => s.account === "Additional Paid-In Capital");
  assert.ok(expenseLine && apicLine);

  // Total expense across all four periods should tie back to the full $24,000 grant.
  assert.equal(expenseLine!.totalDebit.toFixed(2), "24000.00");
  assert.equal(apicLine!.totalCredit.toFixed(2), "24000.00");
});

test("checkReconciliation: flags a batch that doesn't net to zero across accounts", () => {
  const unbalancedEntries = [
    {
      date: "2025-01-01",
      description: "Deliberately malformed entry for this test",
      lines: [{ account: "Stock Compensation Expense", debit: money(100) }], // no offsetting credit anywhere
    },
  ];
  const result = checkReconciliation(unbalancedEntries);
  assert.equal(result.length, 1); // one currency (the default, USD) in play
  assert.equal(result[0].balanced, false);
  assert.equal(result[0].difference.toFixed(2), "100.00");
});
