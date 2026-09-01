import { NextRequest, NextResponse } from "next/server";
import {
  buildAwardActivityRollforward,
  computeIntrinsicValueRealized,
  AwardActivityEvent,
  IntrinsicValueExerciseEvent,
} from "@/lib/accounting/reporting";
import { requireApiUser } from "@/lib/auth/apiGuard";

/**
 * POST /api/reports/equity-comp-disclosures
 *   { "mode": "ROLLFORWARD", "outstandingAtStart", "events": [{type, quantity, weightedAverageExercisePrice?}, ...],
 *     "weightedAverageExercisePriceAtStart"? }
 *   { "mode": "INTRINSIC_VALUE", "events": [{quantity, exercisePricePerUnit, fairMarketValuePerUnitAtExercise}, ...] }
 *
 * Two more pieces of the "additional ASC 718 footnote disclosures" pinned gap in the
 * README: the award activity rollforward by count, and intrinsic value realized
 * across a batch of exercises. Both functions live in `reporting.ts` alongside the
 * pre-existing `buildStockCompDisclosure` (unrecognized cost / weighted-average
 * remaining period — already reachable via the financial-statements report) and
 * `buildSettlementActivityDisclosure` (cash received / tax withholding / share
 * counts) rather than a new module — see reporting.ts's doc comment above these two
 * functions for why, and what's still not built (the fair-value assumptions rollup,
 * the vested/expected-to-vest table).
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

  try {
    if (mode === "ROLLFORWARD") {
      if (body.outstandingAtStart === undefined || !Array.isArray(body.events)) {
        return NextResponse.json({ error: `"outstandingAtStart" and "events" (an array) are required for mode ROLLFORWARD` }, { status: 400 });
      }
      const result = buildAwardActivityRollforward(
        body.outstandingAtStart,
        body.events as AwardActivityEvent[],
        body.weightedAverageExercisePriceAtStart
      );
      return NextResponse.json({
        mode,
        outstandingAtStart: result.outstandingAtStart.toFixed(2),
        granted: result.granted.toFixed(2),
        exercisedOrSettled: result.exercisedOrSettled.toFixed(2),
        forfeitedOrExpired: result.forfeitedOrExpired.toFixed(2),
        outstandingAtEnd: result.outstandingAtEnd.toFixed(2),
        weightedAverageExercisePriceAtStart: result.weightedAverageExercisePriceAtStart?.toFixed(4),
        weightedAverageExercisePriceAtEnd: result.weightedAverageExercisePriceAtEnd?.toFixed(4),
      });
    }

    if (mode === "INTRINSIC_VALUE") {
      if (!Array.isArray(body.events)) {
        return NextResponse.json({ error: `"events" (an array) is required for mode INTRINSIC_VALUE` }, { status: 400 });
      }
      const total = computeIntrinsicValueRealized(body.events as IntrinsicValueExerciseEvent[]);
      return NextResponse.json({ mode, totalIntrinsicValueRealized: total.toFixed(2) });
    }

    return NextResponse.json({ error: `"mode" must be one of ROLLFORWARD, INTRINSIC_VALUE` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute the disclosure result" }, { status: 400 });
  }
}
