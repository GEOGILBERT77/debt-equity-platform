"use client";

import { useState } from "react";
import { DecimalField, SelectField, smallButtonStyle, removeButtonStyle, hintStyle, fieldsetStyle, legendStyle } from "./termsFields/FieldPrimitives";

type Mode = "ROLLFORWARD" | "INTRINSIC_VALUE";

interface ExerciseRow {
  id: string;
  quantity: string;
  exercisePricePerUnit: string;
  fairMarketValuePerUnitAtExercise: string;
}

let nextId = 1;
const newExerciseRow = (): ExerciseRow => ({ id: `ex-${nextId++}`, quantity: "", exercisePricePerUnit: "", fairMarketValuePerUnitAtExercise: "" });

/** Client-side calculator UI for POST /api/reports/equity-comp-disclosures — see
 * reporting.ts's `buildAwardActivityRollforward`/`computeIntrinsicValueRealized` for
 * the actual ASC 718-10-50 aggregation this wraps (two pieces of the pinned "additional
 * ASC 718 footnote disclosures" gap; unrecognized cost is already covered by the
 * financial-statements report's existing `buildStockCompDisclosure`, and cash/tax
 * effects by that report's `buildSettlementActivityDisclosure` — not duplicated here).
 * Same "collect inputs, render whatever the API returns" pattern as the other
 * calculators. The ROLLFORWARD mode collects one aggregate quantity per event type
 * (granted, exercised, forfeited, expired) rather than an itemized event list — the
 * underlying function sums a list of events by type, and a single event per type IS a
 * valid way to call it when only period totals are on hand, which is the common case
 * for a quick disclosure check. */
