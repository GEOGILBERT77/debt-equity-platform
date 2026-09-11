import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQsbsAttestationLetterPdf, QsbsAttestationLetterInput } from "../src/lib/pdf/qsbsAttestationPdf.js";

const baseInput: QsbsAttestationLetterInput = {
  company: {
    name: "Acme Robotics, Inc.",
    stateOfIncorporation: "Delaware",
    address: "1 Robotics Way, Palo Alto, CA 94301",
    signatoryName: "Pat Rivera",
    signatoryTitle: "Chief Financial Officer",
  },
  shareholder: { name: "Jane A. Doe", address: "2 Employee Lane, Mountain View, CA 94040" },
  stock: {
    stockClass: "Series A Preferred Stock",
    sharesCovered: 10000,
    pricePerShareAtIssuance: 1.5,
    issuanceDate: "2023-05-01",
  },
  representations: {
    metGrossAssetsTest: true,
    isQualifiedSmallBusinessStock: true,
    activeBusinessDescription: "Since inception, the Company has been engaged in software development.",
    noDisqualifyingRedemptions: true,
  },
  letterDate: "2026-09-11",
};

test("buildQsbsAttestationLetterPdf: renders every identification field and representation", () => {
  const pdf = buildQsbsAttestationLetterPdf(baseInput);
  const text = pdf.toString("binary");

  assert.ok(text.startsWith("%PDF-1.4"));
  for (const expected of [
    "Acme Robotics, Inc.",
    "Jane A. Doe",
    "Series A Preferred Stock",
    "10000",
    "2023-05-01",
    "Delaware",
    "Pat Rivera",
    "Chief Financial Officer",
    "2026-09-11",
  ]) {
    assert.ok(text.includes(expected), `expected "${expected}" to appear in the rendered letter`);
  }
});

test("buildQsbsAttestationLetterPdf: pre-OBBBA issuance (before 7/4/2025) states the $50M ceiling regime", () => {
  const pdf = buildQsbsAttestationLetterPdf(baseInput);
  const text = pdf.toString("binary");
  assert.ok(text.includes("50,000,000"), "pre-OBBBA stock should reference the $50M gross-assets ceiling");
});

test("buildQsbsAttestationLetterPdf: post-OBBBA issuance (after 7/4/2025) states the $75M ceiling regime", () => {
  const pdf = buildQsbsAttestationLetterPdf({
    ...baseInput,
    stock: { ...baseInput.stock, issuanceDate: "2025-08-01" },
  });
  const text = pdf.toString("binary");
  assert.ok(text.includes("75,000,000"), "post-OBBBA stock should reference the $75M gross-assets ceiling");
});

test("buildQsbsAttestationLetterPdf: omitting hypotheticalDisposition produces no exclusion-calculation section", () => {
  const pdf = buildQsbsAttestationLetterPdf(baseInput);
  const text = pdf.toString("binary");
  assert.ok(!text.includes("Illustrative exclusion calculation"), "no disposition supplied -> no illustrative section");
});

test("buildQsbsAttestationLetterPdf: including hypotheticalDisposition renders the illustrative exclusion figures", () => {
  const pdf = buildQsbsAttestationLetterPdf({
    ...baseInput,
    hypotheticalDisposition: { dispositionDate: "2026-09-01", adjustedBasis: 15000, amountRealized: 215000 },
  });
  const text = pdf.toString("binary");
  assert.ok(text.includes("Illustrative exclusion calculation"));
  assert.ok(text.includes("2026-09-01"));
});

test("buildQsbsAttestationLetterPdf: a shareholder ineligible on the gross-assets test states that plainly rather than the standard representation", () => {
  const pdf = buildQsbsAttestationLetterPdf({
    ...baseInput,
    representations: { ...baseInput.representations, metGrossAssetsTest: false },
  });
  const text = pdf.toString("binary");
  assert.ok(text.includes("NOT able to represent"), "must not silently claim the gross-assets test passed when it didn't");
});

test("buildQsbsAttestationLetterPdf: paginates automatically when the letter body runs long", () => {
  const pdf = buildQsbsAttestationLetterPdf({
    ...baseInput,
    representations: {
      ...baseInput.representations,
      activeBusinessDescription: "Since inception, the Company has been engaged in software development. ".repeat(80),
    },
  });
  const text = pdf.toString("binary");
  const pageCount = (text.match(/\/Type \/Page /g) ?? []).length;
  assert.ok(pageCount >= 2, `expected the long letter to spill onto a second page, got ${pageCount} page(s)`);
});
