import { NextRequest, NextResponse } from "next/server";
import {
  classifySafe,
  buildLiabilitySafeIssuanceEntry,
  buildEquitySafeIssuanceEntry,
  buildSafeConversionEntry,
  SafeClassificationInputs,
} from "@/lib/accounting/safe";
import { requireApiUser } from "@/lib/auth/apiGuard";

/**
 * POST /api/reports/safe
 *   { "mode": "CLASSIFY", "conversionPriceFixedAtInception", "holderCanElectCashSettlement" }
 *   { "mode": "LIABILITY_ISSUANCE_ENTRY", "date", "investmentAmountReceived", "initialFairValue"? }
 *   { "mode": "EQUITY_ISSUANCE_ENTRY", "date", "investmentAmountReceived" }
 *   { "mode": "CONVERSION_ENTRY", "date", "safeAccountName", "carryingValueAtConversion",
 *     "sharesIssued", "parValuePerShare"? }
 *
 * ASC 480-10-25-14's SAFE classification triage and the resulting issuance/conversion
 * accounting — see safe.ts's module doc comment for the full reasoning (why a standard
 * cap/discount SAFE is liability-classified by default, and how the liability path's
 * periodic remeasurement reuses fairValueRemeasurement.ts directly rather than a new
 * engine — call POST /api/reports/fair-value-remeasurement, if/when that route exists,
 * or the underlying function directly, for that ongoing roll-forward).
 *
 * A CALCULATOR, same pattern as the other /api/reports/* calculators here — not tied
 * to any stored `Instrument` row. Still requires a logged-in user.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest) {
  const user = await requireApiUser(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const { mode } = body ?? {};

  try {
    if (mode === "CLASSIFY") {
      if (body.conversionPriceFixedAtInception === undefined || body.holderCanElectCashSettlement === undefined) {
        return NextResponse.json(
          { error: `"conversionPriceFixedAtInception" and "holderCanElectCashSettlement" are both required for mode CLASSIFY` },
          { status: 400 }
        );
      }
      const classification = classifySafe(body as SafeClassificationInputs);
      return NextResponse.json({ mode, classification });
    }

    if (mode === "LIABILITY_ISSUANCE_ENTRY") {
      if (body.date === undefined || body.investmentAmountReceived === undefined) {
        return NextResponse.json({ error: `"date" and "investmentAmountReceived" are required for mode LIABILITY_ISSUANCE_ENTRY` }, { status: 400 });
      }
      const entry = buildLiabilitySafeIssuanceEntry(body.date, body.investmentAmountReceived, undefined, body.initialFairValue);
      return NextResponse.json({ mode, entry: serializeEntry(entry) });
    }

    if (mode === "EQUITY_ISSUANCE_ENTRY") {
      if (body.date === undefined || body.investmentAmountReceived === undefined) {
        return NextResponse.json({ error: `"date" and "investmentAmountReceived" are required for mode EQUITY_ISSUANCE_ENTRY` }, { status: 400 });
      }
      const entry = buildEquitySafeIssuanceEntry(body.date, body.investmentAmountReceived);
      return NextResponse.json({ mode, entry: serializeEntry(entry) });
    }

    if (mode === "CONVERSION_ENTRY") {
      const required = ["date", "safeAccountName", "carryingValueAtConversion", "sharesIssued"];
      for (const field of required) {
        if (body[field] === undefined || body[field] === null) {
          return NextResponse.json({ error: `"${field}" is required for mode CONVERSION_ENTRY` }, { status: 400 });
        }
      }
      const entry = buildSafeConversionEntry(
        body.date,
        body.safeAccountName,
        body.carryingValueAtConversion,
        body.sharesIssued,
        body.parValuePerShare ?? 0
      );
      return NextResponse.json({ mode, entry: serializeEntry(entry) });
    }

    return NextResponse.json(
      { error: `"mode" must be one of CLASSIFY, LIABILITY_ISSUANCE_ENTRY, EQUITY_ISSUANCE_ENTRY, CONVERSION_ENTRY` },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute the SAFE result" }, { status: 400 });
  }
}

function serializeEntry(entry: ReturnType<typeof buildEquitySafeIssuanceEntry>) {
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
