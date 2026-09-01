import test from "node:test";
import assert from "node:assert/strict";
import { InstrumentTimeline, recomputeSchedule, computeIncrementalFairValue } from "../src/lib/accounting/modificationEngine.js";
import { buildServiceConditionSchedule, ServiceConditionGrant } from "../src/lib/accounting/vesting.js";

/**
 * This test exercises the actual requirement from the "modification handling" spec:
 * an instrument's original grant governs its early periods untouched, a later
 * modification governs everything from its effective date forward, and the SAME
 * builder function (buildServiceConditionSchedule) handles both eras — there is no
 * special-cased "modified schedule" function anywhere in this codebase.
 *
 * Setup: original grant on 2025-01-01, 4,000 options at $2.00 ($8,000 total), vesting
 * 2025-01-01 -> 2027-01-01 straight-line. Since 2025 and 2026 are both 365-day years,
 * that's an exact $4,000/$4,000 split — hand-verifiable without a calculator.
 *
 * Modification effective 2027-01-01 (start of era 2): treated as a fresh incremental
 * grant of $2,000 (1,000 units x $2.00 incremental fair value) vesting over the next
 * two years, 2027-01-01 -> 2029-01-01, straight-line — per ASC 718-20-35, a
 * modification's incremental value is recognized over the remaining service period
 * exactly like a new grant, which is why the same builder function is reusable here.
 */
test("recomputeSchedule: original-grant periods stay untouched, modification governs everything after", () => {
  const originalTerms: ServiceConditionGrant = {
    grantDate: "2025-01-01",
    quantity: 4000,
    grantDateFairValuePerUnit: 2,
    attributionMethod: "straight-line",
    tranches: [{ id: "t1", vestDate: "2027-01-01", quantity: 4000 }],
  };

  const timeline = new InstrumentTimeline<ServiceConditionGrant>(originalTerms, "2025-01-01", "Original grant");

  const modifiedTerms: ServiceConditionGrant = {
    grantDate: "2027-01-01", // the modification date itself, not the original grant date
    quantity: 1000,
    grantDateFairValuePerUnit: 2, // incremental fair value per ASC 718-20-35
    attributionMethod: "straight-line",
    tranches: [{ id: "t2", vestDate: "2029-01-01", quantity: 1000 }],
  };
  timeline.applyModification(modifiedTerms, "2027-01-01", "Repricing 2027-01-01");

  const periods = [
    { label: "Y1", start: "2025-01-01", end: "2026-01-01" },
    { label: "Y2", start: "2026-01-01", end: "2027-01-01" },
    { label: "Y3", start: "2027-01-01", end: "2028-01-01" },
    { label: "Y4", start: "2028-01-01", end: "2029-01-01" },
  ];

  const schedule = recomputeSchedule(timeline, periods, (terms, periodsForEra) =>
    buildServiceConditionSchedule(terms, periodsForEra)
  );

  // Pre-modification periods: exactly the original grant's straight-line schedule,
  // completely unaffected by the fact that a modification happens later.
  assert.equal(schedule[0].amount.toFixed(2), "4000.00");
  assert.equal(schedule[1].amount.toFixed(2), "4000.00");
  assert.equal(schedule[0].meta?.termVersionLabel, "Original grant");
  assert.equal(schedule[1].meta?.termVersionLabel, "Original grant");

  // Post-modification periods: the incremental $2,000 grant, recognized over its own
  // remaining service period, ties out exactly regardless of the leap-year day split.
  const postModTotal = schedule[2].amount.plus(schedule[3].amount);
  assert.equal(postModTotal.toFixed(2), "2000.00");
  assert.equal(schedule[2].meta?.termVersionLabel, "Repricing 2027-01-01");
  assert.equal(schedule[3].meta?.termVersionLabel, "Repricing 2027-01-01");

  // Grand total across both eras: $8,000 original + $2,000 incremental.
  const grandTotal = schedule.reduce((sum, r) => sum.plus(r.amount), schedule[0].amount.minus(schedule[0].amount));
  assert.equal(grandTotal.toFixed(2), "10000.00");
});

test("InstrumentTimeline.applyModification refuses a modification dated before the latest version", () => {
  const timeline = new InstrumentTimeline<{ x: number }>({ x: 1 }, "2026-01-01", "Original");
  assert.throws(() => timeline.applyModification({ x: 2 }, "2025-06-01", "Backdated"), /must be after/);
});

test("computeIncrementalFairValue: only a value increase produces a non-zero incremental amount", () => {
  assert.equal(computeIncrementalFairValue(10, 15).toFixed(2), "5.00");
  assert.equal(computeIncrementalFairValue(10, 8).toFixed(2), "0.00"); // decreases are never reversed
});
