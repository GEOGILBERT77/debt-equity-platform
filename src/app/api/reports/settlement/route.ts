import { NextRequest, NextResponse } from "next/server";
import {
  buildCashExerciseEntry,
  buildNetShareSettlementEntry,
  buildTaxWithholdingRemittanceEntry,
  CashExerciseInput,
  NetShareSettlementInput,
} from "@/lib/accounting/optionSettlement";
import { buildSettlementActivityDisclosure, SettlementActivityInput } from "@/lib/accounting/reporting";
import { requireApiUser } from "@/lib/auth/apiGuard";

/**
 * POST /api/reports/settlement
 *   { "mode": "CASH_EXERCISE", "exerciseDate", "quantityExercised", "exercisePricePerUnit",
 *     "grantDateFairValuePerUnit" }
 *   { "mode": "NET_SHARE_SETTLEMENT", "settlementDate", "grossQuantity",
 *     "exercisePricePerUnit" (0 for an RSU), "fairMarketValuePerUnitAtSettlement",
 *     "taxWithholdingAmount"? }
 *   { "mode": "TAX_WITHHOLDING_REMITTANCE", "remittanceDate", "amount" }
 *   { "mode": "ACTIVITY_SUMMARY", "events": [ { instrumentId, stakeholderName, type:
 *     "CASH_EXERCISE"|"NET_SHARE_SETTLEMENT", sharesIssued, cashReceivedFromExercise?,
 *     taxWithholdingAmount? }, ... ] }
 *
 * ACTIVITY_SUMMARY (v0.20.0) rolls a batch of already-computed settlement
 * transactions into the disclosure-style totals `buildSettlementActivityDisclosure`
 * (reporting.ts) produces — see that function's doc comment for why it takes
 * transactions as ad hoc input rather than querying stored data: this platform has no
 * persisted "exercise"/"settlement" event yet, only grant terms and vesting schedules.
 *
 * A CALCULATOR, same pattern as /api/reports/exit-waterfall and the /api/reports/tax/*
 * routes — see optionSettlement.ts's module doc comment for the full accounting this
 * wraps. Not entity-scoped and not tied to any stored `Instrument`/`ScheduleEntry` row:
 * this platform doesn't have an "exercise" or "settlement" event in its data model at
 * all yet (only grant terms and vesting schedules), so every call supplies its own
 * numbers by hand for now, same limitation the exit-waterfall calculator already
 * documents. Still requires a logged-in user, not a public calculator.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest) {
  const user = await requireApiUser(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const { mode } = body ?? {};

  try {
    if (mode === "CASH_EXERCISE") {
      const required = ["exerciseDate", "quantityExercised", "exercisePricePerUnit", "grantDateFairValuePerUnit"];
      for (const field of required) {
        if (body[field] === undefined || body[field] === null) {
          return NextResponse.json({ error: `"${field}" is required for mode CASH_EXERCISE` }, { status: 400 });
        }
      }
      const entry = buildCashExerciseEntry(body as CashExerciseInput);
      return NextResponse.json({ mode, entry: serializeEntry(entry) });
    }

    if (mode === "NET_SHARE_SETTLEMENT") {
      const required = ["settlementDate", "grossQuantity", "exercisePricePerUnit", "fairMarketValuePerUnitAtSettlement"];
      for (const field of required) {
        if (body[field] === undefined || body[field] === null) {
          return NextResponse.json({ error: `"${field}" is required for mode NET_SHARE_SETTLEMENT` }, { status: 400 });
        }
      }
      const entry = buildNetShareSettlementEntry(body as NetShareSettlementInput);
      return NextResponse.json({ mode, entry: serializeEntry(entry) });
    }

    if (mode === "TAX_WITHHOLDING_REMITTANCE") {
      if (body.remittanceDate === undefined || body.amount === undefined) {
        return NextResponse.json({ error: `"remittanceDate" and "amount" are required for mode TAX_WITHHOLDING_REMITTANCE` }, { status: 400 });
      }
      const entry = buildTaxWithholdingRemittanceEntry(body.remittanceDate, body.amount);
      return NextResponse.json({ mode, entry: serializeEntry(entry) });
    }

    if (mode === "ACTIVITY_SUMMARY") {
      if (!Array.isArray(body.events) || body.events.length === 0) {
        return NextResponse.json({ error: `"events" must be a non-empty array for mode ACTIVITY_SUMMARY` }, { status: 400 });
      }
      const requiredFields = ["instrumentId", "stakeholderName", "type", "sharesIssued"];
      for (const [i, e] of body.events.entries()) {
        for (const field of requiredFields) {
          if (e?.[field] === undefined || e?.[field] === null) {
            return NextResponse.json({ error: `events[${i}] is missing required field "${field}"` }, { status: 400 });
          }
        }
      }
      const summary = buildSettlementActivityDisclosure(body.events as SettlementActivityInput[]);
      return NextResponse.json({
        mode,
        totalSharesIssued: summary.totalSharesIssued.toFixed(2),
        totalCashReceivedFromExercise: summary.totalCashReceivedFromExercise.toFixed(2),
        totalTaxWithholdingAmount: summary.totalTaxWithholdingAmount.toFixed(2),
        transactionCountByType: summary.transactionCountByType,
        rows: summary.rows.map((r) => ({
          instrumentId: r.instrumentId,
          stakeholderName: r.stakeholderName,
          type: r.type,
          sharesIssued: r.sharesIssued.toFixed(2),
          cashReceivedFromExercise: r.cashReceivedFromExercise.toFixed(2),
          taxWithholdingAmount: r.taxWithholdingAmount.toFixed(2),
        })),
      });
    }

    return NextResponse.json(
      { error: `"mode" must be one of CASH_EXERCISE, NET_SHARE_SETTLEMENT, TAX_WITHHOLDING_REMITTANCE, ACTIVITY_SUMMARY` },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute the settlement entry" }, { status: 400 });
  }
}

function serializeEntry(entry: ReturnType<typeof buildCashExerciseEntry>) {
  return {
    date: entry.date,
    description: entry.description,
    ascReference: entry.ascReference,
    lines: entry.lines.map((l) => ({
      account: l.account,
      debit: l.debit?.toFixed(2),
      credit: l.credit?.toFixed(2),
      memo: l.memo,
    })),
  };
}
