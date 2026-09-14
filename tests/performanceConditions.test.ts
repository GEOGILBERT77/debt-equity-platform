import test from "node:test";
import assert from "node:assert/strict";
import { resolvePerformanceConditionProbabilities } from "../src/lib/accounting/performanceConditions.js";
import {
  computeFullSchedule,
  computeScheduleForInstrument,
  TermVersionRecord,
  StockOptionPerformanceConditionTerms,
} from "../src/lib/accounting/dispatch.js";
import { buildMonthlyPeriods } from "../src/lib/accounting/dateMath.js";

/**
 * resolvePerformanceConditionProbabilities — the pure, low-level date-to-period
 * resolution math. See its doc comment in performanceConditions.ts for the exact
 * "most recent assessment as of this period's end" rule being verified here.
 */
test("resolvePerformanceConditionProbabilities: a period before the first assessment defaults to not-probable", () => {
  const periods = buildMonthlyPeriods("2026-01-01", "2026-04-01"); // 3 monthly periods
  const resolved = resolvePerformanceConditionProbabilities([{ effectiveDate: "2026-03-15", probable: true }], periods);
  assert.equal(resolved.length, 3);
  assert.equal(resolved[0].probable, false); // Jan — before any assessment
  assert.equal(resolved[1].probable, false); // Feb — still before
  assert.equal(resolved[2].probable, true); // Mar — 3/15 assessment is on/before this period's end (4/1)
});

test("resolvePerformanceConditionProbabilities: carries the most recent assessment forward until superseded", () => {
  const periods = buildMonthlyPeriods("2026-01-01", "2026-06-01"); // 5 monthly periods
  const resolved = resolvePerformanceConditionProbabilities(
    [
      { effectiveDate: "2026-01-10", probable: true },
      { effectiveDate: "2026-04-05", probable: false },
    ],
    periods
  );
  assert.deepEqual(
    resolved.map((r) => r.probable),
    [true, true, true, false, false]
  );
});

test("resolvePerformanceConditionProbabilities: sorts unsorted input and lets the last same-date entry win", () => {
  const periods = buildMonthlyPeriods("2026-01-01", "2026-02-01"); // 1 period
  const resolved = resolvePerformanceConditionProbabilities(
    [
      { effectiveDate: "2026-01-15", probable: true },
      { effectiveDate: "2026-01-01", probable: false },
      { effectiveDate: "2026-01-15", probable: false }, // corrective same-day re-assessment, appended later
    ],
    periods
  );
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].probable, false);
});

test("resolvePerformanceConditionProbabilities: an empty assessment history defaults every period to not-probable", () => {
  const periods = buildMonthlyPeriods("2026-01-01", "2026-03-01");
  const resolved = resolvePerformanceConditionProbabilities([], periods);
  assert.deepEqual(
    resolved.map((r) => r.probable),
    [false, false]
  );
});

/**
 * enrichTermVersionsWithPerformanceConditions (exercised indirectly through
 * computeFullSchedule/computeScheduleForInstrument, its real call path) — confirms the
 * shared-condition history actually reaches and overrides the engine's
 * probabilityAssessments, and that a version NOT opted in is completely unaffected.
 */
const grantDate = "2026-01-01";
const requisiteServiceEndDate = "2026-07-01"; // 6 months
const performanceTerms: StockOptionPerformanceConditionTerms = {
  conditionType: "performance",
  grantDate,
  quantity: 12000,
  grantDateFairValuePerUnit: "1.00",
  requisiteServiceEndDate,
  // Deliberately WRONG/stale inline data — a shared-condition version should ignore
  // this entirely once performanceConditionAssessments is attached below.
  probabilityAssessments: buildMonthlyPeriods(grantDate, requisiteServiceEndDate).map((p) => ({ date: p.end, probable: true })),
};

test("computeFullSchedule: a term version with no performanceConditionAssessments uses its own inline probabilityAssessments, unchanged", () => {
  const versions: TermVersionRecord[] = [{ effectiveDate: grantDate, label: "Original grant", terms: performanceTerms }];
  const schedule = computeFullSchedule("STOCK_OPTION", versions);
  const total = schedule.reduce((sum, row) => sum + Number(row.amount.toFixed(4)), 0);
  assert.equal(total.toFixed(2), "12000.00"); // fully probable the whole way per its own inline data
});

test("computeFullSchedule: a shared-condition version with an EMPTY assessment history overrides stale inline data to fully not-probable", () => {
  const versions: TermVersionRecord[] = [
    {
      effectiveDate: grantDate,
      label: "Original grant",
      terms: performanceTerms,
      performanceConditionAssessments: [], // linked to a condition, never assessed yet
    },
  ];
  const schedule = computeFullSchedule("STOCK_OPTION", versions);
  const total = schedule.reduce((sum, row) => sum + Number(row.amount.toFixed(4)), 0);
  assert.equal(total.toFixed(2), "0.00"); // conservative default overrides the stale "always probable" inline array
});

test("computeFullSchedule: a shared-condition's dated history drives partial recognition, reversing once it turns improbable", () => {
  const versions: TermVersionRecord[] = [
    {
      effectiveDate: grantDate,
      label: "Original grant",
      terms: performanceTerms,
      performanceConditionAssessments: [
        { effectiveDate: "2026-01-01", probable: true },
        { effectiveDate: "2026-04-15", probable: false }, // turns improbable partway through
      ],
    },
  ];
  const schedule = computeFullSchedule("STOCK_OPTION", versions);
  const total = schedule.reduce((sum, row) => sum + Number(row.amount.toFixed(4)), 0);
  assert.equal(total.toFixed(2), "0.00"); // reverses fully once improbable — see buildPerformanceConditionSchedule
});

test("computeScheduleForInstrument: a shared condition's assessment is scoped to the term version's OWN era across a modification", () => {
  const periods = buildMonthlyPeriods(grantDate, requisiteServiceEndDate);
  const modifiedTerms: StockOptionPerformanceConditionTerms = {
    ...performanceTerms,
    grantDateFairValuePerUnit: "1.00",
  };
  const versions: TermVersionRecord[] = [
    {
      effectiveDate: grantDate,
      label: "Original grant",
      terms: performanceTerms,
      performanceConditionAssessments: [{ effectiveDate: grantDate, probable: true }],
    },
    {
      // A later era linked to a DIFFERENT (or reassessed) condition — improbable from
      // the modification date forward. Confirms each era resolves against only its
      // OWN slice of periods, not the whole instrument's history.
      effectiveDate: "2026-04-01",
      label: "Modification",
      terms: modifiedTerms,
      performanceConditionAssessments: [{ effectiveDate: "2026-04-01", probable: false }],
    },
  ];
  const schedule = computeScheduleForInstrument("STOCK_OPTION", versions, periods);
  const beforeModification = schedule.filter((r) => r.periodEnd <= "2026-04-01");
  const afterModification = schedule.filter((r) => r.periodEnd > "2026-04-01");
  assert.ok(beforeModification.some((r) => Number(r.amount.toFixed(4)) !== 0), "expense recognized while probable");
  assert.ok(
    afterModification.every((r) => Number(r.amount.toFixed(4)) === 0),
    "no expense once the later era's condition is not-probable"
  );
});
