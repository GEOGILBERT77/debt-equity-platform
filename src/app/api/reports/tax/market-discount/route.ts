import { NextRequest, NextResponse } from "next/server";
import { computeMarketDiscount, MarketDiscountInputs } from "@/lib/accounting/taxElections";
import { Period } from "@/lib/accounting/dateMath";
import { requireApiUser } from "@/lib/auth/apiGuard";

/**
 * POST /api/reports/tax/market-discount
 *   { "inputs": { purchaseDate, purchasePrice, revisedIssuePriceAtPurchase,
 *       statedRedemptionPriceAtMaturity, maturityDate, yieldToMaturity,
 *       completeYearsToMaturity, cashFlows: [{date, amount}] },
 *     "periods": [{ label, start, end }, ...] }
 *
 * Wraps taxElections.ts's IRC 1276/1278 market discount calculator (holder-side —
 * see that function's doc comment for the default-vs-IRC-1278(b)-election distinction
 * and why it returns BOTH the ratable and constant-yield schedules for comparison
 * rather than picking one). Same "caller supplies periods, this is a calculator not a
 * stored-data report" shape as this directory's debt-oid sibling route.
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
    result = computeMarketDiscount(inputs as MarketDiscountInputs, periods as Period[]);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute market discount" }, { status: 400 });
  }

  const formatSchedule = (schedule: typeof result.ratableSchedule) =>
    schedule.map((r) => ({
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      label: r.label,
      amount: r.amount.toFixed(2),
      ircReference: (r.meta as { ircReference?: string } | undefined)?.ircReference,
    }));

  return NextResponse.json({
    totalMarketDiscount: result.totalMarketDiscount.toFixed(2),
    deMinimisThreshold: result.deMinimisThreshold.toFixed(2),
    isDeMinimis: result.isDeMinimis,
    ratableSchedule: formatSchedule(result.ratableSchedule),
    constantYieldSchedule: formatSchedule(result.constantYieldSchedule),
  });
}
