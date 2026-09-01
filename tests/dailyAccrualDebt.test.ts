import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDailyAccrualDetail,
  buildDailyAccrualSchedule,
} from "../src/lib/accounting/debtAmortization.js";
import { dailyAccrualInterestEntry } from "../src/lib/accounting/journalEntries.js";
import { checkReconciliation } from "../src/lib/accounting/reporting.js";
import { buildMonthlyPeriods } from "../src/lib/accounting/dateMath.js";
import { money } from "../src/lib/accounting/types.js";

/**
 * GOLDEN SCENARIO 1 — constant rate, ACT/360, no mid-month activity: sanity-checks
 * the daily loop against a closed-form calculation before adding any complexity.
 * $1,000,000 at a constant 6.00% annual rate, ACT/360, for January (31 days).
 * Hand check: 1,000,000 * 0.06 / 360 = $166.666666... per day * 31 days = $5,166.666...
 * -> rounds to $5,166.67.
 */
test("buildDailyAccrualSchedule: constant rate, no mid-period activity, matches the closed-form daily-simple-interest calculation", () => {
  const schedule = buildDailyAccrualSchedule(
    {
      initialPrincipal: 1_000_000,
      startDate: "2025-01-01",
      rateSegments: [{ effectiveDate: "2025-01-01", annualRate: 0.06 }],
      dayCountConvention: "ACT/360",
    },
    buildMonthlyPeriods("2025-01-01", "2025-02-01")
  );
  assert.equal(schedule.length, 1);
  assert.equal(schedule[0].amount.toFixed(2), "5166.67");
  assert.equal(schedule[0].endingBalance!.toFixed(2), "1000000.00");
});

/**
 * GOLDEN SCENARIO 2 — mid-month RATE RESET, no principal change: a SOFR-indexed loan
 * resets from 6.00% to 6.50% on January 15 (a date with no relationship to the
 * monthly reporting period boundary). ACT/360.
 * Hand check: days 1-14 (14 days) at 6.00%: 1,000,000 * 0.06 / 360 = 166.666667/day
 *   * 14 = 2,333.333333
 * Days 15-31 (17 days) at 6.50%: 1,000,000 * 0.065 / 360 = 180.555556/day * 17 =
 *   3,069.444444
 * Total = 2,333.333333 + 3,069.444444 = 5,402.777778 -> rounds to $5,402.78.
 */
test("buildDailyAccrualSchedule: a mid-month rate reset splits the period into two correctly-weighted segments", () => {
  const schedule = buildDailyAccrualSchedule(
    {
      initialPrincipal: 1_000_000,
      startDate: "2025-01-01",
      rateSegments: [
        { effectiveDate: "2025-01-01", annualRate: 0.06 },
        { effectiveDate: "2025-01-15", annualRate: 0.065 },
      ],
      dayCountConvention: "ACT/360",
    },
    buildMonthlyPeriods("2025-01-01", "2025-02-01")
  );
  assert.equal(schedule[0].amount.toFixed(2), "5402.78");
  // The reset shows up in the audit-trail metadata, not just the total.
  const rateChanges = schedule[0].meta!.rateChangesInPeriod as { effectiveDate: string; annualRate: string }[];
  assert.equal(rateChanges.length, 2);
  assert.equal(rateChanges[1].effectiveDate, "2025-01-15");
});

/**
 * GOLDEN SCENARIO 3 — mid-month PRINCIPAL PAYDOWN, no rate change: a $200,000
 * paydown on January 20 (again, a date unrelated to the period boundary). Constant
 * 6.50% throughout, ACT/360.
 * Hand check: days 1-19 (19 days) at $1,000,000: 1,000,000*0.065/360=180.555556/day
 *   * 19 = 3,430.555556
 * Days 20-31 (12 days) at $800,000 (the paydown applies ON the 20th, per this
 *   module's documented convention): 800,000*0.065/360=144.444444/day * 12 =
 *   1,733.333333
 * Total = 3,430.555556 + 1,733.333333 = 5,163.888889 -> rounds to $5,163.89.
 * Ending balance for the period must reflect the paydown: $800,000.
 */
