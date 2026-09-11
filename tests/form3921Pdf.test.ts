import { test } from "node:test";
import assert from "node:assert/strict";
import { computeForm3921Data } from "../src/lib/accounting/optionTaxCompliance.js";
import { buildForm3921Pdf } from "../src/lib/pdf/form3921Pdf.js";

const sampleResult = computeForm3921Data({
  entity: { name: "Acme Robotics, Inc.", address: "1 Robotics Way, Palo Alto, CA 94301", employerIdentificationNumber: "12-3456789" },
  stakeholder: { name: "Jane A. Doe", address: "2 Employee Lane, Mountain View, CA 94040", taxIdNumber: "123-45-6789" },
  grantDate: "2025-01-01",
  exerciseDate: "2026-03-15",
  exercisePricePerShare: 1.25,
  fairMarketValuePerShareAtExercise: 5.75,
  isoQualifiedSharesTransferred: 3000,
});

test("buildForm3921Pdf: produces a 2-page PDF (Copy B, Copy C) containing every real data field", () => {
  assert.equal(sampleResult.ok, true);
  if (!sampleResult.ok) return;

  const pdf = buildForm3921Pdf(sampleResult.data);
  const text = pdf.toString("binary");

  assert.ok(text.startsWith("%PDF-1.4"));
  assert.equal((text.match(/\/Type \/Page /g) ?? []).length, 2, "exactly 2 pages: Copy B and Copy C");
  assert.ok(text.includes("(Copy B)"), "page 1 is labeled Copy B");
  assert.ok(text.includes("(Copy C)"), "page 2 is labeled Copy C");

  // Every real field from the computed data must actually appear in the rendered
  // content streams — this is what actually proves the PDF reflects the real numbers,
  // not just that SOME PDF was produced.
  for (const expected of [
    "Acme Robotics, Inc.",
    "1 Robotics Way, Palo Alto, CA 94301",
    "12-3456789",
    "Jane A. Doe",
    "2 Employee Lane, Mountain View, CA 94040",
    "123-45-6789",
    "2025-01-01", // date option granted
    "2026-03-15", // date option exercised
    "$1.2500", // exercise price
    "$5.7500", // FMV at exercise
    "3000", // shares transferred
    "2026", // tax year
    "2027-01-31", // furnish-to-employee deadline
    "2027-02-28", // IRS paper deadline
    "2027-03-31", // IRS electronic deadline
  ]) {
    assert.ok(text.includes(expected), `expected "${expected}" to appear in the rendered PDF`);
  }
});

test("buildForm3921Pdf: never renders a Copy A page (Copy A must go through e-file or official pre-printed forms, not this platform's PDF output)", () => {
  if (!sampleResult.ok) return;
  const pdf = buildForm3921Pdf(sampleResult.data);
  const text = pdf.toString("binary");
  assert.ok(!text.includes("(Copy A)"), "must never label a page Copy A");
});
