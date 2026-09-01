import test from "node:test";
import assert from "node:assert/strict";
import { buildDeferredFeeSchedule, buildMultiTrancheEffectiveInterestSchedule } from "../src/lib/accounting/debtAmortization.js";
import { buildAnnualPeriods } from "../src/lib/accounting/dateMath.js";
import { Decimal } from "../src/lib/accounting/types.js";

/**
 * GOLDEN SCENARIO 1 (buildDeferredFeeSchedule, single tranche): $100,000 deferred
 * financing fee on a revolver at inception (2025-01-01), amortized straight-line over
 * a clean 3-year commitment period (2025-01-01 to 2028-01-01), reported annually.
 * Hand check: each of the 3 years is exactly 365 days (no leap day falls inside this
 * window), so the fee splits evenly: $100,000 / 3 = $33,333.33... per year, tying out
 * exactly to $100,000 across all three periods (the point of the "remainder to the
 * final period" plug already proven out in vesting.test.ts).
 */
test("buildDeferredFeeSchedule: single tranche straight-lines evenly and ties out exactly to the fee amount", () => {
  const periods = buildAnnualPeriods("2025-01-01", "2028-01-01");
  const schedule = buildDeferredFeeSchedule(
    [{ id: "Initial deferred financing fee", amount: 100000, amortizationStart: "2025-01-01", amortizationEnd: "2028-01-01" }],
    periods
  );
  assert.equal(schedule.length, 3);
  const total = schedule.reduce((sum, r) => sum.plus(r.amount), new Decimal(0));
  assert.equal(total.toFixed(2), "100000.00");
  // Ending balance (unamortized asset) should decline to exactly zero by year 3.
  assert.equal(schedule[2].endingBalance!.toFixed(2), "0.00");
});

/**
 * GOLDEN SCENARIO 2 (buildDeferredFeeSchedule, multi-tranche upsize): the same
 * $60,000 original fee, PLUS a $30,000 upsize fee incurred exactly one year in
 * (2026-01-01), amortizing only over the 2 years actually remaining to the same
 * 2028-01-01 maturity — not restarting a fresh 3-year clock, and not disturbing the
 * original tranche's own amortization.
 *
 * Hand check:
 *   Tranche A ($60,000 / 3 years): $20,000/year for years 1, 2, 3.
 *   Tranche B ($30,000 / 2 years, starting year 2): $0 in year 1 (doesn't exist yet),
 *     $15,000 in year 2, $15,000 in year 3.
 * Combined: Year 1 = $20,000; Year 2 = $20,000 + $15,000 = $35,000; Year 3 = $20,000 +
 *   $15,000 = $35,000. Total = $90,000 (60,000 + 30,000), confirming nothing leaked or
 *   duplicated across tranches.
 * Ending balance (unamortized) at year-1-end: Tranche A has $40,000 left, Tranche B
 *   doesn't exist yet ($0) -> $40,000. At year-2-end: Tranche A $20,000 left, Tranche B
 *   $15,000 left -> $35,000.
 */
test("buildDeferredFeeSchedule: an upsize fee added mid-facility amortizes only over its own remaining term, without disturbing the original tranche", () => {
  const periods = buildAnnualPeriods("2025-01-01", "2028-01-01");
  const schedule = buildDeferredFeeSchedule(
    [
      { id: "Original fee", amount: 60000, amortizationStart: "2025-01-01", amortizationEnd: "2028-01-01" },
      { id: "Upsize fee (Amendment No. 1)", amount: 30000, amortizationStart: "2026-01-01", amortizationEnd: "2028-01-01" },
    ],
    periods
  );

  assert.equal(schedule[0].amount.toFixed(2), "20000.00"); // Year 1 — only the original tranche
  assert.equal(schedule[1].amount.toFixed(2), "35000.00"); // Year 2 — both tranches active
  assert.equal(schedule[2].amount.toFixed(2), "35000.00"); // Year 3 — both tranches active

  const total = schedule.reduce((sum, r) => sum.plus(r.amount), new Decimal(0));
  assert.equal(total.toFixed(2), "90000.00");

  assert.equal(schedule[0].endingBalance!.toFixed(2), "40000.00");
  assert.equal(schedule[1].endingBalance!.toFixed(2), "35000.00");
  assert.equal(schedule[2].endingBalance!.toFixed(2), "0.00");

  // Per-tranche detail survives in meta for audit — not just the combined total.
  assert.equal((schedule[1].meta!.tranches as Record<string, string>)["Original fee"], "20000.00");
  assert.equal((schedule[1].meta!.tranches as Record<string, string>)["Upsize fee (Amendment No. 1)"], "15000.00");
});

