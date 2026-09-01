"use client";

import { useState } from "react";
import { DecimalField, DateField, SelectField, smallButtonStyle, hintStyle, fieldsetStyle, legendStyle } from "./termsFields/FieldPrimitives";

type Mode = "CASH_EXERCISE" | "NET_SHARE_SETTLEMENT" | "TAX_WITHHOLDING_REMITTANCE";

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

/** Client-side calculator UI for POST /api/reports/settlement — see optionSettlement.ts
 * for the actual accounting and its documented methodology/simplifications. Same
 * "collect inputs, render whatever the API returns" pattern as ExitWaterfallCalculator
 * and TaxCalculators — this component does no accounting itself. */
export default function SettlementCalculator() {
  const [mode, setMode] = useState<Mode>("NET_SHARE_SETTLEMENT");

  // Cash exercise fields
  const [exerciseDate, setExerciseDate] = useState("");
  const [quantityExercised, setQuantityExercised] = useState("");
  const [exercisePricePerUnit, setExercisePricePerUnit] = useState("");
  const [grantDateFairValuePerUnit, setGrantDateFairValuePerUnit] = useState("");

  // Net share settlement fields
  const [settlementDate, setSettlementDate] = useState("");
  const [grossQuantity, setGrossQuantity] = useState("");
  const [netExercisePrice, setNetExercisePrice] = useState("0");
  const [fmvAtSettlement, setFmvAtSettlement] = useState("");
  const [taxWithholdingAmount, setTaxWithholdingAmount] = useState("");

  // Remittance fields
  const [remittanceDate, setRemittanceDate] = useState("");
  const [remittanceAmount, setRemittanceAmount] = useState("");

  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EntryResult | null>(null);

  async function handleCompute() {
    setStatus("loading");
    setError(null);
    setResult(null);

    let body: Record<string, unknown>;
    if (mode === "CASH_EXERCISE") {
      body = { mode, exerciseDate, quantityExercised, exercisePricePerUnit, grantDateFairValuePerUnit };
    } else if (mode === "NET_SHARE_SETTLEMENT") {
      body = {
        mode,
        settlementDate,
        grossQuantity,
        exercisePricePerUnit: netExercisePrice || "0",
        fairMarketValuePerUnitAtSettlement: fmvAtSettlement,
        taxWithholdingAmount: taxWithholdingAmount || undefined,
      };
    } else {
      body = { mode, remittanceDate, amount: remittanceAmount };
    }

    try {
      const res = await fetch("/api/reports/settlement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setError(data.error ?? "Failed to compute the entry");
        return;
      }
      setResult(data.entry);
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to compute the entry");
    }
  }

  return (
    <div>
      <SelectField
        label="What happened? (CASH_EXERCISE = cash-exercised option · NET_SHARE_SETTLEMENT = cashless-net-exercised option or a settling RSU · TAX_WITHHOLDING_REMITTANCE = paying a previously-withheld amount to the taxing authority)"
        value={mode}
        onChange={(v) => {
          setMode(v);
          setResult(null);
          setError(null);
        }}
        options={["CASH_EXERCISE", "NET_SHARE_SETTLEMENT", "TAX_WITHHOLDING_REMITTANCE"] as const}
      />

      {mode === "CASH_EXERCISE" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Cash exercise</legend>
          <DateField label="Exercise date" value={exerciseDate} onChange={setExerciseDate} />
          <DecimalField label="Quantity exercised" value={quantityExercised} onChange={setQuantityExercised} />
          <DecimalField label="Exercise price per share ($)" value={exercisePricePerUnit} onChange={setExercisePricePerUnit} />
          <DecimalField
            label="Grant-date fair value per share already recognized ($)"
            value={grantDateFairValuePerUnit}
            onChange={setGrantDateFairValuePerUnit}
          />
          <span style={hintStyle}>
            Total shares issued = cash paid + this previously-recognized value — see optionSettlement.ts for why.
          </span>
        </fieldset>
      )}

      {mode === "NET_SHARE_SETTLEMENT" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Net (cashless) share settlement</legend>
          <DateField label="Settlement date" value={settlementDate} onChange={setSettlementDate} />
          <DecimalField label="Gross quantity (before any shares withheld)" value={grossQuantity} onChange={setGrossQuantity} />
          <DecimalField
            label="Exercise price per share ($) — leave 0 for an RSU"
            value={netExercisePrice}
            onChange={setNetExercisePrice}
          />
          <DecimalField label="Fair market value per share at settlement ($)" value={fmvAtSettlement} onChange={setFmvAtSettlement} />
          <DecimalField
            label="Total tax withholding obligation ($, optional)"
            value={taxWithholdingAmount}
            onChange={setTaxWithholdingAmount}
          />
          <span style={hintStyle}>
            Shares are withheld to cover the exercise price (options only) and/or the tax withholding amount above; the
            remainder is issued as net shares. The tax-withholding portion books as a liability here — use the remittance
            mode above once it's actually paid.
          </span>
        </fieldset>
      )}

      {mode === "TAX_WITHHOLDING_REMITTANCE" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Tax withholding remittance</legend>
          <DateField label="Remittance date" value={remittanceDate} onChange={setRemittanceDate} />
          <DecimalField label="Amount remitted ($)" value={remittanceAmount} onChange={setRemittanceAmount} />
        </fieldset>
      )}

      <button type="button" style={{ ...smallButtonStyle, marginTop: "1rem" }} onClick={handleCompute} disabled={status === "loading"}>
        {status === "loading" ? "Computing…" : "Compute journal entry"}
      </button>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {result && (
        <>
          <h2>Journal entry</h2>
          <p>
            <strong>{result.date}</strong> — {result.description}
            {result.ascReference && <span style={{ color: "#666" }}> ({result.ascReference})</span>}
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
              {result.lines.map((l, i) => (
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
