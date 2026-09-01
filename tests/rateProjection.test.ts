import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProjectedRateSegments,
  buildDailyAccrualSchedule,
} from "../src/lib/accounting/debtAmortization.js";
import { buildMonthlyPeriods } from "../src/lib/accounting/dateMath.js";

const knownHistory = [
  { effectiveDate: "2025-01-01", annualRate: 0.06 },
  { effectiveDate: "2025-01-15", annualRate: 0.065 }, // the last actually-realized reset
];

test("buildProjectedRateSegments: lockLatestReset holds the most recent known rate flat across every future reset date", () => {
  const combined = buildProjectedRateSegments(knownHistory, ["2025-02-15", "2025-03-15"], { type: "lockLatestReset" });
  assert.equal(combined.length, 4);
  const feb = combined.find((s) => s.effectiveDate === "2025-02-15")!;
  const mar = combined.find((s) => s.effectiveDate === "2025-03-15")!;
  assert.equal(String(feb.annualRate), "0.065");
  assert.equal(String(mar.annualRate), "0.065");
});

test("buildProjectedRateSegments: lockLatestReset applies an optional spread on top of the locked rate", () => {
  const combined = buildProjectedRateSegments(knownHistory, ["2025-02-15"], { type: "lockLatestReset" }, 0.01);
  const feb = combined.find((s) => s.effectiveDate === "2025-02-15")!;
  assert.equal(feb.annualRate.toString(), "0.075"); // 0.065 + 0.01
});

/**
 * GOLDEN SCENARIO (forward curve): an index forward curve (e.g. derived from SOFR
 * futures) gives 5% starting 2025-01-01, stepping up to 7% on 2025-02-15 and 8% on
 * 2025-03-15. A 100bps spread is layered on top for the loan's actual all-in rate.
 * Hand check: the Feb 15 reset should pick up the curve's 7% point (since it's
 * effective exactly on the reset date) plus the 1% spread = 8%; the Mar 15 reset
 * should pick up 8% + 1% = 9%.
 */
test("buildProjectedRateSegments: forwardCurve looks up each future reset date against the curve (held flat between points) and adds the spread", () => {
  const curve = [
    { date: "2025-01-01", rate: 0.05 },
    { date: "2025-02-15", rate: 0.07 },
    { date: "2025-03-15", rate: 0.08 },
  ];
  const combined = buildProjectedRateSegments(knownHistory, ["2025-02-15", "2025-03-15"], { type: "forwardCurve", curve }, 0.01);
  const feb = combined.find((s) => s.effectiveDate === "2025-02-15")!;
  const mar = combined.find((s) => s.effectiveDate === "2025-03-15")!;
  assert.equal(feb.annualRate.toString(), "0.08"); // 0.07 + 0.01
  assert.equal(mar.annualRate.toString(), "0.09"); // 0.08 + 0.01
});

test("buildProjectedRateSegments: a reset date on or before the latest known reset is rejected — only future resets get projected", () => {
  assert.throws(
    () => buildProjectedRateSegments(knownHistory, ["2025-01-15"], { type: "lockLatestReset" }),
    /is not after the latest known reset/
  );
});

test("buildProjectedRateSegments: a forward curve that doesn't cover a requested reset date throws rather than extrapolating", () => {
  const curve = [{ date: "2025-03-01", rate: 0.07 }]; // starts AFTER the requested reset date
  assert.throws(
    () => buildProjectedRateSegments(knownHistory, ["2025-02-01"], { type: "forwardCurve", curve }),
    /doesn't cover this date/
  );
});

/**
 * INTEGRATION: the combined known + projected segments feed straight into the daily
 * accrual engine with no changes needed there — proving the two features actually
 * compose, not just that each works in isolation. $1,000,000 balance, known 6.00% Jan
 * 1-14, 6.50% Jan 15-31 (matches the golden scenario in dailyAccrualDebt.test.ts), then
 * a LOCKED projection of 6.50% for February (28 days, 2025 not a leap year), ACT/360.
 * Hand check for February: 1,000,000 * 0.065 / 360 = 180.555556/day * 28 days =
 * 5,055.555556 -> rounds to $5,055.56.
 */
test("buildProjectedRateSegments composes with buildDailyAccrualSchedule: a locked-forward February reset accrues correctly", () => {
  const segments = buildProjectedRateSegments(knownHistory, ["2025-02-01"], { type: "lockLatestReset" });
  const schedule = buildDailyAccrualSchedule(
    {
      initialPrincipal: 1_000_000,
      startDate: "2025-01-01",
      rateSegments: segments,
      dayCountConvention: "ACT/360",
    },
    buildMonthlyPeriods("2025-01-01", "2025-03-01")
  );
  assert.equal(schedule.length, 2);
  assert.equal(schedule[0].amount.toFixed(2), "5402.78"); // January — same as the dedicated golden scenario
  assert.equal(schedule[1].amount.toFixed(2), "5055.56"); // February, at the locked-forward 6.50%
});
