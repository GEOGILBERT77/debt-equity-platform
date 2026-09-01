import test from "node:test";
import assert from "node:assert/strict";
import {
  buildServiceConditionSchedule,
  buildPerformanceConditionSchedule,
  buildMarketConditionSchedule,
  reverseForfeitedExpense,
} from "../src/lib/accounting/vesting.js";

/**
 * GOLDEN SCENARIO: 12,000 time-based options, $2.00 grant-date fair value ($24,000
 * total), vesting in four equal annual tranches from 2025-01-01 to 2029-01-01,
 * straight-line attribution.
 *
 * Hand-verified arithmetic: the schedule allocates by elapsed calendar days over the
 * 1,461-day service period (365 + 365 + 365 + 366, since 2028 is a leap year).
 *   Y1 (2025, 365 days):  24000 * 365/1461 = 5,995.89322... -> $5,995.89
 *   Y2 (2026, 365 days):  same day-count as Y1             -> $5,995.89
 *   Y3 (2027, 365 days):  same day-count as Y1             -> $5,995.89
 *   Y4 (2028, 366 days):  remainder, ties the total to $24,000.00 exactly -> $6,012.32
 * Note the Y4 figure is the *unrounded* cumulative-through-Y3 (17,987.67966...)
 * subtracted from 24,000 — NOT three times the cent-rounded 5,995.89 (which would give
 * 6,012.33). Getting this fencepost right is exactly what this test is for: the engine
 * carries full precision internally and only rounds at the reporting boundary, which is
 * the correct order of operations for anything that has to tie out to a ledger.
 */
test("service condition, straight-line: ties to $24,000 total and matches day-weighted allocation", () => {
  const periods = [
    { label: "Y1", start: "2025-01-01", end: "2026-01-01" },
    { label: "Y2", start: "2026-01-01", end: "2027-01-01" },
    { label: "Y3", start: "2027-01-01", end: "2028-01-01" },
    { label: "Y4", start: "2028-01-01", end: "2029-01-01" },
  ];
  const schedule = buildServiceConditionSchedule(
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
    periods
  );

  assert.equal(schedule[0].amount.toFixed(2), "5995.89");
  assert.equal(schedule[1].amount.toFixed(2), "5995.89");
  assert.equal(schedule[2].amount.toFixed(2), "5995.89");
  assert.equal(schedule[3].amount.toFixed(2), "6012.32");

  const total = schedule.reduce((sum, row) => sum.plus(row.amount), schedule[0].amount.minus(schedule[0].amount));
  assert.equal(total.toFixed(2), "24000.00");
});

/**
 * GOLDEN SCENARIO: same $24,000 grant, but graded (FIN 28) attribution — each 3,000-
 * option tranche is its own $6,000 award, vesting straight-line from grant date to its
 * own vest date. This front-loads expense recognition relative to straight-line: by
 * the design of graded attribution, tranche 1 fully vests (and fully expenses) within
 * year 1, so year 1's total expense is materially higher than straight-line's $5,995.89.
 *
 * Hand check: tranche 1 ($6,000, 1-year service period) recognizes its entire $6,000 in
 * Y1. Tranche 2 ($6,000, 2-year service period) recognizes half in Y1 and half in Y2 —
 * split further in reality by the exact day-count of Y1 vs Y2 within its 2-year window,
 * but since Y1 and Y2 are both 365-day years here, it's an even $3,000/$3,000 split.
 * So Y1 total = 6000 (tranche 1, fully) + 3000 (tranche 2, half) + 2000 (tranche 3, a
 * third) + 1500 (tranche 4, a quarter) = 12,500 — well above straight-line's 5,995.89,
 * which is exactly the point of the two methods being tested separately.
 */
test("service condition, graded: front-loads expense relative to straight-line", () => {
  const periods = [
    { label: "Y1", start: "2025-01-01", end: "2026-01-01" },
    { label: "Y2", start: "2026-01-01", end: "2027-01-01" },
    { label: "Y3", start: "2027-01-01", end: "2028-01-01" },
    { label: "Y4", start: "2028-01-01", end: "2029-01-01" },
  ];
  const schedule = buildServiceConditionSchedule(
    {
      grantDate: "2025-01-01",
      quantity: 12000,
      grantDateFairValuePerUnit: 2,
      attributionMethod: "graded",
      tranches: [
        { id: "t1", vestDate: "2026-01-01", quantity: 3000 },
        { id: "t2", vestDate: "2027-01-01", quantity: 3000 },
        { id: "t3", vestDate: "2028-01-01", quantity: 3000 },
        { id: "t4", vestDate: "2029-01-01", quantity: 3000 },
      ],
    },
    periods
  );

  const y1 = Number(schedule[0].amount.toFixed(2));
  const straightLineY1 = 5995.89;
  assert.ok(y1 > straightLineY1, `graded Y1 expense (${y1}) should exceed straight-line Y1 expense (${straightLineY1})`);

  const total = schedule.reduce((sum, row) => sum.plus(row.amount), schedule[0].amount.minus(schedule[0].amount));
  assert.equal(total.toFixed(2), "24000.00");
});

