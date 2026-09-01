"use client";

import { useState } from "react";
import { DecimalField, DateField, BoolField, smallButtonStyle } from "./termsFields/FieldPrimitives";

/**
 * Client-side forms for three of taxElections.ts's five calculators, reachable for the
 * first time as of v0.19.0 (see this directory's sibling API routes under
 * /api/reports/tax/*). AMT-on-ISO-exercise, OID, and market discount are deliberately
 * NOT given a form here — they're reachable via their own API routes today, but a
 * usable UI for them (OID/market-discount in particular need a full `periods` array,
 * which isn't a one-line form field) is left for a follow-up pass rather than rushed
 * into a bad form. Flagged in this file rather than silently only building "the easy
 * three."
 */
export default function TaxCalculators() {
  return (
    <div>
      <QsbsCalculator />
      <Section83bCalculator />
      <Iso100kCalculator />
      <p style={{ color: "#666", fontSize: "0.85rem", marginTop: "1.5rem" }}>
        Two more taxElections.ts calculators (IRC 56(b)(3) AMT preference on ISO exercise, and IRC 1272/1276 debt-side
        OID / market discount) are reachable via API only for now — see
        <code> POST /api/reports/tax/iso-amt-preference</code>, <code>/debt-oid</code>, and <code>/market-discount</code>.
      </p>
    </div>
  );
}

function QsbsCalculator() {
  const [issuanceDate, setIssuanceDate] = useState("");
  const [acquisitionDate, setAcquisitionDate] = useState("");
  const [dispositionDate, setDispositionDate] = useState("");
  const [adjustedBasis, setAdjustedBasis] = useState("");
  const [amountRealized, setAmountRealized] = useState("");
  const [metGrossAssetsTest, setMetGrossAssetsTest] = useState(true);
  const [isQsbs, setIsQsbs] = useState(true);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCompute() {
    setError(null);
    setResult(null);
    const res = await fetch("/api/reports/tax/qsbs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issuanceDate,
        acquisitionDate: acquisitionDate || undefined,
        dispositionDate,
        adjustedBasis,
        amountRealized,
        metGrossAssetsTest,
        isQualifiedSmallBusinessStock: isQsbs,
      }),
    }).catch(() => null);
    if (!res) return setError("Request failed");
    const data = await res.json();
    if (!res.ok) return setError(data.error ?? "Failed to compute");
    setResult(data);
  }

  return (
    <fieldset style={{ border: "1px solid #ddd", borderRadius: 4, padding: "1rem", marginBottom: "1.5rem" }}>
      <legend style={{ fontWeight: 600 }}>QSBS / Section 1202 exclusion (IRC 1202)</legend>
      <DateField label="Issuance date" value={issuanceDate} onChange={setIssuanceDate} />
      <DateField label="Acquisition date (leave blank if same as issuance)" value={acquisitionDate} onChange={setAcquisitionDate} />
      <DateField label="Disposition date" value={dispositionDate} onChange={setDispositionDate} />
      <DecimalField label="Adjusted basis ($)" value={adjustedBasis} onChange={setAdjustedBasis} />
      <DecimalField label="Amount realized ($)" value={amountRealized} onChange={setAmountRealized} />
      <BoolField label="Issuer met the aggregate gross assets test at issuance" value={metGrossAssetsTest} onChange={setMetGrossAssetsTest} />
      <BoolField label="Is Qualified Small Business Stock (IRC 1202(c))" value={isQsbs} onChange={setIsQsbs} />
      <button type="button" style={smallButtonStyle} onClick={handleCompute}>
        Compute
      </button>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {result && <ResultTable result={result} />}
    </fieldset>
  );
}

function Section83bCalculator() {
  const [transferDate, setTransferDate] = useState("");
  const [fmvPerShareAtTransfer, setFmv] = useState("");
  const [purchasePricePerShare, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [filedDate, setFiledDate] = useState("");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCompute() {
    setError(null);
    setResult(null);
    const res = await fetch("/api/reports/tax/83b-election", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenario: { transferDate, fmvPerShareAtTransfer, purchasePricePerShare, quantity },
        filedDate,
      }),
    }).catch(() => null);
    if (!res) return setError("Request failed");
    const data = await res.json();
    if (!res.ok) return setError(data.error ?? "Failed to compute");
    setResult(data.election);
  }

  return (
    <fieldset style={{ border: "1px solid #ddd", borderRadius: 4, padding: "1rem", marginBottom: "1.5rem" }}>
      <legend style={{ fontWeight: 600 }}>IRC 83(b) election timeliness &amp; income</legend>
      <DateField label="Transfer date" value={transferDate} onChange={setTransferDate} />
      <DecimalField label="FMV per share at transfer ($)" value={fmvPerShareAtTransfer} onChange={setFmv} />
      <DecimalField label="Purchase price per share ($)" value={purchasePricePerShare} onChange={setPrice} />
      <DecimalField label="Quantity" value={quantity} onChange={setQuantity} />
      <DateField label="Date election was (or would be) filed" value={filedDate} onChange={setFiledDate} />
      <button type="button" style={smallButtonStyle} onClick={handleCompute}>
        Compute
      </button>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {result && <ResultTable result={result} />}
    </fieldset>
  );
}

function Iso100kCalculator() {
  const [grantDate, setGrantDate] = useState("");
  const [grantDateFmvPerShare, setFmv] = useState("");
  const [firstExercisableDate, setFirstExercisableDate] = useState("");
  const [quantity, setQuantity] = useState("");
  const [result, setResult] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCompute() {
    setError(null);
    setResult(null);
    // Single-grant, single-tranche convenience form — the API accepts an arbitrary
    // array of grants/tranches; call it directly (see the route's doc comment) for a
    // multi-grant $100k analysis across a whole option pool.
    const res = await fetch("/api/reports/tax/iso-100k", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grants: [
          {
            id: "grant-1",
            grantDate,
            grantDateFmvPerShare,
            tranches: [{ id: "tranche-1", firstExercisableDate, quantity }],
          },
        ],
      }),
    }).catch(() => null);
    if (!res) return setError("Request failed");
    const data = await res.json();
    if (!res.ok) return setError(data.error ?? "Failed to compute");
    setResult(data.classifications);
  }

  return (
    <fieldset style={{ border: "1px solid #ddd", borderRadius: 4, padding: "1rem", marginBottom: "1.5rem" }}>
      <legend style={{ fontWeight: 600 }}>ISO $100k limit (IRC 422(d)) — single grant/tranche</legend>
      <DateField label="Grant date" value={grantDate} onChange={setGrantDate} />
      <DecimalField label="FMV per share at grant ($)" value={grantDateFmvPerShare} onChange={setFmv} />
      <DateField label="Tranche's first-exercisable date" value={firstExercisableDate} onChange={setFirstExercisableDate} />
      <DecimalField label="Tranche quantity" value={quantity} onChange={setQuantity} />
      <button type="button" style={smallButtonStyle} onClick={handleCompute}>
        Compute
      </button>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {result && result.map((r, i) => <ResultTable key={i} result={r} />)}
    </fieldset>
  );
}

function ResultTable({ result }: { result: Record<string, unknown> }) {
  return (
    <table style={{ borderCollapse: "collapse", marginTop: "0.5rem" }}>
      <tbody>
        {Object.entries(result).map(([k, v]) => (
          <tr key={k}>
            <td style={{ padding: "0.2rem 0.6rem", fontWeight: 600, fontSize: "0.85rem" }}>{k}</td>
            <td style={{ padding: "0.2rem 0.6rem", fontSize: "0.85rem" }}>{String(v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
