"use client";

import { useMemo, useState } from "react";
import { generateStandardMonthlyTranches, buildServiceConditionSchedule } from "@/lib/accounting/vesting";
import { buildCalendarMonthlyPeriods } from "@/lib/accounting/dateMath";
import { theme } from "@/lib/theme";

/**
 * "What if we granted more options" — a hypothetical, NEVER-SAVED addition to the
 * real forecast on this report page (see reports/stock-option-forecast/page.tsx).
 * Runs the exact same engine functions (generateStandardMonthlyTranches,
 * buildServiceConditionSchedule) real grants use, entirely in the browser — nothing
 * here is persisted or sent to the server, this is purely a planning aid layered on
 * top of the real, approved-schedule-derived forecast passed in via `realMonthly`.
 *
 * SINGLE HYPOTHETICAL GRANT SHAPE (multiplied by a grantee count) — for modeling "we
 * plan to hire N more people at roughly this grant size," not for entering several
 * different hypothetical grant sizes at once. Good enough for a rough forecast; a
 * real what-if planner with per-grantee variation would be a natural extension.
 *
 * CALENDAR-ALIGNED PERIODS, matching the real forecast: uses
 * `buildCalendarMonthlyPeriods` (dateMath.ts) — the same period builder
 * `computeFullSchedule` uses for real grants — not the grant-date-anchored
 * `buildMonthlyPeriods`. Necessary, not cosmetic: `combined` below merges this
 * hypothetical schedule into `realMonthly` by matching "YYYY-MM" keys, so the two
 * need to mean the same thing by "month." Bucketed by `periodStart`, not
 * `periodEnd`, for the same reason the real forecast page is: periodEnd is the
 * exclusive boundary into the FOLLOWING month once periods are calendar-aligned.
 */
export function HypotheticalGrantForecast({ realMonthly }: { realMonthly: { month: string; amount: number }[] }) {
  const [grantCount, setGrantCount] = useState(1);
  const [quantity, setQuantity] = useState(10000);
  const [fairValue, setFairValue] = useState(2.5);
  const [grantDate, setGrantDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [vestingMonths, setVestingMonths] = useState(48);
  const [cliffMonths, setCliffMonths] = useState(12);

  // Computed (not stored in state) so there's never a setState call during render —
  // both the result and any error are derived together from the current inputs.
  const { hypotheticalMonthly, error } = useMemo(() => {
    if (grantCount <= 0 || quantity <= 0 || fairValue <= 0 || vestingMonths <= 0) {
      return { hypotheticalMonthly: [] as { month: string; amount: number }[], error: null as string | null };
    }
    try {
      const tranches = generateStandardMonthlyTranches({ grantDate, quantity, vestingMonths, cliffMonths });
      const vestEnd = tranches[tranches.length - 1].vestDate;
      const periods = buildCalendarMonthlyPeriods(grantDate, vestEnd);
      const schedule = buildServiceConditionSchedule(
        { grantDate, quantity, grantDateFairValuePerUnit: fairValue, tranches, attributionMethod: "straight-line" },
        periods
      );
      const monthly = schedule.map((row) => ({ month: row.periodStart.slice(0, 7), amount: Number(row.amount.toString()) * grantCount }));
      return { hypotheticalMonthly: monthly, error: null as string | null };
    } catch (err) {
      return { hypotheticalMonthly: [] as { month: string; amount: number }[], error: err instanceof Error ? err.message : "Failed to compute the hypothetical schedule" };
    }
  }, [grantCount, quantity, fairValue, grantDate, vestingMonths, cliffMonths]);

  const combined = useMemo(() => {
    const map = new Map<string, { real: number; hypothetical: number }>();
    for (const r of realMonthly) map.set(r.month, { real: r.amount, hypothetical: 0 });
    for (const h of hypotheticalMonthly) {
      const existing = map.get(h.month) ?? { real: 0, hypothetical: 0 };
      existing.hypothetical += h.amount;
      map.set(h.month, existing);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([month, v]) => ({ month, ...v, total: v.real + v.hypothetical }));
  }, [realMonthly, hypotheticalMonthly]);

  return (
    <div>
      <p style={{ color: theme.inkMuted }}>
        Model a planned future grant — never saved, purely additive to the real forecast above. Enter one
        representative grant size and how many grantees you expect to give it to.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", marginBottom: "1rem" }}>
        <label style={labelStyle}>
          Number of grantees
          <input type="number" min={1} value={grantCount} onChange={(e) => setGrantCount(Number(e.target.value))} style={inputStyle} />
        </label>
        <label style={labelStyle}>
          Quantity per grantee
          <input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} style={inputStyle} />
        </label>
        <label style={labelStyle}>
          Fair value per share
          <input type="number" min={0.01} step={0.01} value={fairValue} onChange={(e) => setFairValue(Number(e.target.value))} style={inputStyle} />
        </label>
        <label style={labelStyle}>
          Grant date
          <input type="date" value={grantDate} onChange={(e) => setGrantDate(e.target.value)} style={inputStyle} />
        </label>
        <label style={labelStyle}>
          Vesting months
          <input type="number" min={1} value={vestingMonths} onChange={(e) => setVestingMonths(Number(e.target.value))} style={inputStyle} />
        </label>
        <label style={labelStyle}>
          Cliff months
          <input type="number" min={0} value={cliffMonths} onChange={(e) => setCliffMonths(Number(e.target.value))} style={inputStyle} />
        </label>
      </div>
      {error && <p style={{ color: theme.danger.fg }}>{error}</p>}
      {combined.length > 0 && (
        <div style={{ maxHeight: 400, overflowY: "auto", border: `1px solid ${theme.border}` }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={cellStyle}>Month</th>
                <th style={cellStyle}>Approved (real)</th>
                <th style={cellStyle}>+ Hypothetical</th>
                <th style={cellStyle}>Combined total</th>
              </tr>
            </thead>
            <tbody>
              {combined.map((r) => (
                <tr key={r.month}>
                  <td style={cellStyle}>{r.month}</td>
                  <td style={cellStyle}>{r.real.toFixed(2)}</td>
                  <td style={cellStyle}>{r.hypothetical.toFixed(2)}</td>
                  <td style={{ ...cellStyle, fontWeight: 600 }}>{r.total.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", fontSize: "0.85rem", gap: "0.25rem" };
const inputStyle: React.CSSProperties = { padding: "0.35rem", width: "9rem" };
const cellStyle: React.CSSProperties = { border: `1px solid ${theme.border}`, padding: "0.5rem", textAlign: "left" };
