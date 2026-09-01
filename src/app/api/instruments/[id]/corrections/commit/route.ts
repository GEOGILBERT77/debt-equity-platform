import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { previewCorrection, buildProspectiveCorrectionEntry, buildRetrospectiveCorrectionBatch } from "@/lib/accounting/correctionService";
import { getScheduleBuilder, buildVisiblePeriods, InstrumentTypeForDispatch } from "@/lib/accounting/dispatch";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

/**
 * POST /api/instruments/:id/corrections/commit
 *   { "targetEffectiveDate", "correctedTerms", "reason", "through",
 *     "election": "PROSPECTIVE" | "RETROSPECTIVE", "currentOpenPeriodEnd" }
 * (currentOpenPeriodEnd only required when election is PROSPECTIVE)
 *
 * Deliberately recomputes the preview from scratch server-side rather than trusting a
 * client-supplied number — what gets booked and what gets stored in
 * `Correction.previewSnapshot` for the audit trail must be the same computation, not
 * whatever a client claims it saw. This does mean calling this route without having
 * called /preview first works fine; the preview route exists for the human
 * materiality-review step, not as a required prior write.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}));
  const { targetEffectiveDate, correctedTerms, reason, through, election, currentOpenPeriodEnd } = body ?? {};

  if (!targetEffectiveDate || correctedTerms === undefined || !reason || !election) {
    return NextResponse.json(
      { error: "targetEffectiveDate, correctedTerms, reason, and election are all required" },
      { status: 400 }
    );
  }
  if (election !== "PROSPECTIVE" && election !== "RETROSPECTIVE") {
    return NextResponse.json({ error: 'election must be "PROSPECTIVE" or "RETROSPECTIVE"' }, { status: 400 });
  }
  if (election === "PROSPECTIVE" && !currentOpenPeriodEnd) {
    return NextResponse.json({ error: "currentOpenPeriodEnd is required for a PROSPECTIVE election" }, { status: 400 });
  }

  const instrument = await db.instrument.findUnique({
    where: { id: params.id },
    include: { termVersions: { orderBy: { effectiveDate: "asc" } } },
  });
  if (!instrument) {
    return NextResponse.json({ error: `No instrument found with id "${params.id}"` }, { status: 404 });
  }

  const access = await requireApiEntityAccess(req, instrument.entityId, "EDITOR");
  if (access instanceof NextResponse) return access;

  const type = instrument.type as InstrumentTypeForDispatch;

  const lastClosed = await db.scheduleEntry.findFirst({
    where: { instrumentId: instrument.id, supersededByCorrectionId: null },
    orderBy: { periodEnd: "desc" },
  });
  if (!lastClosed) {
    return NextResponse.json({ error: "This instrument has no closed periods yet — there's nothing to correct." }, { status: 409 });
  }
  const alreadyClosedThroughPeriodEnd = lastClosed.periodEnd.toISOString().slice(0, 10);

  let preview;
  try {
    const termVersions = instrument.termVersions.map((v) => ({
      effectiveDate: v.effectiveDate.toISOString().slice(0, 10),
      label: v.label,
      terms: v.terms,
    }));
    // buildVisiblePeriods, not a manually-truncated buildAnnualPeriods — see the
    // matching note in corrections/preview/route.ts and dispatch.ts's CORRECTNESS NOTE.
    const periods = buildVisiblePeriods(type, termVersions, through ?? new Date().toISOString().slice(0, 10), [
      alreadyClosedThroughPeriodEnd,
    ]);
    const builder = getScheduleBuilder(type);
    preview = previewCorrection(termVersions, targetEffectiveDate, correctedTerms, periods, alreadyClosedThroughPeriodEnd, builder);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute the correction" }, { status: 400 });
  }

  const previewSnapshot = {
    perPeriodDeltas: preview.perPeriodDeltas.map((d) => ({
      label: d.label,
      periodEnd: d.periodEnd,
      originalAmount: d.originalAmount.toFixed(2),
      correctedAmount: d.correctedAmount.toFixed(2),
      delta: d.delta.toFixed(2),
    })),
    cumulativeDelta: preview.cumulativeDelta.toFixed(2),
  };

  const result = await db.$transaction(async (tx) => {
    const correction = await tx.correction.create({
      data: {
        instrumentId: instrument.id,
        discoveredDate: new Date(),
        reason,
        election,
        previewSnapshot,
        // v0.19.0 audit-trail attribution — see prisma/schema.prisma's doc comment.
        createdByUserId: access.user.id,
      },
    });

    if (election === "PROSPECTIVE") {
      // Closed periods are untouched by design — only a single adjusting entry in the
      // current open period. See buildProspectiveCorrectionEntry's doc comment.
      const entry = buildProspectiveCorrectionEntry(type, preview.cumulativeDelta, currentOpenPeriodEnd, reason);
      await tx.journalEntry.create({
        data: {
          instrumentId: instrument.id,
          date: new Date(entry.date),
          description: entry.description,
          ascReference: entry.ascReference ?? null,
          // See the matching note in close/route.ts — prefer the engine-tagged
          // currency, fall back to the instrument's own stored currency.
          currency: entry.currency ?? instrument.currency,
          createdByCorrectionId: correction.id,
          lines: {
            create: entry.lines.map((l) => ({
              account: l.account,
              debit: l.debit?.toFixed(4),
              credit: l.credit?.toFixed(4),
              memo: l.memo ?? null,
            })),
          },
        },
      });
    } else {
      // RETROSPECTIVE: mark every closed ScheduleEntry/JournalEntry for the affected
      // periods as superseded (never deleted — that's the ASC 250 audit trail), then
      // insert the restated rows pointing back at this same Correction.
      const batch = buildRetrospectiveCorrectionBatch(type, preview.correctedClosedRows);
      const affectedPeriodEnds = batch.restatedScheduleRows.map((r) => new Date(r.periodEnd));

      await tx.scheduleEntry.updateMany({
        where: { instrumentId: instrument.id, periodEnd: { in: affectedPeriodEnds }, supersededByCorrectionId: null },
        data: { supersededByCorrectionId: correction.id },
      });
      await tx.journalEntry.updateMany({
        where: { instrumentId: instrument.id, date: { in: affectedPeriodEnds }, supersededByCorrectionId: null },
        data: { supersededByCorrectionId: correction.id },
      });

      for (let i = 0; i < batch.restatedScheduleRows.length; i++) {
        const row = batch.restatedScheduleRows[i];
        await tx.scheduleEntry.create({
          data: {
            instrumentId: instrument.id,
            periodStart: new Date(row.periodStart),
            periodEnd: new Date(row.periodEnd),
            label: `${row.label} (restated)`,
            amount: row.amount.toFixed(4),
            endingBalance: row.endingBalance?.toFixed(4),
            currency: row.currency ?? instrument.currency,
            ascReference: "ASC 250 (retrospective restatement)",
            createdByCorrectionId: correction.id,
          },
        });

        const je = batch.restatedJournalEntries[i];
        await tx.journalEntry.create({
          data: {
            instrumentId: instrument.id,
            date: new Date(je.date),
            description: `${je.description} (restated per correction)`,
            ascReference: "ASC 250 (retrospective restatement)",
            currency: je.currency ?? instrument.currency,
            createdByCorrectionId: correction.id,
            lines: {
              create: je.lines.map((l) => ({
                account: l.account,
                debit: l.debit?.toFixed(4),
                credit: l.credit?.toFixed(4),
                memo: l.memo ?? null,
              })),
            },
          },
        });
      }
    }

    return correction;
  });

  return NextResponse.json({ committed: true, correctionId: result.id, election, previewSnapshot });
}
