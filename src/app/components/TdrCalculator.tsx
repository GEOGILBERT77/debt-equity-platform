"use client";

import { useState } from "react";
import { DecimalField, DateField, TextField, SelectField, smallButtonStyle, hintStyle, fieldsetStyle, legendStyle } from "./termsFields/FieldPrimitives";

type Mode = "TEST" | "GAIN_ENTRY" | "SETTLEMENT_ENTRY";

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

function parseAmountList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Client-side calculator UI for POST /api/reports/troubled-debt-restructuring — see
 * troubledDebtRestructuring.ts for the actual ASC 470-60 accounting this wraps. Same
 * "collect inputs, render whatever the API returns" pattern as the other calculators
 * here. */
export default function TdrCalculator() {
  const [mode, setMode] = useState<Mode>("TEST");

  // TEST fields
  const [carryingValue, setCarryingValue] = useState("");
  const [cashFlowsRaw, setCashFlowsRaw] = useState("");

  // GAIN_ENTRY fields
  const [gainDate, setGainDate] = useState("");
  const [oldCarryingValue, setOldCarryingValue] = useState("");
  const [newCarryingValue, setNewCarryingValue] = useState("");

  // SETTLEMENT_ENTRY fields
  const [settlementDate, setSettlementDate] = useState("");
  const [debtCarryingValue, setDebtCarryingValue] = useState("");
  const [considerationAccountName, setConsiderationAccountName] = useState("");
  const [considerationFairValue, setConsiderationFairValue] = useState("");

  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(null);
  const [entryResult, setEntryResult] = useState<EntryResult | null>(null);

  async function handleCompute() {
    setStatus("loading");
    setError(null);
    setTestResult(null);
    setEntryResult(null);

    const body: Record<string, unknown> =
      mode === "TEST"
        ? { mode, currentCarryingValue: carryingValue, restructuredCashFlows: parseAmountList(cashFlowsRaw) }
        : mode === "GAIN_ENTRY"
          ? { mode, date: gainDate, oldCarryingValue, newCarryingValue }
          : { mode, date: settlementDate, debtCarryingValue, considerationAccountName, considerationFairValue };

    try {
      const res = await fetch("/api/reports/troubled-debt-restructuring", {
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
      if (mode === "TEST") {
        setTestResult(data);
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
        label="What do you need? (TEST = run the undiscounted total-payments test · GAIN_ENTRY = book the immediate gain path · SETTLEMENT_ENTRY = full settlement via asset/equity transfer)"
        value={mode}
        onChange={(v) => {
          setMode(v);
          setTestResult(null);
          setEntryResult(null);
          setError(null);
        }}
        options={["TEST", "GAIN_ENTRY", "SETTLEMENT_ENTRY"] as const}
      />

      {mode === "TEST" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>ASC 470-60-35-5 undiscounted total future cash payments test</legend>
          <DecimalField label="Current carrying value of the debt ($)" value={carryingValue} onChange={setCarryingValue} />
          <TextField
            label="Restructured future cash payments (comma-separated, UNDISCOUNTED)"
            value={cashFlowsRaw}
            onChange={setCashFlowsRaw}
            placeholder="300000, 300000, 300000"
          />
          <span style={hintStyle}>
            Unlike the ASC 470-50 modification test, this comparison is NOT present-valued — see
            troubledDebtRestructuring.ts for why.
          </span>
        </fieldset>
      )}

      {mode === "GAIN_ENTRY" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Immediate gain (total future payments below carrying value)</legend>
          <DateField label="Date" value={gainDate} onChange={setGainDate} />
          <DecimalField label="Old carrying value ($)" value={oldCarryingValue} onChange={setOldCarryingValue} />
          <DecimalField label="New carrying value ($, = total future cash payments)" value={newCarryingValue} onChange={setNewCarryingValue} />
        </fieldset>
      )}

      {mode === "SETTLEMENT_ENTRY" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Full settlement via transfer of assets or equity</legend>
          <DateField label="Date" value={settlementDate} onChange={setSettlementDate} />
          <DecimalField label="Debt carrying value, including accrued interest ($)" value={debtCarryingValue} onChange={setDebtCarryingValue} />
          <TextField
            label='Consideration account name (e.g. "Real Estate, at fair value")'
            value={considerationAccountName}
            onChange={setConsiderationAccountName}
          />
          <DecimalField label="Fair value of consideration transferred ($)" value={considerationFairValue} onChange={setConsiderationFairValue} />
        </fieldset>
      )}

      <button type="button" style={{ ...smallButtonStyle, marginTop: "1rem" }} onClick={handleCompute} disabled={status === "loading"}>
        {status === "loading" ? "Computing…" : "Compute"}
      </button>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {testResult && (
        <>
          <h2>Result: {String(testResult.kind)}</h2>
          {testResult.kind === "GAIN_RECOGNIZED_IMMEDIATELY" ? (
            <p>
              Gain: <strong>${String(testResult.gain)}</strong> · New carrying value: <strong>${String(testResult.newCarryingValue)}</strong> — no
              further interest expense for the life of the restructured debt.
            </p>
          ) : (
            <p>
              New effective annual yield: <strong>{(Number(testResult.newEffectiveAnnualYield) * 100).toFixed(4)}%</strong> — no gain; amortize with
              this rate via the ordinary effective-interest engine.
            </p>
          )}
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
