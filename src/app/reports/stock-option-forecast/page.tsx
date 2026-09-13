import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requirePageEntityAccess, requireCurrentUser, resolveDefaultEntityId } from "@/lib/auth/pageGuard";
import { HypotheticalGrantForecast } from "@/app/components/HypotheticalGrantForecast";
import { ScheduleGridTable } from "@/app/components/ScheduleGridTable";
import { theme } from "@/lib/theme";

/**
 * Stock option expense FORECAST (v0.23.0) — the follow-up request after
 * /reports/stock-option-amortization: "it would be great to have a forecast function
 * for this." Two things live on this page:
 *
 * 1. The REAL forecast — every approved stock option amortization table already
 *    covers the FULL service period (see computeFullSchedule's doc comment in
 *    dispatch.ts), so "what's coming" was already sitting in the data; this page's
 *    job is just to split it at TODAY into what's already been recognized vs. what's
 *    still ahead, and total the "ahead" part into one unrecognized-compensation-cost
 *    figure — the same split every equity comp footnote makes. Reads only APPROVED
 *    schedules, same as the amortization report.
 * 2. A HYPOTHETICAL what-if calculator (HypotheticalGrantForecast.tsx) for planned
 *    future grants that don't exist as real instruments yet — entirely client-side,
 *    never saved, purely additive on top of the real forecast above.
 *
 * If "forecast" meant something more specific (e.g. projecting NEW HIRES/headcount-
 * driven grants automatically from a headcount plan, or a cash-flow forecast rather
 * than an expense forecast), this is the interpretation that was built — say so and
 * this can be adjusted.
 *
 * MONTH BUCKETING: keys `monthlyTotals` by each row's `periodStart`, not `periodEnd`
 * — see /reports/stock-option-amortization's doc comment for why (periods are
 * calendar-month-aligned per computeFullSchedule/buildCalendarMonthlyPeriods, and
 * periodEnd is the EXCLUSIVE boundary into the following month, so keying off it
 * shifts every row's expense — and therefore the recognized-vs-forecasted split
 * below, since that split itself keys off this same month string — one month late).
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function StockOptionForecastPage({ searchParams }: { searchParams: { entityId?: string } }) {
  const entityId = searchParams.entityId;
  if (!entityId) {
    const user = await requireCurrentUser();
    const defaultEntityId = await resolveDefaultEntityId(user);
    if (defaultEntityId) redirect(`/reports/stock-option-forecast?entityId=${defaultEntityId}`);
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
      amortizationApprovals: { orderBy: { approvedAt: "desc" }, take: 1, include: { rows: true } },
    },
  });

  const monthlyTotals = new Map<string, number>();
  for (const inst of instruments) {
    const approval = inst.amortizationApprovals[0];
    if (!approval) continue;
    for (const row of approval.rows) {
      const monthKey = row.periodStart.toISOString().slice(0, 7); // see module doc comment: periodStart, not periodEnd
      const amount = Number(row.amount.toString());
      monthlyTotals.set(monthKey, (monthlyTotals.get(monthKey) ?? 0) + amount);
    }
  }

  const currentMonth = new Date().toISOString().slice(0, 7);
  const sortedMonths = Array.from(monthlyTotals.keys()).sort();
  const monthlyRows = sortedMonths.map((month) => ({ month, amount: monthlyTotals.get(month)!, isFuture: month > currentMonth }));

  const recognizedToDate = monthlyRows.filter((r) => !r.isFuture).reduce((s, r) => s + r.amount, 0);
  const unrecognized = monthlyRows.filter((r) => r.isFuture).reduce((s, r) => s + r.amount, 0);
  const instrumentsMissingApproval = instruments.filter((i) => i.amortizationApprovals.length === 0).length;

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href={`/captable?entityId=${entityId}`}>Cap table</Link> {" · "}
        <Link href={`/reports/stock-option-amortization?entityId=${entityId}`}>Amortization report</Link>
      </p>
      <h1>Stock option forecast</h1>
      <p style={{ color: theme.inkMuted }}>
        Splits every approved stock option amortization table at today's date into what's already been
        recognized vs. what's still ahead. Only approved schedules are included — see the amortization report
        for which instruments still need approval.
      </p>
      {instrumentsMissingApproval > 0 && (
        <p style={{ color: theme.warning.fg }}>
          {instrumentsMissingApproval} stock option(s) have no approved schedule yet and are excluded from this
          forecast.
        </p>
      )}

      <div style={{ display: "flex", gap: "2rem", margin: "1rem 0" }}>
        <div>
          <div style={{ fontSize: "0.8rem", color: theme.inkMuted }}>Recognized to date</div>
          <div style={{ fontSize: "1.5rem", fontWeight: 600, color: theme.success.fg }}>{recognizedToDate.toFixed(2)}</div>
        </div>
        <div>
          <div style={{ fontSize: "0.8rem", color: theme.inkMuted }}>Unrecognized (forecasted remaining)</div>
          <div style={{ fontSize: "1.5rem", fontWeight: 600, color: theme.warning.fg }}>{unrecognized.toFixed(2)}</div>
        </div>
      </div>

      <h2>Monthly forecast (approved grants only)</h2>
      {monthlyRows.length === 0 && <p>No approved stock option amortization schedules yet.</p>}
      {monthlyRows.length > 0 && (
        <div style={{ marginBottom: "1.5rem" }}>
          <ScheduleGridTable
            maxHeight={300}
            columns={[{ label: "Month" }, { label: "Expense", align: "right" }, { label: "Status" }]}
            rows={monthlyRows.map((r) => ({
              key: r.month,
              cells: [r.month, r.amount.toFixed(2), <span style={{ color: theme.inkMuted, fontSize: "0.8rem" }}>{r.isFuture ? "Forecasted" : "Recognized"}</span>],
            }))}
          />
        </div>
      )}

      <h2>What if we grant more?</h2>
      <HypotheticalGrantForecast realMonthly={monthlyRows.map((r) => ({ month: r.month, amount: r.amount }))} />
    </main>
  );
}

const cellStyle: React.CSSProperties = { border: `1px solid ${theme.border}`, padding: "0.5rem", textAlign: "left" };
