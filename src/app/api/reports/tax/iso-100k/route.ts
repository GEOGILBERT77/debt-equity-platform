import { NextRequest, NextResponse } from "next/server";
import { applyIso100kLimit, IsoGrant } from "@/lib/accounting/taxElections";
import { requireApiUser } from "@/lib/auth/apiGuard";

/**
 * POST /api/reports/tax/iso-100k
 *   { "grants": [ { id, grantDate, grantDateFmvPerShare, tranches: [{id, firstExercisableDate, quantity}] } ], "annualLimit"?: "100000" }
 *
 * Tax filing support (v0.19.0) — the first API caller taxElections.ts's IRC 422(d)
 * $100k-limit engine has ever had; the function itself has existed (and been fully
 * tested) since before this version but was reachable only from tests. A CALCULATOR,
 * like every route under /api/reports/tax: this doesn't read stored instrument terms,
 * because STOCK_OPTION's ServiceConditionGrant terms shape has no ISO/NSO designation
 * or grant-date-FMV field to read one from yet (see the README's tax-reporting gaps
 * note). Every grant is supplied by hand for now.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest) {
  const user = await requireApiUser(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const { grants, annualLimit } = body ?? {};

  if (!Array.isArray(grants) || grants.length === 0) {
    return NextResponse.json({ error: "grants must be a non-empty array" }, { status: 400 });
  }

  let results;
  try {
    results = applyIso100kLimit(grants as IsoGrant[], annualLimit ?? undefined);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to apply the ISO $100k limit" }, { status: 400 });
  }

  return NextResponse.json({
    classifications: results.map((r) => ({
      grantId: r.grantId,
      trancheId: r.trancheId,
      calendarYear: r.calendarYear,
      quantity: r.quantity.toString(),
      isoQuantity: r.isoQuantity.toString(),
      nsoQuantity: r.nsoQuantity.toString(),
      valueAtGrantFmv: r.valueAtGrantFmv.toFixed(2),
      cumulativeValueForYearThroughThisTranche: r.cumulativeValueForYearThroughThisTranche.toFixed(2),
    })),
  });
}
