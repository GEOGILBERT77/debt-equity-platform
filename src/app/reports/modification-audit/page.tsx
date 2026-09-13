import Link from "next/link";
import { redirect } from "next/navigation";
import { getModificationAuditReport } from "@/lib/db/modificationAudit";
import { requirePageEntityAccess, requireCurrentUser, resolveDefaultEntityId } from "@/lib/auth/pageGuard";
import { theme } from "@/lib/theme";
import { ListingTable } from "@/app/components/ListingTable";

/**
 * Modification audit report — "there needs to be an audit report of all
 * modifications made... so a user can search for all modifications over a date
 * range and it provides the instruments that were modified and summary info of which
 * terms changed and the impact on the reporting/financial statements." See
 * modificationAudit.ts's doc comment for exactly what counts as a "modification"
 * here (never the original grant, never a Correction — the audit-trail report covers
 * the broader chronological picture including those) and why the date filter is the
 * modification's COMMIT date (createdAt), not its effective date.
 *
 * The date-range filter below is a plain GET form (no client JS) — submitting it
 * just reloads this page with `from`/`to` in the URL, the same "URL is the state"
 * pattern every other filtered/scoped page in this app already uses.
 *
 * EDITOR-gated, same bar as /reports/audit-trail — this exposes financial-impact
 * figures and terms detail, not just a plain read.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function ModificationAuditPage({
  searchParams,
}: {
  searchParams: { entityId?: string; from?: string; to?: string };
}) {
  const entityId = searchParams.entityId;
  if (!entityId) {
    const user = await requireCurrentUser();
    const defaultEntityId = await resolveDefaultEntityId(user);
    if (defaultEntityId) {
      const params = new URLSearchParams({ entityId: defaultEntityId });
      if (searchParams.from) params.set("from", searchParams.from);
      if (searchParams.to) params.set("to", searchParams.to);
      redirect(`/reports/modification-audit?${params.toString()}`);
    }
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

  const entries = await getModificationAuditReport(entityId, { from: searchParams.from, to: searchParams.to });

  const totalImpact = entries.filter((e) => e.impactApplicable).reduce((sum, e) => sum + Number(e.totalDelta), 0);

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 1100 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href={`/reports/audit-trail?entityId=${entityId}`}>Audit trail</Link>
      </p>
      <h1>Modification audit</h1>
      <p style={{ color: theme.inkMuted }}>
        Every terms MODIFICATION recorded for this entity — never the original grant, never a correction (see{" "}
        <Link href={`/reports/audit-trail?entityId=${entityId}`}>audit trail</Link> for the full chronological
        picture including those). The date range below filters on when each modification was COMMITTED, not
        when its terms take effect.
      </p>

      <form method="GET" style={{ display: "flex", gap: "1rem", alignItems: "flex-end", margin: "1rem 0", flexWrap: "wrap" }}>
        <input type="hidden" name="entityId" value={entityId} />
        <label style={labelStyle}>
          Modified from
          <input type="date" name="from" defaultValue={searchParams.from ?? ""} style={inputStyle} />
        </label>
        <label style={labelStyle}>
          Modified through
          <input type="date" name="to" defaultValue={searchParams.to ?? ""} style={inputStyle} />
        </label>
        <button type="submit" style={buttonStyle}>
          Search
        </button>
        {(searchParams.from || searchParams.to) && (
          <Link href={`/reports/modification-audit?entityId=${entityId}`} style={{ fontSize: "0.9rem" }}>
            Clear dates
          </Link>
        )}
      </form>

      <p style={{ color: theme.inkMuted }}>
        {entries.length} modification(s) found
        {(searchParams.from || searchParams.to) && (
          <>
            {" "}
            between {searchParams.from || "the beginning"} and {searchParams.to || "today"}
          </>
        )}
        {entries.length > 0 && (
          <>
            {" "}
            · net amortization-table impact of the modifications shown:{" "}
            <strong style={{ color: totalImpact === 0 ? "inherit" : totalImpact > 0 ? theme.success.fg : theme.warning.fg }}>
              {totalImpact > 0 ? "+" : ""}
              {totalImpact.toFixed(2)}
            </strong>
          </>
        )}
        .
      </p>

      {entries.length === 0 ? (
        <p>No modifications recorded in this range.</p>
      ) : (
        <ListingTable
          columns={[
            { label: "Modified on" },
            { label: "Instrument" },
            { label: "Effective" },
            { label: "Who" },
            { label: "Terms changed" },
            { label: "Impact" },
          ]}
          rows={entries.map((e) => ({
            key: e.termVersionId,
            cells: [
              e.modificationDate,
              <>
                <Link href={`/instruments/${e.instrumentId}`}>
                  {e.stakeholderName} ({e.instrumentType})
                </Link>
                <div style={{ color: theme.inkMuted, fontSize: "0.8rem" }}>{e.label}</div>
              </>,
              e.effectiveDate,
              e.modifiedByUserEmail ?? "unknown",
              e.changedFields.length === 0 ? (
                <span style={{ color: theme.inkMuted }}>No terms fields changed</span>
              ) : (
                <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                  {e.changedFields.map((c) => (
                    <li key={c.field}>
                      <strong>{c.field}</strong>: {c.before} &rarr; {c.after}
                    </li>
                  ))}
                </ul>
              ),
              e.impactApplicable ? (
                <>
                  {e.totalBeforeAmount} &rarr; {e.totalAfterAmount}
                  <div
                    style={{
                      fontWeight: 600,
                      color: Number(e.totalDelta) === 0 ? "inherit" : Number(e.totalDelta) > 0 ? theme.success.fg : theme.warning.fg,
                    }}
                  >
                    {Number(e.totalDelta) > 0 ? "+" : ""}
                    {e.totalDelta}
                  </div>
                </>
              ) : (
                <span style={{ color: theme.inkMuted, fontSize: "0.85rem" }}>{e.impactMessage}</span>
              ),
            ],
          }))}
        />
      )}
    </main>
  );
}

const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", fontSize: "0.85rem", gap: "0.25rem" };
const inputStyle: React.CSSProperties = { padding: "0.35rem" };
const buttonStyle: React.CSSProperties = {
  padding: "0.45rem 0.9rem",
  border: `1px solid ${theme.ink}`,
  borderRadius: 4,
  background: theme.surfaceAlt,
  cursor: "pointer",
};