test("buildDailyAccrualSchedule: a mid-month principal paydown reduces interest starting the day it's applied, and flows through to the ending balance", () => {
  const schedule = buildDailyAccrualSchedule(
    {
      initialPrincipal: 1_000_000,
      startDate: "2025-01-01",
      rateSegments: [{ effectiveDate: "2025-01-01", annualRate: 0.065 }],
      principalEvents: [{ date: "2025-01-20", amount: money(-200_000) }],
      dayCountConvention: "ACT/360",
    },
    buildMonthlyPeriods("2025-01-01", "2025-02-01")
  );
  assert.equal(schedule[0].amount.toFixed(2), "5163.89");
  assert.equal(schedule[0].endingBalance!.toFixed(2), "800000.00");
});

test("buildDailyAccrualDetail: exposes the exact day a principal event and a rate reset each take effect, for hand-verification", () => {
  const days = buildDailyAccrualDetail(
    {
      initialPrincipal: 1_000_000,
      startDate: "2025-01-01",
      rateSegments: [
        { effectiveDate: "2025-01-01", annualRate: 0.06 },
        { effectiveDate: "2025-01-15", annualRate: 0.065 },
      ],
      principalEvents: [{ date: "2025-01-20", amount: money(-200_000) }],
      dayCountConvention: "ACT/360",
    },
    "2025-01-31" // through Jan 30 inclusive (exclusive end)
  );
  const jan14 = days.find((d) => d.date === "2025-01-14")!;
  const jan15 = days.find((d) => d.date === "2025-01-15")!;
  const jan19 = days.find((d) => d.date === "2025-01-19")!;
  const jan20 = days.find((d) => d.date === "2025-01-20")!;

  assert.equal(jan14.annualRate.toFixed(4), "0.0600");
  assert.equal(jan15.annualRate.toFixed(4), "0.0650"); // reset takes effect same-day
  assert.equal(jan19.balance.toFixed(2), "1000000.00");
  assert.equal(jan20.balance.toFixed(2), "800000.00"); // paydown takes effect same-day
});

test("buildDailyAccrualSchedule: ACT/360 and ACT/365 produce different interest on identical balances and rates", () => {
  const inputs360 = {
    initialPrincipal: 1_000_000,
    startDate: "2025-01-01",
    rateSegments: [{ effectiveDate: "2025-01-01", annualRate: 0.06 }],
    dayCountConvention: "ACT/360" as const,
  };
  const inputs365 = { ...inputs360, dayCountConvention: "ACT/365" as const };
  const periods = buildMonthlyPeriods("2025-01-01", "2025-02-01");

  const act360 = buildDailyAccrualSchedule(inputs360, periods)[0].amount;
  const act365 = buildDailyAccrualSchedule(inputs365, periods)[0].amount;

  // Same numerator, smaller divisor (360 < 365) -> ACT/360 always produces MORE
  // interest for the same nominal rate — a fact worth a dedicated regression test
  // since it's a common source of "why don't these two lenders' numbers match."
  assert.ok(act360.greaterThan(act365));
  assert.equal(act360.toFixed(2), "5166.67");
  assert.equal(act365.toFixed(2), "5095.89"); // 1,000,000 * 0.06 / 365 * 31 = 5,095.890411
});

test("buildDailyAccrualSchedule: multi-period rollup carries the ending balance forward correctly across a mid-period paydown that crosses a period boundary", () => {
  const schedule = buildDailyAccrualSchedule(
    {
      initialPrincipal: 1_000_000,
      startDate: "2025-01-01",
      rateSegments: [{ effectiveDate: "2025-01-01", annualRate: 0.065 }],
      principalEvents: [{ date: "2025-01-20", amount: money(-200_000) }],
      dayCountConvention: "ACT/360",
    },
    buildMonthlyPeriods("2025-01-01", "2025-03-01") // January + February
  );
  assert.equal(schedule.length, 2);
  assert.equal(schedule[0].endingBalance!.toFixed(2), "800000.00"); // January, post-paydown
  assert.equal(schedule[1].endingBalance!.toFixed(2), "800000.00"); // February, no further activity
  // February's interest should be computed on the full $800,000 for all 28 days (2025
  // is not a leap year): 800,000 * 0.065 / 360 = 144.444444/day * 28 = 4,044.444444.
  assert.equal(schedule[1].amount.toFixed(2), "4044.44");
});

test("buildDailyAccrualDetail: throws if no rate segment covers the start date", () => {
  assert.throws(
    () =>
      buildDailyAccrualDetail(
        { initialPrincipal: 1000, startDate: "2025-01-01", rateSegments: [{ effectiveDate: "2025-02-01", annualRate: 0.05 }] },
        "2025-01-31"
      ),
    /rateSegments must include a segment effective on or before startDate/
  );
});

