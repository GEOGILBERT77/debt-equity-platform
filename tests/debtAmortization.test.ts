import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEffectiveInterestSchedule,
  solveEffectiveYield,
  buildRevolverFeeSchedule,
  buildPikSchedule,
} from "../src/lib/accounting/debtAmortization.js";
import { Decimal } from "../src/lib/accounting/types.js";

/**
 * GOLDEN SCENARIO (hand-computed, single period — the cleanest possible case to verify
 * by hand before trusting the engine with anything more complex): $100,000 face term
 * loan, 1-year bullet (no periodic coupon, single repayment at maturity), $95,000 net
 * proceeds after a $5,000 discount for issuance costs.
 *
 * Hand check: effective annual yield = (100,000 - 95,000) / 95,000 = 5,000/95,000
 *   = 0.0526315789... (5.263158%)
 * Interest expense for the single period = netProceeds * yield = 95,000 * (5000/95000)
 *   = exactly $5,000.00 (the discount fully amortizes in one period, by construction).
 * Ending balance = 95,000 + 5,000 - 100,000 (cash paid at maturity) = $0.00 exactly —
 * the loan is fully extinguished, which is the sanity check that catches an off-by-one
 * error in the roll-forward faster than any other single number in this whole engine.
 */
test("effective interest, single period: discount fully amortizes, ends at exactly zero", () => {
  const yield_ = 5000 / 95000; // 0.052631578947368...
  const schedule = buildEffectiveInterestSchedule(
    {
      faceValue: 100000,
      netProceeds: 95000,
      effectiveAnnualYield: yield_,
      cashFlows: [{ date: "2026-01-01", amount: 100000 }],
    },
    [{ label: "Year 1", start: "2025-01-01", end: "2026-01-01" }]
  );

  assert.equal(schedule[0].amount.toFixed(2), "5000.00");
  assert.equal(schedule[0].endingBalance?.toFixed(2), "0.00");
});

test("solveEffectiveYield recovers the same yield used to construct the single-period case above", () => {
  const solved = solveEffectiveYield(95000, [100000]);
  assert.ok(
    Math.abs(solved.toNumber() - 5000 / 95000) < 0.0001,
    `solved yield ${solved.toNumber()} should be within 0.0001 of 0.05263158`
  );
});

/**
 * MULTI-PERIOD CROSS-CHECK: $100,000 face, 3-year bullet, 5% effective annual yield,
 * no periodic coupon. Net proceeds are computed independently here via plain
 * floating-point `Math.pow` (NPV of the single maturity cash flow) — a code path
 * entirely separate from the fixed-point engine under test — and the two are compared
 * within a cent. This is a cross-check rather than a hand-verified figure, and it's
 * documented as such: the point is that an independent calculation and the engine agree,
 * not that the number was computed by hand.
 */
test("effective interest, 3-year bullet: matches an independently computed reference within a cent", () => {
  const annualYield = 0.05;
  const referenceNetProceeds = 100000 / Math.pow(1 + annualYield, 3);

  const periods = [
    { label: "Year 1", start: "2025-01-01", end: "2026-01-01" },
    { label: "Year 2", start: "2026-01-01", end: "2027-01-01" },
    { label: "Year 3", start: "2027-01-01", end: "2028-01-01" },
  ];
  const schedule = buildEffectiveInterestSchedule(
    {
      faceValue: 100000,
      netProceeds: referenceNetProceeds,
      effectiveAnnualYield: annualYield,
      cashFlows: [
        { date: "2026-01-01", amount: 0 },
        { date: "2027-01-01", amount: 0 },
        { date: "2028-01-01", amount: 100000 },
      ],
    },
    periods
  );

  // Independent reference roll-forward in plain floating point.
  let refBalance = referenceNetProceeds;
  const refCashFlows = [0, 0, 100000];
  for (let i = 0; i < 3; i++) {
    const refInterest = refBalance * annualYield;
    refBalance = refBalance + refInterest - refCashFlows[i];
    assert.ok(
      Math.abs(schedule[i].amount.toNumber() - refInterest) < 0.01,
      `period ${i} interest expense should match reference within a cent`
    );
  }
  // The loan is fully repaid at maturity by construction of the reference proceeds.
  assert.equal(schedule[2].endingBalance?.toFixed(2), "0.00");
});

