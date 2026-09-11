"use client";

import { useState } from "react";
import WaterfallSensitivityChart, { SensitivityChartPoint, SensitivityChartClass } from "./WaterfallSensitivityChart";
import { theme } from "@/lib/theme";

/**
 * v0.32.0 — "a line graph of payouts by share classes and stakeholders across a range
 * of exit values," Carta's own description of sensitivity analysis. Loads with a
 * server-computed default range (see page.tsx) so it renders immediately, same as
 * WaterfallBreakpoints — the range can be widened or narrowed and re-run against
 * POST /api/reports/cap-table-waterfall's `sensitivity` section.
 */
export default function WaterfallSensitivityAnalysis({
  entityId,
  classes,
  initialPoints,
  initialMin,
  initialMax,
  initialSteps,
}: {
  entityId: string;
  classes: SensitivityChartClass[];
  initialPoints: SensitivityChartPoint[];
  initialMin: string;
  initialMax: string;
  initialSteps: number;
}) {
  const [minInput, setMinInput] = useState(initialMin);
  const [maxInput, setMaxInput] = useState(initialMax);
  const [stepsInput, setStepsInput] = useState(String(initialSteps));
  const [points, setPoints] = useState(initialPoints);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleRun() {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/reports/cap-table-waterfall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityId,
          sensitivity: { min: minInput, max: maxInput, steps: Number(stepsInput) },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setError(data.error ?? "Failed to compute sensitivity analysis");
        return;
      }
      setPoints(data.sensitivity);
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to compute sensitivity analysis");
    }
  }

  return (
    <div>
      <p style={{ color: theme.inkMuted, fontSize: "0.9rem" }}>
        Every class&apos;s total proceeds across a range of exit values, not just a handful of hand-picked scenarios —
        hover the chart for exact figures at any point along the curve.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem", marginBottom: "0.75rem" }}>
        <label>
          Min ($) <input style={inputStyle} value={minInput} onChange={(e) => setMinInput(e.target.value)} />
        </label>
        <label>
          Max ($) <input style={inputStyle} value={maxInput} onChange={(e) => setMaxInput(e.target.value)} />
        </label>
        <label>
          Steps <input style={{ ...inputStyle, width: 60 }} value={stepsInput} onChange={(e) => setStepsInput(e.target.value)} />
        </label>
        <button type="button" onClick={handleRun} disabled={status === "loading"} style={smallButtonStyle}>
          {status === "loading" ? "Computing…" : "Run sensitivity"}
        </button>
      </div>
      {error && <p style={{ color: theme.danger.fg }}>{error}</p>}

      <WaterfallSensitivityChart points={points} classes={classes} />

      <details style={{ marginTop: "0.75rem" }}>
        <summary style={{ cursor: "pointer", fontSize: "0.85rem", color: theme.inkMuted }}>Show exact figures for every point</summary>
        <div style={{ overflowX: "auto", marginTop: "0.5rem" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={cellStyle}>Exit proceeds</th>
                {classes.map((c) => (
                  <th key={c.id} style={cellStyle}>
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={i}>
                  <td style={cellStyle}>${Number(p.exitProceeds).toLocaleString()}</td>
                  {classes.map((c) => (
                    <td key={c.id} style={cellStyle}>
                      ${Number(p.classResults.find((cr) => cr.id === c.id)?.totalProceeds ?? 0).toLocaleString()}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

const cellStyle: React.CSSProperties = { border: `1px solid ${theme.border}`, padding: "0.4rem", textAlign: "left" };
const inputStyle: React.CSSProperties = { padding: "0.25rem", width: 130 };
const smallButtonStyle: React.CSSProperties = {
  padding: "0.25rem 0.6rem",
  border: `1px solid ${theme.border}`,
  borderRadius: 4,
  background: theme.surface,
  cursor: "pointer",
};
