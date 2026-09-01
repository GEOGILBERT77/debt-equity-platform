"use client";

import { useState } from "react";
import { DecimalField, DateField, BoolField, SelectField, TextField, smallButtonStyle, hintStyle, fieldsetStyle, legendStyle } from "./termsFields/FieldPrimitives";

type Mode = "VESTING_TRANCHES" | "RECOGNITION_ENTRY" | "CUSTOMER_TIMING";
type CounterpartyType = "VENDOR_OR_CONSULTANT" | "CUSTOMER";

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

/** Client-side calculator UI for POST /api/reports/nonemployee-awards — see
 * nonemployeeAwards.ts for the actual ASC 718-10/ASC 606-10-32-25 accounting this
 * wraps. Same "collect inputs, render whatever the API returns" pattern as the other
 * calculators here. The full period-by-period SCHEDULE mode (which needs an array of
 * periods) isn't surfaced in this simple UI — same precedent as TdrCalculator leaving
 * its REDUCED_CARRYING_VALUE_SCHEDULE mode API-only — but is reachable directly via
 * the API. */
export default function NonemployeeAwardCalculator() {
  const [mode, setMode] = useState<Mode>("VESTING_TRANCHES");
  const [counterpartyType, setCounterpartyType] = useState<CounterpartyType>("VENDOR_OR_CONSULTANT");

  // VESTING_TRANCHES fields
  const [grantDate, setGrantDate] = useState("");
  const [quantity, setQuantity] = useState("");
  const [grantDateFairValuePerUnit, setGrantDateFairValuePerUnit] = useState("");
  const [hasExplicitCondition, setHasExplicitCondition] = useState(false);
  const [explicitVestDate, setExplicitVestDate] = useState("");

  // RECOGNITION_ENTRY fields
  const [rowPeriodStart, setRowPeriodStart] = useState("");
  const [rowPeriodEnd, setRowPeriodEnd] = useState("");
  const [rowLabel, setRowLabel] = useState("");
  const [rowAmount, setRowAmount] = useState("");

  // CUSTOMER_TIMING fields
  const [timingGrantDate, setTimingGrantDate] = useState("");
  const [revenueRecognitionDate, setRevenueRecognitionDate] = useState("");

  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [tranchesResult, setTranchesResult] = useState<Record<string, unknown> | null>(null);
  const [entryResult, setEntryResult] = useState<EntryResult | null>(null);
  const [timingResult, setTimingResult] = useState<string | null>(null);

  async function handleCompute() {
    setStatus("loading");
    setError(null);
    setTranchesResult(null);
    setEntryResult(null);
    setTimingResult(null);

    const body: Record<string, unknown> =
      mode === "VESTING_TRANCHES"
        ? {
            mode,
            grantDate,
            quantity,
            grantDateFairValuePerUnit,
            counterpartyType,
            explicitVestingTranches: hasExplicitCondition ? [{ id: "explicit", vestDate: explicitVestDate, quantity }] : undefined,
          }
        : mode === "RECOGNITION_ENTRY"
          ? { mode, counterpartyType, row: { periodStart: rowPeriodStart, periodEnd: rowPeriodEnd, label: rowLabel, amount: rowAmount } }
          : { mode, awardGrantDate: timingGrantDate, revenueRecognitionDate };

    try {
      const res = await fetch("/api/reports/nonemployee-awards", {
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
      if (mode === "VESTING_TRANCHES") {
        setTranchesResult(data);
      } else if (mode === "RECOGNITION_ENTRY") {
        setEntryResult(data.entry);
      } else {
        setTimingResult(data.noEarlierThan);
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
        label="What do you need? (VESTING_TRANCHES = ASC 718-10-25-2C requisite service period · RECOGNITION_ENTRY = journal entry for one period's expense · CUSTOMER_TIMING = ASC 606-10-32-27 timing floor for an award to a customer)"
        value={mode}
        onChange={(v) => {
          setMode(v);
          setTranchesResult(null);
          setEntryResult(null);
          setTimingResult(null);
          setError(null);
        }}
        options={["VESTING_TRANCHES", "RECOGNITION_ENTRY", "CUSTOMER_TIMING"] as const}
      />

      {mode === "VESTING_TRANCHES" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>ASC 718-10-25-2C requisite service period</legend>
          <DateField label="Grant date" value={grantDate} onChange={setGrantDate} />
          <DecimalField label="Quantity (shares/units)" value={quantity} onChange={setQuantity} />
          <DecimalField label="Grant-date fair value per unit ($)" value={grantDateFairValuePerUnit} onChange={setGrantDateFairValuePerUnit} />
          <SelectField label="Counterparty" value={counterpartyType} onChange={setCounterpartyType} options={["VENDOR_OR_CONSULTANT", "CUSTOMER"] as const} />
          <BoolField
            label="There's an explicit condition on the nonemployee's FUTURE performance (beyond simply delivering the good/service)"
            value={hasExplicitCondition}
            onChange={setHasExplicitCondition}
          />
          {hasExplicitCondition && <DateField label="Vest date for that future-performance condition" value={explicitVestDate} onChange={setExplicitVestDate} />}
          <span style={hintStyle}>
            With no explicit future-performance condition, the award is presumed fully vested — and its whole value
            recognized immediately — on the grant date itself. See nonemployeeAwards.ts.
          </span>
        </fieldset>
      )}

      {mode === "RECOGNITION_ENTRY" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Journal entry for one period's recognized expense</legend>
          <SelectField label="Counterparty" value={counterpartyType} onChange={setCounterpartyType} options={["VENDOR_OR_CONSULTANT", "CUSTOMER"] as const} />
          <DateField label="Period start" value={rowPeriodStart} onChange={setRowPeriodStart} />
          <DateField label="Period end" value={rowPeriodEnd} onChange={setRowPeriodEnd} />
          <TextField label="Label (e.g. Y1)" value={rowLabel} onChange={setRowLabel} />
          <DecimalField label="Amount recognized this period ($, negative for a reversal)" value={rowAmount} onChange={setRowAmount} />
          <span style={hintStyle}>
            A CUSTOMER counterparty debits "Reduction of Revenue" instead of an expense account (ASU 2019-08 / ASC
            606-10-32-25) — see nonemployeeAwards.ts.
          </span>
        </fieldset>
      )}

      {mode === "CUSTOMER_TIMING" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>ASC 606-10-32-27 timing floor (award to a customer)</legend>
          <DateField label="Award grant date" value={timingGrantDate} onChange={setTimingGrantDate} />
          <DateField label="Date revenue is recognized for the related goods/services" value={revenueRecognitionDate} onChange={setRevenueRecognitionDate} />
          <span style={hintStyle}>
            The reduction of revenue can't be recognized any earlier than the LATER of these two dates.
          </span>
        </fieldset>
      )}

      <button type="button" style={{ ...smallButtonStyle, marginTop: "1rem" }} onClick={handleCompute} disabled={status === "loading"}>
        {status === "loading" ? "Computing…" : "Compute"}
      </button>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {tranchesResult && (
        <>
          <h2>Result</h2>
          <p>
            Total grant-date fair value: <strong>${String(tranchesResult.totalGrantDateFairValue)}</strong>
            {" — "}
            {tranchesResult.immediatelyRecognized ? "recognized immediately on the grant date." : "spread over the explicit vesting condition."}
          </p>
        </>
      )}

      {timingResult && (
        <>
          <h2>Result</h2>
          <p>
            The reduction of revenue is recognized no earlier than <strong>{timingResult}</strong>.
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
