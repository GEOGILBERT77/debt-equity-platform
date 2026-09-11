"use client";

import { useState } from "react";
import { smallButtonStyle, removeButtonStyle } from "./termsFields/FieldPrimitives";
import { theme } from "@/lib/theme";

export interface WaterfallClassSummary {
  id: string;
  name: string;
  seniorityRank: number;
  shares: string;
  liquidationPreferencePerShare: string;
  participating: boolean;
  participationCap: string | null;
}

interface ScenarioRow {
  id: string;
  label: string;
  exitProceeds: string;
}

interface ClassResult {
  id: string;
  name: string;
  shares: string;
  converted: boolean;
  cappedByParticipation: boolean;
  proceedsFromPreference: string;
  proceedsFromResidual: string;
  totalProceeds: string;
  perShareProceeds: string;
}

interface ScenarioResult {
  label: string;
  exitProceeds: string;
  totalDistributed: string;
  undistributed: string;
  classResults: ClassResult[];
}

let nextId = 1;
function newScenario(label: string, exitProceeds = ""): ScenarioRow {
  return { id: `scenario-${nextId++}`, label, exitProceeds };
}

/**
 * v0.31.0 — client half of the cap-table waterfall report. Unlike
 * ExitWaterfallCalculator.tsx (the pre-existing standalone tool), the class stack
 * itself is NOT editable here: it's this entity's real, stored preferred-stock
 * seniority/preference/participation terms, derived server-side by
 * capTableWaterfall.ts so a caller can't hand-fabricate the stack a real report runs
 * against. What IS editable is the exit-value scenario list — one row is "the current
 * priorities at an assumed exit value," several rows is the scenario-analysis
 * comparison George asked for ("build in a scenario analysis function showing
 * different impacts on waterfall").
 *
 * Both the single-scenario and multi-scenario cases hit the same
 * POST /api/reports/cap-table-waterfall call (it always accepts an array) — see that
 * route's doc comment. The UI just renders one comparison table when there's more than
 * one scenario, since a one-row "comparison" of itself isn't useful.
 */
