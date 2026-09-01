import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFairValueRemeasurementSchedule,
  fairValueRemeasurementEntry,
} from "../src/lib/accounting/fairValueRemeasurement.js";
import { checkReconciliation } from "../src/lib/accounting/reporting.js";

/**
 * GOLDEN SCENARIO: a bifurcated embedded derivative (liability-classified) is
 * recognized at $250,000 fair value on issuance (2025-01-01). Two quarterly
 * remeasurements follow:
 *   Q1 end (2025-04-01): independent valuation comes in at $310,000.
 *   Q2 end (2025-07-01): independent valuation comes in at $280,000.
 * Hand check: Q1 loss = 310,000 - 250,000 = $60,000 (the liability grew, so this is a
 * loss). Q2 gain = 280,000 - 310,000 = -$30,000 (the liability shrank, a gain — shown
 * as a negative amount per this module's sign convention). Ending balance each period
 * is simply the period's own fair value observation.
 */
const inputs = {
  inceptionDate: "2025-01-01",
  inceptionFairValue: 250000,
  observations: [
    { date: "2025-04-01", fairValue: 310000, source: "Independent valuation as of 3/31/2025", hierarchyLevel: 3 as const },
    { date: "2025-07-01", fairValue: 280000, source: "Independent valuation as of 6/30/2025", hierarchyLevel: 3 as const },
  ],
};
const periods = [
  { label: "Q1 2025", start: "2025-01-01", end: "2025-04-01" },
  { label: "Q2 2025", start: "2025-04-01", end: "2025-07-01" },
];

test("buildFairValueRemeasurementSchedule: a liability-classified instrument's first period already produces a real gain/loss (unlike fxTranslation's zero-impact opening row)", () => {
  const schedule = buildFairValueRemeasurementSchedule(inputs, "liability", periods);
  assert.equal(schedule[0].amount.toFixed(2), "60000.00"); // loss
  assert.equal(schedule[0].endingBalance!.toFixed(2), "310000.00");
  assert.equal(schedule[1].amount.toFixed(2), "-30000.00"); // gain
  assert.equal(schedule[1].endingBalance!.toFixed(2), "280000.00");
});

test("buildFairValueRemeasurementSchedule: the identical fair value path on an ASSET flips loss/gain relative to the liability case", () => {
  const schedule = buildFairValueRemeasurementSchedule(inputs, "asset", periods);
  assert.equal(schedule[0].amount.toFixed(2), "-60000.00"); // gain (asset grew)
  assert.equal(schedule[1].amount.toFixed(2), "30000.00"); // loss (asset shrank)
});

test("buildFairValueRemeasurementSchedule: carries provenance (source, hierarchy level) through to meta for the ASC 820 disclosure trail", () => {
  const schedule = buildFairValueRemeasurementSchedule(inputs, "liability", periods);
  assert.equal(schedule[0].meta!.source, "Independent valuation as of 3/31/2025");
  assert.equal(schedule[0].meta!.hierarchyLevel, 3);
});

test("buildFairValueRemeasurementSchedule: defaults to a generic ASC 820 citation, but an explicit reference overrides it", () => {
  const defaultRef = buildFairValueRemeasurementSchedule(inputs, "liability", periods);
  assert.equal(defaultRef[0].meta!.ascReference, "ASC 820 (fair value remeasurement)");

  const explicitRef = buildFairValueRemeasurementSchedule(
    { ...inputs, ascReference: "ASC 815-40 (liability-classified warrant, remeasured through earnings)" },
    "liability",
    periods
  );
  assert.equal(explicitRef[0].meta!.ascReference, "ASC 815-40 (liability-classified warrant, remeasured through earnings)");
});

test("buildFairValueRemeasurementSchedule: refuses a mismatched observation count", () => {
  assert.throws(
    () => buildFairValueRemeasurementSchedule({ ...inputs, observations: [inputs.observations[0]] }, "liability", periods),
    /observations must have exactly one entry per period/
  );
});

test("buildFairValueRemeasurementSchedule: refuses an observation dated to something other than its period's own end", () => {
  assert.throws(
    () =>
      buildFairValueRemeasurementSchedule(
        { ...inputs, observations: [{ date: "2025-03-15", fairValue: 310000 }, inputs.observations[1]] },
        "liability",
        periods
      ),
    /must be dated to their own period's end/
  );
});

test("fairValueRemeasurementEntry: books a liability's loss as Dr Change in Fair Value / Cr the liability account, and balances", () => {
  const schedule = buildFairValueRemeasurementSchedule(inputs, "liability", periods);
  const entry = fairValueRemeasurementEntry(schedule[0], "liability", "Bifurcated Derivative Liability");
  const lossLine = entry.lines.find((l) => l.account === "Change in Fair Value of Liability");
  const liabilityLine = entry.lines.find((l) => l.account === "Bifurcated Derivative Liability");
  assert.equal(lossLine?.debit?.toFixed(2), "60000.00");
  assert.equal(liabilityLine?.credit?.toFixed(2), "60000.00");
  assert.equal(checkReconciliation([entry])[0].balanced, true);
});

test("fairValueRemeasurementEntry: books a liability's gain as Dr the liability account / Cr Change in Fair Value, and balances", () => {
  const schedule = buildFairValueRemeasurementSchedule(inputs, "liability", periods);
  const entry = fairValueRemeasurementEntry(schedule[1], "liability", "Bifurcated Derivative Liability");
  const gainLine = entry.lines.find((l) => l.account === "Change in Fair Value of Liability");
  const liabilityLine = entry.lines.find((l) => l.account === "Bifurcated Derivative Liability");
  assert.equal(gainLine?.credit?.toFixed(2), "30000.00");
  assert.equal(liabilityLine?.debit?.toFixed(2), "30000.00");
  assert.equal(checkReconciliation([entry])[0].balanced, true);
});

test("fairValueRemeasurementEntry: honors a custom instrument account name and a custom gain/loss account name", () => {
  const schedule = buildFairValueRemeasurementSchedule(inputs, "liability", periods);
  const entry = fairValueRemeasurementEntry(schedule[0], "liability", "Warrant Liability", "Loss on Change in Fair Value of Warrants");
  assert.ok(entry.lines.some((l) => l.account === "Warrant Liability"));
  assert.ok(entry.lines.some((l) => l.account === "Loss on Change in Fair Value of Warrants"));
});
