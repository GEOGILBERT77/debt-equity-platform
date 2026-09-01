"use client";

import { useState } from "react";
import { DecimalField, DateField, BoolField, SelectField, smallButtonStyle, hintStyle, fieldsetStyle, legendStyle } from "./termsFields/FieldPrimitives";

type Mode = "CLASSIFY" | "FAIR_VALUE" | "PURCHASE_ENTRY";

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

/** Client-side calculator UI for POST /api/reports/espp — see espp.ts for the actual
 * ASC 718-50 accounting this wraps. Same "collect inputs, render whatever the API
 * returns" pattern as the other calculators here. */
export default function EsppCalculator() {
  const [mode, setMode] = useState<Mode>("CLASSIFY");

  // CLASSIFY fields
  const [classifyDiscount, setClassifyDiscount] = useState("0.15");
  const [classifyHasLookback, setClassifyHasLookback] = useState(false);
  const [classifyEligible, setClassifyEligible] = useState(true);
  const [classifyJustified, setClassifyJustified] = useState(false);

  // FAIR_VALUE fields
  const [fvHasLookback, setFvHasLookback] = useState(true);
  const [fvStockPrice, setFvStockPrice] = useState("");
  const [fvDiscount, setFvDiscount] = useState("0.15");
  const [fvRiskFreeRate, setFvRiskFreeRate] = useState("0.045");
  const [fvVolatility, setFvVolatility] = useState("0.45");
  const [fvOfferingPeriodYears, setFvOfferingPeriodYears] = useState("0.5");
  const [fvDividendYield, setFvDividendYield] = useState("0");

  // PURCHASE_ENTRY fields
  const [purchaseDate, setPurchaseDate] = useState("");
  const [quantityPurchased, setQuantityPurchased] = useState("");
  const [purchasePricePerUnit, setPurchasePricePerUnit] = useState("");
  const [grantDateFairValuePerUnit, setGrantDateFairValuePerUnit] = useState("");

  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [classifyResult, setClassifyResult] = useState<Record<string, unknown> | null>(null);
  const [fairValueResult, setFairValueResult] = useState<string | null>(null);
  const [entryResult, setEntryResult] = useState<EntryResult | null>(null);

  async function handleCompute() {
    setStatus("loading");
    setError(null);
    setClassifyResult(null);
    setFairValueResult(null);
    setEntryResult(null);

    const body: Record<string, unknown> =
      mode === "CLASSIFY"
        ? {
            mode,
            discountPercent: classifyDiscount,
            hasLookback: classifyHasLookback,
            substantiallyAllEmployeesEligible: classifyEligible,
            discountJustifiedAboveSafeHarbor: classifyJustified,
          }
        : mode === "FAIR_VALUE"
          ? {
              mode,
              hasLookback: fvHasLookback,
              grantDateStockPrice: fvStockPrice,
              discountPercent: fvDiscount,
              riskFreeRate: fvRiskFreeRate,
              volatility: fvHasLookback ? fvVolatility : undefined,
              offeringPeriodYears: fvOfferingPeriodYears,
              dividendYield: fvDividendYield,
            }
          : { mode, purchaseDate, quantityPurchased, purchasePricePerUnit, grantDateFairValuePerUnit };

    try {
      const res = await fetch("/api/reports/espp", {
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
        setClassifyResult(data);
      } else if (mode === "FAIR_VALUE") {
        setFairValueResult(data.grantDateFairValuePerUnit);
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
        label="What do you need? (CLASSIFY = ASC 718-50-25-1 noncompensatory test · FAIR_VALUE = grant-date value of the purchase right · PURCHASE_ENTRY = journal entry at the purchase date)"
        value={mode}
        onChange={(v) => {
          setMode(v);
          setClassifyResult(null);
          setFairValueResult(null);
          setEntryResult(null);
          setError(null);
        }}
        options={["CLASSIFY", "FAIR_VALUE", "PURCHASE_ENTRY"] as const}
      />

      {mode === "CLASSIFY" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>ASC 718-50-25-1 noncompensatory-plan test</legend>
          <DecimalField label="Discount from market price (e.g. 0.15 for 15%)" value={classifyDiscount} onChange={setClassifyDiscount} />
          <BoolField label="Plan has a look-back feature (purchase price based on the lower of grant-date or purchase-date price)" value={classifyHasLookback} onChange={setClassifyHasLookback} />
          <BoolField label="Substantially all employees may participate on an equitable basis" value={classifyEligible} onChange={setClassifyEligible} />
          <BoolField
            label="Discount above 5% is justified by evidence (only matters if discount is between 5% and 15%)"
            value={classifyJustified}
            onChange={setClassifyJustified}
          />
          <span style={hintStyle}>
            A look-back feature makes a plan compensatory no matter how small the discount is — see espp.ts for why.
          </span>
        </fieldset>
      )}

      {mode === "FAIR_VALUE" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Grant-date fair value of the purchase right</legend>
          <BoolField label="Plan has a look-back feature" value={fvHasLookback} onChange={setFvHasLookback} />
          <DecimalField label="Grant-date stock price ($)" value={fvStockPrice} onChange={setFvStockPrice} />
          <DecimalField label="Discount (e.g. 0.15 for 15%)" value={fvDiscount} onChange={setFvDiscount} />
          <DecimalField label="Risk-free rate (annualized, e.g. 0.045)" value={fvRiskFreeRate} onChange={setFvRiskFreeRate} />
          {fvHasLookback && <DecimalField label="Volatility (annualized, e.g. 0.45)" value={fvVolatility} onChange={setFvVolatility} />}
          <DecimalField label="Offering period (years, e.g. 0.5 for six months)" value={fvOfferingPeriodYears} onChange={setFvOfferingPeriodYears} />
          <DecimalField label="Dividend yield (annualized, default 0)" value={fvDividendYield} onChange={setFvDividendYield} />
          <span style={hintStyle}>
            {fvHasLookback
              ? "Priced as Call(K=grant price) + discount × grant price × e^(-rT) − discount × Put(K=grant price) — see espp.ts."
              : "No look-back: this is a forward, not an option — no volatility is used (see espp.ts)."}
          </span>
        </fieldset>
      )}

      {mode === "PURCHASE_ENTRY" && (
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Purchase-date journal entry</legend>
          <DateField label="Purchase date" value={purchaseDate} onChange={setPurchaseDate} />
          <DecimalField label="Quantity purchased (shares)" value={quantityPurchased} onChange={setQuantityPurchased} />
          <DecimalField label="Purchase price actually paid per share ($, the discounted price)" value={purchasePricePerUnit} onChange={setPurchasePricePerUnit} />
          <DecimalField
            label="Grant-date fair value per unit already recognized as compensation cost ($, use 0 for a noncompensatory plan)"
            value={grantDateFairValuePerUnit}
            onChange={setGrantDateFairValuePerUnit}
          />
        </fieldset>
      )}

      <button type="button" style={{ ...smallButtonStyle, marginTop: "1rem" }} onClick={handleCompute} disabled={status === "loading"}>
        {status === "loading" ? "Computing…" : "Compute"}
      </button>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {classifyResult && (
        <>
          <h2>Result: {String(classifyResult.kind)}</h2>
          <p>{String(classifyResult.reason)}</p>
        </>
      )}

      {fairValueResult && (
        <>
          <h2>Grant-date fair value per unit</h2>
          <p>
            <strong>${fairValueResult}</strong> per share
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
