"use client";

import { useState } from "react";
import { theme } from "@/lib/theme";

export interface BreakpointsClassSummary {
  id: string;
  name: string;
  participating: boolean;
  hasParticipationCap: boolean;
}

interface ClassBreakpointsRow {
  id: string;
  name: string;
  breakevenExitProceeds: string | null;
  conversionBreakpointExitProceeds: string | null;
  participationCapBreakpointExitProceeds: string | null;
}

function fmt(v: string | null): string {
  if (v === null) return "—";
  const n = Number(v);
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/**
 * v0.32.0 — "what exit valuation would this class need to participate in payouts,"
 * Carta's own framing of breakpoint analysis. Computed by `findWaterfallBreakpoints`
 * (bisection against the real `buildExitWaterfall`, never a separately-derived
 * formula — see waterfallAnalysis.ts) and shown automatically on page load with a
 * server-computed default search ceiling, the same "no user input required, since your
 * cap table is already here" posture Carta's own automatic breakpoint view takes. The
 * ceiling can be raised if a class's breakpoint doesn't occur within the default range
 * (shown as "—" rather than a guess).
 */
export default function WaterfallBreakpoints({
  entityId,
  classes,
  initialBreakpoints,
  initialMax,
}: {
  entityId: string;
  classes: BreakpointsClassSummary[];
  initialBreakpoints: ClassBreakpointsRow[];
  initialMax: string;
}) {
  const [maxInput, setMaxInput] = useState(initialMax);
  const [breakpoints, setBreakpoints] = useState(initialBreakpoints);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const showConversionCol = classes.some((c) => !c.participating);
  const showCapCol = classes.some((c) => c.participating && c.hasParticipationCap);

  async function handleRecompute() {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/reports/cap-table-waterfall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId, breakpointsMax: maxInput }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setError(data.error ?? "Failed to compute breakpoints");
        return;
      }
      setBreakpoints(data.breakpoints);
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to compute breakpoints");
    }
  }

  return (
    <div>
      <p style={{ color: theme.inkMuted, fontSize: "0.9rem" }}>
        The exit value each class needs to reach before it sees any money at all, and — where it applies — the exit
        value at which a non-participating class flips from taking its stated preference to converting to common, or
        a participation cap kicks in. A blank cell means that transition doesn't occur below the search ceiling.
      </p>
      <table style={{ borderCollapse: "collapse", width: "100%", margin: "0.75rem 0" }}>
        <thead>
          <tr>
            <th style={cellStyle}>Class</th>
            <th style={cellStyle}>Breakeven (starts receiving proceeds)</th>
            {showConversionCol && <th style={cellStyle}>Converts to common above</th>}
            {showCapCol && <th style={cellStyle}>Participation cap binds above</th>}
          </tr>
        </thead>
        <tbody>
          {breakpoints.map((b) => (
            <tr key={b.id}>
              <td style={cellStyle}>{b.name}</td>
              <td style={cellStyle}>{fmt(b.breakevenExitProceeds)}</td>
              {showConversionCol && <td style={cellStyle}>{fmt(b.conversionBreakpointExitProceeds)}</td>}
              {showCapCol && <td style={cellStyle}>{fmt(b.participationCapBreakpointExitProceeds)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}>
        <label>
          Search ceiling ($){" "}
          <input
            style={{ padding: "0.25rem", width: 160 }}
            value={maxInput}
            onChange={(e) => setMaxInput(e.target.value)}
            placeholder="e.g. 500000000"
          />
        </label>
        <button type="button" onClick={handleRecompute} disabled={status === "loading" || !maxInput.trim()} style={smallButtonStyle}>
          {status === "loading" ? "Computing…" : "Recompute"}
        </button>
      </div>
      {error && <p style={{ color: theme.danger.fg }}>{error}</p>}
    </div>
  );
}

const cellStyle: React.CSSProperties = { border: `1px solid ${theme.border}`, padding: "0.4rem", textAlign: "left" };
const smallButtonStyle: React.CSSProperties = {
  padding: "0.25rem 0.6rem",
  border: `1px solid ${theme.border}`,
  borderRadius: 4,
  background: theme.surface,
  cursor: "pointer",
};
