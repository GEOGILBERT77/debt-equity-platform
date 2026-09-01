"use client";

import { useState } from "react";
import { DecimalField, DateField, TextField, BoolField, SelectField, smallButtonStyle, hintStyle, fieldsetStyle, legendStyle } from "./termsFields/FieldPrimitives";

type Mode = "CLASSIFY" | "LIABILITY_ISSUANCE_ENTRY" | "EQUITY_ISSUANCE_ENTRY" | "CONVERSION_ENTRY";

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

/** Client-side calculator UI for POST /api/reports/safe — see safe.ts for the actual
 * ASC 480-10-25-14 classification and accounting this wraps. Same "collect inputs,
 * render whatever the API returns" pattern as the other calculators here. */
export default function SafeCalculator() {
  const [mode, setMode] = useState<Mode>("CLASSIFY");

  // CLASSIFY fields
  const [conversionPriceFixed, setConversionPriceFixed] = useState(false);
  const [cashSettlement, setCashSettlement] = useState(false);

  // LIABILITY_ISSUANCE_ENTRY / EQUITY_ISSUANCE_ENTRY fields
  const [issuanceDate, setIssuanceDate] = useState("");
  const [investmentAmount, setInvestmentAmount] = useState("");
  const [initialFairValue, setInitialFairValue] = useState("");

  // CONVERSION_ENTRY fields
  const [conversionDate, setConversionDate] = useState("");
  const [safeAccountName, setSafeAccountName] = useState("SAFE Liability");
  const [carryingValue, setCarryingValue] = useState("");
  const [sharesIssued, setSharesIssued] = useState("");
  const [parValue, setParValue] = useState("0");

  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [entryResult, setEntryResult] = useState<EntryResult | null>(null);
  const [classification, setClassification] = useState<string | null>(null);

  async function handleCompute() {
    setStatus("loading");
    setError(null);
    setEntryResult(null);
    setClassification(null);

    let body: Record<string, unknown>;
    if (mode === "CLASSIFY") {
      body = { mode, conversionPriceFixedAtInception: conversionPriceFixed, holderCanElectCashSettlement: cashSettlement };
    } else if (mode === "LIABILITY_ISSUANCE_ENTRY") {
      body = { mode, date: issuanceDate, investmentAmountReceived: investmentAmount, initialFairValue: initialFairValue || undefined };
    } else if (mode === "EQUITY_ISSUANCE_ENTRY") {
      body = { mode, date: issuanceDate, investmentAmountReceived: investmentAmount };
    } else {
      body = {
        mode,
        date: conversionDate,
        safeAccountName,
        carryingValueAtConversion: carryingValue,
        sharesIssued,
        parValuePerShare: parValue || "0",
      };
    }

    try {
      const res = await fetch("/api/reports/safe", {
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
      if (mode === "CLASSIFY") {
        setClassification(data.classification);
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
        label="What do you need? (CLASSIFY = liability vs. equity · LIABILITY_ISSUANCE_ENTRY / EQUITY_ISSUANCE_ENTRY = book the SAFE at issuance · CONVERSION_ENTRY = book conversion into shares)"
        value={mode}
        onChange={(v) => {
          setMode(v);
          setEntryResult(null);
          setClassification(null);
          setError(null);
        }}
        options={["CLASSIFY", "LIABILITY_ISSUANCE_ENTRY", "EQUITY_ISSUANCE_ENTRY", "CONVERSION_ENTRY"] as const}
      />

      {mode === "CLASSIFY" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>ASC 480-10-25-14 SAFE classification</legend>
          <BoolField
            label="Conversion price is fixed and stated in the agreement itself (uncommon — most SAFEs price off a future round)"
            value={conversionPriceFixed}
            onChange={setConversionPriceFixed}
          />
          <BoolField
            label="Holder can elect cash settlement instead of converting into shares (uncommon)"
            value={cashSettlement}
            onChange={setCashSettlement}
          />
        </fieldset>
      )}

      {(mode === "LIABILITY_ISSUANCE_ENTRY" || mode === "EQUITY_ISSUANCE_ENTRY") && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>SAFE issuance</legend>
          <DateField label="Date" value={issuanceDate} onChange={setIssuanceDate} />
          <DecimalField label="Investment amount received ($)" value={investmentAmount} onChange={setInvestmentAmount} />
          {mode === "LIABILITY_ISSUANCE_ENTRY" && (
            <DecimalField
              label="Initial fair value ($, optional — defaults to investment amount received)"
              value={initialFairValue}
              onChange={setInitialFairValue}
              hint="Only pass this if a more precise day-one valuation exists; otherwise the practical expedient (cash received = fair value) is used."
            />
          )}
        </fieldset>
      )}

      {mode === "CONVERSION_ENTRY" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>SAFE conversion into shares</legend>
          <DateField label="Date" value={conversionDate} onChange={setConversionDate} />
          <TextField label='SAFE account name (must match issuance — e.g. "SAFE Liability")' value={safeAccountName} onChange={setSafeAccountName} />
          <DecimalField label="Carrying value at conversion ($)" value={carryingValue} onChange={setCarryingValue} />
          <DecimalField label="Shares issued" value={sharesIssued} onChange={setSharesIssued} />
          <DecimalField label="Par value per share ($, optional, defaults to 0)" value={parValue} onChange={setParValue} />
        </fieldset>
      )}

      <button type="button" style={{ ...smallButtonStyle, marginTop: "1rem" }} onClick={handleCompute} disabled={status === "loading"}>
        {status === "loading" ? "Computing…" : "Compute"}
      </button>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {classification && (
        <h2>
          Classification: <span style={{ textTransform: "uppercase" }}>{classification}</span>
        </h2>
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
          <span style={hintStyle}>
            A liability-classified SAFE's periodic fair value roll-forward uses the same fair-value-remeasurement engine as a
            liability-classified warrant — see safe.ts for details.
          </span>
        </>
      )}
    </div>
  );
}

const cellStyle: React.CSSProperties = { border: "1px solid #ccc", padding: "0.4rem" };
