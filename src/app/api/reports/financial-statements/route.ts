import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { money, JournalEntry as DomainJournalEntry } from "@/lib/accounting/types";
import { buildAccountRollForward, buildStockCompDisclosure, StockCompInstrumentInput } from "@/lib/accounting/reporting";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

/**
 * GET /api/reports/financial-statements?entityId=...&periodStart=YYYY-MM-DD&periodEnd=YYYY-MM-DD
 *
 * Financial-statement support (v0.19.0, the "reporting functionality" phase): two
 * distinct footnote-style outputs in one call, since a preparer building a period's
 * financial statements typically wants both side by side —
 *
 *  1. An account-by-account roll-forward (beginning balance / period activity / ending
 *     balance) built from the SAME closed JournalEntry rows the existing journal-
 *     entries report reads — see reporting.ts's buildAccountRollForward doc comment
 *     for why this reuses summarizeByAccount rather than re-deriving balances.
 *  2. The ASC 718 unrecognized-stock-compensation-cost disclosure, computed from
 *     closed ScheduleEntry rows for every STOCK_OPTION/RSU/RESTRICTED_STOCK
 *     instrument in the entity.
 *
 * SCOPE — deliberately excludes stock-settled SAR from the disclosure: a SAR's expense
 * is a fair-value REMEASUREMENT each period (stockAppreciationRights.ts), not
 * amortization of a fixed grant-date total the way an option/RSU/restricted grant is —
 * "unrecognized cost" isn't a meaningful concept for it the same way. Flagged here
 * rather than silently included with a wrong number.
 *
 * Reads ONLY closed/reported rows (supersededByCorrectionId: null) — same "never a
 * live recomputation" rule the existing journal-entries report follows, for the same
 * reason (see this file's sibling route's doc comment).
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function GET(req: NextRequest) {
  const entityId = req.nextUrl.searchParams.get("entityId");
  if (!entityId) {
    return NextResponse.json({ error: "entityId query parameter is required" }, { status: 400 });
  }

  const access = await requireApiEntityAccess(req, entityId, "VIEWER");
  if (access instanceof NextResponse) return access;

  const today = new Date().toISOString().slice(0, 10);
  const periodStart = req.nextUrl.searchParams.get("periodStart") ?? `${today.slice(0, 4)}-01-01`;
  const periodEnd = req.nextUrl.searchParams.get("periodEnd") ?? today;

  // --- 1. Account roll-forward -------------------------------------------------
  const journalRows = await db.journalEntry.findMany({
    where: { instrument: { entityId }, supersededByCorrectionId: null },
    include: { lines: true },
    orderBy: { date: "asc" },
  });
  const entries: DomainJournalEntry[] = journalRows.map((r) => ({
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
  const rollForward = buildAccountRollForward(entries, periodStart, periodEnd).map((r) => ({
    account: r.account,
    currency: r.currency,
    beginningBalance: r.beginningBalance.toFixed(2),
    periodActivity: r.periodActivity.toFixed(2),
    endingBalance: r.endingBalance.toFixed(2),
  }));

  // --- 2. ASC 718 stock compensation disclosure ---------------------------------
  // `select` rather than `include` (v0.20.0 — "trim over-fetched API responses"): only
  // stakeholder name and the latest term version's `terms` JSON are read below.
  const equityCompInstruments = await db.instrument.findMany({
    where: { entityId, type: { in: ["STOCK_OPTION", "RSU", "RESTRICTED_STOCK"] } },
    select: {
      id: true,
      type: true,
      stakeholder: { select: { name: true } },
      termVersions: { select: { terms: true }, orderBy: { effectiveDate: "desc" }, take: 1 },
    },
  });

  const disclosureInputs: StockCompInstrumentInput[] = [];
  const stockCompWarnings: { instrumentId: string; stakeholderName: string; message: string }[] = [];

  // Batched, not one `scheduleEntry.aggregate` call per instrument inside the loop
  // below — the original v0.19.0 version of this route did exactly that (fine for a
  // handful of instruments, a real bottleneck once an entity has hundreds of equity
  // awards; flagged as a Pending item in the task-status spreadsheet and README, fixed
  // here in v0.20.0). One groupBy covers every instrument's cumulative-recognized sum
  // in a single round trip; the loop below only does an in-memory Map lookup.
  const recognizedByInstrument = await db.scheduleEntry.groupBy({
    by: ["instrumentId"],
    where: {
      instrumentId: { in: equityCompInstruments.map((inst) => inst.id) },
      periodEnd: { lte: new Date(periodEnd) },
      supersededByCorrectionId: null,
    },
    _sum: { amount: true },
  });
  const recognizedByInstrumentId = new Map(recognizedByInstrument.map((r) => [r.instrumentId, r._sum.amount?.toString() ?? "0"]));

  for (const inst of equityCompInstruments) {
    const terms = inst.termVersions[0]?.terms as
      | { quantity?: string; grantDateFairValuePerUnit?: string; tranches?: { vestDate: string }[] }
      | undefined;
    if (!terms?.quantity || !terms?.grantDateFairValuePerUnit || !terms?.tranches?.length) {
      stockCompWarnings.push({
        instrumentId: inst.id,
        stakeholderName: inst.stakeholder.name,
        message: "Missing quantity/grantDateFairValuePerUnit/tranches on the latest term version — excluded from the disclosure.",
      });
      continue;
    }
    const serviceEndDate = terms.tranches.map((t) => t.vestDate).sort().slice(-1)[0];
    const totalGrantDateFairValue = money(terms.quantity).times(terms.grantDateFairValuePerUnit).toFixed(4);

    disclosureInputs.push({
      instrumentId: inst.id,
      stakeholderName: inst.stakeholder.name,
      type: inst.type,
      totalGrantDateFairValue,
      cumulativeExpenseRecognized: recognizedByInstrumentId.get(inst.id) ?? "0",
      serviceEndDate,
      asOfDate: periodEnd,
    });
  }

  const stockCompDisclosure = buildStockCompDisclosure(disclosureInputs);

  return NextResponse.json({
    periodStart,
    periodEnd,
    rollForward,
    stockCompDisclosure: {
      rows: stockCompDisclosure.rows.map((r) => ({
        instrumentId: r.instrumentId,
        stakeholderName: r.stakeholderName,
        type: r.type,
        totalGrantDateFairValue: r.totalGrantDateFairValue.toFixed(2),
        cumulativeExpenseRecognized: r.cumulativeExpenseRecognized.toFixed(2),
        unrecognizedCompCost: r.unrecognizedCompCost.toFixed(2),
        remainingRecognitionYears: Number(r.remainingRecognitionYears.toFixed(2)),
      })),
      totalUnrecognizedCompCost: stockCompDisclosure.totalUnrecognizedCompCost.toFixed(2),
      weightedAverageRemainingYears: Number(stockCompDisclosure.weightedAverageRemainingYears.toFixed(2)),
      warnings: stockCompWarnings,
    },
  });
}
