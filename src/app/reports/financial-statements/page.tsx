import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { money, JournalEntry as DomainJournalEntry } from "@/lib/accounting/types";
import { buildAccountRollForward, buildStockCompDisclosure, StockCompInstrumentInput } from "@/lib/accounting/reporting";
import { requirePageEntityAccess, requireCurrentUser, resolveDefaultEntityId } from "@/lib/auth/pageGuard";
import { theme } from "@/lib/theme";
import { ListingTable, spanCell } from "@/app/components/ListingTable";

/**
 * Financial-statement support report (v0.19.0) — the front-end counterpart to
 * GET /api/reports/financial-statements. See that route's doc comment for the full
 * scope note (notably: stock-settled SAR is deliberately excluded from the ASC 718
 * disclosure table, and everything here reads only closed/reported rows, never a live
 * recomputation).
 *
 * v0.36.0: added the default-entity redirect every other entity-scoped page has had
 * since v0.21.0 — this page predates that convention and was never updated when it was
 * introduced. See audit-trail/page.tsx's doc comment for the same fix, caught the same
 * way (user report).
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function FinancialStatementsPage({
  searchParams,
}: {
  searchParams: { entityId?: string; periodStart?: string; periodEnd?: string };
}) {
  const entityId = searchParams.entityId;
  if (!entityId) {
    const user = await requireCurrentUser();
    const defaultEntityId = await resolveDefaultEntityId(user);
    if (defaultEntityId) {
      const params = new URLSearchParams({ entityId: defaultEntityId });
      if (searchParams.periodStart) params.set("periodStart", searchParams.periodStart);
      if (searchParams.periodEnd) params.set("periodEnd", searchParams.periodEnd);
      redirect(`/reports/financial-statements?${params.toString()}`);
    }
    return (
      <main style={{ fontFamily: theme.font.body, padding: "2rem" }}>
        <p>
          Pass <code>?entityId=...</code> to view this report, or go to <Link href="/">the entity list</Link> (or
          set a default entity there).
        </p>
      </main>
    );
  }

  await requirePageEntityAccess(entityId, "VIEWER");

  const today = new Date().toISOString().slice(0, 10);
  const periodStart = searchParams.periodStart ?? `${today.slice(0, 4)}-01-01`;
  const periodEnd = searchParams.periodEnd ?? today;

  const journalRows = await db.journalEntry.findMany({
    where: { instrument: { entityId }, supersededByCorrectionId: null },
    include: { lines: true },
    orderBy: { date: "asc" },
  });
  const entries: DomainJournalEntry[] = journalRows.map((r) => ({
    date: r.date.toISOString().slice(0, 10),
    description: r.description,
    currency: r.currency,
    lines: r.lines.map((l) => ({
      account: l.account,
      debit: l.debit ? money(l.debit.toString()) : undefined,
      credit: l.credit ? money(l.credit.toString()) : undefined,
    })),
  }));
  const rollForward = buildAccountRollForward(entries, periodStart, periodEnd);

  const equityCompInstruments = await db.instrument.findMany({
    where: { entityId, type: { in: ["STOCK_OPTION", "RSU", "RESTRICTED_STOCK"] } },
    include: { stakeholder: true, termVersions: { orderBy: { effectiveDate: "desc" }, take: 1 } },
  });
  const disclosureInputs: StockCompInstrumentInput[] = [];
  const warnings: string[] = [];
  for (const inst of equityCompInstruments) {
    const terms = inst.termVersions[0]?.terms as
      | { quantity?: string; grantDateFairValuePerUnit?: string; tranches?: { vestDate: string }[] }
      | undefined;
    if (!terms?.quantity || !terms?.grantDateFairValuePerUnit || !terms?.tranches?.length) {
      warnings.push(`${inst.stakeholder.name} (${inst.type}): missing data on its latest term version — excluded below.`);
      continue;
    }
    const serviceEndDate = terms.tranches.map((t) => t.vestDate).sort().slice(-1)[0];
    const recognizedAgg = await db.scheduleEntry.aggregate({
      where: { instrumentId: inst.id, periodEnd: { lte: new Date(periodEnd) }, supersededByCorrectionId: null },
      _sum: { amount: true },
    });
    disclosureInputs.push({
      instrumentId: inst.id,
      stakeholderName: inst.stakeholder.name,
      type: inst.type,
      totalGrantDateFairValue: money(terms.quantity).times(terms.grantDateFairValuePerUnit).toFixed(4),
      cumulativeExpenseRecognized: recognizedAgg._sum.amount?.toString() ?? "0",
      serviceEndDate,
      asOfDate: periodEnd,
    });
  }
  const disclosure = buildStockCompDisclosure(disclosureInputs);

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href={`/reports?entityId=${entityId}`}>Journal entries report</Link> {" · "}
        <Link href={`/captable?entityId=${entityId}`}>Cap table</Link>
      </p>
      <h1>Financial statement support</h1>
      <p style={{ color: theme.inkMuted }}>
        Period: {periodStart} to {periodEnd}. Reads only closed/reported rows — see the README's "Live preview vs.
        closed/reported numbers" note. Stock-settled SAR is excluded from the disclosure table below (its expense is
        a fair-value remeasurement each period, not amortization of a fixed grant-date total).
      </p>

      <h2>Account roll-forward</h2>
      {rollForward.length === 0 && <p>Nothing closed yet.</p>}
      {rollForward.length > 0 && (
        <div style={{ marginBottom: "2rem" }}>
          <ListingTable
            columns={[
              { label: "Account" },
              { label: "Currency" },
              { label: "Beginning balance", align: "right" },
              { label: "Period activity", align: "right" },
              { label: "Ending balance", align: "right" },
            ]}
            rows={rollForward.map((r, i) => ({
              key: i,
              cells: [r.account, r.currency, r.beginningBalance.toFixed(2), r.periodActivity.toFixed(2), r.endingBalance.toFixed(2)],
            }))}
          />
        </div>
      )}

      <h2>ASC 718 unrecognized compensation cost</h2>
      {warnings.length > 0 && (
        <ul>
          {warnings.map((w, i) => (
            <li key={i} style={{ color: theme.warning.fg }}>
              {w}
            </li>
          ))}
        </ul>
      )}
      {disclosure.rows.length === 0 ? (
        <p>No equity-compensation instruments with usable data.</p>
      ) : (
        <ListingTable
          columns={[
            { label: "Stakeholder" },
            { label: "Type" },
            { label: "Total grant-date FV", align: "right" },
            { label: "Cumulative recognized", align: "right" },
            { label: "Unrecognized cost", align: "right" },
            { label: "Remaining years", align: "right" },
          ]}
          rows={[
            ...disclosure.rows.map((r) => ({
              key: r.instrumentId,
              cells: [
                r.stakeholderName,
                r.type,
                r.totalGrantDateFairValue.toFixed(2),
                r.cumulativeExpenseRecognized.toFixed(2),
                r.unrecognizedCompCost.toFixed(2),
                r.remainingRecognitionYears.toFixed(2),
              ],
            })),
            {
              key: "total",
              highlight: true,
              cells: [
                spanCell("Total unrecognized cost / weighted-average remaining period", 4),
                disclosure.totalUnrecognizedCompCost.toFixed(2),
                disclosure.weightedAverageRemainingYears.toFixed(2),
              ],
            },
          ]}
        />
      )}
    </main>
  );
}
