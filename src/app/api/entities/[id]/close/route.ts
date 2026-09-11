import { NextRequest, NextResponse } from "next/server";
import { closeAllInstrumentsForEntity } from "@/lib/db/closeInstrument";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

/**
 * POST /api/entities/:id/close  { "through": "YYYY-MM-DD" }
 *
 * Runs the same close logic `/api/instruments/:id/close` runs for one instrument,
 * across EVERY instrument this entity has — see closeInstrument.ts's doc comment on
 * `closeAllInstrumentsForEntity` for why this is per-instrument-transaction rather
 * than one all-or-nothing transaction. This is what makes "each company can use the
 * accounting engines to build schedules for each of its instruments, stored and
 * recoverable in reporting" a single action instead of clicking "Close through today"
 * on every instrument's own page one at a time.
 *
 * IDEMPOTENT the same way the per-instrument route is: re-running this commits
 * nothing new for an instrument that's already closed through this date (or later).
 *
 * Returns a per-instrument breakdown rather than just a total, so a caller (the UI
 * button, or anyone scripting against this API) can see exactly which instruments
 * closed cleanly, which had nothing new, and which failed and why — never a single
 * opaque success/failure for the whole entity.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}));
  const through = body?.through ?? new Date().toISOString().slice(0, 10);

  // Closing books journal entries across the whole entity — EDITOR-or-above, same bar
  // as the per-instrument close.
  const access = await requireApiEntityAccess(req, params.id, "EDITOR");
  if (access instanceof NextResponse) return access;

  const results = await closeAllInstrumentsForEntity(params.id, through);

  const committed = results.filter((r) => r.status === "committed");
  const nothingToClose = results.filter((r) => r.status === "nothing-to-close");
  const errors = results.filter((r) => r.status === "error");

  return NextResponse.json({
    totalInstruments: results.length,
    committedCount: committed.length,
    nothingToCloseCount: nothingToClose.length,
    errorCount: errors.length,
    results,
  });
}
