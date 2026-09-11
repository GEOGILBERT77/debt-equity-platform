import { PdfPageBuilder, buildPdf } from "./simplePdfWriter.js";
import { Form3921Data } from "../accounting/optionTaxCompliance.js";

/**
 * v0.33.0 — renders a Form3921Data record (see optionTaxCompliance.ts) into an actual
 * PDF file: Copy B (For Employee) and Copy C (For Corporation's Records), one page
 * each, using the hand-rolled writer in simplePdfWriter.ts.
 *
 * WHY THIS IS A RECREATION, NOT THE OFFICIAL IRS PDF — READ BEFORE RELYING ON THIS:
 * building this required getting Form 3921's exact box layout and numbering right, so
 * I fetched and read the IRS's own current form (Rev. April 2025,
 * irs.gov/pub/irs-pdf/f3921.pdf) and its instructions (irs.gov/pub/irs-pdf/i3921.pdf)
 * directly — the transferor/recipient fields, the six numbered boxes, and the box 6
 * "if other than transferor" carve-out below are all taken from that reading, not
 * guessed at. But this sandbox's network policy blocks fetching binary files
 * (including that PDF) directly from irs.gov — confirmed against the sandbox's own
 * proxy status endpoint, which reported a policy-level 403, not a transient failure —
 * so the actual official PDF file could not be brought in and used as a fillable
 * template. What follows instead redraws the same box layout and labels from scratch
 * using this app's own hand-rolled PDF writer (see simplePdfWriter.ts's doc comment
 * for why: no PDF-generation library exists anywhere in this app, and npm's registry
 * is unreachable from this sandbox for the same policy reason).
 *
 * THIS MATTERS FOR WHICH COPY THIS IS SAFE TO USE FOR: the IRS's own instructions say
 * "Copies B and C of Form 3921 ... have been made fillable online" — i.e. these two
 * copies are explicitly fine to print on plain paper and hand to the employee / keep
 * on file. Copy A (the copy actually FILED with the IRS on paper) is NOT in that
 * fillable-online list — it requires the special scannable "red ink" printing IRS
 * scanning equipment depends on, and the IRS does not allow a self-printed plain-
 * paper Copy A (unscannable submissions draw a per-form penalty; see this feature's
 * delivery README for sourcing). This function DELIBERATELY renders Copy B and Copy C
 * ONLY. A company that needs to actually FILE with the IRS on paper must either order
 * official pre-printed Copy A forms from the IRS or e-file (which sidesteps the red-
 * ink requirement entirely) — computeForm3921Data's output is exactly the field data
 * an e-file submission or a paper Copy A would need, whichever path is used; this
 * module just doesn't attempt to render that specific copy as a PDF.
 */

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 54; // 0.75"

