import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeVisibleSchedule, InstrumentTypeForDispatch } from "@/lib/accounting/dispatch";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

/**
 * GET /api/instruments/:id/schedule?through=YYYY-MM-DD
 * Computes (does not persist) the instrument's full schedule by replaying every term
 * version on file through the modification engine — this is the live view; writing the
 * result to ScheduleEntry rows for reporting is a deliberate separate step (a POST/
 * background job), not something a GET should have the side effect of doing.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const through = req.nextUrl.searchParams.get("through") ?? new Date().toISOString().slice(0, 10);

  const instrument = await db.instrument.findUnique({
    where: { id: params.id },
    include: { termVersions: { orderBy: { effectiveDate: "asc" } } },
  });

  if (!instrument) {
    return NextResponse.json({ error: `No instrument found with id "${params.id}"` }, { status: 404 });
  }

  const access = await requireApiEntityAccess(req, instrument.entityId, "VIEWER");
  if (access instanceof NextResponse) return access;

  try {
    // computeVisibleSchedule, not a manually-truncated buildAnnualPeriods +
    // computeScheduleForInstrument — see dispatch.ts's CORRECTNESS NOTE.
    const schedule = computeVisibleSchedule(
      instrument.type as InstrumentTypeForDispatch,
      instrument.termVersions.map((v) => ({
        effectiveDate: v.effectiveDate.toISOString().slice(0, 10),
        label: v.label,
        terms: v.terms,
      })),
      through
    );

    return NextResponse.json({
      instrumentId: instrument.id,
      schedule: schedule.map((row) => ({
        ...row,
        amount: row.amount.toFixed(2),
        endingBalance: row.endingBalance?.toFixed(2),
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute schedule" }, { status: 400 });
  }
}
