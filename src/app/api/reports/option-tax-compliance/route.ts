import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";
import {
  ExerciseForCompliance,
  Restricted83bTransfer,
  PersistedTaxFilingRecord,
  buildMonthlyComplianceReport,
  allocateIso100kAcrossExercises,
  IsoGrantWithTranches,
  ExerciseForIso100kAllocation,
} from "@/lib/accounting/optionTaxCompliance";
import { StockOptionInstrumentTerms } from "@/lib/accounting/dispatch";

/**
 * POST /api/reports/option-tax-compliance { "entityId", "targetMonth": "YYYY-MM" }
 *
 * The monthly compliance report George asked for: "a report each month that tells
 * [a user] what tax filings need to be done for any options with an event that
 * requires filing." Reads every recorded OptionExerciseEvent/ShareDispositionEvent
 * for this entity's STOCK_OPTION instruments (plus RESTRICTED_STOCK instruments for
 * 83(b) deadline tracking), runs them through optionTaxCompliance.ts's pure
 * classification functions, and reconciles the result against whatever
 * TaxFilingRecord rows already exist — creating a new PENDING row for every
 * newly-discovered obligation (see buildMonthlyComplianceReport's own doc comment for
 * why that persistence step lives here, not in the pure lib function).
 *
 * $100K RULE SCOPE NOTE: the ISO $100k allocation (allocateIso100kAcrossExercises,
 * which needs each grant's own vesting TRANCHE schedule) only has real tranche data
 * to work with for SERVICE-CONDITION STOCK_OPTION grants (see
 * StockOptionServiceConditionTerms in dispatch.ts) — a performance- or market-
 * condition ISO grant has no tranche-level vest schedule in this data model at all.
 * For those, every exercised share is treated as fully ISO-qualified (i.e. the $100k
 * rule is NOT applied) — flagged here explicitly, in `iso100kRuleSkipped` on the
 * response, rather than silently assumed away. Performance/market-condition ISOs are
 * rare in practice; this is a real, documented gap, not an oversight.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { entityId, targetMonth } = body ?? {};

  if (!entityId || typeof entityId !== "string") {
    return NextResponse.json({ error: "entityId is required" }, { status: 400 });
  }
  if (!targetMonth || typeof targetMonth !== "string" || !/^\d{4}-\d{2}$/.test(targetMonth)) {
    return NextResponse.json({ error: 'targetMonth is required and must be "YYYY-MM"' }, { status: 400 });
  }

  const access = await requireApiEntityAccess(req, entityId, "VIEWER");
  if (access instanceof NextResponse) return access;

  const entity = await db.entity.findUnique({ where: { id: entityId } });
  if (!entity) {
    return NextResponse.json({ error: `No entity found with id "${entityId}"` }, { status: 404 });
  }

  const stakeholders = await db.stakeholder.findMany({
    where: { entityId },
    select: {
      id: true,
      name: true,
      taxIdNumber: true,
      address: true,
      instruments: {
        where: { type: { in: ["STOCK_OPTION", "RESTRICTED_STOCK"] } },
        select: {
          id: true,
          type: true,
          issueDate: true,
          termVersions: {
            select: { terms: true },
            orderBy: { effectiveDate: "desc" },
            take: 1,
          },
          exerciseEvents: {
            select: {
              id: true,
              exerciseDate: true,
              quantityExercised: true,
              exercisePricePerShare: true,
              fairMarketValuePerShareAtExercise: true,
              dispositions: { select: { dispositionDate: true, quantitySold: true, salePricePerShare: true } },
            },
          },
        },
      },
    },
  });

  const exercisesForCompliance: ExerciseForCompliance[] = [];
  const restrictedTransfers: Restricted83bTransfer[] = [];
  let iso100kRuleSkipped = false;

  for (const stakeholder of stakeholders) {
    // Gather this stakeholder's ISO grants that HAVE a real tranche schedule (see this
    // route's $100K RULE SCOPE NOTE) for the $100k allocation, and remember every
    // exercise recorded against a STOCK_OPTION instrument so it can be classified once
    // the allocation is known.
    const isoGrantsWithTranches: IsoGrantWithTranches[] = [];
    const allocationInputExercises: ExerciseForIso100kAllocation[] = [];
    const rawExercisesByInstrument = new Map<
      string,
      { isIncentiveStockOption: boolean; grantDate: string; exercises: (typeof stakeholder.instruments)[number]["exerciseEvents"] }
    >();

    for (const inst of stakeholder.instruments) {
      if (inst.type === "RESTRICTED_STOCK") {
        // 83(b) deadline tracking uses the instrument's own issueDate directly — no
        // need to read the terms JSON for this purpose.
        restrictedTransfers.push({
          instrumentId: inst.id,
          stakeholderId: stakeholder.id,
          transferDate: inst.issueDate.toISOString().slice(0, 10),
        });
        continue;
      }

      // STOCK_OPTION
      const latestTerms = inst.termVersions[0]?.terms as unknown as StockOptionInstrumentTerms | undefined;
      if (!latestTerms || inst.exerciseEvents.length === 0) continue;

      const isIncentiveStockOption = Boolean((latestTerms as { isIncentiveStockOption?: boolean }).isIncentiveStockOption);
      const grantDate = (latestTerms as { grantDate: string }).grantDate;
      rawExercisesByInstrument.set(inst.id, { isIncentiveStockOption, grantDate, exercises: inst.exerciseEvents });

      if (isIncentiveStockOption) {
        const conditionType = (latestTerms as { conditionType?: string }).conditionType ?? "service";
        const tranches = (latestTerms as { tranches?: { id: string; vestDate: string; quantity: unknown }[] }).tranches;
        const grantDateFairValuePerUnit = (latestTerms as { grantDateFairValuePerUnit?: unknown }).grantDateFairValuePerUnit;
        if (conditionType === "service" && tranches && grantDateFairValuePerUnit !== undefined) {
          isoGrantsWithTranches.push({
            instrumentId: inst.id,
            grantDate,
            grantDateFmvPerShare: grantDateFairValuePerUnit as string,
            tranches: tranches.map((t) => ({ id: t.id, vestDate: t.vestDate, quantity: t.quantity as string })),
          });
        } else {
          iso100kRuleSkipped = true;
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
    }

    const allocations = allocateIso100kAcrossExercises(isoGrantsWithTranches, allocationInputExercises);
    const allocationByExerciseId = new Map(allocations.map((a) => [a.exerciseEventId, a.iso100kQualifiedQuantity]));

    for (const [instrumentId, { isIncentiveStockOption, grantDate, exercises }] of rawExercisesByInstrument) {
      for (const ex of exercises) {
        const iso100kQualifiedQuantity = allocationByExerciseId.get(ex.id);
        exercisesForCompliance.push({
          exerciseEventId: ex.id,
          instrumentId,
          stakeholderId: stakeholder.id,
          isIncentiveStockOption,
          grantDate,
          exerciseDate: ex.exerciseDate.toISOString().slice(0, 10),
          quantityExercised: ex.quantityExercised.toString(),
          exercisePricePerShare: ex.exercisePricePerShare.toString(),
          fairMarketValuePerShareAtExercise: ex.fairMarketValuePerShareAtExercise.toString(),
          // Undefined (not zero) when this ISO grant had no usable tranche schedule —
          // ExerciseForCompliance's own default ("assume the whole exercise is ISO-
          // qualified") is exactly the documented fallback for that case.
          iso100kQualifiedQuantity: iso100kQualifiedQuantity?.toString(),
          dispositions: ex.dispositions.map((d) => ({
            dispositionDate: d.dispositionDate.toISOString().slice(0, 10),
            quantitySold: d.quantitySold.toString(),
            salePricePerShare: d.salePricePerShare.toString(),
          })),
        });
      }
    }
  }

  const existingRecordRows = await db.taxFilingRecord.findMany({ where: { entityId } });
  const existingRecords: PersistedTaxFilingRecord[] = existingRecordRows.map((r) => ({
    id: r.id,
    filingType: r.filingType,
    taxYear: r.taxYear,
    exerciseEventId: r.exerciseEventId,
    instrumentId: r.instrumentId,
    status: r.status,
  }));

  const report = buildMonthlyComplianceReport(targetMonth, exercisesForCompliance, restrictedTransfers, existingRecords);

  // Persist a new PENDING TaxFilingRecord for every obligation this run discovered
  // that has no existing row yet — across ALL rows, not just this month's, so a
  // filing that's due in a future month already shows up (as PENDING, not
  // actionable-yet) the first time this report is ever run, rather than waiting until
  // its own due month to be created.
  const newlyCreatedIds: string[] = [];
  for (const row of report.rows) {
    if (row.existingRecord) continue;
    const created = await db.taxFilingRecord.create({
      data: {
        entityId,
        filingType: row.obligation.filingType,
        taxYear: row.obligation.taxYear,
        exerciseEventId: row.obligation.exerciseEventId ?? null,
        instrumentId: row.obligation.exerciseEventId ? null : row.obligation.instrumentId,
      },
    });
    row.existingRecord = {
      id: created.id,
      filingType: created.filingType,
      taxYear: created.taxYear,
      exerciseEventId: created.exerciseEventId,
      instrumentId: created.instrumentId,
      status: created.status,
    };
    newlyCreatedIds.push(created.id);
  }

  return NextResponse.json({
    entity: { id: entity.id, name: entity.name },
    targetMonth: report.targetMonth,
    iso100kRuleSkipped,
    newlyCreatedRecordIds: newlyCreatedIds,
    rows: report.rows.map((row) => ({
      filingType: row.obligation.filingType,
      taxYear: row.obligation.taxYear,
      stakeholderId: row.obligation.stakeholderId,
      instrumentId: row.obligation.instrumentId,
      exerciseEventId: row.obligation.exerciseEventId ?? null,
      description: row.obligation.description,
      amount: row.obligation.amount?.toFixed(2) ?? null,
      deadline: row.obligation.deadline ?? null,
      dueThisMonth: row.dueThisMonth,
      overdue: row.overdue,
      taxFilingRecordId: row.existingRecord?.id ?? null,
      status: row.existingRecord?.status ?? "PENDING",
    })),
    actionableCount: report.actionableThisMonth.length,
  });
}
