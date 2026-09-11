/**
 * v0.33.0 — a minimal, DEPENDENCY-FREE PDF writer, built by hand for exactly the same
 * reason WaterfallSensitivityChart.tsx hand-rolled an inline SVG chart instead of
 * adding a charting library: this app has no PDF-generation library anywhere, npm's
 * registry is unreachable from this sandbox (confirmed — see this feature's delivery
 * README), and this is a Next.js/Node application, not a Python one, so the pdf
 * skill's Python toolchain (reportlab/pypdf) used to VERIFY this file's OUTPUT during
 * development can't be what actually generates the PDF at runtime in production.
 *
 * SCOPE, DELIBERATELY NARROW: this is NOT a general PDF library. It supports exactly
 * what a static, single-page, text-and-lines government form needs — absolute-
 * positioned text in one of the 14 standard PDF fonts (no font embedding required,
 * since Helvetica/Helvetica-Bold are guaranteed present in every PDF viewer) and
 * simple stroked lines/rectangles. No images, no page-content compression, no
 * incremental updates, no encryption, no interactive AcroForm fields (this produces a
 * FLATTENED, already-filled PDF — see form3921Pdf.ts's module doc comment for why
 * that's the right choice here, not a gap).
 *
 * PDF FORMAT NOTES for whoever maintains this next: a PDF file is a header, a
 * sequence of numbered indirect objects, a cross-reference (xref) table giving each
 * object's exact byte offset, and a trailer pointing at the root Catalog object and
 * the xref table's own offset. Coordinates are in points (1/72 inch), origin at the
 * BOTTOM-LEFT of the page — the opposite of this app's SVG chart's top-left origin,
 * a deliberate trap worth calling out for the next person editing this file.
 */

export type StandardFont = "Helvetica" | "Helvetica-Bold";

interface TextOp {
  kind: "text";
  x: number;
  y: number;
  size: number;
  font: StandardFont;
  text: string;
}

interface LineOp {
  kind: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
}

interface RectOp {
  kind: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  lineWidth: number;
}

type PageOp = TextOp | LineOp | RectOp;

/** A handful of common Unicode punctuation characters this codebase's own doc-comment
 * style actually uses (em/en dash, curly quotes, bullet, ellipsis) mapped to their
 * WinAnsiEncoding byte values (0x80-0x9F range) — every one of these text runs is
 * declared /Encoding /WinAnsiEncoding, so writing the raw byte here (escaped as PDF
 * octal, since it's outside the 7-bit-ASCII range a literal string can contain
 * unescaped) renders the actual intended character instead of a fallback "?". */
const WIN_ANSI_SPECIALS: Record<string, number> = {
  "—": 0x97, // em dash
  "–": 0x96, // en dash
  "‘": 0x91, // left single quote
  "’": 0x92, // right single quote
  "“": 0x93, // left double quote
  "”": 0x94, // right double quote
  "•": 0x95, // bullet
  "…": 0x85, // ellipsis
};

/** Escapes a string for a PDF literal string ( ... ) — backslash and both parens must
 * be backslash-escaped, the small set of Unicode punctuation this codebase actually
 * uses is mapped to its real WinAnsi byte (see WIN_ANSI_SPECIALS), and anything else
 * outside WinAnsi's safe printable range is replaced with "?" rather than risk
 * corrupting the content stream (real form data here is names/addresses/currency
 * figures — that fallback is a deliberately conservative last resort, not the common
 * case). */
function escapePdfString(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 63;
    if (ch === "\\" || ch === "(" || ch === ")") {
      out += "\\" + ch;
    } else if (code >= 32 && code <= 126) {
      out += ch;
    } else if (ch in WIN_ANSI_SPECIALS) {
      out += "\\" + WIN_ANSI_SPECIALS[ch].toString(8).padStart(3, "0");
    } else {
      out += "?"; // outside the safe ASCII/WinAnsi-specials range this writer supports
    }
  }
  return out;
}

function fmt(n: number): string {
  // Up to 3 decimal places, trimmed — PDF numbers don't need more precision than that
  // for a form laid out in whole/half points, and trimming keeps the file smaller.
  return (Math.round(n * 1000) / 1000).toString();
}

