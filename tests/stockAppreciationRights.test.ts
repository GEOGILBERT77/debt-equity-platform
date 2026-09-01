import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCashSettledSarSchedule,
  buildStockSettledSarSchedule,
  CashSettledSarGrant,
} from "../src/lib/accounting/stockAppreciationRights.js";
import { sarLiabilityExpenseEntry, stockCompExpenseEntry } from "../src/lib/accounting/journalEntries.js";
import { checkReconciliation } from "../src/lib/accounting/reporting.js";
import { JournalEntry } from "../src/lib/accounting/types.js";

/**
 * GOLDEN SCENARIO — cash-settled SAR (ASC 718-30): 1,000 units granted 2025-01-01,
 * cliff-vesting 2027-01-01 (a single tranche — total requisite service = 730 days:
 * 365 days in 2025 + 365 in 2026, neither a leap year, so this is an exact, hand-
 * checkable day count with no rounding ambiguity). Three annual periods with per-unit
 * fair value observations at each period end: $3.00 (2026-01-01, mid-vesting), $5.00
 * (2027-01-01, exactly fully vested), $4.00 (2028-01-01, one year AFTER full vesting —
 * value fell, and per ASC 718-30-35-3 that decline still flows through in full since
 * variable accounting continues after vesting, all the way to settlement).
 *
 * Hand check:
 *   Period 1 (2025): elapsed = 365/730 days = 0.5 exactly. Cumulative = 1000 * 3.00 *
 *     0.5 = $1,500. Expense = $1,500 - $0 = $1,500.
 *   Period 2 (2026): elapsed = 730/730 = 1.0 (exactly fully vested at this period's
 *     end). Cumulative = 1000 * 5.00 * 1.0 = $5,000. Expense = $5,000 - $1,500 = $3,500.
 *   Period 3 (2027): service fraction stays capped at 1.0 (fully vested, service
 *     doesn't "un-elapse"). Cumulative = 1000 * 4.00 * 1.0 = $4,000. Expense = $4,000 -
 *     $5,000 = -$1,000 — a GAIN (credit), because the SAR's value fell after the
 *     company had already fully earned it. This is the one behavior that has no
 *     equivalent in the equity-classified (stock option / stock-settled SAR) world:
 *     post-vesting remeasurement, including the possibility of a credit/gain period.
 */
const grant: CashSettledSarGrant = {
  grantDate: "2025-01-01",
  quantity: 1000,
  strikePrice: 10,
  tranches: [{ id: "t1", vestDate: "2027-01-01", quantity: 1000 }],
  observations: [
    { date: "2026-01-01", fairValuePerUnit: 3.0 },
    { date: "2027-01-01", fairValuePerUnit: 5.0 },
    { date: "2028-01-01", fairValuePerUnit: 4.0 },
  ],
};
const periods = [
  { label: "2025", start: "2025-01-01", end: "2026-01-01" },
  { label: "2026", start: "2026-01-01", end: "2027-01-01" },
  { label: "2027", start: "2027-01-01", end: "2028-01-01" },
];

test("buildCashSettledSarSchedule: mid-vesting period recognizes the service-elapsed fraction of current fair value", () => {
  const schedule = buildCashSettledSarSchedule(grant, periods);
  assert.equal(schedule[0].amount.toFixed(2), "1500.00");
  assert.equal(schedule[0].endingBalance!.toFixed(2), "1500.00");
  assert.equal(schedule[0].meta!.serviceFraction, "0.500000");
  assert.equal(schedule[0].meta!.fullyVested, false);
});

test("buildCashSettledSarSchedule: the period the award becomes fully vested recognizes the remaining cumulative catch-up", () => {
  const schedule = buildCashSettledSarSchedule(grant, periods);
  assert.equal(schedule[1].amount.toFixed(2), "3500.00");
  assert.equal(schedule[1].endingBalance!.toFixed(2), "5000.00");
  assert.equal(schedule[1].meta!.serviceFraction, "1.000000");
  assert.equal(schedule[1].meta!.fullyVested, true);
});

test("buildCashSettledSarSchedule: post-vesting fair value DECLINE still flows through as a full-magnitude credit (variable accounting doesn't stop at full vesting)", () => {
  const schedule = buildCashSettledSarSchedule(grant, periods);
  assert.equal(schedule[2].amount.toFixed(2), "-1000.00");
  assert.equal(schedule[2].endingBalance!.toFixed(2), "4000.00");
  assert.equal(schedule[2].meta!.fullyVested, true);
  assert.equal(schedule[2].meta!.ascReference, "ASC 718-30-35-3 (cash-settled SAR — liability remeasured to fair value each period)");
});

test("buildCashSettledSarSchedule: rejects a mismatched observations/periods length, same contract as FairValueRemeasurementInputs", () => {
  assert.throws(() => buildCashSettledSarSchedule({ ...grant, observations: grant.observations.slice(0, 2) }, periods), /one entry per period/);
});

