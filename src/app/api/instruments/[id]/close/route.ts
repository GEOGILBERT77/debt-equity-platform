import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { closeInstrumentThrough } from "@/lib/db/closeInstrument";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

/**
 * POST /api/instruments/:id/close  { "through": "YYYY-MM-DD" }
 *
 * This is the step described in the README/chat as missing: it takes the live-computed
 * schedule, works out which periods haven't been committed yet, and persists both the
 * ScheduleEntry rows and their journal entries in a single transaction. Reporting reads
 * from what this writes, never from a live recomputation — see reports/journal-
 * entries/route.ts.
 *
 * IDEMPOTENT: calling this twice with the same or an earlier `through` date commits
 * nothing new the second time, because the cutoff is read from what's already in the
 * database, not from anything the caller has to track.
 *
 * v0.21.0: the actual close logic (compute schedule, build the close batch, persist in
 * one transaction) now lives in `closeInstrumentThrough` (src/lib/db/closeInstrument.ts)
 * — extracted so `POST /api/entities/:id/close` (the bulk, entity-wide close — see that
 * route and closeInstrument.ts's doc comment) runs the IDENTICAL logic per instrument
 * rather than a second copy of it. This route is now just the access-check wrapper.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}));
  const through = body?.through ?? new Date().toISOString().slice(0, 10);

  const instrument = await db.instrument.findUnique({ where: { id: params.id }, select: { entityId: true } });
  if (!instrument) {
    return NextResponse.json({ error: `No instrument found with id "${params.id}"` }, { status: 404 });
  }

  // Closing a period books journal entries — an EDITOR-or-above action, same bar as
  // creating an instrument or recording a modification.
  const access = await requireApiEntityAccess(req, instrument.entityId, "EDITOR");
  if (access instanceof NextResponse) return access;

  const result = await closeInstrumentThrough(params.id, through);

  if (result.status === "error") {
    return NextResponse.json({ error: result.message }, { status: 400 });
  }
  if (result.status === "nothing-to-close") {
    return NextResponse.json({ committed: false, message: "Nothing new to close — already up to date through this date." });
  }
  return NextResponse.json({
    committed: true,
    periodsClosedCount: result.periodsClosedCount,
    closedThrough: result.closedThrough,
  });
}
