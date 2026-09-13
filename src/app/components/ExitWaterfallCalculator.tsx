"use client";

import { useState } from "react";
import { DecimalField, smallButtonStyle, removeButtonStyle } from "./termsFields/FieldPrimitives";
import { theme } from "@/lib/theme";
import { ListingTable } from "./ListingTable";

interface ClassRow {
  id: string;
  name: string;
  seniorityRank: string;
  shares: string;
  liquidationPreferencePerShare: string;
  participating: boolean;
  participationCap: string; // empty string = uncapped
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

let nextId = 1;
function newRow(name: string, rank: string, pref: string): ClassRow {
  return { id: `row-${nextId++}`, name, seniorityRank: rank, shares: "", liquidationPreferencePerShare: pref, participating: false, participationCap: "" };
}

/** Client-side calculator UI for POST /api/reports/exit-waterfall — see that route and
 * exitWaterfall.ts for the actual math and its documented methodology/simplifications.
 * This component itself does no accounting; it only collects the class-stack inputs
 * and renders whatever the API returns. */
export default function ExitWaterfallCalculator() {
  const [exitProceeds, setExitProceeds] = useState("");
  const [rows, setRows] = useState<ClassRow[]>([newRow("Common", "99", "0"), newRow("Series A", "1", "1")]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<{ classResults: ClassResult[]; totalDistributed: string; undistributed: string } | null>(null);

  function updateRow(id: string, patch: Partial<ClassRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function handleCompute() {
    setStatus("loading");
    setError(null);
    setResults(null);
    try {
      const res = await fetch("/api/reports/exit-waterfall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exitProceeds,
          classes: rows.map((r) => ({
            id: r.id,
            name: r.name,
            seniorityRank: Number(r.seniorityRank),
            shares: r.shares,
            liquidationPreferencePerShare: r.liquidationPreferencePerShare,
            participating: r.participating,
            participationCap: r.participationCap === "" ? undefined : r.participationCap,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setError(data.error ?? "Failed to compute the waterfall");
        return;
      }
      setResults(data);
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to compute the waterfall");
    }
  }

  return (
    <div>
      <DecimalField label="Exit proceeds ($)" value={exitProceeds} onChange={setExitProceeds} placeholder="e.g. 50000000" />

      <div style={{ margin: "1rem 0" }}>
        <ListingTable
          columns={[
            { label: "Class name" },
            { label: "Seniority (lower = paid first)" },
            { label: "Shares" },
            { label: "Pref/share ($)" },
            { label: "Participating?" },
            { label: "Cap ($/share, optional)" },
            { label: "" },
          ]}
          rows={rows.map((r) => ({
            key: r.id,
            cells: [
              <input style={inputStyle} value={r.name} onChange={(e) => updateRow(r.id, { name: e.target.value })} />,
              <input style={inputStyle} value={r.seniorityRank} onChange={(e) => updateRow(r.id, { seniorityRank: e.target.value })} />,
              <input style={inputStyle} value={r.shares} onChange={(e) => updateRow(r.id, { shares: e.target.value })} />,
              <input
                style={inputStyle}
                value={r.liquidationPreferencePerShare}
                onChange={(e) => updateRow(r.id, { liquidationPreferencePerShare: e.target.value })}
              />,
              <input type="checkbox" checked={r.participating} onChange={(e) => updateRow(r.id, { participating: e.target.checked })} />,
              <input style={inputStyle} value={r.participationCap} onChange={(e) => updateRow(r.id, { participationCap: e.target.value })} />,
              <button type="button" style={removeButtonStyle} onClick={() => setRows((prev) => prev.filter((x) => x.id !== r.id))}>
                Remove
              </button>,
            ],
          }))}
        />
      </div>
      <button type="button" style={smallButtonStyle} onClick={() => setRows((prev) => [...prev, newRow("New class", "1", "1")])}>
        + Add class
      </button>{" "}
      <button
        type="button"
        style={{ ...smallButtonStyle, marginLeft: "1rem" }}
        onClick={handleCompute}
        disabled={status === "loading" || !exitProceeds}
      >
        {status === "loading" ? "Computing…" : "Compute waterfall"}
      </button>

      {error && <p style={{ color: theme.danger.fg }}>{error}</p>}

      {results && (
        <>
          <h2>Results</h2>
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
            rows={results.classResults.map((r) => ({
              key: r.id,
              cells: [
                r.name,
                r.converted ? "Yes" : "No",
                r.cappedByParticipation ? "Yes" : "No",
                r.proceedsFromPreference,
                r.proceedsFromResidual,
                r.totalProceeds,
                r.perShareProceeds,
              ],
            }))}
          />
          <p>
            Total distributed: {results.totalDistributed}
            {Number(results.undistributed) !== 0 && (
              <span style={{ color: theme.warning.fg }}> — undistributed (clawed back by a participation cap, not reallocated): {results.undistributed}</span>
            )}
          </p>
        </>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = { width: "100%", padding: "0.25rem", fontSize: "0.85rem" };