test("dailyAccrualInterestEntry: paying exactly the period's full-precision accrual books Dr Interest Expense / Cr Cash only, and balances", () => {
  const accrualOnly = buildDailyAccrualSchedule(
    {
      initialPrincipal: 1_000_000,
      startDate: "2025-01-01",
      rateSegments: [{ effectiveDate: "2025-01-01", annualRate: 0.06 }],
      dayCountConvention: "ACT/360",
    },
    buildMonthlyPeriods("2025-01-01", "2025-02-01")
  );
  const exactAccrual = accrualOnly[0].amount; // full 16-digit precision, not rounded to the cent

  const schedule = buildDailyAccrualSchedule(
    {
      initialPrincipal: 1_000_000,
      startDate: "2025-01-01",
      rateSegments: [{ effectiveDate: "2025-01-01", annualRate: 0.06 }],
      interestPayments: [{ date: "2025-01-31", amount: exactAccrual }],
      dayCountConvention: "ACT/360",
    },
    buildMonthlyPeriods("2025-01-01", "2025-02-01")
  );
  const entry = dailyAccrualInterestEntry(schedule[0]);
  assert.equal(entry.lines.length, 2);
  const cashLine = entry.lines.find((l) => l.account === "Cash");
  assert.equal(cashLine?.credit?.toFixed(2), "5166.67");
  assert.equal(checkReconciliation([entry])[0].balanced, true);
});

test("dailyAccrualInterestEntry: paying the penny-ROUNDED accrual (the realistic case — a wire is sent for $5,166.67, not a 16-digit figure) leaves a sub-cent residual in Accrued Interest Payable rather than silently dropping it", () => {
  const schedule = buildDailyAccrualSchedule(
    {
      initialPrincipal: 1_000_000,
      startDate: "2025-01-01",
      rateSegments: [{ effectiveDate: "2025-01-01", annualRate: 0.06 }],
      interestPayments: [{ date: "2025-01-31", amount: money("5166.67") }],
      dayCountConvention: "ACT/360",
    },
    buildMonthlyPeriods("2025-01-01", "2025-02-01")
  );
  const entry = dailyAccrualInterestEntry(schedule[0]);
  assert.equal(entry.lines.length, 3);
  const payableLine = entry.lines.find((l) => l.account === "Accrued Interest Payable");
  // 5,166.666666... - 5,166.67 = -0.00333... — a fraction of a cent, correctly carried
  // rather than rounded away, since silently dropping sub-cent amounts is exactly the
  // kind of drift that eventually shows up as an out-of-balance account.
  assert.equal(payableLine?.debit?.toFixed(4), "0.0033");
  assert.equal(checkReconciliation([entry])[0].balanced, true);
});

test("dailyAccrualInterestEntry: no cash paid in the period books the full accrual to Accrued Interest Payable", () => {
  const schedule = buildDailyAccrualSchedule(
    {
      initialPrincipal: 1_000_000,
      startDate: "2025-01-01",
      rateSegments: [{ effectiveDate: "2025-01-01", annualRate: 0.06 }],
      dayCountConvention: "ACT/360",
    },
    buildMonthlyPeriods("2025-01-01", "2025-02-01")
  );
  const entry = dailyAccrualInterestEntry(schedule[0]);
  const payableLine = entry.lines.find((l) => l.account === "Accrued Interest Payable");
  assert.equal(payableLine?.credit?.toFixed(2), "5166.67");
  assert.equal(checkReconciliation([entry])[0].balanced, true);
});

test("dailyAccrualInterestEntry: cash paid in EXCESS of the period's accrual (paying down a prior period's accrual) debits Accrued Interest Payable instead", () => {
  const schedule = buildDailyAccrualSchedule(
    {
      initialPrincipal: 1_000_000,
      startDate: "2025-01-01",
      rateSegments: [{ effectiveDate: "2025-01-01", annualRate: 0.06 }],
      interestPayments: [{ date: "2025-01-31", amount: money("6000.00") }], // more than the 5,166.67 accrued
      dayCountConvention: "ACT/360",
    },
    buildMonthlyPeriods("2025-01-01", "2025-02-01")
  );
  const entry = dailyAccrualInterestEntry(schedule[0]);
  const payableLine = entry.lines.find((l) => l.account === "Accrued Interest Payable");
  assert.equal(payableLine?.debit?.toFixed(2), "833.33"); // 6000.00 - 5166.67
  assert.equal(checkReconciliation([entry])[0].balanced, true);
});
