import Link from "next/link";
import { db } from "@/lib/db";
import { summarizeByAccount, checkReconciliation } from "@/lib/accounting/reporting";
import { money, JournalEntry as DomainJournalEntry } from "@/lib/accounting/types";
import { requirePageEntityAccess } from "@/lib/auth/pageGuard";

/**
 * Journal entries report — the front-end counterpart to GET /api/reports/journal-
 * entries. Deliberately re-runs the same query/transform here (as a server component)
 * rather than fetching that route from within another server component, which is the
 * usual Next.js App Router recommendation when both live in the same app.
 *
 * Reads ONLY persisted JournalEntry rows (never a live recomputation) — see the
 * "Live preview vs. closed/reported numbers" section of the README for why that
 * distinction matters for a report specifically.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function ReportsPage({ searchParams }: { searchParams: { entityId?: string } }) {
  const entityId = searchParams.entityId;
  if (!entityId) {
    return (
      <main style={{ fontFamily: "sans-serif", padding: "2rem" }}>
        <p>
          Pass <code>?entityId=...</code> to view a report, or go to <Link href="/">the entity list</Link>.
        </p>
      </main>
    );
  }

  await requirePageEntityAccess(entityId, "VIEWER");

  const rows = await db.journalEntry.findMany({
    where: { instrument: { entityId }, supersededByCorrectionId: null },
    include: { lines: true, instrument: { include: { stakeholder: true } } },
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

  const accountSummary = summarizeByAccount(entries);
  const reconciliationByCurrency = checkReconciliation(entries);

  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 1000 }}>
      {/* The rest of this page's sibling reports and every standalone ASC calculator moved into the top nav
          bar's "GAAP reports" menu (see NavBar.tsx) — this breadcrumb now only keeps the two links that are
          specific to THIS report/entity rather than duplicating global navigation. */}
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href={`/captable?entityId=${entityId}`}>Cap table</Link>
      </p>
      <h1>Journal entries report</h1>
      <p style={{ color: "#555" }}>
        Reads only closed/reported rows — a period that hasn't been closed yet (see each instrument's page for a
        "Close" action) won't show up here.
      </p>

      <h2>Reconciliation</h2>
      {reconciliationByCurrency.length === 0 && <p>Nothing closed yet.</p>}
      {reconciliationByCurrency.map((r) => (
        <p key={r.currency} style={{ color: r.balanced ? "#166534" : "crimson" }}>
          {r.currency}: {r.balanced ? "Balanced" : "OUT OF BALANCE"} — debits {r.totalDebits.toFixed(2)}, credits{" "}
          {r.totalCredits.toFixed(2)}
          {!r.balanced && ` (difference ${r.difference.toFixed(2)})`}
        </p>
      ))}

      <h2>Account summary</h2>
      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "2rem" }}>
        <thead>
          <tr>
            <th style={cellStyle}>Account</th>
            <th style={cellStyle}>Currency</th>
            <th style={cellStyle}>Total debit</th>
            <th style={cellStyle}>Total credit</th>
            <th style={cellStyle}>Net</th>
          </tr>
        </thead>
        <tbody>
          {accountSummary.map((s, i) => (
            <tr key={i}>
              <td style={cellStyle}>{s.account}</td>
              <td style={cellStyle}>{s.currency}</td>
              <td style={cellStyle}>{s.totalDebit.toFixed(2)}</td>
              <td style={cellStyle}>{s.totalCredit.toFixed(2)}</td>
              <td style={cellStyle}>{s.net.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Journal entries</h2>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={cellStyle}>Date</th>
            <th style={cellStyle}>Description</th>
            <th style={cellStyle}>Instrument</th>
            <th style={cellStyle}>ASC ref</th>
            <th style={cellStyle}>Lines</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={cellStyle}>{r.date.toISOString().slice(0, 10)}</td>
              <td style={cellStyle}>{r.description}</td>
              <td style={cellStyle}>
                {r.instrument ? (
                  <Link href={`/instruments/${r.instrument.id}`}>
                    {r.instrument.stakeholder.name} ({r.instrument.type})
                  </Link>
                ) : (
                  "—"
                )}
              </td>
              <td style={cellStyle}>{r.ascReference ?? "—"}</td>
              <td style={cellStyle}>
                {r.lines.map((l) => (
                  <div key={l.id}>
                    {l.account}: {l.debit ? `Dr ${l.debit.toString()}` : `Cr ${l.credit?.toString()}`}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

const cellStyle: React.CSSProperties = { border: "1px solid #ccc", padding: "0.5rem", textAlign: "left" };
