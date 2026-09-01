import Link from "next/link";
import { db } from "@/lib/db";
import { computeVisibleSchedule, InstrumentTypeForDispatch } from "@/lib/accounting/dispatch";
import { CloseInstrumentButton } from "@/app/components/CloseInstrumentButton";
import { CorrectionPanel } from "@/app/components/CorrectionPanel";
import { requirePageEntityAccess } from "@/lib/auth/pageGuard";

/**
 * Schedule + term-version-history viewer for one instrument. The term-version table at
 * the bottom is the modification audit trail made visible — every row there is an
 * InstrumentTermVersion, in the order it was recorded, never edited after the fact.
 *
 * Shows THREE distinct things, deliberately not collapsed into one table, because
 * conflating them is exactly the mistake the "Live preview vs. closed/reported numbers"
 * section of the README warns about:
 *   1. The live-computed schedule (recomputed on every page load — a preview).
 *   2. What's actually been closed/persisted (ScheduleEntry rows — the real record).
 *   3. The journal entries booked for what's closed (JournalEntry/JournalLine rows).
 * The "Close through today" button is what moves rows from (1) into (2) and (3).
 *
 * NOT EXECUTED IN THIS SANDBOX — see captable/page.tsx for the same caveat.
 */
export default async function InstrumentPage({ params }: { params: { id: string } }) {
  const instrument = await db.instrument.findUnique({
    where: { id: params.id },
    include: {
      stakeholder: true,
      entity: true,
      termVersions: { orderBy: { effectiveDate: "asc" } },
    },
  });

  if (!instrument) {
    return <p>No instrument found with id "{params.id}".</p>;
  }

  // VIEWER is enough to see this page — the write actions on it (CloseInstrumentButton,
  // CorrectionPanel) hit API routes that independently require EDITOR, so a VIEWER
  // loading this page just sees controls that will 404 if they try to use them. Giving
  // VIEWER-only users a cleaner "read-only" rendering of this page (hiding those
  // buttons rather than letting them fail) is left as a front-end polish item, not a
  // security gap — the API is what actually enforces the boundary.
  await requirePageEntityAccess(instrument.entityId, "VIEWER");

  const today = new Date().toISOString().slice(0, 10);

  let scheduleError: string | null = null;
  let schedule: ReturnType<typeof computeVisibleSchedule> = [];
  try {
    // computeVisibleSchedule, not a manually-truncated buildAnnualPeriods +
    // computeScheduleForInstrument — see dispatch.ts's CORRECTNESS NOTE for why the
    // naive pattern silently overstated stock comp / revolver fee schedules here.
    schedule = computeVisibleSchedule(
      instrument.type as InstrumentTypeForDispatch,
      instrument.termVersions.map((v) => ({
        effectiveDate: v.effectiveDate.toISOString().slice(0, 10),
        label: v.label,
        terms: v.terms,
      })),
      today
    );
  } catch (err) {
    scheduleError = err instanceof Error ? err.message : "Failed to compute schedule";
  }

  const [closedRows, journalEntries] = await Promise.all([
    db.scheduleEntry.findMany({
      where: { instrumentId: instrument.id, supersededByCorrectionId: null },
      orderBy: { periodEnd: "asc" },
    }),
    db.journalEntry.findMany({
      where: { instrumentId: instrument.id, supersededByCorrectionId: null },
      include: { lines: true },
      orderBy: { date: "asc" },
    }),
  ]);

  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href={`/captable?entityId=${instrument.entityId}`}>{instrument.entity.name} cap table</Link>
      </p>
      <h1>
        {instrument.type} — {instrument.stakeholder.name}
      </h1>
      <p>
        Status: {instrument.status} · Currency: {instrument.currency} · Issued: {instrument.issueDate.toISOString().slice(0, 10)}
      </p>

      <CloseInstrumentButton instrumentId={instrument.id} />
      <CorrectionPanel instrumentId={instrument.id} />

      <h2>Live computed schedule (preview — not yet closed/reported)</h2>
      {scheduleError && (
        <p style={{ color: "crimson" }}>
          {scheduleError}
          {schedule.length === 0 && closedRows.length > 0 && " (The closed/reported rows below are unaffected.)"}
        </p>
      )}
      {!scheduleError && (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={cellStyle}>Period</th>
              <th style={cellStyle}>Amount</th>
              <th style={cellStyle}>Ending balance</th>
              <th style={cellStyle}>Term version</th>
            </tr>
          </thead>
          <tbody>
            {schedule.map((row, i) => (
              <tr key={i}>
                <td style={cellStyle}>{row.label}</td>
                <td style={cellStyle}>{row.amount.toFixed(2)}</td>
                <td style={cellStyle}>{row.endingBalance?.toFixed(2) ?? "—"}</td>
                <td style={cellStyle}>{String(row.meta?.termVersionLabel ?? "—")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Closed &amp; reported (persisted ScheduleEntry rows)</h2>
      {closedRows.length === 0 && <p>Nothing closed yet — use the button above.</p>}
      {closedRows.length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={cellStyle}>Period</th>
              <th style={cellStyle}>Amount</th>
              <th style={cellStyle}>Ending balance</th>
              <th style={cellStyle}>Currency</th>
              <th style={cellStyle}>ASC ref</th>
            </tr>
          </thead>
          <tbody>
            {closedRows.map((r) => (
              <tr key={r.id}>
                <td style={cellStyle}>{r.label}</td>
                <td style={cellStyle}>{r.amount.toString()}</td>
                <td style={cellStyle}>{r.endingBalance?.toString() ?? "—"}</td>
                <td style={cellStyle}>{r.currency}</td>
                <td style={cellStyle}>{r.ascReference ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Journal entries booked</h2>
      {journalEntries.length === 0 && <p>None yet.</p>}
      {journalEntries.length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={cellStyle}>Date</th>
              <th style={cellStyle}>Description</th>
              <th style={cellStyle}>Lines</th>
            </tr>
          </thead>
          <tbody>
            {journalEntries.map((je) => (
              <tr key={je.id}>
                <td style={cellStyle}>{je.date.toISOString().slice(0, 10)}</td>
                <td style={cellStyle}>{je.description}</td>
                <td style={cellStyle}>
                  {je.lines.map((l) => (
                    <div key={l.id}>
                      {l.account}: {l.debit ? `Dr ${l.debit.toString()}` : `Cr ${l.credit?.toString()}`}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Modification history</h2>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={cellStyle}>Effective date</th>
            <th style={cellStyle}>Label</th>
          </tr>
        </thead>
        <tbody>
          {instrument.termVersions.map((v) => (
            <tr key={v.id}>
              <td style={cellStyle}>{v.effectiveDate.toISOString().slice(0, 10)}</td>
              <td style={cellStyle}>{v.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

const cellStyle: React.CSSProperties = { border: "1px solid #ccc", padding: "0.5rem", textAlign: "left" };
