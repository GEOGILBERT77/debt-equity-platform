import { NextRequest, NextResponse } from "next/server";
import {
  runDebtModificationTest,
  buildExtinguishmentEntry,
  buildModificationLenderFeeEntry,
  buildThirdPartyCostExpenseEntry,
  DebtModificationTestInput,
  ExtinguishmentAccountingInput,
} from "@/lib/accounting/debtModification";
import { requireApiUser } from "@/lib/auth/apiGuard";

/**
 * POST /api/reports/debt-modification
 *   { "mode": "TEST", "originalCashFlows": [{period, amount}, ...],
 *     "newCashFlows": [{period, amount}, ...], "originalEffectiveRatePerPeriod" }
 *   { "mode": "EXTINGUISHMENT_ENTRY", "date", "oldDebtCarryingValue", "newDebtFairValue",
 *     "lenderFeesPaid"? }
 *   { "mode": "MODIFICATION_LENDER_FEE_ENTRY", "date", "lenderFeesPaid" }
 *   { "mode": "THIRD_PARTY_COST_ENTRY", "date", "amount" }
 *
 * ASC 470-50's 10% cash flow test and the fee/gain/loss accounting that follows from
 * it — see debtModification.ts's module doc comment for the full accounting (why both
 * cash-flow streams discount at the OLD debt's rate, how lender fees are folded into
 * the test itself but third-party fees never are, and what's deliberately out of
 * scope: troubled debt restructurings and multi-lender syndications).
 *
 * A CALCULATOR, same pattern as /api/reports/settlement and /api/reports/exit-waterfall
 * — not tied to any stored `Instrument` row, since this platform has no "modification
 * event" in its data model yet, only grant/issuance terms and vesting/amortization
 * schedules. Still requires a logged-in user, not a public calculator.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest) {
  const user = await requireApiUser(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const { mode } = body ?? {};

  try {
    if (mode === "TEST") {
      const required = ["originalCashFlows", "newCashFlows", "originalEffectiveRatePerPeriod"];
      for (const field of required) {
        if (body[field] === undefined || body[field] === null) {
          return NextResponse.json({ error: `"${field}" is required for mode TEST` }, { status: 400 });
        }
      }
      if (!Array.isArray(body.originalCashFlows) || !Array.isArray(body.newCashFlows)) {
        return NextResponse.json({ error: `"originalCashFlows" and "newCashFlows" must both be arrays` }, { status: 400 });
      }
      const result = runDebtModificationTest(body as DebtModificationTestInput);
      return NextResponse.json({
        mode,
        presentValueOriginal: result.presentValueOriginal.toFixed(2),
        presentValueNew: result.presentValueNew.toFixed(2),
        percentDifference: result.percentDifference.toFixed(4),
        threshold: result.threshold.toFixed(2),
        classification: result.classification,
      });
    }

    if (mode === "EXTINGUISHMENT_ENTRY") {
      const required = ["date", "oldDebtCarryingValue", "newDebtFairValue"];
      for (const field of required) {
        if (body[field] === undefined || body[field] === null) {
          return NextResponse.json({ error: `"${field}" is required for mode EXTINGUISHMENT_ENTRY` }, { status: 400 });
        }
      }
      const { entry, gainOrLoss } = buildExtinguishmentEntry(body as ExtinguishmentAccountingInput);
      return NextResponse.json({ mode, gainOrLoss: gainOrLoss.toFixed(2), entry: serializeEntry(entry) });
    }

    if (mode === "MODIFICATION_LENDER_FEE_ENTRY") {
      if (body.date === undefined || body.lenderFeesPaid === undefined) {
        return NextResponse.json({ error: `"date" and "lenderFeesPaid" are required for mode MODIFICATION_LENDER_FEE_ENTRY` }, { status: 400 });
      }
      const entry = buildModificationLenderFeeEntry(body.date, body.lenderFeesPaid);
      return NextResponse.json({ mode, entry: serializeEntry(entry) });
    }

    if (mode === "THIRD_PARTY_COST_ENTRY") {
      if (body.date === undefined || body.amount === undefined) {
        return NextResponse.json({ error: `"date" and "amount" are required for mode THIRD_PARTY_COST_ENTRY` }, { status: 400 });
      }
      const entry = buildThirdPartyCostExpenseEntry(body.date, body.amount);
      return NextResponse.json({ mode, entry: serializeEntry(entry) });
    }

    return NextResponse.json(
      { error: `"mode" must be one of TEST, EXTINGUISHMENT_ENTRY, MODIFICATION_LENDER_FEE_ENTRY, THIRD_PARTY_COST_ENTRY` },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute the debt modification result" }, { status: 400 });
  }
}

function serializeEntry(entry: ReturnType<typeof buildThirdPartyCostExpenseEntry>) {
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
