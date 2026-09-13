"use client";

import { useState } from "react";
import { smallButtonStyle, removeButtonStyle } from "./termsFields/FieldPrimitives";
import { theme } from "@/lib/theme";
import { ListingTable } from "./ListingTable";

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
      <div style={{ margin: "1rem 0" }}>
        <ListingTable
          columns={[{ label: "Scenario label" }, { label: "Exit proceeds ($)" }, { label: "" }]}
          rows={scenarios.map((s) => ({
            key: s.id,
            cells: [
              <input
                style={inputStyle}
                value={s.label}
                onChange={(e) => updateScenario(s.id, { label: e.target.value })}
                placeholder="e.g. Base case"
              />,
              <input
                style={inputStyle}
                value={s.exitProceeds}
                onChange={(e) => updateScenario(s.id, { exitProceeds: e.target.value })}
                placeholder="e.g. 50000000"
              />,
              scenarios.length > 1 && (
                <button type="button" style={removeButtonStyle} onClick={() => setScenarios((prev) => prev.filter((x) => x.id !== s.id))}>
                  Remove
                </button>
              ),
            ],
          }))}
        />
      </div>
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
          <ListingTable
            columns={[
              { label: "Class" },
              ...results.map((r) => ({
                label: (
                  <>
                    {r.label}
                    <br />
                    <span style={{ fontWeight: "normal", color: theme.inkMuted, textTransform: "none" as const }}>(${r.exitProceeds})</span>
                  </>
                ),
                align: "right" as const,
              })),
            ]}
            rows={[
              ...classes.map((c) => ({
                key: c.id,
                cells: [
                  c.name,
                  ...results.map((r) => {
                    const cr = r.classResults.find((x) => x.id === c.id);
                    return cr ? cr.totalProceeds : "—";
                  }),
                ],
              })),
              {
                key: "total",
                highlight: true,
                cells: ["Total distributed", ...results.map((r) => r.totalDistributed)],
              },
            ]}
          />
        </>
      )}

      {results &&
        results.map((r) => (
          <div key={r.label} style={{ marginTop: "1.5rem" }}>
            <h2>{results.length > 1 ? `${r.label} — detail` : "Results"}</h2>
            <p style={{ color: theme.inkMuted, fontSize: "0.9rem" }}>Exit proceeds: ${r.exitProceeds}</p>
            <ListingTable
              columns={[
                { label: "Class" },
                { label: "Converted?" },
                { label: "Capped?" },
                { label: "From preference", align: "right" },
                { label: "From residual", align: "right" },
                { label: "Total", align: "right" },
                { label: "Per share", align: "right" },
              ]}
              rows={r.classResults.map((cr) => ({
                key: cr.id,
                cells: [
                  cr.name,
                  cr.converted ? "Yes" : "No",
                  cr.cappedByParticipation ? "Yes" : "No",
                  cr.proceedsFromPreference,
                  cr.proceedsFromResidual,
                  cr.totalProceeds,
                  cr.perShareProceeds,
                ],
              }))}
            />
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

const inputStyle: React.CSSProperties = { width: "100%", padding: "0.25rem", fontSize: "0.85rem" };
