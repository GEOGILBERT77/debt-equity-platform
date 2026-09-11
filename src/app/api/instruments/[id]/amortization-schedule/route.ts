import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { previewAmortizationSchedule, approveAmortizationSchedule } from "@/lib/db/amortizationSchedule";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

/**
 * GET /api/instruments/:id/amortization-schedule — preview only, nothing persisted.
 * Returns the full, end-to-end MONTHLY amortization table computed from the
 * instrument's CURRENT terms — see computeFullSchedule's doc comment in dispatch.ts
 * for why this only works for types with a natural end date (STOCK_OPTION, RSU,
 * RESTRICTED_STOCK, ...), not a period-by-period roll-forward type like TERM_LOAN.
 *
 * POST /api/instruments/:id/amortization-schedule { } — approves it: persists the
 * same computation as a new AmortizationScheduleApproval + rows (see
 * amortizationSchedule.ts). EDITOR-or-above, same bar as closing a period. This is a
 * REQUIRED gate, not automatic — a grant's schedule is excluded from every report
 * until this (or the entity-wide approve-all) has been called once for it. See
 * amortizationSchedule.ts's top-of-file doc comment for why approval is a deliberate
 * checkpoint rather than a side effect of data entry.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const instrument = await db.instrument.findUnique({ where: { id: params.id }, select: { entityId: true } });
  if (!instrument) {
    return NextResponse.json({ error: `No instrument found with id "${params.id}"` }, { status: 404 });
  }

  const access = await requireApiEntityAccess(req, instrument.entityId, "VIEWER");
  if (access instanceof NextResponse) return access;

  try {
    const rows = await previewAmortizationSchedule(params.id);
    return NextResponse.json({ rows });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute schedule" }, { status: 400 });
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const instrument = await db.instrument.findUnique({ where: { id: params.id }, select: { entityId: true } });
  if (!instrument) {
    return NextResponse.json({ error: `No instrument found with id "${params.id}"` }, { status: 404 });
  }

  const access = await requireApiEntityAccess(req, instrument.entityId, "EDITOR");
  if (access instanceof NextResponse) return access;

  try {
    const approval = await approveAmortizationSchedule(params.id, access.user.id);
    return NextResponse.json({ approval }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to approve schedule" }, { status: 400 });
  }
}
