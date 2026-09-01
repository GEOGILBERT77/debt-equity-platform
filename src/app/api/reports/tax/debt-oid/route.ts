import { NextRequest, NextResponse } from "next/server";
import { computeTaxOid, TaxOidInputs } from "@/lib/accounting/taxElections";
import { Period } from "@/lib/accounting/dateMath";
import { requireApiUser } from "@/lib/auth/apiGuard";

/**
 * POST /api/reports/tax/debt-oid
 *   { "inputs": { issuePrice, statedRedemptionPriceAtMaturity, yieldToMaturity,
 *       completeYearsToMaturity, cashFlows: [{date, amount}] },
 *     "periods": [{ label, start, end }, ...] }
 *
 * Wraps taxElections.ts's IRC 1272(a) constant-yield OID accrual calculator (issuer-
 * side). `periods` is caller-supplied rather than generated here so the caller
 * controls the exact reporting calendar (fiscal year, not necessarily anniversary
 * year) — see dateMath.ts's buildAnnualPeriods/buildMonthlyPeriods for two ready-made
 * generators a caller can run client-side or in a script before calling this route.
 *
 * A calculator, not a report over stored data — see this directory's sibling routes'
 * doc comments for why every route under /api/reports/tax works this way for now.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest) {
  const user = await requireApiUser(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const { inputs, periods } = body ?? {};

  if (!inputs || !Array.isArray(periods) || periods.length === 0) {
    return NextResponse.json({ error: "inputs and a non-empty periods array are both required" }, { status: 400 });
  }

  let result;
  try {
    result = computeTaxOid(inputs as TaxOidInputs, periods as Period[]);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute OID" }, { status: 400 });
  }

  return NextResponse.json({
    totalOid: result.totalOid.toFixed(2),
    deMinimisThreshold: result.deMinimisThreshold.toFixed(2),
    isDeMinimis: result.isDeMinimis,
    schedule: result.schedule.map((r) => ({
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      label: r.label,
      amount: r.amount.toFixed(2),
      ircReference: (r.meta as { ircReference?: string } | undefined)?.ircReference,
    })),
  });
}
