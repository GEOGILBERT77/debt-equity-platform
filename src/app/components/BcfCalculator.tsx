"use client";

import { useState } from "react";
import { DecimalField, DateField, SelectField, smallButtonStyle, hintStyle, fieldsetStyle, legendStyle } from "./termsFields/FieldPrimitives";

type Mode = "COMPUTE" | "DEBT_ENTRY" | "PREFERRED_ENTRY";

interface JournalLineResult {
  account: string;
  debit?: string;
  credit?: string;
}
interface EntryResult {
  date: string;
  description: string;
  ascReference?: string;
  lines: JournalLineResult[];
}
interface ComputeResult {
  effectiveConversionPricePerShare: string;
  intrinsicValuePerShare: string;
  beneficialConversionFeatureAmount: string;
  hasBeneficialConversionFeature: boolean;
}

/** Client-side calculator UI for POST /api/reports/beneficial-conversion-feature —
 * see beneficialConversionFeature.ts for the actual ASC 470-20-30 accounting this
 * wraps. Same "collect inputs, render whatever the API returns" pattern as the other
 * calculators here — this component does no accounting itself. */
export default function BcfCalculator() {
  const [mode, setMode] = useState<Mode>("COMPUTE");

  // COMPUTE fields
  const [proceeds, setProceeds] = useState("");
  const [shares, setShares] = useState("");
  const [fmvPerShare, setFmvPerShare] = useState("");

  // DEBT_ENTRY / PREFERRED_ENTRY fields
  const [entryDate, setEntryDate] = useState("");
  const [bcfAmount, setBcfAmount] = useState("");

  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [computeResult, setComputeResult] = useState<ComputeResult | null>(null);
  const [entryResult, setEntryResult] = useState<EntryResult | null>(null);

  async function handleCompute() {
    setStatus("loading");
    setError(null);
    setComputeResult(null);
    setEntryResult(null);

    const body: Record<string, unknown> =
      mode === "COMPUTE"
        ? {
            mode,
            proceedsAllocatedToConvertibleInstrument: proceeds,
            numberOfConversionShares: shares,
            commitmentDateFairValuePerShare: fmvPerShare,
          }
        : { mode, date: entryDate, beneficialConversionFeatureAmount: bcfAmount };

    try {
      const res = await fetch("/api/reports/beneficial-conversion-feature", {
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
      if (mode === "COMPUTE") {
        setComputeResult(data);
      } else {
        setEntryResult(data.entry);
      }
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to compute the result");
    }
  }

  return (
    <div>
      <SelectField
        label="What do you need? (COMPUTE = the BCF amount itself · DEBT_ENTRY = book it as debt discount · PREFERRED_ENTRY = book it as a deemed dividend)"
        value={mode}
        onChange={(v) => {
          setMode(v);
          setComputeResult(null);
          setEntryResult(null);
          setError(null);
        }}
        options={["COMPUTE", "DEBT_ENTRY", "PREFERRED_ENTRY"] as const}
      />

      {mode === "COMPUTE" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>ASC 470-20-30 beneficial conversion feature</legend>
          <DecimalField
            label="Proceeds allocated to the convertible instrument ($)"
            value={proceeds}
            onChange={setProceeds}
          />
          <DecimalField label="Number of shares issuable upon conversion" value={shares} onChange={setShares} />
          <DecimalField
            label="Commitment-date (issuance-date) fair value per share ($)"
            value={fmvPerShare}
            onChange={setFmvPerShare}
          />
          <span style={hintStyle}>
            Proceeds should already exclude any separately-valued component (e.g. a detachable warrant) — see the
            warrant relative-fair-value calculator for that split.
          </span>
        </fieldset>
      )}

      {(mode === "DEBT_ENTRY" || mode === "PREFERRED_ENTRY") && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Book the BCF</legend>
          <DateField label="Date" value={entryDate} onChange={setEntryDate} />
          <DecimalField label="Beneficial conversion feature amount ($)" value={bcfAmount} onChange={setBcfAmount} />
        </fieldset>
      )}

      <button type="button" style={{ ...smallButtonStyle, marginTop: "1rem" }} onClick={handleCompute} disabled={status === "loading"}>
        {status === "loading" ? "Computing…" : "Compute"}
      </button>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {computeResult && (
        <>
          <h2>{computeResult.hasBeneficialConversionFeature ? "Beneficial conversion feature found" : "No beneficial conversion feature"}</h2>
          <p>
            Effective conversion price: <strong>${computeResult.effectiveConversionPricePerShare}</strong>/share · Intrinsic value:{" "}
            <strong>${computeResult.intrinsicValuePerShare}</strong>/share · BCF amount:{" "}
            <strong>${computeResult.beneficialConversionFeatureAmount}</strong>
          </p>
        </>
      )}

      {entryResult && (
        <>
          <h2>Journal entry</h2>
          <p>
            <strong>{entryResult.date}</strong> — {entryResult.description}
            {entryResult.ascReference && <span style={{ color: "#666" }}> ({entryResult.ascReference})</span>}
          </p>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={cellStyle}>Account</th>
                <th style={cellStyle}>Debit</th>
                <th style={cellStyle}>Credit</th>
              </tr>
            </thead>
            <tbody>
              {entryResult.lines.map((l, i) => (
                <tr key={i}>
                  <td style={cellStyle}>{l.account}</td>
                  <td style={cellStyle}>{l.debit ?? ""}</td>
                  <td style={cellStyle}>{l.credit ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

const cellStyle: React.CSSProperties = { border: "1px solid #ccc", padding: "0.4rem" };
