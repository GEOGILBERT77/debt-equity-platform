"use client";

import { useState } from "react";
import { DecimalField, DateField, TextField, SelectField, smallButtonStyle, hintStyle, fieldsetStyle, legendStyle } from "./termsFields/FieldPrimitives";

type Mode = "TEST" | "EXTINGUISHMENT_ENTRY" | "MODIFICATION_LENDER_FEE_ENTRY" | "THIRD_PARTY_COST_ENTRY";

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
interface TestResult {
  presentValueOriginal: string;
  presentValueNew: string;
  percentDifference: string;
  threshold: string;
  classification: "EXTINGUISHMENT" | "MODIFICATION";
}

/** Parses "1:100, 2:1100" into [{period:1, amount:"100"}, {period:2, amount:"1100"}] —
 * a plain comma-separated "period:amount" list rather than dynamic add/remove rows, to
 * keep this calculator's UI as simple as ExitWaterfallCalculator's/TaxCalculators' own
 * plain-field inputs. Throws with a specific message on malformed input rather than
 * silently dropping a bad entry. */
function parseCashFlows(raw: string): { period: number; amount: string }[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  return trimmed.split(",").map((chunk, i) => {
    const parts = chunk.trim().split(":");
    if (parts.length !== 2) {
      throw new Error(`Cash flow entry ${i + 1} ("${chunk.trim()}") must be "period:amount", e.g. "1:1100".`);
    }
    const period = Number(parts[0].trim());
    if (!Number.isInteger(period) || period < 1) {
      throw new Error(`Cash flow entry ${i + 1}: period must be a positive whole number (got "${parts[0].trim()}").`);
    }
    return { period, amount: parts[1].trim() };
  });
}

/** Client-side calculator UI for POST /api/reports/debt-modification — see
 * debtModification.ts for the actual ASC 470-50 accounting this wraps. Same "collect
 * inputs, render whatever the API returns" pattern as SettlementCalculator and
 * ExitWaterfallCalculator — this component does no accounting itself. */
