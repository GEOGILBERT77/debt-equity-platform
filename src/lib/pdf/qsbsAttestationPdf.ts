import { PdfPageBuilder, buildPdf, wrapTextToWidth } from "./simplePdfWriter.js";
import { computeQsbsExclusion, QsbsExclusionResult } from "../accounting/taxElections.js";
import { Decimal, DecimalValue } from "../accounting/types.js";

/**
 * v0.36.0 — renders a QSBS (Qualified Small Business Stock, IRC 1202) attestation
 * letter: a document a company gives a shareholder confirming the facts that support
 * QSBS treatment, so the shareholder's own tax preparer has something concrete to
 * work from at the time of a sale (or for diligence during a later financing round).
 *
 * THIS IS A FACTUAL ATTESTATION FROM THE COMPANY, NOT A TAX OR LEGAL OPINION — SAID
 * PLAINLY ON THE LETTER ITSELF, NOT JUST HERE. A real QSBS attestation letter
 * typically covers eight things (per current market practice for these letters):
 * (1) exact stock identification — class, share count, price paid, issuance date;
 * (2) the aggregate-gross-assets test result at issuance ($50M pre-7/4/2025 stock,
 * $75M post-OBBBA stock — see taxElections.ts's OBBBA split); (3) the active-
 * qualified-trade-or-business representation; (4) original-issuance (not secondary-
 * market) confirmation; (5) domestic C-corporation status; (6) the acquisition/
 * issuance dates that anchor the 3/5-year (pre-OBBBA) or 3-year (post-OBBBA)
 * graduated holding period; (7) the two redemption tests (issuer-from-taxpayer, and
 * issuer's own significant redemptions) that can taint QSBS status even when
 * everything else checks out; (8) which regime (pre- vs. post-OBBBA) applies and why.
 * ITEMS 2-3-4-5-7 ARE REPRESENTATIONS THIS FUNCTION TAKES AS GIVEN BOOLEANS/TEXT FROM
 * WHOEVER FILLS OUT THE FORM — same "assumed, not verified" boundary
 * `computeQsbsExclusion`'s own doc comment already draws for the gross-assets test and
 * QSBS-eligibility flag; this letter doesn't (and can't) independently confirm a
 * company's balance sheet or business activity, it only formats what it's told into a
 * shareable document. Whoever prepares this letter is representing those facts, and
 * should have real support for each one before signing.
 *
 * THE EXCLUSION-AMOUNT SECTION IS OPTIONAL, DELIBERATELY: an attestation letter is
 * routinely issued well before any sale (at a financing round, or on a shareholder's
 * request for their own records) — there's no disposition yet to compute a gain
 * against. Pass `hypotheticalDisposition` only when illustrating the exclusion against
 * an actual or planned sale; leave it undefined for a standing, pre-sale attestation,
 * and the letter simply omits that section rather than showing a meaningless $0.
 *
 * Same hand-rolled-PDF-writer reasoning as form3921Pdf.ts (see that file's doc
 * comment) — no PDF library is installable in this sandbox, and this is a Next.js
 * app, not a Python one, so the pdf skill's own toolchain can verify this file's
 * OUTPUT during development but can't be what generates it at runtime.
 */

export interface QsbsAttestationCompanyInfo {
  name: string;
  stateOfIncorporation: string;
  address: string;
  /** Whoever is signing on the company's behalf — e.g. "Chief Financial Officer". */
  signatoryName: string;
  signatoryTitle: string;
}

export interface QsbsAttestationShareholderInfo {
  name: string;
  address: string;
}

export interface QsbsAttestationStockInfo {
  stockClass: string;
  sharesCovered: DecimalValue;
  pricePerShareAtIssuance: DecimalValue;
  issuanceDate: string;
  /** Defaults to `issuanceDate` when omitted — same convention as `QsbsHolding`. */
  acquisitionDate?: string;
}

export interface QsbsAttestationRepresentations {
  metGrossAssetsTest: boolean;
  isQualifiedSmallBusinessStock: boolean;
  /** Free text — e.g. "Since inception, the Company has been engaged in software
   * development and has not conducted any of the excluded activities listed in IRC
   * 1202(e)(3) (professional services, banking, farming, hotels/restaurants, etc.)." */
  activeBusinessDescription: string;
  /** The issuer-from-taxpayer AND issuer's-own-significant-redemption tests — both
   * folded into one representation, since both are "did anything happen that could
   * taint this stock's QSBS status" checks a company attests to together in practice. */
  noDisqualifyingRedemptions: boolean;
  redemptionNotes?: string;
}

export interface QsbsHypotheticalDisposition {
  dispositionDate: string;
  adjustedBasis: DecimalValue;
  amountRealized: DecimalValue;
}

