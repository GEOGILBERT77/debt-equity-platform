"use client";

import { useState } from "react";
import { DecimalField, smallButtonStyle, removeButtonStyle } from "./termsFields/FieldPrimitives";

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

      <table style={{ borderCollapse: "collapse", width: "100%", margin: "1rem 0" }}>
        <thead>
          <tr>
            <th style={cellStyle}>Class name</th>
            <th style={cellStyle}>Seniority (lower = paid first)</th>
            <th style={cellStyle}>Shares</th>
            <th style={cellStyle}>Pref/share ($)</th>
            <th style={cellStyle}>Participating?</th>
            <th style={cellStyle}>Cap ($/share, optional)</th>
            <th style={cellStyle}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={cellStyle}>
                <input style={inputStyle} value={r.name} onChange={(e) => updateRow(r.id, { name: e.target.value })} />
              </td>
              <td style={cellStyle}>
                <input style={inputStyle} value={r.seniorityRank} onChange={(e) => updateRow(r.id, { seniorityRank: e.target.value })} />
              </td>
              <td style={cellStyle}>
                <input style={inputStyle} value={r.shares} onChange={(e) => updateRow(r.id, { shares: e.target.value })} />
              </td>
              <td style={cellStyle}>
                <input
                  style={inputStyle}
                  value={r.liquidationPreferencePerShare}
                  onChange={(e) => updateRow(r.id, { liquidationPreferencePerShare: e.target.value })}
                />
              </td>
              <td style={cellStyle}>
                <input type="checkbox" checked={r.participating} onChange={(e) => updateRow(r.id, { participating: e.target.checked })} />
              </td>
              <td style={cellStyle}>
                <input style={inputStyle} value={r.participationCap} onChange={(e) => updateRow(r.id, { participationCap: e.target.value })} />
              </td>
              <td style={cellStyle}>
                <button type="button" style={removeButtonStyle} onClick={() => setRows((prev) => prev.filter((x) => x.id !== r.id))}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {results && (
        <>
          <h2>Results</h2>
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
              {results.classResults.map((r) => (
                <tr key={r.id}>
                  <td style={cellStyle}>{r.name}</td>
                  <td style={cellStyle}>{r.converted ? "Yes" : "No"}</td>
                  <td style={cellStyle}>{r.cappedByParticipation ? "Yes" : "No"}</td>
                  <td style={cellStyle}>{r.proceedsFromPreference}</td>
                  <td style={cellStyle}>{r.proceedsFromResidual}</td>
                  <td style={cellStyle}>{r.totalProceeds}</td>
                  <td style={cellStyle}>{r.perShareProceeds}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Total distributed: {results.totalDistributed}
            {Number(results.undistributed) !== 0 && (
              <span style={{ color: "#92400e" }}> — undistributed (clawed back by a participation cap, not reallocated): {results.undistributed}</span>
            )}
          </p>
        </>
      )}
    </div>
  );
}

const cellStyle: React.CSSProperties = { border: "1px solid #ccc", padding: "0.4rem" };
const inputStyle: React.CSSProperties = { width: "100%", padding: "0.25rem", fontSize: "0.85rem" };
