import Link from "next/link";
import { redirect } from "next/navigation";
import { theme } from "@/lib/theme";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/accounting/types";
import { computeVisibleSchedule, InstrumentTypeForDispatch, PreferredStockInstrumentTerms } from "@/lib/accounting/dispatch";
import { buildCapTableRollup, aggregateByStakeholder, CapTableInstrumentInput } from "@/lib/accounting/capTable";
import { requirePageEntityAccess, requireCurrentUser, resolveDefaultEntityId } from "@/lib/auth/pageGuard";
import { StakeholderRowActions } from "@/app/components/StakeholderRowActions";
import { CloseAllInstrumentsButton } from "@/app/components/CloseAllInstrumentsButton";
import { CapTableOwnershipTable, CapTableGroupRow } from "@/app/components/CapTableOwnershipTable";

/**
 * "Class" for the ownership table's "By Instrument/Class" grouping (v0.42.0) — not the
 * same grouping capTableWaterfall.ts uses for the Waterfall Analysis report (that one
 * pools everything non-preferred into a single "Common (fully-diluted)" bucket, which
 * is right for liquidation-preference math but too coarse for "what classes does this
 * cap table actually have"). Here, COMMON_STOCK classes by its term-version label
 * (same "class" concept EquityFundingWizard.tsx already uses for "issue more of an
 * existing class" — see that file's doc comment), PREFERRED_STOCK classes by
 * liquidationPreference.seriesName (falling back to its label if that's not set yet),
 * and every other equity-shaped type gets its own class named after the instrument
 * type, since lumping stock options in with warrants in with restricted stock would
 * hide exactly the breakdown a cap table's "by class" view exists to show.
 */
