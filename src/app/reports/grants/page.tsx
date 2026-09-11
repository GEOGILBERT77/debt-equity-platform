import Link from "next/link";
import { redirect } from "next/navigation";
import { theme } from "@/lib/theme";
import { getGrantsReport } from "@/lib/db/grantsReport";
import { requirePageEntityAccess, requireCurrentUser, resolveDefaultEntityId } from "@/lib/auth/pageGuard";

/**
 * Grants report — "the strike price needs to be maintained... as part of a grants
 * report which has all the salient terms of each grant by grant ID." One row per
 * STOCK_OPTION/RSU/RESTRICTED_STOCK instrument's CURRENT terms — see
 * grantsReport.ts's module doc comment for why this reads only the latest term
 * version (use /reports/modification-audit for how a grant's terms changed over
 * time). "Grant ID" is the instrument's own id — there's no separate grant-numbering
 * scheme in this platform, and the instrument id is already the stable identifier
 * every other report/page links a grant by.
 *
 * EDITOR-gated, same bar as the other disclosure-oriented reports (audit trail,
 * modification audit) — this exposes strike price and fair value figures.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function GrantsReportPage({ searchParams }: { searchParams: { entityId?: string } }) {
  const entityId = searchParams.entityId;
  if (!entityId) {
    const user = await requireCurrentUser();
    const defaultEntityId = await resolveDefaultEntityId(user);
    if (defaultEntityId) redirect(`/reports/grants?entityId=${defaultEntityId}`);
    return (
      <main style={{ fontFamily: theme.font.body, padding: "2rem" }}>
        <p>
          Pass <code>?entityId=...</code> to view this report, or go to <Link href="/">the entity list</Link>
          (or set a default entity there).
        </p>
      </main>
    );
  }

  await requirePageEntityAccess(entityId, "EDITOR");

  const entries = await getGrantsReport(entityId);

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 1300 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href={`/reports/modification-audit?entityId=${entityId}`}>Modification audit</Link>
      </p>
      <h1>Grants report</h1>
      <p style={{ color: theme.inkMuted }}>
        Every stock option, RSU, and restricted stock grant recorded for this entity, with its CURRENT terms — grant
        date, quantity, strike price (stock options only), grant-date fair value, vesting, and approval status, all
        by grant ID. This shows terms as they stand today; see{" "}
        <Link href={`/reports/modification-audit?entityId=${entityId}`}>modification audit</Link> for how a grant's
        terms changed over time.
      </p>

      {entries.length === 0 ? (
        <p>No stock option, RSU, or restricted stock grants recorded for this entity yet.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.85rem" }}>
            <thead>
              <tr>
                <th style={cellStyle}>Grant ID</th>
                <th style={cellStyle}>Type</th>
                <th style={cellStyle}>Grantee</th>
                <th style={cellStyle}>Grant date</th>
                <th style={cellStyle}>Quantity</th>
                <th style={cellStyle}>Strike price</th>
                <th style={cellStyle}>Grant-date FV/unit</th>
                <th style={cellStyle}>Total FV</th>
                <th style={cellStyle}>Purchase price</th>
                <th style={cellStyle}>Attribution</th>
                <th style={cellStyle}>Vesting</th>
                <th style={cellStyle}>Service period ends</th>
                <th style={cellStyle}>Approval</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.instrumentId}>
                  <td style={{ ...cellStyle, fontFamily: theme.font.mono, fontSize: "0.75rem" }}>
                    <Link href={`/instruments/${e.instrumentId}`}>{e.instrumentId.slice(0, 10)}…</Link>
                  </td>
                  <td style={cellStyle}>{e.instrumentType}</td>
                  <td style={cellStyle}>{e.stakeholderName}</td>
                  <td style={cellStyle}>{e.grantDate}</td>
                  <td style={cellStyle}>{Number(e.quantity).toLocaleString()}</td>
                  <td style={cellStyle}>{e.strikePrice ?? "—"}</td>
                  <td style={cellStyle}>{e.grantDateFairValuePerUnit}</td>
                  <td style={cellStyle}>{e.totalGrantDateFairValue}</td>
                  <td style={cellStyle}>{e.purchasePricePerShare ?? "—"}</td>
                  <td style={cellStyle}>{e.attributionMethod}</td>
                  <td style={cellStyle}>
                    <ul style={{ margin: 0, paddingLeft: "1rem" }}>
                      {e.tranches.map((t, i) => (
                        <li key={i}>
                          {t.vestDate}: {Number(t.quantity).toLocaleString()}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td style={cellStyle}>
                    {e.servicePeriodEndDate ? (
                      <span title={`Last vesting tranche: ${e.lastVestDate}`}>
                        {e.servicePeriodEndDate}{" "}
                        <span style={{ color: theme.inkMuted, fontSize: "0.75rem" }}>(vests {e.lastVestDate})</span>
                      </span>
                    ) : (
                      <span style={{ color: theme.inkMuted }}>same as vesting ({e.lastVestDate})</span>
                    )}
                  </td>
                  <td
                    style={{
                      ...cellStyle,
                      color: e.approvalStatus === "approved" ? theme.success.fg : e.approvalStatus === "stale" ? theme.warning.fg : theme.inkMuted,
                    }}
                  >
                    {e.approvalStatus === "approved"
                      ? `Approved${e.approvedAt ? ` (${e.approvedAt})` : ""}`
                      : e.approvalStatus === "stale"
                        ? "Stale — re-approve"
                        : "Not approved"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

const cellStyle: React.CSSProperties = { border: `1px solid ${theme.border}`, padding: "0.4rem", textAlign: "left", verticalAlign: "top" };
