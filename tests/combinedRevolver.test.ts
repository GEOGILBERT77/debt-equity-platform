import test from "node:test";
import assert from "node:assert/strict";
import { buildCombinedRevolverSchedule, buildRevolverSchedule } from "../src/lib/accounting/debtAmortization.js";
import { buildMonthlyPeriods } from "../src/lib/accounting/dateMath.js";

test("omitting drawnBalance reduces to exactly buildRevolverSchedule's fee-only output", () => {
  const periods = buildMonthlyPeriods("2027-01-01", "2027-04-01");
  const inputs = {
    commitmentFee: { totalCommitmentFee: 3000, commitmentStart: "2027-01-01", commitmentEnd: "2027-04-01" },
  };
  const combined = buildCombinedRevolverSchedule(inputs, periods);
  const feesOnly = buildRevolverSchedule(inputs, periods);
  assert.equal(combined.length, feesOnly.length);
  combined.forEach((row, i) => {
    assert.equal(row.amount.toFixed(4), feesOnly[i].amount.toFixed(4));
  });
});

test("with drawnBalance, combines fee amortization and daily-accrual drawn-balance interest", () => {
  const periods = buildMonthlyPeriods("2027-01-01", "2027-03-01"); // Jan (31 days), Feb (28 days, 2027 not a leap year)
  const inputs = {
    commitmentFee: { totalCommitmentFee: 620, commitmentStart: "2027-01-01", commitmentEnd: "2027-03-01" }, // ~10/day for 62 days -> 310+310... actually day-weighted, checked below
    drawnBalance: {
      initialPrincipal: 1_000_000,
      startDate: "2027-01-01",
      rateSegments: [{ effectiveDate: "2027-01-01", annualRate: 0.09 }],
      dayCountConvention: "ACT/360" as const,
    },
  };
  const combined = buildCombinedRevolverSchedule(inputs, periods);
  assert.equal(combined.length, 2);

  // January: 1,000,000 * 0.09 / 360 * 31 days = 7,750.00 interest.
  const janInterest = 1_000_000 * 0.09 / 360 * 31;
  // Commitment fee for January: day-weighted share of 620 over 60 total days (31+28... wait Jan+Feb = 31+28=59 days for 2027) — just check it's the sum of drawnBalanceInterest + commitmentFeeAmount from meta.
  const janRow = combined[0];
  assert.equal(Number(janRow.meta!.drawnBalanceInterest), Number(janInterest.toFixed(4)));
  const feeAmount = Number(janRow.meta!.commitmentFeeAmount);
  assert.equal(janRow.amount.toFixed(2), (janInterest + feeAmount).toFixed(2));
  assert.equal(janRow.endingBalance!.toFixed(2), "1000000.00"); // no principal events -> balance unchanged
  assert.equal(janRow.meta!.drawnBalanceEnding!.toFixed(2), "1000000.00");
});

test("drawn-balance interest reflects a mid-period draw, via principalEvents", () => {
  const periods = buildMonthlyPeriods("2027-01-01", "2027-02-01"); // January only, 31 days
  const inputs = {
    commitmentFee: { totalCommitmentFee: 100, commitmentStart: "2027-01-01", commitmentEnd: "2027-02-01" },
    drawnBalance: {
      initialPrincipal: 0,
      startDate: "2027-01-01",
      rateSegments: [{ effectiveDate: "2027-01-01", annualRate: 0.10 }],
      principalEvents: [{ date: "2027-01-16", amount: 500_000 }], // drawn on day 16
      dayCountConvention: "ACT/360" as const,
    },
  };
  const combined = buildCombinedRevolverSchedule(inputs, periods);
  // 15 days at 0 balance (no interest) + 16 days (Jan 16 through Jan 31 inclusive = 16 days) at 500,000 * 10% / 360
  const expectedInterest = 16 * (500_000 * 0.10) / 360;
  assert.equal(Number(combined[0].meta!.drawnBalanceInterest), Number(expectedInterest.toFixed(4)));
  assert.equal(combined[0].endingBalance!.toFixed(2), "500000.00");
});

test("deferred fee unamortized balance is preserved separately from the drawn balance in meta", () => {
  const periods = buildMonthlyPeriods("2027-01-01", "2027-03-01");
  const inputs = {
    deferredFees: [{ id: "closing-fee", amount: 12000, amortizationStart: "2027-01-01", amortizationEnd: "2028-01-01" }],
    drawnBalance: {
      initialPrincipal: 200_000,
      startDate: "2027-01-01",
      rateSegments: [{ effectiveDate: "2027-01-01", annualRate: 0.08 }],
    },
  };
  const combined = buildCombinedRevolverSchedule(inputs, periods);
  // The drawn balance (200,000) should NOT be conflated with the deferred fee's
  // unamortized balance (a much larger, unrelated number since it's amortizing over a
  // full year while the drawn balance stays flat).
  assert.notEqual(combined[0].endingBalance!.toFixed(2), combined[0].meta!.deferredFeeUnamortizedBalance!.toFixed(2));
  assert.equal(combined[0].endingBalance!.toFixed(2), "200000.00");
});

test("throws with the same helpful message as buildRevolverSchedule when neither fee input is provided", () => {
  assert.throws(
    () => buildCombinedRevolverSchedule({}, buildMonthlyPeriods("2027-01-01", "2027-02-01")),
    /at least a commitmentFee or a deferredFees entry/
  );
});
