import { NextRequest, NextResponse } from "next/server";
import {
  classifyTdrModification,
  buildTdrGainEntry,
  buildTdrReducedCarryingValueSchedule,
  buildTdrSettlementEntry,
  TdrModificationTestInput,
} from "@/lib/accounting/troubledDebtRestructuring";
import { requireApiUser } from "@/lib/auth/apiGuard";

/**
 * POST /api/reports/troubled-debt-restructuring
 *   { "mode": "TEST", "currentCarryingValue", "restructuredCashFlows": [amounts...] }
 *   { "mode": "GAIN_ENTRY", "date", "oldCarryingValue", "newCarryingValue" }
 *   { "mode": "REDUCED_CARRYING_VALUE_SCHEDULE", "newCarryingValue", "restructuredCashFlows": [amounts...],
 *     "periods": [{label, start, end}, ...] }
 *   { "mode": "SETTLEMENT_ENTRY", "date", "debtCarryingValue", "considerationAccountName",
 *     "considerationFairValue" }
 *
 * ASC 470-60 troubled debt restructuring — the undiscounted total-future-cash-payments
 * test, the immediate-gain/zero-interest path, the new-effective-rate path, and full
 * settlement via asset/equity transfer. See troubledDebtRestructuring.ts's module doc
 * comment for the full mechanics, why this is a genuinely different test from ASC
 * 470-50's discounted 10% test, and what's deliberately out of scope (a partial
 * settlement combining both paths, contingent-payment terms).
 *
 * A CALCULATOR, same pattern as the other /api/reports/* calculators here. Still
 * requires a logged-in user.
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
      if (body.currentCarryingValue === undefined || !Array.isArray(body.restructuredCashFlows)) {
        return NextResponse.json({ error: `"currentCarryingValue" and "restructuredCashFlows" (an array) are required for mode TEST` }, { status: 400 });
      }
      const result = classifyTdrModification(body as TdrModificationTestInput);
      if (result.kind === "GAIN_RECOGNIZED_IMMEDIATELY") {
        return NextResponse.json({ mode, kind: result.kind, gain: result.gain.toFixed(2), newCarryingValue: result.newCarryingValue.toFixed(2) });
      }
      return NextResponse.json({ mode, kind: result.kind, newEffectiveAnnualYield: result.newEffectiveAnnualYield.toFixed(6) });
    }

    if (mode === "GAIN_ENTRY") {
      if (body.date === undefined || body.oldCarryingValue === undefined || body.newCarryingValue === undefined) {
        return NextResponse.json({ error: `"date", "oldCarryingValue", and "newCarryingValue" are required for mode GAIN_ENTRY` }, { status: 400 });
      }
      const entry = buildTdrGainEntry(body.date, body.oldCarryingValue, body.newCarryingValue);
      return NextResponse.json({ mode, entry: serializeEntry(entry) });
    }

    if (mode === "REDUCED_CARRYING_VALUE_SCHEDULE") {
      if (body.newCarryingValue === undefined || !Array.isArray(body.restructuredCashFlows) || !Array.isArray(body.periods)) {
        return NextResponse.json(
          { error: `"newCarryingValue", "restructuredCashFlows" (array), and "periods" (array) are required for mode REDUCED_CARRYING_VALUE_SCHEDULE` },
          { status: 400 }
        );
      }
      const schedule = buildTdrReducedCarryingValueSchedule(body.newCarryingValue, body.restructuredCashFlows, body.periods);
      return NextResponse.json({
        mode,
        schedule: schedule.map((r) => ({
          label: r.label,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          amount: r.amount.toFixed(2),
          endingBalance: r.endingBalance?.toFixed(2),
        })),
      });
    }

    if (mode === "SETTLEMENT_ENTRY") {
      const required = ["date", "debtCarryingValue", "considerationAccountName", "considerationFairValue"];
      for (const field of required) {
        if (body[field] === undefined || body[field] === null) {
          return NextResponse.json({ error: `"${field}" is required for mode SETTLEMENT_ENTRY` }, { status: 400 });
        }
      }
      const { entry, gainOnRestructuring } = buildTdrSettlementEntry(
        body.date,
        body.debtCarryingValue,
        body.considerationAccountName,
        body.considerationFairValue
      );
      return NextResponse.json({ mode, gainOnRestructuring: gainOnRestructuring.toFixed(2), entry: serializeEntry(entry) });
    }

    return NextResponse.json(
      { error: `"mode" must be one of TEST, GAIN_ENTRY, REDUCED_CARRYING_VALUE_SCHEDULE, SETTLEMENT_ENTRY` },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute the TDR result" }, { status: 400 });
  }
}

function serializeEntry(entry: ReturnType<typeof buildTdrGainEntry>) {
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
