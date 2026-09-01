import test from "node:test";
import assert from "node:assert/strict";
import {
  previewCorrection,
  buildProspectiveCorrectionEntry,
  buildRetrospectiveCorrectionBatch,
} from "../src/lib/accounting/correctionService.js";
import { buildServiceConditionSchedule, ServiceConditionGrant } from "../src/lib/accounting/vesting.js";
import { checkReconciliation } from "../src/lib/accounting/reporting.js";

/**
 * GOLDEN SCENARIO: a data-entry error is discovered. The original grant was recorded
 * with a $2.00 grant-date fair value per option (4,000 options -> $8,000 total); the
 * correct value was actually $2.50 ($10,000 total) — someone mistyped the Black-Scholes
 * output when the grant was entered. Both Y1 and Y2 (2025, 2026 — both 365-day years,
 * so an exact split) are already closed.
 *
 * Hand check: original Y1/Y2 = $4,000 each ($8,000 / 2). Corrected Y1/Y2 = $5,000 each
 * ($10,000 / 2). Delta per period = $1,000. Cumulative delta across both closed
 * periods = $2,000 — that's the number a preview should surface for the materiality
 * call, before anyone decides how to book it.
 */
const originalVersions = [
  {
    effectiveDate: "2025-01-01",
    label: "Original grant",
    terms: {
      grantDate: "2025-01-01",
      quantity: 4000,
      grantDateFairValuePerUnit: 2, // the error
      attributionMethod: "straight-line" as const,
      tranches: [{ id: "t1", vestDate: "2027-01-01", quantity: 4000 }],
    } satisfies ServiceConditionGrant,
  },
];
const periods = [
  { label: "Y1", start: "2025-01-01", end: "2026-01-01" },
  { label: "Y2", start: "2026-01-01", end: "2027-01-01" },
];

test("previewCorrection: surfaces the exact per-period and cumulative impact without persisting anything", () => {
  const preview = previewCorrection(
    originalVersions,
    "2025-01-01",
    { ...originalVersions[0].terms, grantDateFairValuePerUnit: 2.5 }, // the fix
    periods,
    "2027-01-01", // both periods already closed
    buildServiceConditionSchedule
  );

  assert.equal(preview.perPeriodDeltas.length, 2);
  assert.equal(preview.perPeriodDeltas[0].delta.toFixed(2), "1000.00");
  assert.equal(preview.perPeriodDeltas[1].delta.toFixed(2), "1000.00");
  assert.equal(preview.cumulativeDelta.toFixed(2), "2000.00");
  assert.equal(preview.correctedClosedRows[0].amount.toFixed(2), "5000.00");
});

test("previewCorrection: refuses to preview a correction targeting a date with no recorded version", () => {
  assert.throws(
    () =>
      previewCorrection(
        originalVersions,
        "2099-01-01", // no version at this date
        originalVersions[0].terms,
        periods,
        "2027-01-01",
        buildServiceConditionSchedule
      ),
    /No term version found/
  );
});

test("buildProspectiveCorrectionEntry: books the full cumulative delta as one balanced entry in the current period, leaving closed periods untouched", () => {
  const preview = previewCorrection(
    originalVersions,
    "2025-01-01",
    { ...originalVersions[0].terms, grantDateFairValuePerUnit: 2.5 },
    periods,
    "2027-01-01",
    buildServiceConditionSchedule
  );

  const entry = buildProspectiveCorrectionEntry("STOCK_OPTION", preview.cumulativeDelta, "2027-06-30", "Grant-date FV data-entry error found during Q2 review");
  assert.equal(entry.date, "2027-06-30");
  assert.equal(entry.lines[0].debit?.toFixed(2), "2000.00");
  const recon = checkReconciliation([entry]);
  assert.equal(recon.length, 1);
  assert.equal(recon[0].balanced, true);
});

test("buildRetrospectiveCorrectionBatch: restates both closed periods to their corrected amounts, each still balanced", () => {
  const preview = previewCorrection(
    originalVersions,
    "2025-01-01",
    { ...originalVersions[0].terms, grantDateFairValuePerUnit: 2.5 },
    periods,
    "2027-01-01",
    buildServiceConditionSchedule
  );

  const batch = buildRetrospectiveCorrectionBatch("STOCK_OPTION", preview.correctedClosedRows);
  assert.equal(batch.restatedScheduleRows.length, 2);
  assert.equal(batch.restatedScheduleRows[0].amount.toFixed(2), "5000.00");
  assert.equal(batch.restatedScheduleRows[1].amount.toFixed(2), "5000.00");

  const recon = checkReconciliation(batch.restatedJournalEntries);
  assert.equal(recon.length, 1);
  assert.equal(recon[0].balanced, true);
  // Restated total across both periods should tie to the corrected $10,000 grant, not
  // the original (erroneous) $8,000.
  const restatedTotal = batch.restatedScheduleRows.reduce((sum, r) => sum.plus(r.amount), batch.restatedScheduleRows[0].amount.minus(batch.restatedScheduleRows[0].amount));
  assert.equal(restatedTotal.toFixed(2), "10000.00");
});
