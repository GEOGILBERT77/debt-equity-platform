import { NextRequest, NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth/apiGuard";
import { computeForm3922Data, ComputeForm3922DataParams } from "@/lib/accounting/espp";
import { buildForm3922Pdf } from "@/lib/pdf/form3922Pdf";

/**
 * POST /api/reports/tax/form-3922
 *
 * Ad hoc calculator, same reasoning as /api/reports/tax/qsbs and every other
 * standalone tax calculator route: ESPP has no instrument type or persisted purchase
 * record anywhere in this schema yet (see espp.ts's own module doc comment), so this
 * takes every field directly in the request body rather than reading a stored
 * purchase — the ESPP-accounting sibling of computeForm3921Data's approach, one level
 * further from stored data since there's no OptionExerciseEvent-equivalent table for
 * ESPP purchases to read from at all.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest) {
  const user = await requireApiUser(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const {
    entity,
    stakeholder,
    grantDate,
    exerciseDate,
    fairMarketValuePerShareAtGrant,
    fairMarketValuePerShareAtExercise,
    exercisePricePaidPerShare,
    sharesTransferred,
    dateLegalTitleTransferred,
    exercisePriceIfGrantedDatePricing,
  } = body as Partial<ComputeForm3922DataParams>;

  const missing: string[] = [];
  if (!entity?.name) missing.push("entity.name");
  if (!stakeholder?.name) missing.push("stakeholder.name");
  if (!grantDate) missing.push("grantDate");
  if (!exerciseDate) missing.push("exerciseDate");
  if (fairMarketValuePerShareAtGrant === undefined) missing.push("fairMarketValuePerShareAtGrant");
  if (fairMarketValuePerShareAtExercise === undefined) missing.push("fairMarketValuePerShareAtExercise");
  if (exercisePricePaidPerShare === undefined) missing.push("exercisePricePaidPerShare");
  if (sharesTransferred === undefined) missing.push("sharesTransferred");
  if (missing.length > 0) {
    return NextResponse.json({ error: `Missing required fields: ${missing.join(", ")}` }, { status: 400 });
  }

  const result = computeForm3922Data({
    entity: {
      name: entity!.name,
      address: entity!.address ?? null,
      employerIdentificationNumber: entity!.employerIdentificationNumber ?? null,
    },
    stakeholder: {
      name: stakeholder!.name,
      address: stakeholder!.address ?? null,
      taxIdNumber: stakeholder!.taxIdNumber ?? null,
    },
    grantDate: grantDate as string,
    exerciseDate: exerciseDate as string,
    fairMarketValuePerShareAtGrant: fairMarketValuePerShareAtGrant as string,
    fairMarketValuePerShareAtExercise: fairMarketValuePerShareAtExercise as string,
    exercisePricePaidPerShare: exercisePricePaidPerShare as string,
    sharesTransferred: sharesTransferred as string,
    dateLegalTitleTransferred,
    exercisePriceIfGrantedDatePricing,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: `Can't generate Form 3922 — missing required information: ${result.missingFields.join(", ")}.`, missingFields: result.missingFields },
      { status: 409 }
    );
  }

  const pdf = buildForm3922Pdf(result.data);
  // Buffer isn't directly assignable to NextResponse's BodyInit under this project's
  // TypeScript config — Uint8Array is.
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="form-3922-${stakeholder!.name.replace(/[^a-z0-9]+/gi, "-")}-${result.data.taxYear}.pdf"`,
    },
  });
}