export default function DebtModificationCalculator() {
  const [mode, setMode] = useState<Mode>("TEST");

  // TEST fields
  const [originalCashFlowsRaw, setOriginalCashFlowsRaw] = useState("");
  const [newCashFlowsRaw, setNewCashFlowsRaw] = useState("");
  const [ratePerPeriod, setRatePerPeriod] = useState("");

  // EXTINGUISHMENT_ENTRY fields
  const [extDate, setExtDate] = useState("");
  const [oldDebtCarryingValue, setOldDebtCarryingValue] = useState("");
  const [newDebtFairValue, setNewDebtFairValue] = useState("");
  const [extLenderFeesPaid, setExtLenderFeesPaid] = useState("");

  // MODIFICATION_LENDER_FEE_ENTRY fields
  const [modDate, setModDate] = useState("");
  const [modLenderFeesPaid, setModLenderFeesPaid] = useState("");

  // THIRD_PARTY_COST_ENTRY fields
  const [costDate, setCostDate] = useState("");
  const [costAmount, setCostAmount] = useState("");

  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [entryResult, setEntryResult] = useState<EntryResult | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [gainOrLoss, setGainOrLoss] = useState<string | null>(null);

  async function handleCompute() {
    setStatus("loading");
    setError(null);
    setEntryResult(null);
    setTestResult(null);
    setGainOrLoss(null);

    let body: Record<string, unknown>;
    try {
      if (mode === "TEST") {
        body = {
          mode,
          originalCashFlows: parseCashFlows(originalCashFlowsRaw),
          newCashFlows: parseCashFlows(newCashFlowsRaw),
          originalEffectiveRatePerPeriod: ratePerPeriod,
        };
      } else if (mode === "EXTINGUISHMENT_ENTRY") {
        body = {
          mode,
          date: extDate,
          oldDebtCarryingValue,
          newDebtFairValue,
          lenderFeesPaid: extLenderFeesPaid || undefined,
        };
      } else if (mode === "MODIFICATION_LENDER_FEE_ENTRY") {
        body = { mode, date: modDate, lenderFeesPaid: modLenderFeesPaid };
      } else {
        body = { mode, date: costDate, amount: costAmount };
      }
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Could not parse the cash flows entered above.");
      return;
    }

    try {
      const res = await fetch("/api/reports/debt-modification", {
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
        if (data.gainOrLoss !== undefined) setGainOrLoss(data.gainOrLoss);
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
        label="What do you need? (TEST = run the 10% cash flow test · EXTINGUISHMENT_ENTRY = derecognize old debt, record new debt · MODIFICATION_LENDER_FEE_ENTRY = capitalize a fee paid to the lender in a modification · THIRD_PARTY_COST_ENTRY = expense a third-party cost)"
        value={mode}
        onChange={(v) => {
          setMode(v);
          setEntryResult(null);
          setTestResult(null);
          setGainOrLoss(null);
          setError(null);
        }}
        options={["TEST", "EXTINGUISHMENT_ENTRY", "MODIFICATION_LENDER_FEE_ENTRY", "THIRD_PARTY_COST_ENTRY"] as const}
      />

      {mode === "TEST" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>ASC 470-50-40 10% cash flow test</legend>
          <TextField
            label="Remaining cash flows under the ORIGINAL terms"
            value={originalCashFlowsRaw}
            onChange={setOriginalCashFlowsRaw}
            placeholder="1:100, 2:1100"
          />
          <TextField
            label="Cash flows under the NEW terms (include any fees paid to the lender)"
            value={newCashFlowsRaw}
            onChange={setNewCashFlowsRaw}
            placeholder="1:100, 2:1400"
          />
          <DecimalField
            label="Original debt's effective interest rate, per period (e.g. 0.10 for 10%)"
            value={ratePerPeriod}
            onChange={setRatePerPeriod}
          />
          <span style={hintStyle}>
            Format: comma-separated "period:amount" pairs, period 1 = the first cash flow after the modification date.
            Both streams discount at the ORIGINAL rate — see debtModification.ts for why.
          </span>
        </fieldset>
      )}

      {mode === "EXTINGUISHMENT_ENTRY" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Extinguishment accounting</legend>
          <DateField label="Date" value={extDate} onChange={setExtDate} />
          <DecimalField label="Old debt's carrying value ($, net of unamortized discount/costs)" value={oldDebtCarryingValue} onChange={setOldDebtCarryingValue} />
          <DecimalField label="New debt's fair value ($)" value={newDebtFairValue} onChange={setNewDebtFairValue} />
          <DecimalField label="Fees paid to the lender ($, optional)" value={extLenderFeesPaid} onChange={setExtLenderFeesPaid} />
        </fieldset>
      )}

      {mode === "MODIFICATION_LENDER_FEE_ENTRY" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Lender fee on a modification (capitalized as discount)</legend>
          <DateField label="Date" value={modDate} onChange={setModDate} />
          <DecimalField label="Fees paid to the lender ($)" value={modLenderFeesPaid} onChange={setModLenderFeesPaid} />
        </fieldset>
      )}

      {mode === "THIRD_PARTY_COST_ENTRY" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Third-party cost (expensed immediately)</legend>
          <DateField label="Date" value={costDate} onChange={setCostDate} />
          <DecimalField label="Amount ($)" value={costAmount} onChange={setCostAmount} />
        </fieldset>
      )}

      <button type="button" style={{ ...smallButtonStyle, marginTop: "1rem" }} onClick={handleCompute} disabled={status === "loading"}>
        {status === "loading" ? "Computing…" : "Compute"}
      </button>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {testResult && (
        <>
          <h2>Result: {testResult.classification}</h2>
          <p>
            PV of original terms: <strong>${testResult.presentValueOriginal}</strong> · PV of new terms:{" "}
            <strong>${testResult.presentValueNew}</strong> · Difference: <strong>{(Number(testResult.percentDifference) * 100).toFixed(2)}%</strong>{" "}
            (threshold: {(Number(testResult.threshold) * 100).toFixed(0)}%)
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
          {gainOrLoss !== null && (
            <p style={{ color: Number(gainOrLoss) < 0 ? "crimson" : "#166534" }}>
              {Number(gainOrLoss) < 0 ? "Loss" : "Gain"} on extinguishment: ${Math.abs(Number(gainOrLoss)).toFixed(2)}
            </p>
          )}
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
