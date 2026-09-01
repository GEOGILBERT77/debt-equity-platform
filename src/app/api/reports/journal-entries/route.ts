import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { summarizeByAccount, checkReconciliation } from "@/lib/accounting/reporting";
import { money, JournalEntry as DomainJournalEntry } from "@/lib/accounting/types";
import { parsePagination, paginationMeta, paginateArray } from "@/lib/api/pagination";
import { conditionalJsonResponse } from "@/lib/api/caching";

/**
 * GET /api/reports/journal-entries?entityId=...&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Requirement #4 from the original scope ("reporting function that outputs all
 * accounting entries and reconciliations for debt and equity transactions") — this
 * reads ONLY from persisted JournalEntry/JournalLine rows (written by the close route),
 * never from a live recomputation. That's the whole reason the close step exists: this
 * report has to return the same numbers today as it does a year from now, even if the
 * calculation engine changes in the meantime.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function GET(req: NextRequest) {
  const entityId = req.nextUrl.searchParams.get("entityId");
  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");

  if (!entityId) {
    return NextResponse.json({ error: "entityId query parameter is required" }, { status: 400 });
  }

  // `select` rather than `include` (v0.20.0 — "trim over-fetched API responses"): only
  // instrument id/type and stakeholder name are ever read below, not the full
  // Instrument/Stakeholder rows `include` would have pulled in for every line of every
  // journal entry in the filtered range.
  const rows = await db.journalEntry.findMany({
    where: {
      instrument: { entityId },
      // Only the current view — a restated period's original (superseded) entry is
      // excluded here by design, per the audit-trail note on the schema's JournalEntry
      // model. Add ?includeSuperseded=1 support later if you need the full history in
      // one query rather than looking a correction up directly.
      supersededByCorrectionId: null,
      ...(from || to
        ? {
            date: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    },
    select: {
      id: true,
      date: true,
      description: true,
      ascReference: true,
      currency: true,
      lines: { select: { account: true, debit: true, credit: true, memo: true } },
      instrument: { select: { id: true, type: true, stakeholder: { select: { name: true } } } },
    },
    orderBy: { date: "asc" },
  });

  const entries: DomainJournalEntry[] = rows.map((r) => ({
    date: r.date.toISOString().slice(0, 10),
    description: r.description,
    ascReference: r.ascReference ?? undefined,
    currency: r.currency,
    lines: r.lines.map((l) => ({
      account: l.account,
      debit: l.debit ? money(l.debit.toString()) : undefined,
      credit: l.credit ? money(l.credit.toString()) : undefined,
      memo: l.memo ?? undefined,
    })),
  }));

  const accountSummary = summarizeByAccount(entries).map((s) => ({
    account: s.account,
    currency: s.currency,
    totalDebit: s.totalDebit.toFixed(2),
    totalCredit: s.totalCredit.toFixed(2),
    net: s.net.toFixed(2),
  }));

  // One result per currency present in the batch — see reporting.ts's file-level note
  // on why this deliberately isn't collapsed into a single reconciliation object.
  const reconciliationByCurrency = checkReconciliation(entries).map((r) => ({
    currency: r.currency,
    balanced: r.balanced,
    totalDebits: r.totalDebits.toFixed(2),
    totalCredits: r.totalCredits.toFixed(2),
    difference: r.difference.toFixed(2),
  }));

  // PAGINATED as of v0.20.0, applied only to the raw entry LIST below — see
  // src/lib/api/pagination.ts's module doc comment on why: `accountSummary` and
  // `reconciliationByCurrency` above are only correct computed over every row matching
  // the date filter, so those still run over the full `rows`/`entries` set. Paginating
  // just the list still bounds the response payload, the actual bandwidth concern this
  // item was about, even though the query itself still reads every matching row.
  const pagination = parsePagination(req);
  const pageOfRows = paginateArray(rows, pagination);

  // Conditional GET / ETag (v0.20.0 — the "HTTP caching headers" Performance & Scaling
  // item, see src/lib/api/caching.ts) — a client re-requesting the same
  // entity/date-range/page with nothing changed since (no new close, no new
  // correction) gets a 304 and skips re-downloading this body.
  return conditionalJsonResponse(req, {
    entries: pageOfRows.map((r) => ({
      id: r.id,
      date: r.date.toISOString().slice(0, 10),
      description: r.description,
      instrument: { id: r.instrument?.id, type: r.instrument?.type, stakeholder: r.instrument?.stakeholder.name },
      lines: r.lines.map((l) => ({ account: l.account, debit: l.debit?.toString(), credit: l.credit?.toString() })),
    })),
    pagination: paginationMeta(rows.length, pagination),
    accountSummary,
    reconciliationByCurrency,
  });
}
