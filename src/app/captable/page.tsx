import Link from "next/link";
import { db } from "@/lib/db";
import { computeVisibleSchedule, InstrumentTypeForDispatch } from "@/lib/accounting/dispatch";
import { buildCapTableRollup, aggregateByStakeholder, CapTableInstrumentInput } from "@/lib/accounting/capTable";
import { requirePageEntityAccess } from "@/lib/auth/pageGuard";
import { StakeholderRowActions } from "@/app/components/StakeholderRowActions";

/**
 * Cap table view — now an actual rollup (original requirement #1), not just a listing.
 * Ownership percentages here are computed LIVE (today's fully-diluted share count),
 * the same way the instrument detail page's "live preview" schedule is: this is an
 * operational view of who owns what right now, not a reported financial-statement
 * number gated behind the close workflow the way period expense recognition is. Debt
 * balances shown here are likewise the live-computed current balance, not necessarily
 * what's been closed/reported yet — see each instrument's own page for that
 * distinction if it matters for your purposes.
 *
 * One instrument failing to compute (a bad terms payload, a stale cashFlows array —
 * see the known TERM_LOAN/periods-length limitation noted in db/seed.sql) doesn't
 * take down the whole page: it's caught per-instrument and surfaced as a warning
 * instead, the same "flag rather than silently drop or crash" approach capTable.ts
 * itself takes for genuinely unsupported instrument types.
 *
 * As of v0.18.0, the "All instruments (detail)" table's rightmost column offers real
 * inline edit/delete for a stakeholder (StakeholderRowActions.tsx) — delete is blocked
 * with a clear message whenever that stakeholder still holds an instrument, per that
 * component's doc comment.
 *
 * NOT EXECUTED IN THIS SANDBOX — no Postgres, no installed Next.js/React here.
 */
