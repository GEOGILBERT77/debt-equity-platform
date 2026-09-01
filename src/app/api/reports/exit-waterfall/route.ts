import { NextRequest, NextResponse } from "next/server";
import { buildExitWaterfall, WaterfallClassInput } from "@/lib/accounting/exitWaterfall";
import { requireApiUser } from "@/lib/auth/apiGuard";

/**
 * POST /api/reports/exit-waterfall
 *   { "exitProceeds": "50000000", "classes": [ { id, name, seniorityRank, shares,
 *     liquidationPreferencePerShare, participating, participationCap? }, ... ] }
 *
 * A CALCULATOR, not a report over persisted data — see exitWaterfall.ts's file-level
 * doc comment for exactly why: PreferredStockInstrumentTerms doesn't model seniority,
 * participation, or a liquidation-preference multiple yet, so there is no stored data
 * this route could read a real cap table's stack from. This route exists so the
 * calculation is reachable at all (previously it had zero callers, same gap
 * taxElections.ts's five sub-modules had before this version), pending that terms
 * extension. Every caller supplies the whole stack by hand for now.
 *
 * Not entity-scoped (no entityId, no ownership check on the numbers themselves —
 * there's nothing in the database to own) but still requires a logged-in user, same as
 * every other route under /api — this isn't a public calculator.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest) {
  const user = await requireApiUser(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const { exitProceeds, classes } = body ?? {};

  if (exitProceeds === undefined || exitProceeds === null) {
    return NextResponse.json({ error: "exitProceeds is required" }, { status: 400 });
  }
  if (!Array.isArray(classes) || classes.length === 0) {
    return NextResponse.json({ error: "classes must be a non-empty array" }, { status: 400 });
  }

  const requiredFields = ["id", "name", "seniorityRank", "shares", "liquidationPreferencePerShare", "participating"];
  for (const [i, c] of classes.entries()) {
    for (const field of requiredFields) {
      if (c?.[field] === undefined || c?.[field] === null) {
        return NextResponse.json({ error: `classes[${i}] is missing required field "${field}"` }, { status: 400 });
      }
    }
  }

  let result;
  try {
    result = buildExitWaterfall(exitProceeds, classes as WaterfallClassInput[]);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute the waterfall" }, { status: 400 });
  }

  return NextResponse.json({
    exitProceeds: result.exitProceeds.toFixed(2),
    totalDistributed: result.totalDistributed.toFixed(2),
    undistributed: result.undistributed.toFixed(2),
    classResults: result.classResults.map((r) => ({
      id: r.id,
      name: r.name,
      shares: r.shares.toString(),
      converted: r.converted,
      cappedByParticipation: r.cappedByParticipation,
      proceedsFromPreference: r.proceedsFromPreference.toFixed(2),
      proceedsFromResidual: r.proceedsFromResidual.toFixed(2),
      totalProceeds: r.totalProceeds.toFixed(2),
      perShareProceeds: r.perShareProceeds.toFixed(4),
    })),
  });
}
