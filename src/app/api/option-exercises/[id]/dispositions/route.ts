import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

/**
 * POST /api/option-exercises/:id/dispositions
 *   { "dispositionDate", "quantitySold", "salePricePerShare" }
 *
 * Records a real, optional ShareDispositionEvent (v0.33.0) against a previously
 * recorded OptionExerciseEvent — see prisma/schema.prisma's doc comment on that model
 * for why recording this is entirely optional and never assumed. This is what lets
 * the monthly compliance report detect a DISQUALIFYING disposition of ISO shares
 * (optionTaxCompliance.ts's classifyDisposition/classifyExerciseForFiling) — an
 * exercise with no disposition recorded is simply treated as "not yet known to have
 * been sold," never assumed qualifying or disqualifying.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const exercise = await db.optionExerciseEvent.findUnique({
    where: { id: params.id },
    include: { instrument: true },
  });
  if (!exercise) {
    return NextResponse.json({ error: `No option exercise found with id "${params.id}"` }, { status: 404 });
  }

  const access = await requireApiEntityAccess(req, exercise.instrument.entityId, "EDITOR");
  if (access instanceof NextResponse) return access;

  const body = await req.json().catch(() => ({}));
  const { dispositionDate, quantitySold, salePricePerShare } = body ?? {};

  if (!dispositionDate || quantitySold === undefined || salePricePerShare === undefined) {
    return NextResponse.json({ error: "dispositionDate, quantitySold, and salePricePerShare are all required" }, { status: 400 });
  }
  if (Number.isNaN(Number(quantitySold)) || Number(quantitySold) <= 0) {
    return NextResponse.json({ error: "quantitySold must be a positive number" }, { status: 400 });
  }
  if (Number.isNaN(Number(salePricePerShare)) || Number(salePricePerShare) < 0) {
    return NextResponse.json({ error: "salePricePerShare must be a non-negative number" }, { status: 400 });
  }
  if (new Date(dispositionDate) < exercise.exerciseDate) {
    return NextResponse.json({ error: "dispositionDate cannot be before this exercise's exerciseDate" }, { status: 400 });
  }

  const disposition = await db.shareDispositionEvent.create({
    data: {
      exerciseEventId: exercise.id,
      dispositionDate: new Date(dispositionDate),
      quantitySold: String(quantitySold),
      salePricePerShare: String(salePricePerShare),
      recordedByUserId: access.user.id,
    },
  });

  return NextResponse.json({
    disposition: {
      id: disposition.id,
      dispositionDate: disposition.dispositionDate.toISOString().slice(0, 10),
      quantitySold: disposition.quantitySold.toString(),
      salePricePerShare: disposition.salePricePerShare.toString(),
    },
  });
}
