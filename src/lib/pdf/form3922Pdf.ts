import { PdfPageBuilder, buildPdf } from "./simplePdfWriter.js";
import { Form3922Data } from "../accounting/espp.js";

/**
 * v0.36.0 — renders a Form3922Data record (see espp.ts) into an actual PDF: Copy B
 * (For Employee) and Copy C (For Corporation's Records), one page each. Same
 * hand-rolled-writer approach, and the exact same Copy A caveat, as form3921Pdf.ts —
 * see that file's doc comment for the full reasoning, repeated in brief here rather
 * than assumed: this sandbox's network policy blocks fetching the official IRS PDF
 * directly, so this recreates Form 3922's box layout and labels from published IRS
 * form instructions rather than filling the real IRS template, and Copy A (the
 * actual paper filing copy, which requires IRS-scannable red-ink printing) is
 * deliberately NOT rendered — only Copies B and C, which the IRS's own instructions
 * say are fine to furnish on plain paper.
 */

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 54; // 0.75"

function drawCopy(data: Form3922Data, copyLabel: string, copyDescription: string): PdfPageBuilder {
  const page = new PdfPageBuilder(PAGE_WIDTH, PAGE_HEIGHT);
  let y = PAGE_HEIGHT - MARGIN;

  page.text(MARGIN, y, 9, "Form 3922", { bold: true });
  page.text(MARGIN + 70, y, 9, "Transfer of Stock Acquired Through an Employee Stock Purchase Plan");
  page.text(PAGE_WIDTH - MARGIN - 110, y, 9, `Copy ${copyLabel}`, { bold: true });
  y -= 12;
  page.text(MARGIN + 70, y, 8, "Under Section 423(c)");
  page.text(PAGE_WIDTH - MARGIN - 110, y, 8, copyDescription);
  y -= 14;
  page.text(MARGIN, y, 8, "Box layout recreated by this platform from published IRS form instructions, not the official IRS PDF");
  y -= 10;
  page.text(MARGIN, y, 8, "(see this feature's delivery README for why, and the Copy A/B/C distinction that matters here).");
  y -= 16;

  page.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
  y -= 16;

  page.text(MARGIN, y, 7, "TRANSFEROR'S (Corporation's) name, street address, city, state, ZIP code");
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

  const colWidth = (PAGE_WIDTH - 2 * MARGIN - 20) / 2;
  const boxHeight = 40;
  const drawBox = (col: 0 | 1, rowTop: number, label: string, value: string) => {
    const x = MARGIN + col * (colWidth + 20);
    page.rect(x, rowTop - boxHeight, colWidth, boxHeight);
    page.text(x + 6, rowTop - 12, 7, label);
    page.text(x + 6, rowTop - 30, 11, value, { bold: true });
  };

  drawBox(0, y, "1  Date option granted", data.dateOptionGranted);
  drawBox(1, y, "2  Date option exercised", data.dateOptionExercised);
  y -= boxHeight + 8;

  drawBox(0, y, "3  FMV per share on grant date", `$${data.fairMarketValuePerShareOnGrantDate.toFixed(4)}`);
  drawBox(1, y, "4  FMV per share on exercise date", `$${data.fairMarketValuePerShareOnExerciseDate.toFixed(4)}`);
  y -= boxHeight + 8;

  drawBox(0, y, "5  Exercise price paid per share", `$${data.exercisePricePaidPerShare.toFixed(4)}`);
  drawBox(1, y, "6  No. of shares transferred", data.sharesTransferred.toFixed(0));
  y -= boxHeight + 8;

  drawBox(0, y, "7  Date legal title transferred", data.dateLegalTitleTransferred);
  drawBox(1, y, "8  Exercise price/share if determined at grant", `$${data.exercisePriceIfGrantedDatePricing.toFixed(4)}`);
  y -= boxHeight + 20;

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
  page.text(MARGIN, y, 7, "This page recreates Form 3922's box layout from IRS instructions; it is NOT the official IRS PDF and");
  y -= 10;
  page.text(MARGIN, y, 7, "must not be submitted as paper Copy A. See this feature's delivery README for what to do to actually file.");

  return page;
}

/** Builds the two-page (Copy B, Copy C) PDF as a Buffer. Copy A is deliberately not
 * rendered — see this module's doc comment. */
export function buildForm3922Pdf(data: Form3922Data): Buffer {
  const copyB = drawCopy(data, "B", "For Employee");
  const copyC = drawCopy(data, "C", "For Corporation's Records");
  return buildPdf([copyB, copyC]);
}