/**
 * v0.36.0 — a word-wrap helper for the free-flowing prose documents built on top of
 * this writer (the QSBS attestation letter, and any future letter/memo-shaped PDF) —
 * every document built here before this was a fixed-layout FORM (Form 3921) where
 * every string was already short enough to fit one drawn line, so nothing needed this.
 *
 * APPROXIMATE, NOT METRICS-BASED — READ BEFORE USING FOR ANYTHING TIGHTLY LAID OUT:
 * this writer has no font metrics table (Helvetica's real per-character advance
 * widths), because adding one is a lot of fixed data for a hand-rolled writer whose
 * only job so far was drawing short, individually-positioned form field values. This
 * function instead uses a single average-character-width constant for Helvetica
 * (roughly 0.5 of the font size, in points — a standard rough approximation; real
 * Helvetica averages closer to 0.52-0.56 depending on the actual letter mix, so this
 * is deliberately a bit conservative, erring toward wrapping a little EARLIER rather
 * than risking text running past the requested width). Good enough for a business
 * letter's body paragraphs, where a slightly short line now and then is invisible to
 * the reader; not good enough for anything that must fit an exact printed box.
 */
const HELVETICA_AVG_CHAR_WIDTH_EM = 0.5;

/** Wraps `text` into lines that fit within `maxWidthPt` at `fontSize`, breaking only
 * at whitespace (a single word longer than the width is placed on its own line
 * un-split, rather than broken mid-word) — see this function's own doc comment above
 * for the approximation this rests on. Existing newlines in `text` are treated as
 * forced paragraph breaks, each wrapped independently, so a caller can pass a
 * multi-paragraph string and get the blank lines between paragraphs preserved. */
export function wrapTextToWidth(text: string, maxWidthPt: number, fontSize: number): string[] {
  const charWidthPt = fontSize * HELVETICA_AVG_CHAR_WIDTH_EM;
  const maxChars = Math.max(1, Math.floor(maxWidthPt / charWidthPt));
  const outLines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      outLines.push("");
      continue;
    }
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = "";
    for (const word of words) {
      const candidate = current === "" ? word : `${current} ${word}`;
      if (candidate.length > maxChars && current !== "") {
        outLines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current !== "") outLines.push(current);
  }
  return outLines;
}

export class PdfPageBuilder {
  readonly widthPt: number;
  readonly heightPt: number;
  private ops: PageOp[] = [];

  constructor(widthPt: number, heightPt: number) {
    this.widthPt = widthPt;
    this.heightPt = heightPt;
  }

  /** Draws text with its BASELINE at (x, y), measured from the bottom-left of the
   * page — matches raw PDF's own coordinate convention rather than translating it,
   * since every coordinate a caller supplies should already be in PDF space. */
  text(x: number, y: number, size: number, text: string, opts?: { bold?: boolean }): this {
    this.ops.push({ kind: "text", x, y, size, font: opts?.bold ? "Helvetica-Bold" : "Helvetica", text });
    return this;
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.75): this {
    this.ops.push({ kind: "line", x1, y1, x2, y2, width });
    return this;
  }

  rect(x: number, y: number, width: number, height: number, lineWidth = 0.75): this {
    this.ops.push({ kind: "rect", x, y, width, height, lineWidth });
    return this;
  }

  /** Renders the accumulated operations into a raw (uncompressed) PDF content stream. */
  toContentStream(): string {
    const lines: string[] = [];
    for (const op of this.ops) {
      if (op.kind === "text") {
        lines.push("BT");
        lines.push(`/${op.font === "Helvetica-Bold" ? "F2" : "F1"} ${fmt(op.size)} Tf`);
        lines.push(`${fmt(op.x)} ${fmt(op.y)} Td`);
        lines.push(`(${escapePdfString(op.text)}) Tj`);
        lines.push("ET");
      } else if (op.kind === "line") {
        lines.push(`${fmt(op.width)} w`);
        lines.push(`${fmt(op.x1)} ${fmt(op.y1)} m`);
        lines.push(`${fmt(op.x2)} ${fmt(op.y2)} l`);
        lines.push("S");
      } else {
        lines.push(`${fmt(op.lineWidth)} w`);
        lines.push(`${fmt(op.x)} ${fmt(op.y)} ${fmt(op.width)} ${fmt(op.height)} re`);
        lines.push("S");
      }
    }
    return lines.join("\n");
  }
}

