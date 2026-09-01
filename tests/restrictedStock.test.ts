import test from "node:test";
import assert from "node:assert/strict";
import { buildRepurchaseRightLapseSchedule, RepurchaseRightLapseGrant } from "../src/lib/accounting/restrictedStock.js";
import { restrictedStockEntry } from "../src/lib/accounting/journalEntries.js";
import { checkReconciliation } from "../src/lib/accounting/reporting.js";
import { JournalEntry, Decimal, ScheduleRow } from "../src/lib/accounting/types.js";

/**
 * These tests exercise `buildRepurchaseRightLapseSchedule` and `restrictedStockEntry`
 * directly (the two genuinely new pieces this module contributes — the expense half is
 * just `buildServiceConditionSchedule`, already exhaustively tested in vesting.test.ts
 * and re-verified for the RESTRICTED_STOCK wiring specifically in dispatch.test.ts).
 *
 * GOLDEN SCENARIO: 6,000 shares at $0.05/share purchase price, vesting in three equal
 * 2,000-share tranches at the end of three annual periods. Hand check per period:
 *   Period 1: tranche 1 (2,000 sh) vests exactly at this period's own end — reclass =
 *     2,000 * $0.05 = $100. Cumulative = $100.
 *   Period 2: tranche 2 (2,000 sh) vests — reclass = $100. Cumulative = $200.
 *   Period 3: tranche 3 (2,000 sh) vests — reclass = $100. Cumulative = $300 = 6,000 *
 *     $0.05 exactly — the full purchase price, nothing left in the liability.
 */
const grant: RepurchaseRightLapseGrant = {
  quantity: 6000,
  purchasePricePerShare: 0.05,
  tranches: [
    { id: "t1", vestDate: "2026-01-01", quantity: 2000 },
    { id: "t2", vestDate: "2027-01-01", quantity: 2000 },
    { id: "t3", vestDate: "2028-01-01", quantity: 2000 },
  ],
};
const periods = [
  { label: "2025", start: "2025-01-01", end: "2026-01-01" },
  { label: "2026", start: "2026-01-01", end: "2027-01-01" },
  { label: "2027", start: "2027-01-01", end: "2028-01-01" },
];

test("buildRepurchaseRightLapseSchedule: each period reclassifies exactly the purchase price of the tranche(s) vesting within it", () => {
  const schedule = buildRepurchaseRightLapseSchedule(grant, periods);
  assert.equal(schedule.length, 3);
  assert.equal(schedule[0].amount.toFixed(2), "100.00");
  assert.equal(schedule[0].endingBalance!.toFixed(2), "100.00");
  assert.equal(schedule[1].amount.toFixed(2), "100.00");
  assert.equal(schedule[1].endingBalance!.toFixed(2), "200.00");
  assert.equal(schedule[2].amount.toFixed(2), "100.00");
  assert.equal(schedule[2].endingBalance!.toFixed(2), "300.00");
});

test("buildRepurchaseRightLapseSchedule: a period with no tranche vesting in it reclassifies nothing, and the cumulative balance holds steady", () => {
  const sparseGrant: RepurchaseRightLapseGrant = {
    quantity: 2000,
    purchasePricePerShare: 1.0,
    tranches: [{ id: "t1", vestDate: "2026-01-01", quantity: 2000 }],
  };
  const schedule = buildRepurchaseRightLapseSchedule(sparseGrant, periods);
  assert.equal(schedule[0].amount.toFixed(2), "2000.00");
  assert.equal(schedule[1].amount.toFixed(2), "0.00");
  assert.equal(schedule[1].endingBalance!.toFixed(2), "2000.00");
  assert.equal(schedule[2].amount.toFixed(2), "0.00");
  assert.equal(schedule[2].endingBalance!.toFixed(2), "2000.00");
});