/**
 * GOLDEN SCENARIO: $12,000 total revolver commitment fee, straight-lined (day-weighted,
 * as of v0.17.0 — see buildRevolverFeeSchedule's doc comment for the fix and why it's
 * day-weighted rather than equal-by-count) over 4 calendar quarters of 2025 (a non-leap
 * year: 90 + 91 + 92 + 92 = 365 days total).
 *
 * Hand check: $12,000 / 365 days = $32.876712.../day.
 *   Q1 (90 days): 12000 * 90/365 = $2,958.90
 *   Q2 (91 days, cumulative 181/365): 12000*181/365 - 2958.90 = 5950.68 - 2958.90 = $2,991.78
 *   Q3 (92 days, cumulative 273/365): 12000*273/365 - 5950.68 = 8975.34 - 5950.68 = $3,024.66
 *   Q4 (last period — takes the exact remainder so the schedule ties out to $12,000
 *     even after rounding): 12000 - 8975.34 = $3,024.66
 * Quarters are no longer identical dollar amounts (that was the equal-by-count
 * simplification this fix removes) — they now differ by actual day count, which is
 * the more accurate result: real unused-commitment fees accrue on actual days
 * outstanding, not on a "1/N of the periods you happened to slice this into" basis.
 */
test("revolver commitment fee straight-lines by actual elapsed days across calendar quarters (not equally by period count)", () => {
  const periods = [
    { label: "Q1", start: "2025-01-01", end: "2025-04-01" },
    { label: "Q2", start: "2025-04-01", end: "2025-07-01" },
    { label: "Q3", start: "2025-07-01", end: "2025-10-01" },
    { label: "Q4", start: "2025-10-01", end: "2026-01-01" },
  ];
  const schedule = buildRevolverFeeSchedule(
    { totalCommitmentFee: 12000, commitmentStart: "2025-01-01", commitmentEnd: "2026-01-01" },
    periods
  );
  assert.equal(schedule[0].amount.toFixed(2), "2958.90");
  assert.equal(schedule[1].amount.toFixed(2), "2991.78");
  assert.equal(schedule[2].amount.toFixed(2), "3024.66");
  assert.equal(schedule[3].amount.toFixed(2), "3024.66");
  const total = schedule.reduce((s, r) => s.plus(r.amount), new Decimal(0));
  assert.equal(total.toFixed(2), "12000.00");
});

test("revolver commitment fee straight-lines evenly across periods that ARE actually equal length in days", () => {
  // With a facility split into two equal-length annual periods (365 days each, no leap
  // year in the window), day-weighting and equal-by-count division agree exactly —
  // this is the "fine simplification" case the old doc comment described, confirming
  // the fix didn't regress the common case.
  const periods = [
    { label: "Year 1", start: "2025-01-01", end: "2026-01-01" },
    { label: "Year 2", start: "2026-01-01", end: "2027-01-01" },
  ];
  const schedule = buildRevolverFeeSchedule(
    { totalCommitmentFee: 20000, commitmentStart: "2025-01-01", commitmentEnd: "2027-01-01" },
    periods
  );
  assert.equal(schedule[0].amount.toFixed(2), "10000.00");
  assert.equal(schedule[1].amount.toFixed(2), "10000.00");
});

/**
 * GOLDEN SCENARIO: $100,000 PIK note at a 10% annual PIK rate, 2 years, no cash
 * payments. Year 1 accrues $10,000 (balance -> $110,000); Year 2 accrues 10% of the
 * NEW balance, $11,000 (balance -> $121,000) — compounding, not simple interest,
 * which is exactly the behavior that distinguishes PIK debt from a cash-pay note.
 */
test("PIK schedule compounds onto the growing balance rather than the original principal", () => {
  const periods = [
    { label: "Year 1", start: "2025-01-01", end: "2026-01-01" },
    { label: "Year 2", start: "2026-01-01", end: "2027-01-01" },
  ];
  const schedule = buildPikSchedule({ initialPrincipal: 100000, annualPikRate: 0.1 }, periods);

  assert.equal(schedule[0].amount.toFixed(2), "10000.00");
  assert.equal(schedule[0].endingBalance?.toFixed(2), "110000.00");
  assert.equal(schedule[1].amount.toFixed(2), "11000.00");
  assert.equal(schedule[1].endingBalance?.toFixed(2), "121000.00");
});