export default function CapTableWaterfallCalculator({
  entityId,
  classes,
}: {
  entityId: string;
  classes: WaterfallClassSummary[];
}) {
  const [scenarios, setScenarios] = useState<ScenarioRow[]>([newScenario("Current priorities")]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ScenarioResult[] | null>(null);

  function updateScenario(id: string, patch: Partial<ScenarioRow>) {
    setScenarios((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  async function handleRun() {
    setStatus("loading");
    setError(null);
    setResults(null);
    try {
      const res = await fetch("/api/reports/cap-table-waterfall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityId,
          scenarios: scenarios.map((s) => ({ label: s.label, exitProceeds: s.exitProceeds })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setError(data.error ?? "Failed to compute the waterfall");
        return;
      }
      setResults(data.scenarios);
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to compute the waterfall");
    }
  }

  const canRun = scenarios.length > 0 && scenarios.every((s) => s.label.trim() !== "" && s.exitProceeds.trim() !== "");

  return (
    <div>
      <h2>Exit value scenarios</h2>
      <p style={{ color: theme.inkMuted, fontSize: "0.9rem" }}>
        One scenario shows the current priorities at that exit value. Add more to compare how the waterfall shifts
        across different exit outcomes — the class stack (seniority, preference, participation) below is fixed for
        every scenario; only the exit proceeds changes.
      </p>
      <table style={{ borderCollapse: "collapse", width: "100%", margin: "1rem 0" }}>
        <thead>
          <tr>
            <th style={cellStyle}>Scenario label</th>
            <th style={cellStyle}>Exit proceeds ($)</th>
            <th style={cellStyle}></th>
          </tr>
        </thead>
        <tbody>
          {scenarios.map((s) => (
            <tr key={s.id}>
              <td style={cellStyle}>
                <input
                  style={inputStyle}
                  value={s.label}
                  onChange={(e) => updateScenario(s.id, { label: e.target.value })}
                  placeholder="e.g. Base case"
                />
              </td>
              <td style={cellStyle}>
                <input
                  style={inputStyle}
                  value={s.exitProceeds}
                  onChange={(e) => updateScenario(s.id, { exitProceeds: e.target.value })}
                  placeholder="e.g. 50000000"
                />
              </td>
              <td style={cellStyle}>
                {scenarios.length > 1 && (
                  <button type="button" style={removeButtonStyle} onClick={() => setScenarios((prev) => prev.filter((x) => x.id !== s.id))}>
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        style={smallButtonStyle}
        onClick={() => setScenarios((prev) => [...prev, newScenario(`Scenario ${prev.length + 1}`)])}
      >
        + Add scenario
      </button>{" "}
      <button type="button" style={{ ...smallButtonStyle, marginLeft: "1rem" }} onClick={handleRun} disabled={status === "loading" || !canRun}>
        {status === "loading" ? "Computing…" : "Run waterfall"}
      </button>

      {error && <p style={{ color: theme.danger.fg }}>{error}</p>}

      {results && results.length > 1 && (
        <>
          <h2>Scenario comparison</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={cellStyle}>Class</th>
                  {results.map((r) => (
                    <th key={r.label} style={cellStyle}>
                      {r.label}
                      <br />
                      <span style={{ fontWeight: "normal", color: theme.inkMuted }}>(${r.exitProceeds})</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {classes.map((c) => (
                  <tr key={c.id}>
                    <td style={cellStyle}>{c.name}</td>
                    {results.map((r) => {
                      const cr = r.classResults.find((x) => x.id === c.id);
                      return (
                        <td key={r.label} style={cellStyle}>
                          {cr ? cr.totalProceeds : "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr>
                  <td style={{ ...cellStyle, fontWeight: "bold" }}>Total distributed</td>
                  {results.map((r) => (
                    <td key={r.label} style={{ ...cellStyle, fontWeight: "bold" }}>
                      {r.totalDistributed}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      {results &&
        results.map((r) => (
          <div key={r.label} style={{ marginTop: "1.5rem" }}>
            <h2>{results.length > 1 ? `${r.label} — detail` : "Results"}</h2>
            <p style={{ color: theme.inkMuted, fontSize: "0.9rem" }}>Exit proceeds: ${r.exitProceeds}</p>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={cellStyle}>Class</th>
                  <th style={cellStyle}>Converted?</th>
                  <th style={cellStyle}>Capped?</th>
                  <th style={cellStyle}>From preference</th>
                  <th style={cellStyle}>From residual</th>
                  <th style={cellStyle}>Total</th>
                  <th style={cellStyle}>Per share</th>
                </tr>
              </thead>
              <tbody>
                {r.classResults.map((cr) => (
                  <tr key={cr.id}>
                    <td style={cellStyle}>{cr.name}</td>
                    <td style={cellStyle}>{cr.converted ? "Yes" : "No"}</td>
                    <td style={cellStyle}>{cr.cappedByParticipation ? "Yes" : "No"}</td>
                    <td style={cellStyle}>{cr.proceedsFromPreference}</td>
                    <td style={cellStyle}>{cr.proceedsFromResidual}</td>
                    <td style={cellStyle}>{cr.totalProceeds}</td>
                    <td style={cellStyle}>{cr.perShareProceeds}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              Total distributed: {r.totalDistributed}
              {Number(r.undistributed) !== 0 && (
                <span style={{ color: theme.warning.fg }}>
                  {" "}
                  — undistributed (clawed back by a participation cap, not reallocated): {r.undistributed}
                </span>
              )}
            </p>
          </div>
        ))}
    </div>
  );
}

const cellStyle: React.CSSProperties = { border: `1px solid ${theme.border}`, padding: "0.4rem", textAlign: "left" };
const inputStyle: React.CSSProperties = { width: "100%", padding: "0.25rem", fontSize: "0.85rem" };
