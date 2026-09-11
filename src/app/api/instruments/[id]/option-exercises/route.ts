import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

/**
 * POST /api/instruments/:id/option-exercises
 *   { "exerciseDate", "quantityExercised", "exercisePricePerShare",
 *     "fairMarketValuePerShareAtExercise" }
 *
 * Records a real, append-only OptionExerciseEvent (v0.33.0) against a STOCK_OPTION
 * instrument — see prisma/schema.prisma's doc comment on that model for why this is a
 * separate event log rather than another InstrumentTermVersion. This is the write
 * path the monthly compliance report (optionTaxCompliance.ts's
 * buildMonthlyComplianceReport, surfaced at /api/reports/option-tax-compliance) reads
 * from — a compliance obligation (Form 3921, a W-2 flag) is only ever detected once an
 * exercise has actually been recorded here.
 *
 * GET /api/instruments/:id/option-exercises — lists every exercise recorded against
 * this instrument, most recent first, each with its dispositions (for the "record a
 * disposition" UI, which needs to pick which exercise a sale traces back to).
 *
 * Deliberately does NOT recompute or persist any TaxFilingRecord rows itself — that
 * reconciliation only happens when the monthly report route runs, matching the
 * "compute in a pure lib function, persist in the route that actually needs the
 * result" split this codebase uses everywhere else (see buildMonthlyComplianceReport's
 * own doc comment).
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const instrument = await db.instrument.findUnique({ where: { id: params.id } });
  if (!instrument) {
    return NextResponse.json({ error: `No instrument found with id "${params.id}"` }, { status: 404 });
  }
  const access = await requireApiEntityAccess(req, instrument.entityId, "VIEWER");
  if (access instanceof NextResponse) return access;

  const exercises = await db.optionExerciseEvent.findMany({
    where: { instrumentId: params.id },
    include: { dispositions: { orderBy: { dispositionDate: "asc" } } },
    orderBy: { exerciseDate: "desc" },
  });

  return NextResponse.json({
    exercises: exercises.map((e) => ({
      id: e.id,
      exerciseDate: e.exerciseDate.toISOString().slice(0, 10),
      quantityExercised: e.quantityExercised.toString(),
      exercisePricePerShare: e.exercisePricePerShare.toString(),
      fairMarketValuePerShareAtExercise: e.fairMarketValuePerShareAtExercise.toString(),
      dispositions: e.dispositions.map((d) => ({
        id: d.id,
        dispositionDate: d.dispositionDate.toISOString().slice(0, 10),
        quantitySold: d.quantitySold.toString(),
        salePricePerShare: d.salePricePerShare.toString(),
      })),
    })),
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const instrument = await db.instrument.findUnique({ where: { id: params.id } });
  if (!instrument) {
    return NextResponse.json({ error: `No instrument found with id "${params.id}"` }, { status: 404 });
  }
  if (instrument.type !== "STOCK_OPTION") {
    return NextResponse.json(
      { error: `This instrument is a ${instrument.type}, not a STOCK_OPTION — option exercises can only be recorded against stock options.` },
      { status: 400 }
    );
  }

  const access = await requireApiEntityAccess(req, instrument.entityId, "EDITOR");
  if (access instanceof NextResponse) return access;

  const body = await req.json().catch(() => ({}));
  const { exerciseDate, quantityExercised, exercisePricePerShare, fairMarketValuePerShareAtExercise } = body ?? {};

  if (!exerciseDate || quantityExercised === undefined || exercisePricePerShare === undefined || fairMarketValuePerShareAtExercise === undefined) {
    return NextResponse.json(
      { error: "exerciseDate, quantityExercised, exercisePricePerShare, and fairMarketValuePerShareAtExercise are all required" },
      { status: 400 }
    );
  }
  if (Number.isNaN(Number(quantityExercised)) || Number(quantityExercised) <= 0) {
    return NextResponse.json({ error: "quantityExercised must be a positive number" }, { status: 400 });
  }
  if (Number.isNaN(Number(exercisePricePerShare)) || Number(exercisePricePerShare) < 0) {
    return NextResponse.json({ error: "exercisePricePerShare must be a non-negative number" }, { status: 400 });
  }
  if (Number.isNaN(Number(fairMarketValuePerShareAtExercise)) || Number(fairMarketValuePerShareAtExercise) < 0) {
    return NextResponse.json({ error: "fairMarketValuePerShareAtExercise must be a non-negative number" }, { status: 400 });
  }

  const exercise = await db.optionExerciseEvent.create({
    data: {
      instrumentId: instrument.id,
      exerciseDate: new Date(exerciseDate),
      quantityExercised: String(quantityExercised),
      exercisePricePerShare: String(exercisePricePerShare),
      fairMarketValuePerShareAtExercise: String(fairMarketValuePerShareAtExercise),
      recordedByUserId: access.user.id,
    },
  });

  return NextResponse.json({
    exercise: {
      id: exercise.id,
      exerciseDate: exercise.exerciseDate.toISOString().slice(0, 10),
      quantityExercised: exercise.quantityExercised.toString(),
      exercisePricePerShare: exercise.exercisePricePerShare.toString(),
      fairMarketValuePerShareAtExercise: exercise.fairMarketValuePerShareAtExercise.toString(),
    },
  });
}
