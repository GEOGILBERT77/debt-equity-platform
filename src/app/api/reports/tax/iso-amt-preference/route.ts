import { NextRequest, NextResponse } from "next/server";
import { computeIsoExerciseAmtPreference, IsoExerciseEvent } from "@/lib/accounting/taxElections";
import { requireApiUser } from "@/lib/auth/apiGuard";

/**
 * POST /api/reports/tax/iso-amt-preference
 *   { "exerciseDate", "quantity", "exercisePricePerShare", "fmvPerShareAtExercise",
 *     "disqualifyingDispositionSameCalendarYear"? }
 *
 * Wraps taxElections.ts's IRC 56(b)(3) AMT-preference-on-ISO-exercise calculator — see
 * that function's doc comment for the same-calendar-year disqualifying-disposition
 * exception it applies. A calculator, not a report over stored data — same reasoning
 * as every other route under /api/reports/tax.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest) {
  const user = await requireApiUser(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const { exerciseDate, quantity, exercisePricePerShare, fmvPerShareAtExercise, disqualifyingDispositionSameCalendarYear } = body ?? {};

  if (!exerciseDate || quantity === undefined || exercisePricePerShare === undefined || fmvPerShareAtExercise === undefined) {
    return NextResponse.json(
      { error: "exerciseDate, quantity, exercisePricePerShare, and fmvPerShareAtExercise are all required" },
      { status: 400 }
    );
  }

  const event: IsoExerciseEvent = {
    exerciseDate,
    quantity,
    exercisePricePerShare,
    fmvPerShareAtExercise,
    disqualifyingDispositionSameCalendarYear,
  };

  let result;
  try {
    result = computeIsoExerciseAmtPreference(event);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute the AMT preference" }, { status: 400 });
  }

  return NextResponse.json({
    exerciseDate: result.exerciseDate,
    bargainElement: result.bargainElement.toFixed(2),
    amtPreferenceItem: result.amtPreferenceItem.toFixed(2),
    note: result.note,
  });
}