test("buildRepurchaseRightLapseSchedule: stamps the vested tranche ids into meta for each period, empty when nothing vests", () => {
  const schedule = buildRepurchaseRightLapseSchedule(grant, periods);
  assert.deepEqual(schedule[0].meta!.vestedTrancheIds, ["t1"]);
  assert.deepEqual(schedule[1].meta!.vestedTrancheIds, ["t2"]);
  assert.equal(schedule[0].meta!.ascReference, "ASC 718-10-25-9 (repurchase right lapse — reclassifies the purchase price of newly-vested shares from a liability into issued equity)");
});

test("buildRepurchaseRightLapseSchedule: requires at least one vesting tranche", () => {
  assert.throws(() => buildRepurchaseRightLapseSchedule({ ...grant, tranches: [] }, periods), /at least one vesting tranche/);
});

test("restrictedStockEntry: posts both the compensation-expense pair and the repurchase-right-lapse reclass pair, always both even when the reclass is zero", () => {
  const schedule = buildRepurchaseRightLapseSchedule(grant, periods);
  const expenseRow: ScheduleRow = {
    periodStart: "2025-01-01",
    periodEnd: "2026-01-01",
    label: "2025",
    amount: new Decimal(4000),
    meta: {
      ascReference: "ASC 718-10-35 (service condition)",
      repurchaseRightLapseAmount: schedule[0].amount.toString(),
      cumulativeReclassifiedToEquity: schedule[0].endingBalance!.toString(),
    },
  };
  const entry = restrictedStockEntry(expenseRow);
  assert.equal(entry.lines.find((l) => l.account === "Stock Compensation Expense")!.debit!.toFixed(2), "4000.00");
  assert.equal(entry.lines.find((l) => l.account === "Additional Paid-In Capital")!.credit!.toFixed(2), "4000.00");
  assert.equal(
    entry.lines.find((l) => l.account === "Early Exercise Liability (unvested shares subject to repurchase)")!.debit!.toFixed(2),
    "100.00"
  );
  assert.equal(entry.lines.find((l) => l.account === "Common Stock / Additional Paid-In Capital")!.credit!.toFixed(2), "100.00");
  assert.equal(entry.lines.length, 4);
});

test("restrictedStockEntry: a negative (forfeiture reversal) compensation-expense amount flips debit/credit rather than posting a negative line, independent of the reclass pair", () => {
  const reversalRow: ScheduleRow = {
    periodStart: "2026-01-01",
    periodEnd: "2027-01-01",
    label: "2026 (forfeiture reversal)",
    amount: new Decimal(-500),
    meta: { repurchaseRightLapseAmount: "0", cumulativeReclassifiedToEquity: "100" },
  };
  const entry = restrictedStockEntry(reversalRow);
  assert.equal(entry.lines.find((l) => l.account === "Additional Paid-In Capital")!.debit!.toFixed(2), "500.00");
  assert.equal(entry.lines.find((l) => l.account === "Stock Compensation Expense")!.credit!.toFixed(2), "500.00");
  for (const line of entry.lines) {
    assert.ok(!line.debit || !line.debit.isNegative(), "no negative-valued debit line");
    assert.ok(!line.credit || !line.credit.isNegative(), "no negative-valued credit line");
  }
});

test("restrictedStockEntry: every period's entry across the full three-period schedule is internally balanced (assertBalanced doesn't throw)", () => {
  const schedule = buildRepurchaseRightLapseSchedule(grant, periods);
  const expenseAmounts = [new Decimal(4000), new Decimal(4000), new Decimal(0)]; // arbitrary, unrelated to the reclass amounts on purpose
  const entries: JournalEntry[] = schedule.map((row, i) =>
    restrictedStockEntry({
      ...row,
      amount: expenseAmounts[i],
      meta: { ...row.meta, repurchaseRightLapseAmount: row.amount.toString(), cumulativeReclassifiedToEquity: row.endingBalance!.toString() },
    })
  );
  const rec = checkReconciliation(entries);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].balanced, true);
});
