import { NextRequest, NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth/apiGuard";
import { buildQsbsAttestationLetterPdf, QsbsAttestationLetterInput } from "@/lib/pdf/qsbsAttestationPdf";

/**
 * POST /api/reports/tax/qsbs-letter
 *
 * Ad hoc, not entity-scoped — same reasoning as the sibling /api/reports/tax/qsbs
 * calculator route (see its doc comment): none of this platform's stored terms shapes
 * persist the identification/representation fields a real attestation letter needs
 * (state of incorporation, signatory name/title, active-business narrative,
 * redemption representations), so every field is supplied directly in the request
 * body rather than looked up from a stakeholder/entity record. `requireApiUser` (any
 * logged-in user, no specific entity's data touched) is therefore the right bar, same
 * as the QSBS calculator itself.
 *
 * Returns the generated PDF directly (Content-Type: application/pdf) rather than
 * JSON — this route's whole job is producing a document, not a computed result to
 * render in a table.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest) {
  const user = await requireApiUser(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const { company, shareholder, stock, representations, hypotheticalDisposition, letterDate } = body as Partial<QsbsAttestationLetterInput>;

  const missing: string[] = [];
  if (!company?.name) missing.push("company.name");
  if (!company?.stateOfIncorporation) missing.push("company.stateOfIncorporation");
  if (!company?.address) missing.push("company.address");
  if (!company?.signatoryName) missing.push("company.signatoryName");
  if (!company?.signatoryTitle) missing.push("company.signatoryTitle");
  if (!shareholder?.name) missing.push("shareholder.name");
  if (!shareholder?.address) missing.push("shareholder.address");
  if (!stock?.stockClass) missing.push("stock.stockClass");
  if (stock?.sharesCovered === undefined) missing.push("stock.sharesCovered");
  if (stock?.pricePerShareAtIssuance === undefined) missing.push("stock.pricePerShareAtIssuance");
  if (!stock?.issuanceDate) missing.push("stock.issuanceDate");
  if (representations?.metGrossAssetsTest === undefined) missing.push("representations.metGrossAssetsTest");
  if (representations?.isQualifiedSmallBusinessStock === undefined) missing.push("representations.isQualifiedSmallBusinessStock");
  if (!representations?.activeBusinessDescription) missing.push("representations.activeBusinessDescription");
  if (representations?.noDisqualifyingRedemptions === undefined) missing.push("representations.noDisqualifyingRedemptions");
  if (!letterDate) missing.push("letterDate");
  if (missing.length > 0) {
    return NextResponse.json({ error: `Missing required fields: ${missing.join(", ")}` }, { status: 400 });
  }

  let pdf: Buffer;
  try {
    pdf = buildQsbsAttestationLetterPdf({
      company: company as QsbsAttestationLetterInput["company"],
      shareholder: shareholder as QsbsAttestationLetterInput["shareholder"],
      stock: stock as QsbsAttestationLetterInput["stock"],
      representations: representations as QsbsAttestationLetterInput["representations"],
      hypotheticalDisposition: hypotheticalDisposition as QsbsAttestationLetterInput["hypotheticalDisposition"],
      letterDate: letterDate as string,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to generate the letter" }, { status: 400 });
  }

  return new NextResponse(pdf, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="qsbs-attestation-${(shareholder!.name as string).replace(/[^a-z0-9]+/gi, "-")}.pdf"`,
    },
  });
}