function drawCopy(data: Form3921Data, copyLabel: string, copyDescription: string): PdfPageBuilder {
  const page = new PdfPageBuilder(PAGE_WIDTH, PAGE_HEIGHT);
  let y = PAGE_HEIGHT - MARGIN;

  page.text(MARGIN, y, 9, "Form 3921", { bold: true });
  page.text(MARGIN + 70, y, 9, "Exercise of an Incentive Stock Option Under Section 422(b)");
  page.text(PAGE_WIDTH - MARGIN - 110, y, 9, `Copy ${copyLabel}`, { bold: true });
  y -= 12;
  page.text(PAGE_WIDTH - MARGIN - 110, y, 8, copyDescription);
  y -= 14;
  page.text(MARGIN, y, 8, "(Rev. April 2025) — box layout recreated by this platform, not the official IRS PDF (see this");
  y -= 10;
  page.text(MARGIN, y, 8, "feature's delivery README for why, and for the Copy A/B/C distinction that matters here).");
  y -= 16;

  page.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
  y -= 16;

  // --- Transferor block ---
  page.text(MARGIN, y, 7, "TRANSFEROR'S name, street address, city, state, ZIP code");
  y -= 12;
  page.text(MARGIN, y, 10, data.transferor.name);
  y -= 12;
  page.text(MARGIN, y, 10, data.transferor.address);
  y -= 16;
  page.text(MARGIN, y, 7, "TRANSFEROR'S TIN (EIN)");
  y -= 12;
  page.text(MARGIN, y, 10, data.transferor.employerIdentificationNumber);
  y -= 18;
  page.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
  y -= 16;

  // --- Recipient (employee) block ---
  page.text(MARGIN, y, 7, "EMPLOYEE'S name, street address, city, state, ZIP code");
  y -= 12;
  page.text(MARGIN, y, 10, data.recipient.name);
  y -= 12;
  page.text(MARGIN, y, 10, data.recipient.address);
  y -= 16;
  page.text(MARGIN, y, 7, "EMPLOYEE'S TIN");
  y -= 12;
  page.text(MARGIN, y, 10, data.recipient.taxIdNumber);
  y -= 18;
  page.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
  y -= 24;

  // --- Numbered boxes, two per row, matching the real form's box order ---
  const colWidth = (PAGE_WIDTH - 2 * MARGIN - 20) / 2;
  const boxHeight = 42;
  const drawBox = (col: 0 | 1, rowTop: number, label: string, value: string) => {
    const x = MARGIN + col * (colWidth + 20);
    page.rect(x, rowTop - boxHeight, colWidth, boxHeight);
    page.text(x + 6, rowTop - 12, 7, label);
    page.text(x + 6, rowTop - 30, 11, value, { bold: true });
  };

  drawBox(0, y, "1  Date option granted", data.dateOptionGranted);
  drawBox(1, y, "2  Date option exercised", data.dateOptionExercised);
  y -= boxHeight + 10;

  drawBox(0, y, "3  Exercise price per share", `$${data.exercisePricePerShare.toFixed(4)}`);
  drawBox(1, y, "4  FMV per share on exercise date", `$${data.fairMarketValuePerShareOnExerciseDate.toFixed(4)}`);
  y -= boxHeight + 10;

  drawBox(0, y, "5  No. of shares transferred", data.sharesTransferred.toFixed(0));
  const x6 = MARGIN + 1 * (colWidth + 20);
  page.rect(x6, y - boxHeight, colWidth, boxHeight);
  page.text(x6 + 6, y - 12, 7, "6  If other than TRANSFEROR, name, address,");
  page.text(x6 + 6, y - 22, 7, "and TIN of corporation whose stock is transferred");
  page.text(x6 + 6, y - 34, 9, "(not applicable — no parent/subsidiary on file)");
  y -= boxHeight + 24;

  page.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
  y -= 16;
  page.text(MARGIN, y, 8, `Tax year of exercise: ${data.taxYear}`);
  y -= 12;
  page.text(MARGIN, y, 8, `Deadline to furnish this copy to the employee: ${data.furnishToEmployeeDeadline}`);
  y -= 12;
  page.text(
    MARGIN,
    y,
    8,
    `IRS filing deadline (Copy A, separately): ${data.irsPaperFilingDeadline} (paper) / ${data.irsElectronicFilingDeadline} (electronic)`
  );
  y -= 24;

  page.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
  y -= 14;
  page.text(MARGIN, y, 7, "This page recreates Form 3921's box layout from the IRS's published form and instructions; it is");
  y -= 10;
  page.text(MARGIN, y, 7, "NOT the official IRS PDF and must not be submitted as paper Copy A. See this feature's delivery");
  y -= 10;
  page.text(MARGIN, y, 7, "README for the full explanation and for what to do to actually file with the IRS.");

  return page;
}

/** Builds the two-page (Copy B, Copy C) PDF as a Buffer, ready to serve or write to
 * disk. Copy A is deliberately not rendered — see this module's doc comment. */
export function buildForm3921Pdf(data: Form3921Data): Buffer {
  const copyB = drawCopy(data, "B", "For Employee");
  const copyC = drawCopy(data, "C", "For Corporation's Records");
  return buildPdf([copyB, copyC]);
}
