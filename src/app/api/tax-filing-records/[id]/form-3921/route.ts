import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";
import { computeForm3921Data, allocateIso100kAcrossExercises, IsoGrantWithTranches, ExerciseForIso100kAllocation } from "@/lib/accounting/optionTaxCompliance";
import { buildForm3921Pdf } from "@/lib/pdf/form3921Pdf";
import { StockOptionInstrumentTerms } from "@/lib/accounting/dispatch";

/**
 * GET /api/tax-filing-records/:id/form-3921
 *
 * Streams a filled Form 3921 PDF (Copy B + Copy C — see form3921Pdf.ts's doc comment
 * for why never Copy A) for a FORM_3921 TaxFilingRecord. Re-derives the ISO-qualified
 * share count the same way the monthly report route does — gathering this
 * stakeholder's full ISO grant/tranche history and re-running
 * allocateIso100kAcrossExercises — rather than trusting a stored figure, since this
 * table deliberately doesn't persist that computed number (see
 * TaxFilingRecord's own doc comment: only WHETHER a human filed it is state this
 * table stores; everything else is recomputed fresh every time, same as the report).
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const record = await db.taxFilingRecord.findUnique({
    where: { id: params.id },
    include: { exerciseEvent: { include: { instrument: { include: { stakeholder: true } } } } },
  });
  if (!record) {
    return NextResponse.json({ error: `No tax filing record found with id "${params.id}"` }, { status: 404 });
  }
  if (record.filingType !== "FORM_3921") {
    return NextResponse.json({ error: `This record is a ${record.filingType}, not FORM_3921 — there's no PDF to generate for it.` }, { status: 400 });
  }
  if (!record.exerciseEvent) {
    return NextResponse.json({ error: "This FORM_3921 record has no associated exercise event on file." }, { status: 409 });
  }

  const access = await requireApiEntityAccess(req, record.entityId, "VIEWER");
  if (access instanceof NextResponse) return access;

  const entity = await db.entity.findUnique({ where: { id: record.entityId } });
  const stakeholder = record.exerciseEvent.instrument.stakeholder;
  if (!entity) {
    return NextResponse.json({ error: "Entity not found." }, { status: 404 });
  }

  // Re-derive this stakeholder's full ISO grant/tranche + exercise history, exactly
  // like the monthly report route, to get the correct $100k-allocated ISO-qualified
  // quantity for THIS specific exercise.
  const stakeholderInstruments = await db.instrument.findMany({
    where: { stakeholderId: stakeholder.id, type: "STOCK_OPTION" },
    select: {
      id: true,
      termVersions: { select: { terms: true }, orderBy: { effectiveDate: "desc" }, take: 1 },
      exerciseEvents: { select: { id: true, exerciseDate: true, quantityExercised: true } },
    },
  });

  const isoGrantsWithTranches: IsoGrantWithTranches[] = [];
  const allocationInputExercises: ExerciseForIso100kAllocation[] = [];
  for (const inst of stakeholderInstruments) {
    const terms = inst.termVersions[0]?.terms as StockOptionInstrumentTerms | undefined;
    if (!terms || !(terms as { isIncentiveStockOption?: boolean }).isIncentiveStockOption) continue;
    const conditionType = (terms as { conditionType?: string }).conditionType ?? "service";
    const tranches = (terms as { tranches?: { id: string; vestDate: string; quantity: unknown }[] }).tranches;
    const grantDateFairValuePerUnit = (terms as { grantDateFairValuePerUnit?: unknown }).grantDateFairValuePerUnit;
    if (conditionType === "service" && tranches && grantDateFairValuePerUnit !== undefined) {
      isoGrantsWithTranches.push({
        instrumentId: inst.id,
        grantDate: (terms as { grantDate: string }).grantDate,
        grantDateFmvPerShare: grantDateFairValuePerUnit as string,
        tranches: tranches.map((t) => ({ id: t.id, vestDate: t.vestDate, quantity: t.quantity as string })),
      });
    }
    for (const ex of inst.exerciseEvents) {
      allocationInputExercises.push({
        exerciseEventId: ex.id,
        instrumentId: inst.id,
        exerciseDate: ex.exerciseDate.toISOString().slice(0, 10),
        quantityExercised: ex.quantityExercised.toString(),
      });
    }
  }

  const allocations = allocateIso100kAcrossExercises(isoGrantsWithTranches, allocationInputExercises);
  const thisAllocation = allocations.find((a) => a.exerciseEventId === record.exerciseEvent!.id);
  // Falls back to the exercise's full quantity when no ISO grant/tranche data matched
  // (e.g. a performance/market-condition ISO grant — see the report route's $100K
  // RULE SCOPE NOTE) — same documented fallback as ExerciseForCompliance's own default.
  const isoQualifiedSharesTransferred = thisAllocation
    ? thisAllocation.iso100kQualifiedQuantity.toString()
    : record.exerciseEvent.quantityExercised.toString();

  const grantTerms = await db.instrumentTermVersion.findFirst({
    where: { instrumentId: record.exerciseEvent.instrumentId },
    orderBy: { effectiveDate: "desc" },
    select: { terms: true },
  });
  const grantDate = (grantTerms?.terms as { grantDate?: string } | undefined)?.grantDate;
  if (!grantDate) {
    return NextResponse.json({ error: "Could not determine this grant's date option granted — no term version on file." }, { status: 409 });
  }

  const result = computeForm3921Data({
    entity: {
      name: entity.name,
      address: entity.address,
      employerIdentificationNumber: entity.employerIdentificationNumber,
    },
    stakeholder: {
      name: stakeholder.name,
      address: stakeholder.address,
      taxIdNumber: stakeholder.taxIdNumber,
    },
    grantDate,
    exerciseDate: record.exerciseEvent.exerciseDate.toISOString().slice(0, 10),
    exercisePricePerShare: record.exerciseEvent.exercisePricePerShare.toString(),
    fairMarketValuePerShareAtExercise: record.exerciseEvent.fairMarketValuePerShareAtExercise.toString(),
    isoQualifiedSharesTransferred,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: `Can't generate Form 3921 — missing required information: ${result.missingFields.join(", ")}.`, missingFields: result.missingFields },
      { status: 409 }
    );
  }

  const pdf = buildForm3921Pdf(result.data);
  return new NextResponse(pdf, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="form-3921-${stakeholder.name.replace(/[^a-z0-9]+/gi, "-")}-${result.data.taxYear}.pdf"`,
    },
  });
}