function classKeyForInstrument(
  type: InstrumentTypeForDispatch,
  label: string,
  terms: unknown
): { key: string; displayLabel: string } {
  switch (type) {
    case "COMMON_STOCK": {
      const name = label.trim() || "Common stock";
      return { key: `COMMON:${name}`, displayLabel: name };
    }
    case "PREFERRED_STOCK": {
      const t = terms as PreferredStockInstrumentTerms;
      const name = t.liquidationPreference?.seriesName?.trim() || label.trim() || "Preferred stock";
      return { key: `PREFERRED:${name}`, displayLabel: name };
    }
    case "STOCK_OPTION":
      return { key: "STOCK_OPTION", displayLabel: "Stock options" };
    case "RSU":
      return { key: "RSU", displayLabel: "RSUs" };
    case "RESTRICTED_STOCK":
      return { key: "RESTRICTED_STOCK", displayLabel: "Restricted stock" };
    case "WARRANT":
      return { key: "WARRANT", displayLabel: "Standalone warrants" };
    case "SAR":
      return { key: "SAR", displayLabel: "Stock appreciation rights" };
    case "CONVERTIBLE_NOTE":
      return { key: "CONVERTIBLE_NOTE", displayLabel: "Convertible notes (as-converted)" };
    default:
      return { key: type, displayLabel: type };
  }
}

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
    // v0.21.0 — fall back to the user's default entity before showing the "pass
    // ?entityId=..." message, same reasoning as instruments/new/page.tsx.
    const user = await requireCurrentUser();
    const defaultEntityId = await resolveDefaultEntityId(user);
    if (defaultEntityId) redirect(`/captable?entityId=${defaultEntityId}`);
    return (
      <main style={{ fontFamily: theme.font.body, padding: "2rem" }}>
        <p>
          Pass <code>?entityId=...</code> to view a cap table, or go to <Link href="/">the entity list</Link>
          (or set a default entity there).
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
  // See classKeyForInstrument's doc comment above — populated for every instrument
  // regardless of debt/equity classification; only ever looked up for the ones that
  // actually land in rollup.equityRows below.
  const classKeyByInstrumentId = new Map<string, { key: string; displayLabel: string }>();

  for (const s of stakeholders) {
    for (const inst of s.instruments) {
      const latestTerms = inst.termVersions[0]?.terms;
      if (latestTerms === undefined) continue; // shouldn't happen — every instrument requires an original term version
      const type = inst.type as InstrumentTypeForDispatch;
      classKeyByInstrumentId.set(inst.id, classKeyForInstrument(type, inst.termVersions[0]?.label ?? "", latestTerms));

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

  // "By Instrument/Class" grouping — one row per class (see classKeyForInstrument
  // above), each investor's shares within that class combined into one member row
  // even if they hold more than one instrument of it (e.g. two separate option
  // grants). Sorted largest-class-first, same convention the sample "Ledger summary"
  // format uses.
  const classGroups = new Map<string, { label: string; shares: Decimal; members: Map<string, { name: string; shares: Decimal }> }>();
  for (const row of rollup.equityRows) {
    const ck = classKeyByInstrumentId.get(row.instrumentId) ?? { key: row.type, displayLabel: row.type };
    let group = classGroups.get(ck.key);
    if (!group) {
      group = { label: ck.displayLabel, shares: new Decimal(0), members: new Map() };
      classGroups.set(ck.key, group);
    }
    group.shares = group.shares.plus(row.shares ?? 0);
    const existingMember = group.members.get(row.stakeholderId);
    if (existingMember) {
      existingMember.shares = existingMember.shares.plus(row.shares ?? 0);
    } else {
      group.members.set(row.stakeholderId, { name: row.stakeholderName, shares: row.shares ?? new Decimal(0) });
    }
  }
  const byClassRows: CapTableGroupRow[] = [...classGroups.entries()]
    .sort(([, a], [, b]) => (b.shares.greaterThan(a.shares) ? 1 : -1))
    .map(([key, group]) => ({
      key,
      label: group.label,
      memberCount: group.members.size,
      shares: group.shares.toString(),
      ownershipPercent: rollup.totalFullyDilutedShares.greaterThan(0)
        ? group.shares.div(rollup.totalFullyDilutedShares).times(100).toFixed(2)
        : "0.00",
      members: [...group.members.entries()]
        .sort(([, a], [, b]) => (b.shares.greaterThan(a.shares) ? 1 : -1))
        .map(([stakeholderId, m]) => ({
          key: stakeholderId,
          label: m.name,
          href: `/stakeholders/${stakeholderId}`,
          shares: m.shares.toString(),
          percentOfGroup: group.shares.greaterThan(0) ? m.shares.div(group.shares).times(100).toFixed(2) : "0.00",
        })),
    }));

  // "By Investor" grouping — one row per investor (same rollup aggregateByStakeholder
  // already computes for the total), each expanding to that investor's own classes
  // combined the same way (two option grants in the same class become one member row).
  const byInvestorRows: CapTableGroupRow[] = ownershipByStakeholder.map((s) => {
    const classesForStakeholder = new Map<string, { label: string; shares: Decimal }>();
    for (const row of rollup.equityRows) {
      if (row.stakeholderId !== s.stakeholderId) continue;
      const ck = classKeyByInstrumentId.get(row.instrumentId) ?? { key: row.type, displayLabel: row.type };
      const existing = classesForStakeholder.get(ck.key);
      if (existing) {
        existing.shares = existing.shares.plus(row.shares ?? 0);
      } else {
        classesForStakeholder.set(ck.key, { label: ck.displayLabel, shares: row.shares ?? new Decimal(0) });
      }
    }
    return {
      key: s.stakeholderId,
      label: s.stakeholderName,
      href: `/stakeholders/${s.stakeholderId}`,
      memberCount: classesForStakeholder.size,
      shares: s.shares.toString(),
      ownershipPercent: s.ownershipPercent ? s.ownershipPercent.toFixed(2) : "0.00",
      members: [...classesForStakeholder.entries()]
        .sort(([, a], [, b]) => (b.shares.greaterThan(a.shares) ? 1 : -1))
        .map(([key, c]) => ({
          key,
          label: c.label,
          shares: c.shares.toString(),
          percentOfGroup: s.shares.greaterThan(0) ? c.shares.div(s.shares).times(100).toFixed(2) : "0.00",
        })),
    };
  });

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href={`/reports?entityId=${entityId}`}>Journal entries report</Link> {" · "}
        <a href={`/api/reports/cap-table-export?entityId=${entityId}`}>Download CSV</a> {" · "}
        <Link href="/reports/exit-waterfall">Exit waterfall calculator</Link>
      </p>
      <h1>Cap Table</h1>
      <p style={{ color: theme.inkMuted }}>
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

      <CloseAllInstrumentsButton entityId={entityId} />
      <p style={{ color: theme.inkMuted, fontSize: "0.85rem", marginTop: "-0.5rem" }}>
        Runs the accounting engine for every instrument above and stores the resulting schedule/journal
        entries — this is what GAAP reports (and the debt-modification report) actually read from. Closing an
        individual instrument from its own page still works too; this just does all of them at once.
      </p>

      <h2>Ownership (fully diluted)</h2>
      {rollup.totalFullyDilutedShares.toString() === "0" ? (
        <p>No equity instruments yet.</p>
      ) : (
        <CapTableOwnershipTable
          totalShares={rollup.totalFullyDilutedShares.toString()}
          byClass={byClassRows}
          byInvestor={byInvestorRows}
        />
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
                  <Link href={`/stakeholders/${r.stakeholderId}`}>{r.stakeholderName}</Link>
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
          <h2 style={{ color: theme.warning.fg }}>Not included above</h2>
          <ul>
            {rollup.unsupported.map((u) => (
              <li key={u.instrumentId} style={{ color: theme.warning.fg }}>
                <Link href={`/instruments/${u.instrumentId}`}>{u.stakeholderName}</Link> ({u.type}): {u.reason}
              </li>
            ))}
            {computeWarnings.map((w) => (
              <li key={w.instrumentId} style={{ color: theme.warning.fg }}>
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
              <td style={cellStyle}>
                <Link href={`/stakeholders/${s.id}`}>{s.name}</Link>
              </td>
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

const cellStyle: React.CSSProperties = { border: `1px solid ${theme.border}`, padding: "0.5rem", textAlign: "left" };
const buttonLinkStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "0.4rem 0.8rem",
  border: `1px solid ${theme.ink}`,
  borderRadius: 4,
  background: theme.surfaceAlt,
  textDecoration: "none",
  color: "inherit",
  marginRight: "0.5rem",
};
