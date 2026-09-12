import { db } from "@/lib/db";
import { computeVisibleSchedule, InstrumentTypeForDispatch } from "@/lib/accounting/dispatch";
import { computeCloseBatch } from "@/lib/accounting/closeService";
import { attachPerformanceConditionAssessments } from "@/lib/db/performanceConditions";

/**
 * The database-touching half of "closing" an instrument through a date — pulled out of
 * `/api/instruments/:id/close/route.ts` (v0.21.0) so a second caller, the entity-wide
 * bulk close route below, can run the EXACT SAME logic per instrument instead of a
 * second, maintained-separately copy of it. Before this existed, "close" only ran one
 * instrument at a time from that instrument's own page — this is what makes "each
 * company can build and store the accounting treatment for every one of its
 * instruments" (not just one at a time) an actual single action, per the direct
 * request this was built for: the engines already computed correct schedules and the
 * schema already had somewhere to persist them (ScheduleEntry/JournalEntry — see
 * closeService.ts's module doc comment on why a closed period's numbers must freeze
 * rather than stay a live recomputation); what was missing was a way to run that
 * process across a WHOLE ENTITY'S instruments in one action rather than clicking into
 * each one.
 *
 * Deliberately one instrument = one transaction (not one giant transaction across
 * every instrument in the entity) — see closeAllInstrumentsForEntity's doc comment for
 * why that matters for a bulk close specifically.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file that imports `db`.
 */

export type CloseInstrumentResult =
  | { status: "committed"; instrumentId: string; periodsClosedCount: number; closedThrough: string }
  | { status: "nothing-to-close"; instrumentId: string }
  | { status: "error"; instrumentId: string; message: string };

export async function closeInstrumentThrough(instrumentId: string, through: string): Promise<CloseInstrumentResult> {
  const instrument = await db.instrument.findUnique({
    where: { id: instrumentId },
    include: { termVersions: { orderBy: { effectiveDate: "asc" } } },
  });
  if (!instrument) {
    return { status: "error", instrumentId, message: `No instrument found with id "${instrumentId}"` };
  }

  const lastClosed = await db.scheduleEntry.findFirst({
    where: { instrumentId: instrument.id },
    orderBy: { periodEnd: "desc" },
  });
  const alreadyClosedThroughPeriodEnd = lastClosed ? lastClosed.periodEnd.toISOString().slice(0, 10) : null;

  let fullSchedule;
  try {
    // computeVisibleSchedule, not a manually-truncated buildAnnualPeriods +
    // computeScheduleForInstrument — see dispatch.ts's CORRECTNESS NOTE. Same call,
    // same reasoning, as the original per-instrument route this was extracted from.
    fullSchedule = computeVisibleSchedule(
      instrument.type as InstrumentTypeForDispatch,
      await attachPerformanceConditionAssessments(instrument.termVersions),
      through,
      alreadyClosedThroughPeriodEnd ? [alreadyClosedThroughPeriodEnd] : []
    );
  } catch (err) {
    return { status: "error", instrumentId, message: err instanceof Error ? err.message : "Failed to compute schedule" };
  }

  let batch;
  try {
    batch = computeCloseBatch(instrument.type as InstrumentTypeForDispatch, fullSchedule, alreadyClosedThroughPeriodEnd);
  } catch (err) {
    return { status: "error", instrumentId, message: err instanceof Error ? err.message : "Failed to build the close batch" };
  }

  if (batch.newScheduleRows.length === 0) {
    return { status: "nothing-to-close", instrumentId };
  }

  // One transaction PER INSTRUMENT: schedule rows and their journal entries land
  // together, or not at all, exactly like the original single-instrument route. See
  // closeAllInstrumentsForEntity's doc comment for why the bulk caller does NOT wrap
  // every instrument's close into one shared transaction on top of this.
  await db.$transaction(async (tx) => {
    for (let i = 0; i < batch.newScheduleRows.length; i++) {
      const row = batch.newScheduleRows[i];
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

  return {
    status: "committed",
    instrumentId,
    periodsClosedCount: batch.newScheduleRows.length,
    closedThrough: batch.newScheduleRows[batch.newScheduleRows.length - 1].periodEnd,
  };
}

/**
 * Runs closeInstrumentThrough across EVERY instrument in one entity — the "each
 * company must have the ability to use the accounting engines to build schedules for
 * each instrument's accounting treatment, that are stored and recoverable in
 * reporting" requirement, as one action instead of one click per instrument.
 *
 * DELIBERATELY NOT one big transaction across every instrument: (1) an entity can have
 * many instruments, and a single multi-instrument transaction risks a statement-
 * timeout on a large cap table for no real benefit; (2) these are genuinely
 * independent facts — one instrument's terms being malformed (see the "flag rather
 * than crash" precedent in capTable.ts's rollup and reports/debt-modification's
 * per-row error handling) should never block every OTHER instrument in the same
 * entity from closing. Each instrument's own close is still fully atomic on its own
 * (schedule rows + journal entries together or not at all) via
 * closeInstrumentThrough's own transaction — only the ACROSS-instruments grouping is
 * best-effort, with every failure surfaced by instrument, never silently swallowed.
 */
export async function closeAllInstrumentsForEntity(entityId: string, through: string): Promise<CloseInstrumentResult[]> {
  const instruments = await db.instrument.findMany({ where: { entityId }, select: { id: true } });
  const results: CloseInstrumentResult[] = [];
  for (const inst of instruments) {
    results.push(await closeInstrumentThrough(inst.id, through));
  }
  return results;
}