/**
 * GOLDEN SCENARIO 3 (buildMultiTrancheEffectiveInterestSchedule, DDTL): two draws on a
 * delayed-draw term loan that share a common facility maturity (2027-01-01) — the
 * realistic DDTL shape, where every draw is repaid at the same final maturity date
 * regardless of when it was drawn, rather than each draw having its own independent
 * term.
 *   Draw 1: $100,000 face, drawn 2025-01-01 (day one), 5% effective yield, a 2-year
 *     bullet to the 2027-01-01 facility maturity.
 *   Draw 2: $50,000 face, drawn 2026-01-01 (a genuine DDTL draw, one year into the
 *     facility), 6% effective yield, a 1-year bullet to the SAME 2027-01-01 maturity.
 * Both tranches' numbers are cross-checked against an independent floating-point NPV
 * roll-forward (the same pattern as the existing "3-year bullet" cross-check in
 * debtAmortization.test.ts), within a cent — the point here is proving the COMBINED
 * schedule correctly sums two draws with different draw dates and different yields
 * landing in the same reporting period, not re-proving the single-tranche math.
 */
test("buildMultiTrancheEffectiveInterestSchedule: a second DDTL draw with its own yield correctly combines with the first draw in the period they overlap", () => {
  const periods = [
    { label: "Year 1", start: "2025-01-01", end: "2026-01-01" },
    { label: "Year 2", start: "2026-01-01", end: "2027-01-01" },
  ];

  const draw1Yield = 0.05;
  const draw1NetProceeds = 100000 / Math.pow(1 + draw1Yield, 2);
  const draw2Yield = 0.06;
  const draw2NetProceeds = 50000 / Math.pow(1 + draw2Yield, 1);

  const schedule = buildMultiTrancheEffectiveInterestSchedule(
    [
      {
        id: "Draw 1",
        drawDate: "2025-01-01",
        faceValue: 100000,
        netProceeds: draw1NetProceeds,
        effectiveAnnualYield: draw1Yield,
        cashFlows: [
          { date: "2026-01-01", amount: 0 },
          { date: "2027-01-01", amount: 100000 },
        ],
      },
      {
        id: "Draw 2",
        drawDate: "2026-01-01",
        faceValue: 50000,
        netProceeds: draw2NetProceeds,
        effectiveAnnualYield: draw2Yield,
        cashFlows: [{ date: "2027-01-01", amount: 50000 }],
      },
    ],
    periods
  );

  // Independent reference: Draw 1 alone.
  const draw1Year1Interest = draw1NetProceeds * draw1Yield;
  const draw1Year1Balance = draw1NetProceeds + draw1Year1Interest;
  const draw1Year2Interest = draw1Year1Balance * draw1Yield;
  // Independent reference: Draw 2 alone (only exists in Year 2).
  const draw2Year2Interest = draw2NetProceeds * draw2Yield;

  assert.ok(Math.abs(schedule[0].amount.toNumber() - draw1Year1Interest) < 0.01, "Year 1: Draw 1 only");
  assert.ok(Math.abs(schedule[0].endingBalance!.toNumber() - draw1Year1Balance) < 0.01, "Year 1 ending balance: Draw 1 only");

  const combinedYear2Interest = draw1Year2Interest + draw2Year2Interest;
  assert.ok(Math.abs(schedule[1].amount.toNumber() - combinedYear2Interest) < 0.01, "Year 2: both draws combined");
  // Both draws mature at the facility's final maturity — combined ending balance is $0.
  assert.equal(schedule[1].endingBalance!.toFixed(2), "0.00");

  // Per-tranche breakdown confirms Draw 2 contributes nothing in Year 1 (it doesn't
  // exist yet) and both draws are separately visible in Year 2 — no cross-contamination.
  assert.equal(Object.keys(schedule[0].meta!.tranches as Record<string, unknown>).length, 1);
  assert.ok((schedule[0].meta!.tranches as Record<string, unknown>)["Draw 1"]);
  assert.equal(Object.keys(schedule[1].meta!.tranches as Record<string, unknown>).length, 2);
  assert.ok((schedule[1].meta!.tranches as Record<string, unknown>)["Draw 1"]);
  assert.ok((schedule[1].meta!.tranches as Record<string, unknown>)["Draw 2"]);
});

test("buildMultiTrancheEffectiveInterestSchedule: refuses a draw date that doesn't match any period start, rather than silently misplacing it", () => {
  assert.throws(
    () =>
      buildMultiTrancheEffectiveInterestSchedule(
        [
          {
            id: "Draw with a bad date",
            drawDate: "2025-06-15", // not a period start
            faceValue: 100000,
            netProceeds: 95000,
            effectiveAnnualYield: 0.05,
            cashFlows: [{ date: "2026-01-01", amount: 100000 }],
          },
        ],
        [{ label: "Year 1", start: "2025-01-01", end: "2026-01-01" }]
      ),
    /doesn't match the start of any period/
  );
});
