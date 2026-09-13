import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requirePageEntityAccess, requireCurrentUser, resolveDefaultEntityId } from "@/lib/auth/pageGuard";
import { ApproveAllAmortizationSchedulesButton } from "@/app/components/ApproveAllAmortizationSchedulesButton";
import { ScheduleGridTable } from "@/app/components/ScheduleGridTable";
import { theme } from "@/lib/theme";

/**
 * "Aggregated with all other stock options of the same type" — v0.22.0, the report
 * this line from the amortization-approval feature request is for. Reads ONLY
 * approved amortization tables (AmortizationScheduleApproval/Row — see that model's
 * doc comment in prisma/schema.prisma) across every STOCK_OPTION instrument in the
 * entity, never a live recomputation: an unreviewed number shouldn't feed a
 * company-wide aggregate any more than an unclosed period should feed the journal
 * entries report.
 *
 * MONTH BUCKETING: computeFullSchedule (dispatch.ts) builds each instrument's
 * monthly periods aligned to actual CALENDAR months (buildCalendarMonthlyPeriods in
 * dateMath.ts) — a grant made mid-month gets a partial first (and last) period, but
 * every period, full or partial, falls entirely within exactly one calendar month.
 * That means `periodStart`'s "YYYY-MM" is the exact, not approximate, calendar month
 * a row's expense belongs to — bucket by `periodStart`, NOT `periodEnd`: periodEnd is
 * the EXCLUSIVE boundary into the following month (a period 4/1-5/1 is all of April,
 * but its periodEnd's own month is May), so bucketing by periodEnd silently shifts
 * every row's expense one calendar month too late. A per-instrument's OWN cumulative
 * ending balance stays exact regardless (it comes straight from that instrument's own
 * approved rows in period order); only the CROSS-instrument monthly aggregation below
 * depends on picking the right end of each period to key off of.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function StockOptionAmortizationReportPage({
  searchParams,
}: {
  searchParams: { entityId?: string };
}) {
  const entityId = searchParams.entityId;
  if (!entityId) {
    const user = await requireCurrentUser();
    const defaultEntityId = await resolveDefaultEntityId(user);
    if (defaultEntityId) redirect(`/reports/stock-option-amortization?entityId=${defaultEntityId}`);
    return (
      <main style={{ fontFamily: theme.font.body, padding: "2rem" }}>
        <p>
          Pass <code>?entityId=...</code> to view this report, or go to <Link href="/">the entity list</Link>
          (or set a default entity there).
        </p>
      </main>
    );
  }

  await requirePageEntityAccess(entityId, "VIEWER");

  const instruments = await db.instrument.findMany({
    where: { entityId, type: "STOCK_OPTION" },
    include: {
      stakeholder: true,
      termVersions: { orderBy: { effectiveDate: "asc" }, select: { id: true } },
      amortizationApprovals: {
        orderBy: { approvedAt: "desc" },
        take: 1,
        include: { rows: { orderBy: { periodEnd: "asc" } } },
      },
    },
    orderBy: { issueDate: "asc" },
  });

  type InstrumentRow = {
    instrumentId: string;
    stakeholderId: string;
    stakeholderName: string;
    status: "approved" | "stale" | "not-approved";
    approvedAt: string | null;
    totalAmount: string | null;
  };

  const instrumentRows: InstrumentRow[] = [];
  const monthlyTotals = new Map<string, number>();

  for (const inst of instruments) {
    const approval = inst.amortizationApprovals[0];
    const latestTermVersionId = inst.termVersions[inst.termVersions.length - 1]?.id;

    if (!approval) {
      instrumentRows.push({
        instrumentId: inst.id,
        stakeholderId: inst.stakeholderId,
        stakeholderName: inst.stakeholder.name,
        status: "not-approved",
        approvedAt: null,
        totalAmount: null,
      });
      continue;
    }

    const isStale = approval.sourceTermVersionId !== latestTermVersionId;
    let totalAmount = 0;
    for (const row of approval.rows) {
      const monthKey = row.periodStart.toISOString().slice(0, 7); // "YYYY-MM" — see the module doc comment on why periodStart, not periodEnd
      // Prisma's Decimal (Decimal.js-backed) — go through .toString() rather than a
      // direct Number() coercion, the same conversion pattern every other page in
      // this app uses for a raw Prisma Decimal field (e.g. captable/page.tsx's
      // `r.outstandingBalance?.toString()`).
      const amount = Number(row.amount.toString());
      monthlyTotals.set(monthKey, (monthlyTotals.get(monthKey) ?? 0) + amount);
      totalAmount += amount;
    }

    instrumentRows.push({
      instrumentId: inst.id,
      stakeholderId: inst.stakeholderId,
      stakeholderName: inst.stakeholder.name,
      status: isStale ? "stale" : "approved",
      approvedAt: approval.approvedAt.toISOString().slice(0, 10),
      totalAmount: totalAmount.toFixed(2),
    });
  }

  const sortedMonths = Array.from(monthlyTotals.keys()).sort();
  let cumulative = 0;
  const monthlyRows = sortedMonths.map((month) => {
    const amount = monthlyTotals.get(month)!;
    cumulative += amount;
    return { month, amount, cumulative };
  });

  const notApprovedCount = instrumentRows.filter((r) => r.status === "not-approved").length;
  const staleCount = instrumentRows.filter((r) => r.status === "stale").length;

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href={`/captable?entityId=${entityId}`}>Cap table</Link>
      </p>
      <h1>Stock option amortization</h1>
      <p style={{ color: theme.inkMuted }}>
        Aggregates every APPROVED stock option amortization table for this entity into one company-wide
        monthly schedule. A grant's table isn't included here until it's been approved — see this page's
        source doc comment for the month-bucketing approximation used across grants with different anchor
        dates.
      </p>

      {(notApprovedCount > 0 || staleCount > 0) && (
        <>
          <p style={{ color: theme.warning.fg }}>
            {notApprovedCount > 0 && `${notApprovedCount} stock option(s) have no approved schedule yet. `}
            {staleCount > 0 && `${staleCount} approved schedule(s) are stale (modified since approval). `}
            Only approved, current schedules are included in the totals below.
          </p>
          <ApproveAllAmortizationSchedulesButton entityId={entityId} type="STOCK_OPTION" label="stock option" />
        </>
      )}

      <h2>Company-wide monthly total (approved schedules only)</h2>
      {monthlyRows.length === 0 && <p>No approved stock option amortization schedules yet.</p>}
      {monthlyRows.length > 0 && (
        <div style={{ marginBottom: "1.5rem" }}>
          <ScheduleGridTable
            columns={[{ label: "Month" }, { label: "Aggregate expense", align: "right" }, { label: "Cumulative", align: "right" }]}
            rows={monthlyRows.map((r) => ({ key: r.month, cells: [r.month, r.amount.toFixed(2), r.cumulative.toFixed(2)] }))}
          />
        </div>
      )}

      <h2>By instrument</h2>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={cellStyle}>Holder</th>
            <th style={cellStyle}>Status</th>
            <th style={cellStyle}>Approved on</th>
            <th style={cellStyle}>Total value</th>
          </tr>
        </thead>
        <tbody>
          {instrumentRows.map((r) => (
            <tr key={r.instrumentId}>
              <td style={cellStyle}>
                <Link href={`/stakeholders/${r.stakeholderId}`}>{r.stakeholderName}</Link>
              </td>
              <td
                style={{
                  ...cellStyle,
                  color: r.status === "approved" ? theme.success.fg : r.status === "stale" ? theme.warning.fg : theme.inkMuted,
                }}
              >
                {r.status === "approved" ? "Approved" : r.status === "stale" ? "Stale — re-approve" : "Not approved"}
              </td>
              <td style={cellStyle}>{r.approvedAt ?? "—"}</td>
              <td style={cellStyle}>
                {r.totalAmount ?? "—"} <Link href={`/instruments/${r.instrumentId}`}>(view)</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

const cellStyle: React.CSSProperties = { border: `1px solid ${theme.border}`, padding: "0.5rem", textAlign: "left" };