test("buildCashSettledSarSchedule: rejects an observation dated to anything other than its own period's end", () => {
  const badGrant: CashSettledSarGrant = {
    ...grant,
    observations: [
      { date: "2025-06-30", fairValuePerUnit: 3.0 }, // wrong — period 0 ends 2026-01-01
      grant.observations[1],
      grant.observations[2],
    ],
  };
  assert.throws(() => buildCashSettledSarSchedule(badGrant, periods), /must be dated to their own period's end/);
});

test("buildCashSettledSarSchedule: requires at least one vesting tranche", () => {
  assert.throws(() => buildCashSettledSarSchedule({ ...grant, tranches: [] }, periods), /at least one vesting tranche/);
});

test("sarLiabilityExpenseEntry: a positive (expense) period debits SAR Compensation Expense and credits the SAR Liability", () => {
  const schedule = buildCashSettledSarSchedule(grant, periods);
  const entry = sarLiabilityExpenseEntry(schedule[0]);
  assert.equal(entry.lines.find((l) => l.account === "SAR Compensation Expense")!.debit!.toFixed(2), "1500.00");
  assert.equal(entry.lines.find((l) => l.account === "SAR Liability")!.credit!.toFixed(2), "1500.00");
});

test("sarLiabilityExpenseEntry: a negative (gain) period flips debit/credit rather than posting a negative line", () => {
  const schedule = buildCashSettledSarSchedule(grant, periods);
  const entry = sarLiabilityExpenseEntry(schedule[2]);
  assert.equal(entry.lines.find((l) => l.account === "SAR Liability")!.debit!.toFixed(2), "1000.00");
  assert.equal(entry.lines.find((l) => l.account === "SAR Compensation Expense")!.credit!.toFixed(2), "1000.00");
  for (const line of entry.lines) {
    assert.ok(!line.debit || !line.debit.isNegative(), "no negative-valued debit line");
    assert.ok(!line.credit || !line.credit.isNegative(), "no negative-valued credit line");
  }
});

test("sarLiabilityExpenseEntry: every period's entry is internally balanced (assertBalanced doesn't throw) across the full three-period schedule", () => {
  const schedule = buildCashSettledSarSchedule(grant, periods);
  const entries: JournalEntry[] = schedule.map((row) => sarLiabilityExpenseEntry(row));
  const rec = checkReconciliation(entries);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].balanced, true);
});

/**
 * GOLDEN SCENARIO — stock-settled SAR (ASC 718-10): same 1,000-unit grant, but the
 * strike price equals the grant-date share price and it settles in stock, so it's
 * economically identical, for measurement purposes, to a stock option — fixed
 * grant-date fair value ($2.50/unit, e.g. from a Black-Scholes run), no subsequent
 * remeasurement. 4-year straight-line vesting, single tranche for simplicity here
 * (buildServiceConditionSchedule's own tests already cover graded/multi-tranche
 * attribution in depth — this test exists to confirm the SAR wrapper delegates
 * correctly and relabels the ASC citation, not to re-prove straight-line attribution
 * math that's already covered elsewhere).
 *
 * Hand check: total value = 1000 * 2.50 = $2,500 over a 1-year service period
 * (2025-01-01 to 2026-01-01) with a single period spanning exactly that window — the
 * whole $2,500 is recognized in that one period.
 */
test("buildStockSettledSarSchedule: delegates to the exact same straight-line math as a stock option, with the ASC citation and settlementType relabeled", () => {
  const equityGrant = {
    grantDate: "2025-01-01",
    quantity: 1000,
    grantDateFairValuePerUnit: 2.5,
    tranches: [{ id: "t1", vestDate: "2026-01-01", quantity: 1000 }],
    attributionMethod: "straight-line" as const,
  };
  const onePeriod = [{ label: "2025", start: "2025-01-01", end: "2026-01-01" }];
  const schedule = buildStockSettledSarSchedule(equityGrant, onePeriod);
  assert.equal(schedule[0].amount.toFixed(2), "2500.00");
  assert.equal(schedule[0].meta!.ascReference, "ASC 718-10-35 (stock-settled SAR, equity-classified — measured like a stock option)");
  assert.equal(schedule[0].meta!.settlementType, "STOCK");
});

test("stockCompExpenseEntry works unmodified on a stock-settled SAR's rows, same as it does for a stock option or RSU", () => {
  const equityGrant = {
    grantDate: "2025-01-01",
    quantity: 1000,
    grantDateFairValuePerUnit: 2.5,
    tranches: [{ id: "t1", vestDate: "2026-01-01", quantity: 1000 }],
    attributionMethod: "straight-line" as const,
  };
  const onePeriod = [{ label: "2025", start: "2025-01-01", end: "2026-01-01" }];
  const schedule = buildStockSettledSarSchedule(equityGrant, onePeriod);
  const entry = stockCompExpenseEntry(schedule[0]);
  assert.equal(entry.lines.find((l) => l.account === "Stock Compensation Expense")!.debit!.toFixed(2), "2500.00");
  assert.equal(entry.lines.find((l) => l.account === "Additional Paid-In Capital")!.credit!.toFixed(2), "2500.00");
});
