import { NextRequest, NextResponse } from "next/server";
import { computeQsbsExclusion, QsbsHolding } from "@/lib/accounting/taxElections";
import { requireApiUser } from "@/lib/auth/apiGuard";

/**
 * POST /api/reports/tax/qsbs
 *   { "issuanceDate", "acquisitionDate"?, "dispositionDate", "adjustedBasis",
 *     "amountRealized", "metGrossAssetsTest", "isQualifiedSmallBusinessStock" }
 *
 * Wraps taxElections.ts's IRC 1202 QSBS exclusion calculator (pre- vs. post-OBBBA
 * regimes) — see that function's doc comment for the pre-/post-7/4/2025 rule split and
 * its explicitly-flagged AMT-preference caveat for the post-OBBBA tiers, which this
 * route passes through verbatim in `note` rather than re-summarizing (a paraphrase
 * risks losing the "not yet regulation-confirmed" caveat that matters most).
 *
 * REMINDER FROM THE ENGINE'S OWN SCOPE NOTE, surfaced here too: this computes ONE
 * disposition. The $10M/$15M exclusion cap is actually per-taxpayer, per-issuer,
 * LIFETIME — tracking cumulative exclusions already used against the same issuer
 * across multiple calls to this route is the caller's job, not this route's.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest) {
  const user = await requireApiUser(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const { issuanceDate, acquisitionDate, dispositionDate, adjustedBasis, amountRealized, metGrossAssetsTest, isQualifiedSmallBusinessStock } =
    body ?? {};

  if (
    !issuanceDate ||
    !dispositionDate ||
    adjustedBasis === undefined ||
    amountRealized === undefined ||
    metGrossAssetsTest === undefined ||
    isQualifiedSmallBusinessStock === undefined
  ) {
    return NextResponse.json(
      {
        error:
          "issuanceDate, dispositionDate, adjustedBasis, amountRealized, metGrossAssetsTest, and isQualifiedSmallBusinessStock are all required",
      },
      { status: 400 }
    );
  }

  const holding: QsbsHolding = {
    issuanceDate,
    acquisitionDate,
    dispositionDate,
    adjustedBasis,
    amountRealized,
    metGrossAssetsTest,
    isQualifiedSmallBusinessStock,
  };

  let result;
  try {
    result = computeQsbsExclusion(holding);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute the QSBS exclusion" }, { status: 400 });
  }

  return NextResponse.json({
    regime: result.regime,
    eligible: result.eligible,
    ineligibilityReason: result.ineligibilityReason,
    gain: result.gain.toFixed(2),
    exclusionPercentage: result.exclusionPercentage,
    exclusionCap: result.exclusionCap.toFixed(2),
    excludableGain: result.excludableGain.toFixed(2),
    taxableGain: result.taxableGain.toFixed(2),
    amtPreferenceItem: result.amtPreferenceItem.toFixed(2),
    grossAssetsTestThresholdApplicable: result.grossAssetsTestThresholdApplicable,
    note: result.note,
  });
}