/**
 * Builds a complete, valid, minimal single-or-multi-page PDF from a list of
 * PdfPageBuilder pages, using only the two built-in Helvetica standard fonts.
 * Returns a Node Buffer, ready to write to disk or send as an HTTP response body.
 */
export function buildPdf(pages: PdfPageBuilder[]): Buffer {
  if (pages.length === 0) throw new Error("buildPdf: at least one page is required.");

  // Object numbering: 1 = Catalog, 2 = Pages (parent), 3 = Font F1 (Helvetica),
  // 4 = Font F2 (Helvetica-Bold), then for each page i (0-based): a Page object and a
  // Content-stream object, allocated in order starting at object 5.
  const catalogObjNum = 1;
  const pagesObjNum = 2;
  const fontRegularObjNum = 3;
  const fontBoldObjNum = 4;
  const firstPageObjNum = 5;
  const pageObjNums = pages.map((_, i) => firstPageObjNum + i * 2);
  const contentObjNums = pages.map((_, i) => firstPageObjNum + i * 2 + 1);

  const objects: string[] = [];
  // Index 0 is never used (PDF object numbers start at 1) — pushed as a placeholder
  // so objects[n] lines up with object number n throughout this function.
  objects[0] = "";

  objects[catalogObjNum] = `<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>`;
  objects[pagesObjNum] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[fontRegularObjNum] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  objects[fontBoldObjNum] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;

  pages.forEach((page, i) => {
    const pageObjNum = pageObjNums[i];
    const contentObjNum = contentObjNums[i];
    objects[pageObjNum] =
      `<< /Type /Page /Parent ${pagesObjNum} 0 R /MediaBox [0 0 ${fmt(page.widthPt)} ${fmt(page.heightPt)}] ` +
      `/Resources << /Font << /F1 ${fontRegularObjNum} 0 R /F2 ${fontBoldObjNum} 0 R >> >> ` +
      `/Contents ${contentObjNum} 0 R >>`;
    const stream = page.toContentStream();
    // Byte length, not character length — content is constrained to the printable-
    // ASCII fallback escapePdfString guarantees, so these coincide in practice, but
    // computing it correctly costs nothing and removes any doubt.
    const byteLength = Buffer.byteLength(stream, "utf8");
    objects[contentObjNum] = `<< /Length ${byteLength} >>\nstream\n${stream}\nendstream`;
  });

  // Assemble the file, tracking each object's exact byte offset for the xref table.
  const header = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const chunks: string[] = [header];
  const offsets: number[] = [0]; // object 0 is the free-list head, offset 0 by convention
  let runningOffset = Buffer.byteLength(header, "binary");

  const totalObjects = contentObjNums[contentObjNums.length - 1];
  for (let n = 1; n <= totalObjects; n++) {
    offsets[n] = runningOffset;
    const objStr = `${n} 0 obj\n${objects[n]}\nendobj\n`;
    chunks.push(objStr);
    runningOffset += Buffer.byteLength(objStr, "binary");
  }

  const xrefOffset = runningOffset;
  const xrefLines: string[] = [`xref`, `0 ${totalObjects + 1}`, `0000000000 65535 f `];
  for (let n = 1; n <= totalObjects; n++) {
    xrefLines.push(`${offsets[n].toString().padStart(10, "0")} 00000 n `);
  }
  const xrefBlock = xrefLines.join("\n") + "\n";
  chunks.push(xrefBlock);

  const trailer = `trailer\n<< /Size ${totalObjects + 1} /Root ${catalogObjNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  chunks.push(trailer);

  return Buffer.from(chunks.join(""), "binary");
}