export default async function CapTablePage({ searchParams }: { searchParams: { entityId?: string } }) {
  const entityId = searchParams.entityId;
  if (!entityId) {
    return (
      <main style={{ fontFamily: "sans-serif", padding: "2rem" }}>
        <p>
          Pass <code>?entityId=...</code> to view a cap table, or go to <Link href="/">the entity list</Link>.
        </p>
      </main>
    );
  }

  await requirePageEntityAccess(entityId, "VIEWER");

  const stakeholders = await db.stakeholder.findMany({
    where: { entityId },
    include: {
      instruments: {
        include: { termVersions: { orderBy: { effectiveDate: "desc" }, take: 1 } },
      },
    },
    orderBy: { name: "asc" },
  });

  const today = new Date().toISOString().slice(0, 10);
  const rollupInputs: CapTableInstrumentInput[] = [];
  const computeWarnings: { instrumentId: string; stakeholderName: string; type: string; message: string }[] = [];

  for (const s of stakeholders) {
    for (const inst of s.instruments) {
      const latestTerms = inst.termVersions[0]?.terms;
      if (latestTerms === undefined) continue; // shouldn't happen — every instrument requires an original term version
      const type = inst.type as InstrumentTypeForDispatch;

      const isDebtType = type === "TERM_LOAN" || type === "REVOLVER" || type === "PIK_NOTE";
      let outstandingBalance: string | undefined;
      if (isDebtType) {
        try {
          // computeVisibleSchedule, not a manually-truncated buildAnnualPeriods +
          // computeScheduleForInstrument — see dispatch.ts's CORRECTNESS NOTE. REVOLVER
          // is the debt type this actually matters for here (its fee schedule is a
          // remainder-allocation engine); TERM_LOAN/PIK_NOTE are roll-forwards that
          // were never affected, but route everything through the same call for
          // consistency and because "live current balance" is exactly what
          // computeVisibleSchedule is for.
          const schedule = computeVisibleSchedule(
            type,
            inst.termVersions.map((v) => ({
              effectiveDate: v.effectiveDate.toISOString().slice(0, 10),
              label: v.label,
              terms: v.terms,
            })),
            today
          );
          const last = schedule[schedule.length - 1];
          outstandingBalance = last?.endingBalance?.toString();
        } catch (err) {
          computeWarnings.push({
            instrumentId: inst.id,
            stakeholderName: s.name,
            type,
            message: err instanceof Error ? err.message : "Failed to compute current balance",
          });
        }
      }

      rollupInputs.push({
        instrumentId: inst.id,
        stakeholderId: s.id,
        stakeholderName: s.name,
        type,
        terms: latestTerms,
        outstandingBalance,
      });
    }
  }

  const rollup = buildCapTableRollup(rollupInputs);
  const ownershipByStakeholder = aggregateByStakeholder(rollup);

  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href={`/reports?entityId=${entityId}`}>Journal entries report</Link> {" · "}
        <a href={`/api/reports/cap-table-export?entityId=${entityId}`}>Download CSV</a> {" · "}
        <Link href="/reports/exit-waterfall">Exit waterfall calculator</Link>
      </p>
      <h1>Cap Table</h1>
      <p style={{ color: "#555" }}>
        Fully diluted: every option/warrant/as-converted note counts as a share regardless of vesting or
        exercise price. Computed live as of today — see the README's "Live preview vs. closed/reported
        numbers" note.
      </p>
      <p>
        <Link href={`/stakeholders/new?entityId=${entityId}`} style={buttonLinkStyle}>
          + Add a stakeholder
        </Link>{" "}
        <Link href={`/instruments/new?entityId=${entityId}`} style={buttonLinkStyle}>
          + Add an instrument
        </Link>
      </p>

      <h2>Ownership (fully diluted)</h2>
      {rollup.totalFullyDilutedShares.toString() === "0" ? (
        <p>No equity instruments yet.</p>
      ) : (
        <>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={cellStyle}>Stakeholder</th>
                <th style={cellStyle}>Fully diluted shares</th>
                <th style={cellStyle}>Ownership %</th>
              </tr>
            </thead>
            <tbody>
              {ownershipByStakeholder.map((o) => (
                <tr key={o.stakeholderId}>
                  <td style={cellStyle}>{o.stakeholderName}</td>
                  <td style={cellStyle}>{o.shares.toString()}</td>
                  <td style={cellStyle}>{o.ownershipPercent?.toFixed(2)}%</td>
                </tr>
              ))}
              <tr>
                <td style={{ ...cellStyle, fontWeight: "bold" }}>Total</td>
                <td style={{ ...cellStyle, fontWeight: "bold" }}>{rollup.totalFullyDilutedShares.toString()}</td>
                <td style={{ ...cellStyle, fontWeight: "bold" }}>100.00%</td>
              </tr>
            </tbody>
          </table>
        </>
      )}

      <h2>Debt holders</h2>
      {rollup.debtRows.length === 0 && <p>No debt instruments yet.</p>}
      {rollup.debtRows.length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={cellStyle}>Lender</th>
              <th style={cellStyle}>Type</th>
              <th style={cellStyle}>Outstanding balance</th>
            </tr>
          </thead>
          <tbody>
            {rollup.debtRows.map((r) => (
              <tr key={r.instrumentId}>
                <td style={cellStyle}>
                  <Link href={`/instruments/${r.instrumentId}`}>{r.stakeholderName}</Link>
                </td>
                <td style={cellStyle}>{r.type}</td>
                <td style={cellStyle}>{r.outstandingBalance?.toString() ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(rollup.unsupported.length > 0 || computeWarnings.length > 0) && (
        <>
          <h2 style={{ color: "#92400e" }}>Not included above</h2>
          <ul>
            {rollup.unsupported.map((u) => (
              <li key={u.instrumentId} style={{ color: "#92400e" }}>
                <Link href={`/instruments/${u.instrumentId}`}>{u.stakeholderName}</Link> ({u.type}): {u.reason}
              </li>
            ))}
            {computeWarnings.map((w) => (
              <li key={w.instrumentId} style={{ color: "#92400e" }}>
                <Link href={`/instruments/${w.instrumentId}`}>{w.stakeholderName}</Link> ({w.type}): {w.message}
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>All instruments (detail)</h2>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={cellStyle}>Stakeholder</th>
            <th style={cellStyle}>Type</th>
            <th style={cellStyle}>Email</th>
            <th style={cellStyle}>Instruments</th>
            <th style={cellStyle}></th>
          </tr>
        </thead>
        <tbody>
          {stakeholders.map((s) => (
            <tr key={s.id}>
              <td style={cellStyle}>{s.name}</td>
              <td style={cellStyle}>{s.type}</td>
              <td style={cellStyle}>{s.email ?? "—"}</td>
              <td style={cellStyle}>
                {s.instruments.length === 0 && "—"}
                {s.instruments.map((i) => (
                  <div key={i.id}>
                    <Link href={`/instruments/${i.id}`}>
                      {i.type} ({i.status})
                    </Link>
                  </div>
                ))}
              </td>
              <td style={cellStyle}>
                <StakeholderRowActions
                  entityId={entityId}
                  stakeholderId={s.id}
                  initialName={s.name}
                  initialType={s.type}
                  initialEmail={s.email ?? ""}
                  hasInstruments={s.instruments.length > 0}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

const cellStyle: React.CSSProperties = { border: "1px solid #ccc", padding: "0.5rem", textAlign: "left" };
const buttonLinkStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "0.4rem 0.8rem",
  border: "1px solid #333",
  borderRadius: 4,
  background: "#f5f5f5",
  textDecoration: "none",
  color: "inherit",
  marginRight: "0.5rem",
};
