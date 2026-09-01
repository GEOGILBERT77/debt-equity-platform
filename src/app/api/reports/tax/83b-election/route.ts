import { NextRequest, NextResponse } from "next/server";
import {
  evaluateSection83bElection,
  computeOrdinaryIncomeWithoutSection83b,
  Section83bScenario,
  RestrictedStockTranche,
} from "@/lib/accounting/taxElections";
import { requireApiUser } from "@/lib/auth/apiGuard";

/**
 * POST /api/reports/tax/83b-election
 *   { "scenario": { transferDate, fmvPerShareAtTransfer, purchasePricePerShare, quantity },
 *     "filedDate", "comparisonTranches"?: [{ vestDate, quantity, fmvPerShareAtVest, purchasePricePerShare }] }
 *
 * Wraps taxElections.ts's IRC 83(b) election evaluator. When `comparisonTranches` is
 * supplied, this also runs `computeOrdinaryIncomeWithoutSection83b` over them and
 * returns both outcomes side by side — the same "preview both paths before advising"
 * pattern that function's own doc comment describes, surfaced here as one API call
 * instead of two, since deciding whether to file the election is exactly the
 * side-by-side comparison a preparer needs.
 *
 * A calculator, not a report over stored data — RestrictedStockInstrumentTerms has no
 * 83(b)-election-filed-date field to read from yet (see the README's tax-reporting
 * gaps note).
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest) {
  const user = await requireApiUser(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const { scenario, filedDate, comparisonTranches } = body ?? {};

  if (!scenario || !filedDate) {
    return NextResponse.json({ error: "scenario and filedDate are both required" }, { status: 400 });
  }

  let electionResult;
  try {
    electionResult = evaluateSection83bElection(scenario as Section83bScenario, filedDate);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to evaluate the election" }, { status: 400 });
  }

  const withoutElection = Array.isArray(comparisonTranches)
    ? computeOrdinaryIncomeWithoutSection83b(comparisonTranches as RestrictedStockTranche[]).map((r) => ({
        vestDate: r.vestDate,
        ordinaryIncome: r.ordinaryIncome.toFixed(2),
      }))
    : undefined;

  return NextResponse.json({
    election: {
      deadline: electionResult.deadline,
      filedDate: electionResult.filedDate,
      isTimely: electionResult.isTimely,
      ordinaryIncomeAtTransfer: electionResult.ordinaryIncomeAtTransfer.toFixed(2),
      note: electionResult.note,
    },
    withoutElection,
  });
}
