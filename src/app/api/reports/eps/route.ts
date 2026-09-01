import { NextRequest, NextResponse } from "next/server";
import { computeTwoClassBasicEps, computeMoreDilutiveEps, TwoClassEpsInputs } from "@/lib/accounting/epsTwoClass";
import { requireApiUser } from "@/lib/auth/apiGuard";

/**
 * POST /api/reports/eps
 *   { "mode": "BASIC", "netIncomeOrLoss", "dividendsDeclaredToCommon",
 *     "dividendsDeclaredToParticipatingClass", "weightedAverageCommonShares",
 *     "participatingClassAsConvertedShares" }
 *   { "mode": "DILUTED" } — same fields as BASIC, also returns the more-dilutive result.
 *
 * ASC 260-10-45's two-class method for basic EPS, plus the if-converted comparison
 * for diluted EPS — see epsTwoClass.ts's module doc comment for the full mechanics
 * and what's deliberately out of scope (multiple simultaneous participating classes,
 * a non-parity participation rate, full multi-security dilution sequencing).
 *
 * The participating class's as-converted share count should come from
 * `classifyInstrumentForCapTable`'s PREFERRED_STOCK branch (capTable.ts) — the same
 * number, not independently re-derived — so pull that first if computing this for a
 * real stored instrument rather than typing the share count in by hand here.
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

  const required = [
    "netIncomeOrLoss",
    "dividendsDeclaredToCommon",
    "dividendsDeclaredToParticipatingClass",
    "weightedAverageCommonShares",
    "participatingClassAsConvertedShares",
  ];

  try {
    if (mode === "BASIC" || mode === "DILUTED") {
      for (const field of required) {
        if (body[field] === undefined || body[field] === null) {
          return NextResponse.json({ error: `"${field}" is required for mode ${mode}` }, { status: 400 });
        }
      }
      const inputs = body as TwoClassEpsInputs;
      const basic = computeTwoClassBasicEps(inputs);
      const response: Record<string, unknown> = {
        mode,
        basicEpsCommon: basic.basicEpsCommon.toFixed(4),
        basicEpsParticipatingClass: basic.basicEpsParticipatingClass.toFixed(4),
        lossOrInsufficientEarnings: basic.lossOrInsufficientEarnings,
      };
      if (mode === "DILUTED") {
        const diluted = computeMoreDilutiveEps(inputs);
        response.dilutedMethod = diluted.method;
        response.dilutedEpsCommon = diluted.dilutedEpsCommon.toFixed(4);
      }
      return NextResponse.json(response);
    }

    return NextResponse.json({ error: `"mode" must be one of BASIC, DILUTED` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute EPS" }, { status: 400 });
  }
}
