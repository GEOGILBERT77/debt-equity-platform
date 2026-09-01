"use client";

import { useState } from "react";
import { DecimalField, SelectField, smallButtonStyle, hintStyle, fieldsetStyle, legendStyle } from "./termsFields/FieldPrimitives";

type Mode = "BASIC" | "DILUTED";

/** Client-side calculator UI for POST /api/reports/eps — see epsTwoClass.ts for the
 * actual ASC 260-10-45 two-class method this wraps. Same "collect inputs, render
 * whatever the API returns" pattern as the other calculators here. */
export default function EpsCalculator() {
  const [mode, setMode] = useState<Mode>("DILUTED");

  const [netIncomeOrLoss, setNetIncomeOrLoss] = useState("");
  const [divCommon, setDivCommon] = useState("0");
  const [divParticipating, setDivParticipating] = useState("0");
  const [commonShares, setCommonShares] = useState("");
  const [participatingShares, setParticipatingShares] = useState("");

  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  async function handleCompute() {
    setStatus("loading");
    setError(null);
    setResult(null);

    const body = {
      mode,
      netIncomeOrLoss,
      dividendsDeclaredToCommon: divCommon || "0",
      dividendsDeclaredToParticipatingClass: divParticipating || "0",
      weightedAverageCommonShares: commonShares,
      participatingClassAsConvertedShares: participatingShares,
    };

    try {
      const res = await fetch("/api/reports/eps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setError(data.error ?? "Failed to compute EPS");
        return;
      }
      setResult(data);
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to compute EPS");
    }
  }

  return (
    <div>
      <SelectField
        label="What do you need? (BASIC = two-class basic EPS only · DILUTED = also runs the if-converted comparison)"
        value={mode}
        onChange={(v) => {
          setMode(v);
          setResult(null);
          setError(null);
        }}
        options={["BASIC", "DILUTED"] as const}
      />

      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>ASC 260-10-45 two-class method</legend>
        <DecimalField label="Net income (negative for a net loss)" value={netIncomeOrLoss} onChange={setNetIncomeOrLoss} />
        <DecimalField label="Dividends declared to common ($)" value={divCommon} onChange={setDivCommon} />
        <DecimalField
          label="Dividends declared to the participating class ($) — for a cumulative preferred, use the period's accrued amount, not just what was paid"
          value={divParticipating}
          onChange={setDivParticipating}
        />
        <DecimalField label="Weighted-average common shares outstanding" value={commonShares} onChange={setCommonShares} />
        <DecimalField
          label="Participating class shares, on an as-converted-to-common basis"
          value={participatingShares}
          onChange={setParticipatingShares}
        />
        <span style={hintStyle}>
          Assumes exactly one participating class, sharing in undistributed earnings pro-rata by as-converted shares —
          see epsTwoClass.ts for the full scope note (multiple classes, non-parity participation rates, and full
          dilution sequencing across several securities are all out of scope).
        </span>
      </fieldset>

      <button type="button" style={{ ...smallButtonStyle, marginTop: "1rem" }} onClick={handleCompute} disabled={status === "loading"}>
        {status === "loading" ? "Computing…" : "Compute"}
      </button>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {result && (
        <>
          <h2>Results</h2>
          <p>
            Basic EPS, common: <strong>${String(result.basicEpsCommon)}</strong> · Basic EPS, participating class:{" "}
            <strong>${String(result.basicEpsParticipatingClass)}</strong>
            {result.lossOrInsufficientEarnings ? " — net loss or insufficient earnings: nothing allocated to the participating class." : ""}
          </p>
          {mode === "DILUTED" && (
            <p>
              Diluted EPS: <strong>${String(result.dilutedEpsCommon)}</strong> (method: {String(result.dilutedMethod)})
            </p>
          )}
        </>
      )}
    </div>
  );
}