/**
 * GOLDEN SCENARIO: performance-condition award, $10,000 grant-date fair value, 2-year
 * requisite service period. Achievement is NOT probable in year 1 (no expense), becomes
 * probable in year 2 (full cumulative catch-up of $10,000 in that single period) — this
 * is the cumulative catch-up mechanic that makes performance conditions materially
 * different from a straight-line service condition.
 */
test("performance condition: no expense while improbable, full catch-up once probable", () => {
  const periods = [
    { label: "Y1", start: "2025-01-01", end: "2026-01-01" },
    { label: "Y2", start: "2026-01-01", end: "2027-01-01" },
  ];
  const schedule = buildPerformanceConditionSchedule(
    {
      grantDate: "2025-01-01",
      quantity: 5000,
      grantDateFairValuePerUnit: 2,
      requisiteServiceEndDate: "2027-01-01",
    },
    [false, true],
    periods
  );

  assert.equal(schedule[0].amount.toFixed(2), "0.00");
  assert.equal(schedule[1].amount.toFixed(2), "10000.00");
});

/**
 * GOLDEN SCENARIO: same performance award, but achievement is probable in Y1 and then
 * becomes improbable in Y2 — the previously-recognized Y1 expense must fully reverse,
 * not just stop accruing. This is the rule most likely to be coded wrong (a "probable"
 * flip is often implemented as "stop expensing" rather than "true up to zero").
 */
test("performance condition: reverses previously recognized expense if it becomes improbable", () => {
  const periods = [
    { label: "Y1", start: "2025-01-01", end: "2026-01-01" },
    { label: "Y2", start: "2026-01-01", end: "2027-01-01" },
  ];
  const schedule = buildPerformanceConditionSchedule(
    {
      grantDate: "2025-01-01",
      quantity: 5000,
      grantDateFairValuePerUnit: 2,
      requisiteServiceEndDate: "2027-01-01",
    },
    [true, false],
    periods
  );

  assert.equal(schedule[0].amount.toFixed(2), "5000.00"); // half of $10,000 recognized in Y1
  assert.equal(schedule[1].amount.toFixed(2), "-5000.00"); // fully reversed in Y2
});

/**
 * GOLDEN SCENARIO: market-condition award recognizes its full grant-date fair value
 * straight-line over the derived service period with NO reversal — contrast directly
 * with the performance-condition reversal test above. There's no "probable" input here
 * at all; that's the point.
 */
test("market condition: recognizes straight-line with no probability input and no reversal path", () => {
  const periods = [
    { label: "Y1", start: "2025-01-01", end: "2026-01-01" },
    { label: "Y2", start: "2026-01-01", end: "2027-01-01" },
  ];
  const schedule = buildMarketConditionSchedule(
    {
      grantDate: "2025-01-01",
      quantity: 5000,
      grantDateFairValuePerUnit: 2, // from an external Monte Carlo valuation
      derivedServiceEndDate: "2027-01-01",
    },
    periods
  );

  assert.equal(schedule[0].amount.toFixed(2), "5000.00");
  assert.equal(schedule[1].amount.toFixed(2), "5000.00");
  // No `probable` field exists on these rows at all — structurally impossible to reverse.
  assert.equal(schedule[0].meta?.probable, undefined);
});

test("forfeiture reversal: reverses the forfeited fraction of cumulative expense recognized so far", () => {
  const recognizedSoFar = [
    { periodStart: "2025-01-01", periodEnd: "2026-01-01", label: "Y1", amount: buildServiceConditionSchedule(
      {
        grantDate: "2025-01-01",
        quantity: 12000,
        grantDateFairValuePerUnit: 2,
        attributionMethod: "straight-line",
        tranches: [{ id: "t1", vestDate: "2029-01-01", quantity: 12000 }],
      },
      [{ label: "Y1", start: "2025-01-01", end: "2026-01-01" }]
    )[0].amount },
  ];
  // Half the grant (6,000 of 12,000 options) is forfeited.
  const reversal = reverseForfeitedExpense(recognizedSoFar, "2026-06-01", 0.5);
  const expectedReversal = recognizedSoFar[0].amount.times(0.5).negated();
  assert.equal(reversal.amount.toFixed(2), expectedReversal.toFixed(2));
});