export default function EquityCompDisclosuresCalculator() {
  const [mode, setMode] = useState<Mode>("ROLLFORWARD");

  // ROLLFORWARD fields
  const [outstandingAtStart, setOutstandingAtStart] = useState("");
  const [granted, setGranted] = useState("");
  const [exercisedOrSettled, setExercisedOrSettled] = useState("");
  const [forfeited, setForfeited] = useState("");
  const [expired, setExpired] = useState("");
  const [waepAtStart, setWaepAtStart] = useState("");
  const [waepGranted, setWaepGranted] = useState("");
  const [waepExercised, setWaepExercised] = useState("");

  // INTRINSIC_VALUE fields
  const [exerciseRows, setExerciseRows] = useState<ExerciseRow[]>([newExerciseRow()]);

  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  function updateExerciseRow(id: string, patch: Partial<ExerciseRow>) {
    setExerciseRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function handleCompute() {
    setStatus("loading");
    setError(null);
    setResult(null);

    const trackWaep = waepAtStart !== "";
    const body: Record<string, unknown> =
      mode === "ROLLFORWARD"
        ? {
            mode,
            outstandingAtStart,
            weightedAverageExercisePriceAtStart: trackWaep ? waepAtStart : undefined,
            events: [
              { type: "GRANTED", quantity: granted || "0", weightedAverageExercisePrice: trackWaep ? waepGranted || "0" : undefined },
              {
                type: "EXERCISED_OR_SETTLED",
                quantity: exercisedOrSettled || "0",
                weightedAverageExercisePrice: trackWaep ? waepExercised || "0" : undefined,
              },
              { type: "FORFEITED", quantity: forfeited || "0" },
              { type: "EXPIRED", quantity: expired || "0" },
            ],
          }
        : { mode, events: exerciseRows.map(({ id, ...rest }) => rest) };

    try {
      const res = await fetch("/api/reports/equity-comp-disclosures", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setError(data.error ?? "Failed to compute the result");
        return;
      }
      setResult(data);
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to compute the result");
    }
  }

  return (
    <div>
      <SelectField
        label="What do you need? (ROLLFORWARD = award activity by count · INTRINSIC_VALUE = intrinsic value realized across exercises)"
        value={mode}
        onChange={(v) => {
          setMode(v);
          setResult(null);
          setError(null);
        }}
        options={["ROLLFORWARD", "INTRINSIC_VALUE"] as const}
      />

      {mode === "ROLLFORWARD" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Award activity rollforward by count</legend>
          <DecimalField label="Outstanding at period start (shares/units)" value={outstandingAtStart} onChange={setOutstandingAtStart} />
          <DecimalField label="Granted during the period" value={granted} onChange={setGranted} />
          <DecimalField label="Exercised or settled during the period" value={exercisedOrSettled} onChange={setExercisedOrSettled} />
          <DecimalField label="Forfeited during the period" value={forfeited} onChange={setForfeited} />
          <DecimalField label="Expired during the period" value={expired} onChange={setExpired} />
          <span style={hintStyle}>Optionally track weighted-average exercise price (leave blank to skip):</span>
          <DecimalField label="WAEP at period start ($)" value={waepAtStart} onChange={setWaepAtStart} />
          {waepAtStart !== "" && (
            <>
              <DecimalField label="WAEP of shares granted ($)" value={waepGranted} onChange={setWaepGranted} />
              <DecimalField label="WAEP of shares exercised/settled ($)" value={waepExercised} onChange={setWaepExercised} />
            </>
          )}
        </fieldset>
      )}

      {mode === "INTRINSIC_VALUE" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Intrinsic value realized across a batch of exercises</legend>
          <table style={{ borderCollapse: "collapse", width: "100%", margin: "1rem 0" }}>
            <thead>
              <tr>
                <th style={cellStyle}>Quantity</th>
                <th style={cellStyle}>Exercise price/unit ($, 0 for an RSU)</th>
                <th style={cellStyle}>FMV/unit at exercise ($)</th>
                <th style={cellStyle}></th>
              </tr>
            </thead>
            <tbody>
              {exerciseRows.map((r) => (
                <tr key={r.id}>
                  <td style={cellStyle}>
                    <input style={inputStyle} value={r.quantity} onChange={(e) => updateExerciseRow(r.id, { quantity: e.target.value })} />
                  </td>
                  <td style={cellStyle}>
                    <input
                      style={inputStyle}
                      value={r.exercisePricePerUnit}
                      onChange={(e) => updateExerciseRow(r.id, { exercisePricePerUnit: e.target.value })}
                    />
                  </td>
                  <td style={cellStyle}>
                    <input
                      style={inputStyle}
                      value={r.fairMarketValuePerUnitAtExercise}
                      onChange={(e) => updateExerciseRow(r.id, { fairMarketValuePerUnitAtExercise: e.target.value })}
                    />
                  </td>
                  <td style={cellStyle}>
                    <button type="button" style={removeButtonStyle} onClick={() => setExerciseRows((prev) => prev.filter((x) => x.id !== r.id))}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" style={smallButtonStyle} onClick={() => setExerciseRows((prev) => [...prev, newExerciseRow()])}>
            + Add exercise event
          </button>
          <span style={hintStyle}>
            For cash received and tax withholding effects from the same events, see the financial statements
            report's settlement activity disclosure instead — not duplicated here.
          </span>
        </fieldset>
      )}

      <button type="button" style={{ ...smallButtonStyle, marginTop: "1rem" }} onClick={handleCompute} disabled={status === "loading"}>
        {status === "loading" ? "Computing…" : "Compute"}
      </button>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {result && mode === "ROLLFORWARD" && (
        <>
          <h2>Result</h2>
          <p>
            Outstanding at start: <strong>{String(result.outstandingAtStart)}</strong> · Granted: {String(result.granted)} · Exercised/settled:{" "}
            {String(result.exercisedOrSettled)} · Forfeited/expired: {String(result.forfeitedOrExpired)} · Outstanding at end:{" "}
            <strong>{String(result.outstandingAtEnd)}</strong>
          </p>
          {result.weightedAverageExercisePriceAtEnd !== undefined && (
            <p>
              WAEP at start: ${String(result.weightedAverageExercisePriceAtStart)} · WAEP at end: $
              <strong>{String(result.weightedAverageExercisePriceAtEnd)}</strong>
            </p>
          )}
        </>
      )}

      {result && mode === "INTRINSIC_VALUE" && (
        <>
          <h2>Result</h2>
          <p>
            Total intrinsic value realized: <strong>${String(result.totalIntrinsicValueRealized)}</strong>
          </p>
        </>
      )}
    </div>
  );
}

const cellStyle: React.CSSProperties = { border: "1px solid #ccc", padding: "0.4rem" };
const inputStyle: React.CSSProperties = { width: "100%", padding: "0.3rem" };
