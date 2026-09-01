import { test } from "node:test";
import assert from "node:assert/strict";
import { neutralizeCsvFormula, escapeCsvCell } from "../src/lib/api/csv.js";

test("neutralizeCsvFormula: leaves an ordinary value untouched", () => {
  assert.equal(neutralizeCsvFormula("Alice Investor LLC"), "Alice Investor LLC");
});

for (const trigger of ["=", "+", "-", "@", "\t", "\r"]) {
  test(`neutralizeCsvFormula: prefixes a value starting with ${JSON.stringify(trigger)} with a single quote`, () => {
    const malicious = `${trigger}HYPERLINK("http://evil.example/","Open")`;
    assert.equal(neutralizeCsvFormula(malicious), `'${malicious}`);
  });
}

test("neutralizeCsvFormula: a trigger character NOT in the leading position is left alone", () => {
  assert.equal(neutralizeCsvFormula("Smith-Jones Family Trust"), "Smith-Jones Family Trust");
  assert.equal(neutralizeCsvFormula("Q1 = Q2 Holdings"), "Q1 = Q2 Holdings");
});

test("escapeCsvCell: quotes a value containing a comma, preserving the neutralized formula prefix", () => {
  assert.equal(escapeCsvCell("=SUM(A1,A2)"), `"'=SUM(A1,A2)"`);
});

test("escapeCsvCell: doubles embedded double quotes, same as before this module existed", () => {
  assert.equal(escapeCsvCell('Say "hi"'), '"Say ""hi"""');
});

test("escapeCsvCell: an ordinary value with no special characters passes through unquoted", () => {
  assert.equal(escapeCsvCell("Acme Ventures"), "Acme Ventures");
});

test("escapeCsvCell: a newline forces quoting", () => {
  assert.equal(escapeCsvCell("line one\nline two"), '"line one\nline two"');
});
