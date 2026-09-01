import { NextRequest, NextResponse } from "next/server";
import {
  computeBeneficialConversionFeature,
  buildDebtBcfEntry,
  buildPreferredBcfEntry,
  BeneficialConversionFeatureInputs,
} from "@/lib/accounting/beneficialConversionFeature";
import { requireApiUser } from "@/lib/auth/apiGuard";

/**
 * POST /api/reports/beneficial-conversion-feature
 *   { "mode": "COMPUTE", "proceedsAllocatedToConvertibleInstrument", "numberOfConversionShares",
 *     "commitmentDateFairValuePerShare" }
 *   { "mode": "DEBT_ENTRY", "date", "beneficialConversionFeatureAmount" }
 *   { "mode": "PREFERRED_ENTRY", "date", "beneficialConversionFeatureAmount" }
 *
 * ASC 470-20-30's beneficial conversion feature calculation and the two different
 * booking treatments that follow (additional debt discount for convertible notes,
 * an immediate deemed dividend for convertible preferred) — see
 * beneficialConversionFeature.ts's module doc comment for the full accounting and
 * what's deliberately out of scope (contingent conversion features, a later
 * down-round's "additional BCF").
 *
 * A CALCULATOR, same pattern as /api/reports/settlement and
 * /api/reports/debt-modification — not tied to any stored `Instrument` row, since this
 * platform's data model has no separate "BCF" field on a convertible instrument's
 * terms yet. Still requires a logged-in user, not a public calculator.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest) {
  const user = await requireApiUser(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const { mode } = body ?? {};

  try {
    if (mode === "COMPUTE") {
      const required = ["proceedsAllocatedToConvertibleInstrument", "numberOfConversionShares", "commitmentDateFairValuePerShare"];
      for (const field of required) {
        if (body[field] === undefined || body[field] === null) {
          return NextResponse.json({ error: `"${field}" is required for mode COMPUTE` }, { status: 400 });
        }
      }
      const result = computeBeneficialConversionFeature(body as BeneficialConversionFeatureInputs);
      return NextResponse.json({
        mode,
        effectiveConversionPricePerShare: result.effectiveConversionPricePerShare.toFixed(2),
        intrinsicValuePerShare: result.intrinsicValuePerShare.toFixed(2),
        beneficialConversionFeatureAmount: result.beneficialConversionFeatureAmount.toFixed(2),
        hasBeneficialConversionFeature: result.hasBeneficialConversionFeature,
      });
    }

    if (mode === "DEBT_ENTRY" || mode === "PREFERRED_ENTRY") {
      if (body.date === undefined || body.beneficialConversionFeatureAmount === undefined) {
        return NextResponse.json({ error: `"date" and "beneficialConversionFeatureAmount" are required for mode ${mode}` }, { status: 400 });
      }
      const entry =
        mode === "DEBT_ENTRY"
          ? buildDebtBcfEntry(body.date, body.beneficialConversionFeatureAmount)
          : buildPreferredBcfEntry(body.date, body.beneficialConversionFeatureAmount);
      return NextResponse.json({ mode, entry: serializeEntry(entry) });
    }

    return NextResponse.json({ error: `"mode" must be one of COMPUTE, DEBT_ENTRY, PREFERRED_ENTRY` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute the beneficial conversion feature" }, { status: 400 });
  }
}

function serializeEntry(entry: ReturnType<typeof buildDebtBcfEntry>) {
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
