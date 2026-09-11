import { test } from "node:test";
import assert from "node:assert/strict";
import { computeForm3922Data } from "../src/lib/accounting/espp.js";
import { buildForm3922Pdf } from "../src/lib/pdf/form3922Pdf.js";

const sampleResult = computeForm3922Data({
  entity: { name: "Acme Robotics, Inc.", address: "1 Robotics Way, Palo Alto, CA 94301", employerIdentificationNumber: "12-3456789" },
  stakeholder: { name: "Jane A. Doe", address: "2 Employee Lane, Mountain View, CA 94040", taxIdNumber: "123-45-6789" },
  grantDate: "2025-01-01",
  exerciseDate: "2026-06-30",
  fairMarketValuePerShareAtGrant: 4.0,
  fairMarketValuePerShareAtExercise: 5.5,
  exercisePricePaidPerShare: 3.4,
  sharesTransferred: 500,
});

test("computeForm3922Data: defaults dateLegalTitleTransferred and box 8 pricing when not supplied", () => {
  assert.equal(sampleResult.ok, true);
  if (!sampleResult.ok) return;
  assert.equal(sampleResult.data.dateLegalTitleTransferred, "2026-06-30", "defaults to exerciseDate");
  assert.equal(sampleResult.data.exercisePriceIfGrantedDatePricing.toFixed(2), "3.40", "defaults to the actual exercise price paid (no look-back case)");
});

test("computeForm3922Data: refuses to assemble with a missing EIN/TIN/address, same as computeForm3921Data", () => {
  const missing = computeForm3922Data({
    entity: { name: "Acme Robotics, Inc.", address: null, employerIdentificationNumber: null },
    stakeholder: { name: "Jane A. Doe", address: "2 Employee Lane", taxIdNumber: "123-45-6789" },
    grantDate: "2025-01-01",
    exerciseDate: "2026-06-30",
    fairMarketValuePerShareAtGrant: 4.0,
    fairMarketValuePerShareAtExercise: 5.5,
    exercisePricePaidPerShare: 3.4,
    sharesTransferred: 500,
  });
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.ok(missing.missingFields.some((f) => f.includes("employerIdentificationNumber")));
  assert.ok(missing.missingFields.some((f) => f.includes("Entity.address")));
});

test("computeForm3922Data: an explicit look-back box-8 price overrides the box-5 default", () => {
  const result = computeForm3922Data({
    entity: { name: "Acme Robotics, Inc.", address: "1 Robotics Way", employerIdentificationNumber: "12-3456789" },
    stakeholder: { name: "Jane A. Doe", address: "2 Employee Lane", taxIdNumber: "123-45-6789" },
    grantDate: "2025-01-01",
    exerciseDate: "2026-06-30",
    fairMarketValuePerShareAtGrant: 4.0,
    fairMarketValuePerShareAtExercise: 5.5,
    exercisePricePaidPerShare: 3.4, // 85% of the LOWER of grant/exercise FMV = 0.85 * 4.00 = 3.40
    exercisePriceIfGrantedDatePricing: 3.4, // same convention, expressed against grant-date FMV explicitly
    sharesTransferred: 500,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.exercisePriceIfGrantedDatePricing.toFixed(2), "3.40");
});

test("buildForm3922Pdf: produces a 2-page PDF (Copy B, Copy C) containing every real data field", () => {
  assert.equal(sampleResult.ok, true);
  if (!sampleResult.ok) return;

  const pdf = buildForm3922Pdf(sampleResult.data);
  const text = pdf.toString("binary");

  assert.ok(text.startsWith("%PDF-1.4"));
  assert.equal((text.match(/\/Type \/Page /g) ?? []).length, 2, "exactly 2 pages: Copy B and Copy C");
  assert.ok(text.includes("(Copy B)"), "page 1 is labeled Copy B");
  assert.ok(text.includes("(Copy C)"), "page 2 is labeled Copy C");

  for (const expected of [
    "Acme Robotics, Inc.",
    "1 Robotics Way, Palo Alto, CA 94301",
    "12-3456789",
    "Jane A. Doe",
    "2 Employee Lane, Mountain View, CA 94040",
    "123-45-6789",
    "2025-01-01", // date option granted
    "2026-06-30", // date option exercised / legal title transferred
    "$4.0000", // FMV at grant
    "$5.5000", // FMV at exercise
    "$3.4000", // exercise price paid (and box 8 default)
    "500", // shares transferred
    "2026", // tax year
    "2027-01-31",
    "2027-02-28",
    "2027-03-31",
  ]) {
    assert.ok(text.includes(expected), `expected "${expected}" to appear in the rendered PDF`);
  }
});

test("buildForm3922Pdf: never renders a Copy A page", () => {
  if (!sampleResult.ok) return;
  const pdf = buildForm3922Pdf(sampleResult.data);
  const text = pdf.toString("binary");
  assert.ok(!text.includes("(Copy A)"));
});
