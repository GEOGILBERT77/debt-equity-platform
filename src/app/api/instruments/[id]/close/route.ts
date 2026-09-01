import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeVisibleSchedule, InstrumentTypeForDispatch } from "@/lib/accounting/dispatch";
import { computeCloseBatch } from "@/lib/accounting/closeService";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

/**
 * POST /api/instruments/:id/close  { "through": "YYYY-MM-DD" }
 *
 * This is the step described in the README/chat as missing: it takes the live-computed
 * schedule, works out which periods haven't been committed yet (via
 * determineNewPeriods/computeCloseBatch — see closeService.ts for why that's a separate,
 * independently tested function), and persists both the ScheduleEntry rows and their
 * journal entries in a single transaction. Reporting reads from what this writes, never
 * from a live recomputation — see reports/journal-entries/route.ts.
 *
 * IDEMPOTENT: calling this twice with the same or an earlier `through` date commits
 * nothing new the second time, because the cutoff is read from what's already in the
 * database, not from anything the caller has to track.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}));
  const through = body?.through ?? new Date().toISOString().slice(0, 10);

  const instrument = await db.instrument.findUnique({
    where: { id: params.id },
    include: { termVersions: { orderBy: { effectiveDate: "asc" } } },
  });
  if (!instrument) {
    return NextResponse.json({ error: `No instrument found with id "${params.id}"` }, { status: 404 });
  }

  // Closing a period books journal entries — an EDITOR-or-above action, same bar as
  // creating an instrument or recording a modification.
  const access = await requireApiEntityAccess(req, instrument.entityId, "EDITOR");
  if (access instanceof NextResponse) return access;

  const lastClosed = await db.scheduleEntry.findFirst({
    where: { instrumentId: instrument.id },
    orderBy: { periodEnd: "desc" },
  });
  const alreadyClosedThroughPeriodEnd = lastClosed ? lastClosed.periodEnd.toISOString().slice(0, 10) : null;

  let fullSchedule;
  try {
    // computeVisibleSchedule (not a manually-truncated buildAnnualPeriods +
    // computeScheduleForInstrument) — see dispatch.ts's CORRECTNESS NOTE for why the
    // naive pattern silently overstates remainder-allocation engines (stock comp
    // vesting, revolver fees) once `through` lands before the instrument's true
    // natural end. Passing alreadyClosedThroughPeriodEnd as an extra split boundary
    // additionally keeps a second close within the same still-open period from
    // re-booking the slice already committed by an earlier close — see the
    // `extraSplitBoundaries` note in the same doc comment.
    fullSchedule = computeVisibleSchedule(
      instrument.type as InstrumentTypeForDispatch,
      instrument.termVersions.map((v) => ({
        effectiveDate: v.effectiveDate.toISOString().slice(0, 10),
        label: v.label,
        terms: v.terms,
      })),
      through,
      alreadyClosedThroughPeriodEnd ? [alreadyClosedThroughPeriodEnd] : []
    );
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute schedule" }, { status: 400 });
  }

  let batch;
  try {
    batch = computeCloseBatch(instrument.type as InstrumentTypeForDispatch, fullSchedule, alreadyClosedThroughPeriodEnd);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to build the close batch" }, { status: 400 });
  }

  if (batch.newScheduleRows.length === 0) {
    return NextResponse.json({ committed: false, message: "Nothing new to close — already up to date through this date." });
  }

  // One transaction: schedule rows and their journal entries land together, or not at
  // all. A close that persists the schedule but not the entries (or vice versa) would
  // leave the books in a state no reconciliation report could explain.
  await db.$transaction(async (tx) => {
    for (let i = 0; i < batch.newScheduleRows.length; i++) {
      const row = batch.newScheduleRows[i];
      // Prefer the currency the engine actually tagged the row with (ScheduleRow/
      // JournalEntry.currency — see types.ts); fall back to the instrument's own
      // stored currency rather than letting Prisma's schema default silently write
      // "USD" for a non-USD instrument. Omitting this was a real gap caught when this
      // route was cross-checked against the schema after the multi-currency engine
      // work landed — the engines were already computing the right currency, but
      // nothing here was persisting it.
      const rowCurrency = row.currency ?? instrument.currency;
      await tx.scheduleEntry.create({
        data: {
          instrumentId: instrument.id,
          periodStart: new Date(row.periodStart),
          periodEnd: new Date(row.periodEnd),
          label: row.label,
          amount: row.amount.toFixed(4),
          endingBalance: row.endingBalance?.toFixed(4),
          currency: rowCurrency,
          ascReference: (row.meta?.ascReference as string) ?? null,
          termVersionLabel: (row.meta?.termVersionLabel as string) ?? null,
          meta: row.meta as object,
        },
      });

      const je = batch.journalEntries[i];
      const jeCurrency = je.currency ?? instrument.currency;
      await tx.journalEntry.create({
        data: {
          instrumentId: instrument.id,
          date: new Date(je.date),
          description: je.description,
          ascReference: je.ascReference ?? null,
          currency: jeCurrency,
          lines: {
            create: je.lines.map((line) => ({
              account: line.account,
              debit: line.debit?.toFixed(4),
              credit: line.credit?.toFixed(4),
              memo: line.memo ?? null,
            })),
          },
        },
      });
    }
  });

  return NextResponse.json({
    committed: true,
    periodsClosedCount: batch.newScheduleRows.length,
    closedThrough: batch.newScheduleRows[batch.newScheduleRows.length - 1].periodEnd,
  });
}