export interface QsbsAttestationLetterInput {
  company: QsbsAttestationCompanyInfo;
  shareholder: QsbsAttestationShareholderInfo;
  stock: QsbsAttestationStockInfo;
  representations: QsbsAttestationRepresentations;
  hypotheticalDisposition?: QsbsHypotheticalDisposition;
  letterDate: string;
}

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 72; // 1", a letter's usual margin — wider than Form 3921's 0.75"

function money(v: DecimalValue): string {
  return `$${new Decimal(v).toFixed(2)}`;
}

/** Builds the letter as a single- or multi-page PDF Buffer, paginating automatically
 * if the body text runs past one page (the only document in this app's PDF layer that
 * needs to, since Form 3921/3922 are both fixed one-copy-per-page forms). */
export function buildQsbsAttestationLetterPdf(input: QsbsAttestationLetterInput): Buffer {
  const contentWidth = PAGE_WIDTH - 2 * MARGIN;
  const bodyFontSize = 10;
  const lineHeight = 14;

  let exclusion: QsbsExclusionResult | null = null;
  if (input.hypotheticalDisposition) {
    exclusion = computeQsbsExclusion({
      issuanceDate: input.stock.issuanceDate,
      acquisitionDate: input.stock.acquisitionDate,
      dispositionDate: input.hypotheticalDisposition.dispositionDate,
      adjustedBasis: input.hypotheticalDisposition.adjustedBasis,
      amountRealized: input.hypotheticalDisposition.amountRealized,
      metGrossAssetsTest: input.representations.metGrossAssetsTest,
      isQualifiedSmallBusinessStock: input.representations.isQualifiedSmallBusinessStock,
    });
  }

  // Build the whole letter as one list of (text, size, bold, spaceAfter) lines first,
  // THEN paginate — much simpler than tracking page breaks while also wrapping text.
  type Line = { text: string; size: number; bold?: boolean; gapAfter?: number };
  const lines: Line[] = [];
  const addWrapped = (text: string, size = bodyFontSize, bold = false) => {
    for (const l of wrapTextToWidth(text, contentWidth, size)) lines.push({ text: l, size, bold });
  };
  const addBlank = () => lines.push({ text: "", size: bodyFontSize });

  lines.push({ text: input.company.name, size: 13, bold: true });
  addWrapped(input.company.address);
  addBlank();
  addWrapped(input.letterDate);
  addBlank();
  addWrapped(input.shareholder.name);
  addWrapped(input.shareholder.address);
  addBlank();
  lines.push({ text: "Re: Qualified Small Business Stock (IRC Section 1202) Attestation", size: 11, bold: true });
  addBlank();
  addWrapped(`Dear ${input.shareholder.name}:`);
  addBlank();
  addWrapped(
    `This letter confirms certain facts regarding your ownership of ${input.stock.stockClass} of ${input.company.name} ` +
      `(the "Company"), a corporation organized under the laws of ${input.company.stateOfIncorporation}, that are ` +
      `relevant to the Company's belief that this stock may qualify as Qualified Small Business Stock ("QSBS") under ` +
      `Section 1202 of the Internal Revenue Code. This letter is a factual attestation prepared by the Company based ` +
      `on its own records and representations; it is NOT tax or legal advice, and does not itself determine your ` +
      `eligibility for the Section 1202 exclusion. You should provide this letter to your own tax advisor, who ` +
      `should independently confirm QSBS eligibility before relying on it.`
  );
  addBlank();
  lines.push({ text: "1. Stock identification", size: bodyFontSize, bold: true });
  addWrapped(
    `Class of stock: ${input.stock.stockClass}. Shares covered by this letter: ${new Decimal(input.stock.sharesCovered).toFixed(
      0
    )}. Price paid per share at issuance: ${money(input.stock.pricePerShareAtIssuance)}. Date of original issuance: ${
      input.stock.issuanceDate
    }.` +
      (input.stock.acquisitionDate && input.stock.acquisitionDate !== input.stock.issuanceDate
        ? ` Your date of acquisition: ${input.stock.acquisitionDate}.`
        : "")
  );
  addBlank();
  lines.push({ text: "2. Original issuance", size: bodyFontSize, bold: true });
  addWrapped("The Company represents that the shares described above were acquired by you at their original issuance directly from the Company, in exchange for money, property, or services, and not through a purchase from another shareholder on the secondary market.");
  addBlank();
  lines.push({ text: "3. Domestic C corporation status", size: bodyFontSize, bold: true });
  addWrapped(`The Company represents that it has been a domestic C corporation, organized under the laws of ${input.company.stateOfIncorporation}, continuously since the date of issuance referenced above.`);
  addBlank();
  lines.push({ text: "4. Aggregate gross assets test", size: bodyFontSize, bold: true });
  addWrapped(
    input.representations.metGrossAssetsTest
      ? "The Company represents that its aggregate gross assets did not exceed the applicable statutory ceiling at any time before, and immediately after, the issuance described above (see the applicable regime noted in Section 6 below for which ceiling applies)."
      : "The Company is NOT able to represent that it met the aggregate gross assets test at issuance — see the Company's own records for details. This stock may not qualify as QSBS on this basis alone."
  );
  addBlank();
  lines.push({ text: "5. Active qualified trade or business", size: bodyFontSize, bold: true });
  addWrapped(input.representations.activeBusinessDescription);
  addBlank();
  lines.push({ text: "6. Applicable regime", size: bodyFontSize, bold: true });
  const regimeNote =
    input.stock.issuanceDate > "2025-07-04"
      ? "This stock was issued after July 4, 2025 and is therefore evaluated under the post-One Big Beautiful Bill Act (OBBBA) regime — a $75,000,000 aggregate gross assets ceiling, and a graduated 50%/75%/100% exclusion tier keyed to a 3/4/5-year holding period."
      : "This stock was issued on or before July 4, 2025 and is therefore evaluated under the pre-OBBBA regime — a $50,000,000 aggregate gross assets ceiling, and (subject to the acquisition date) either the 50%/75%/100% pre-2010 graduated exclusion or the 100% exclusion available for stock acquired after September 27, 2010.";
  addWrapped(regimeNote);
  addBlank();
  lines.push({ text: "7. Redemptions", size: bodyFontSize, bold: true });
  addWrapped(
    input.representations.noDisqualifyingRedemptions
      ? "The Company represents that neither it nor any related person purchased any of its stock from you (or a related party) during the four-year period beginning two years before this issuance, and the Company has not made any significant redemption (exceeding, in aggregate, 5% of the value of its stock) of its own stock from other shareholders during the relevant testing period."
      : `The Company is NOT able to make an unqualified representation regarding redemptions — see the following note: ${
          input.representations.redemptionNotes ?? "(no further detail provided)."
        }`
  );
  if (input.representations.noDisqualifyingRedemptions && input.representations.redemptionNotes) {
    addWrapped(`Additional note: ${input.representations.redemptionNotes}`);
  }

  if (exclusion) {
    addBlank();
    lines.push({ text: "8. Illustrative exclusion calculation (informational only)", size: bodyFontSize, bold: true });
    addWrapped(
      `Based on a disposition dated ${input.hypotheticalDisposition!.dispositionDate}, with an adjusted basis of ` +
        `${money(input.hypotheticalDisposition!.adjustedBasis)} and amount realized of ${money(
          input.hypotheticalDisposition!.amountRealized
        )}: gain of ${money(exclusion.gain)}, ` +
        `${exclusion.eligible ? `an exclusion percentage of ${(exclusion.exclusionPercentage * 100).toFixed(0)}% subject to a cap of ${money(exclusion.exclusionCap)}, excludable gain of ${money(exclusion.excludableGain)}, and taxable gain of ${money(exclusion.taxableGain)}` : `NOT currently eligible for exclusion (${exclusion.ineligibilityReason})`}` +
        `. This figure is illustrative only, computed by the Company's own platform, and does not substitute for your own tax advisor's independent calculation — see ${exclusion.note}`
    );
  }

  addBlank();
  addWrapped(
    "This letter reflects the Company's understanding of the relevant facts as of the date above and is provided for your convenience. It does not constitute a guarantee that the Internal Revenue Service will treat this stock as QSBS, and the Company undertakes no obligation to update this letter for facts that change after this date."
  );
  addBlank();
  addBlank();
  addWrapped("Sincerely,");
  addBlank();
  addBlank();
  addWrapped(input.company.signatoryName);
  addWrapped(input.company.signatoryTitle);
  addWrapped(input.company.name);

  // --- Paginate ---
  const usableHeight = PAGE_HEIGHT - 2 * MARGIN;
  const linesPerPage = Math.floor(usableHeight / lineHeight);
  const pages: PdfPageBuilder[] = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    const page = new PdfPageBuilder(PAGE_WIDTH, PAGE_HEIGHT);
    let y = PAGE_HEIGHT - MARGIN;
    for (const line of lines.slice(i, i + linesPerPage)) {
      if (line.text !== "") page.text(MARGIN, y, line.size, line.text, { bold: line.bold });
      y -= lineHeight;
    }
    pages.push(page);
  }
  return buildPdf(pages);
}
