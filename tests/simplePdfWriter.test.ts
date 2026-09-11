import { test } from "node:test";
import assert from "node:assert/strict";
import { PdfPageBuilder, buildPdf, wrapTextToWidth } from "../src/lib/pdf/simplePdfWriter.js";

/**
 * These tests deliberately do NOT depend on any external PDF library or the `pdf`
 * skill's Python tooling (pypdf/qpdf/poppler) — this app's own test suite (`npm test`)
 * has to run wherever Node does, which is not guaranteed to have Python or poppler
 * installed. Instead, this parses the writer's OWN output well enough to prove the
 * file is structurally self-consistent: the xref table's byte offsets actually point
 * at the objects they claim to, and the content streams contain the text this test
 * asked for. (The actual visual rendering was verified separately, once, against
 * poppler/pypdf/qpdf during development — see this feature's delivery README.)
 */

function parseXrefOffsets(pdf: Buffer): number[] {
  const text = pdf.toString("binary");
  const xrefMatch = text.match(/\nxref\n([\s\S]*?)\ntrailer/);
  if (!xrefMatch) throw new Error("No xref table found");
  const lines = xrefMatch[1].trim().split("\n");
  // First line is "0 N" (start object, count) — skip it and the free-list entry.
  const entries = lines.slice(2);
  return entries.map((line) => parseInt(line.slice(0, 10), 10));
}

test("buildPdf: produces a well-formed header, %%EOF trailer, and self-consistent xref offsets", () => {
  const page = new PdfPageBuilder(612, 792);
  page.text(72, 700, 12, "Hello, world");
  const pdf = buildPdf([page]);
  const text = pdf.toString("binary");

  assert.ok(text.startsWith("%PDF-1.4"), "must start with a PDF header");
  assert.ok(text.trimEnd().endsWith("%%EOF"), "must end with %%EOF");

  const offsets = parseXrefOffsets(pdf);
  // Object 1 is the Catalog, object 2 is Pages, 3/4 are the two standard fonts, 5 is
  // the one page, 6 is its content stream — every offset must point exactly at
  // "<n> 0 obj".
  offsets.forEach((offset, i) => {
    const objNum = i + 1;
    const slice = text.slice(offset, offset + `${objNum} 0 obj`.length);
    assert.equal(slice, `${objNum} 0 obj`, `offset for object ${objNum} does not point at its own "obj" marker`);
  });
});

test("buildPdf: content stream contains the exact text requested, and multiple pages get distinct content streams", () => {
  const page1 = new PdfPageBuilder(612, 792);
  page1.text(72, 700, 12, "Page one marker");
  const page2 = new PdfPageBuilder(612, 792);
  page2.text(72, 700, 12, "Page two marker");
  const pdf = buildPdf([page1, page2]);
  const text = pdf.toString("binary");

  assert.ok(text.includes("(Page one marker) Tj"), "page 1's text must appear in a Tj operator");
  assert.ok(text.includes("(Page two marker) Tj"), "page 2's text must appear in a Tj operator");
  // Two distinct Page objects, two distinct Content streams, one shared Pages parent.
  assert.equal((text.match(/\/Type \/Page /g) ?? []).length, 2);
  assert.equal((text.match(/\/Length \d+/g) ?? []).length, 2);
});

test("buildPdf: escapes parentheses and backslashes in text so the content stream stays valid", () => {
  const page = new PdfPageBuilder(612, 792);
  page.text(72, 700, 12, "Value (with parens) and a back\\slash");
  const pdf = buildPdf([page]);
  const text = pdf.toString("binary");
  assert.ok(
    text.includes("(Value \\(with parens\\) and a back\\\\slash) Tj"),
    "parentheses and backslashes inside drawn text must be backslash-escaped"
  );
});

test("buildPdf: maps common Unicode punctuation (em dash) to its real WinAnsi byte instead of a '?' fallback", () => {
  const page = new PdfPageBuilder(612, 792);
  page.text(72, 700, 12, "Before—after");
  const pdf = buildPdf([page]);
  const text = pdf.toString("binary");
  // 0x97 is the em dash's WinAnsiEncoding code point, written as PDF octal escape \227.
  assert.ok(text.includes("(Before\\227after) Tj"), "em dash must render as the WinAnsi byte, not '?'");
});

test("wrapTextToWidth: never produces a line longer than the approximate max-chars budget, for ordinary words", () => {
  const text = "The quick brown fox jumps over the lazy dog many times in a row to test wrapping behavior thoroughly.";
  const lines = wrapTextToWidth(text, 200, 10); // 200pt / (10 * 0.5) = 40 max chars
  for (const line of lines) assert.ok(line.length <= 40, `line "${line}" (${line.length} chars) exceeds the 40-char budget`);
  assert.ok(lines.length > 1, "a long sentence at a narrow width should wrap onto more than one line");
});

test("wrapTextToWidth: preserves blank lines between paragraphs as forced breaks", () => {
  const lines = wrapTextToWidth("First paragraph.\n\nSecond paragraph.", 400, 10);
  assert.ok(lines.includes(""), "the blank line between paragraphs should survive as its own empty line");
  assert.ok(lines.some((l) => l.includes("First paragraph.")));
  assert.ok(lines.some((l) => l.includes("Second paragraph.")));
});

test("wrapTextToWidth: never splits a single word across two lines, even one longer than the width budget", () => {
  const lines = wrapTextToWidth("a-word-that-is-extremely-long-and-will-not-fit " + "short words here", 50, 10); // 50/5 = 10 max chars
  assert.equal(lines[0], "a-word-that-is-extremely-long-and-will-not-fit", "the long word is placed whole on its own line, not broken mid-word");
});

test("wrapTextToWidth: a short string that fits entirely returns exactly one line", () => {
  const lines = wrapTextToWidth("Short.", 400, 10);
  assert.deepEqual(lines, ["Short."]);
});

test("buildPdf: rejects an empty page list", () => {
  assert.throws(() => buildPdf([]));
});
