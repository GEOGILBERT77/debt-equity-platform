import { NextRequest, NextResponse } from "next/server";
import { classifyEmbeddedConversionFeature, EmbeddedConversionFeatureInputs } from "@/lib/accounting/embeddedDerivativeBifurcation";
import { requireApiUser } from "@/lib/auth/apiGuard";

/**
 * POST /api/reports/embedded-derivative-bifurcation
 *   { "netCashSettlementPossible", "indexedToOwnStockOnly", "hasDownRoundProtection",
 *     "hybridInstrumentAlreadyAtFairValueThroughEarnings"? }
 *
 * ASC 815-15-25 embedded conversion feature bifurcation assessment — the ASC
 * 815-10-15-74 scope exception for a conversion feature that would be equity-
 * classified if freestanding, reusing warrantAllocation.ts's classifyWarrant rather
 * than a second indexation analysis. See embeddedDerivativeBifurcation.ts's module
 * doc comment for the full mechanics and what's deliberately out of scope — most
 * importantly, this is a CLASSIFICATION triage only; it does not value a derivative
 * that IS required to be bifurcated (that needs a lattice/Monte Carlo model, a
 * materially larger undertaking not attempted here).
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
  const required = ["netCashSettlementPossible", "indexedToOwnStockOnly", "hasDownRoundProtection"];
  for (const field of required) {
    if (body[field] === undefined || body[field] === null) {
      return NextResponse.json({ error: `"${field}" is required` }, { status: 400 });
    }
  }

  try {
    const result = classifyEmbeddedConversionFeature(body as EmbeddedConversionFeatureInputs);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to classify the embedded feature" }, { status: 400 });
  }
}
