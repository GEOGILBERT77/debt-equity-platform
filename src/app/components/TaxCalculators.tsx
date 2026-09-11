"use client";

import { useState } from "react";
import { DecimalField, DateField, TextField, TextAreaField, BoolField, smallButtonStyle } from "./termsFields/FieldPrimitives";
import { theme } from "@/lib/theme";

/** Shared by both PDF-generating calculators below (the QSBS letter and Form 3922) —
 * every other calculator in this file gets back JSON to render in a table; these two
 * get back a PDF file, so downloading it is the "result" rather than a `ResultTable`.
 * Reads the error JSON on a non-2xx response the same way the JSON calculators do,
 * so a validation failure shows the same kind of message either way. */
async function postForPdfDownload(url: string, body: unknown, filenameFallback: string): Promise<string | null> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!res) return "Request failed";
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return data.error ?? "Failed to generate the PDF";
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : filenameFallback;
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
  return null;
}

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
      <QsbsLetterGenerator />
      <Section83bCalculator />
      <Iso100kCalculator />
      <Form3922Generator />
      <p style={{ color: theme.inkMuted, fontSize: "0.85rem", marginTop: "1.5rem" }}>
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
    <fieldset style={{ border: `1px solid ${theme.border}`, borderRadius: 4, padding: "1rem", marginBottom: "1.5rem" }}>
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
      {error && <p style={{ color: theme.danger.fg }}>{error}</p>}
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
    <fieldset style={{ border: `1px solid ${theme.border}`, borderRadius: 4, padding: "1rem", marginBottom: "1.5rem" }}>
      <legend style={{ fontWeight: 600 }}>IRC 83(b) election timeliness &amp; income</legend>
      <DateField label="Transfer date" value={transferDate} onChange={setTransferDate} />
      <DecimalField label="FMV per share at transfer ($)" value={fmvPerShareAtTransfer} onChange={setFmv} />
      <DecimalField label="Purchase price per share ($)" value={purchasePricePerShare} onChange={setPrice} />
      <DecimalField label="Quantity" value={quantity} onChange={setQuantity} />
      <DateField label="Date election was (or would be) filed" value={filedDate} onChange={setFiledDate} />
      <button type="button" style={smallButtonStyle} onClick={handleCompute}>
        Compute
      </button>
      {error && <p style={{ color: theme.danger.fg }}>{error}</p>}
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
    <fieldset style={{ border: `1px solid ${theme.border}`, borderRadius: 4, padding: "1rem", marginBottom: "1.5rem" }}>
      <legend style={{ fontWeight: 600 }}>ISO $100k limit (IRC 422(d)) — single grant/tranche</legend>
      <DateField label="Grant date" value={grantDate} onChange={setGrantDate} />
      <DecimalField label="FMV per share at grant ($)" value={grantDateFmvPerShare} onChange={setFmv} />
      <DateField label="Tranche's first-exercisable date" value={firstExercisableDate} onChange={setFirstExercisableDate} />
      <DecimalField label="Tranche quantity" value={quantity} onChange={setQuantity} />
      <button type="button" style={smallButtonStyle} onClick={handleCompute}>
        Compute
      </button>
      {error && <p style={{ color: theme.danger.fg }}>{error}</p>}
      {result && result.map((r, i) => <ResultTable key={i} result={r} />)}
    </fieldset>
  );
}

/**
 * v0.36.0 — generates a QSBS attestation letter PDF (see qsbsAttestationPdf.ts for
 * everything the letter covers and, just as important, what it deliberately doesn't
 * attempt to verify). This form is deliberately longer than the other calculators on
 * this page — a real attestation letter has real content, and shortening the form
 * would mean silently dropping one of the representations the letter is supposed to
 * make. The optional "illustrative exclusion" section is collapsed by default since
 * most letters are issued before any sale exists to compute against.
 */
function QsbsLetterGenerator() {
  const [companyName, setCompanyName] = useState("");
  const [stateOfIncorporation, setStateOfIncorporation] = useState("Delaware");
  const [companyAddress, setCompanyAddress] = useState("");
  const [signatoryName, setSignatoryName] = useState("");
  const [signatoryTitle, setSignatoryTitle] = useState("Chief Financial Officer");
  const [shareholderName, setShareholderName] = useState("");
  const [shareholderAddress, setShareholderAddress] = useState("");
  const [stockClass, setStockClass] = useState("Common Stock");
  const [sharesCovered, setSharesCovered] = useState("");
  const [pricePerShare, setPricePerShare] = useState("");
  const [issuanceDate, setIssuanceDate] = useState("");
  const [acquisitionDate, setAcquisitionDate] = useState("");
  const [metGrossAssetsTest, setMetGrossAssetsTest] = useState(true);
  const [isQsbs, setIsQsbs] = useState(true);
  const [activeBusinessDescription, setActiveBusinessDescription] = useState("");
  const [noDisqualifyingRedemptions, setNoDisqualifyingRedemptions] = useState(true);
  const [redemptionNotes, setRedemptionNotes] = useState("");
  const [letterDate, setLetterDate] = useState("");
  const [includeDisposition, setIncludeDisposition] = useState(false);
  const [dispositionDate, setDispositionDate] = useState("");
  const [adjustedBasis, setAdjustedBasis] = useState("");
  const [amountRealized, setAmountRealized] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleGenerate() {
    setError(null);
    setBusy(true);
    const err = await postForPdfDownload(
      "/api/reports/tax/qsbs-letter",
      {
        company: { name: companyName, stateOfIncorporation, address: companyAddress, signatoryName, signatoryTitle },
        shareholder: { name: shareholderName, address: shareholderAddress },
        stock: { stockClass, sharesCovered, pricePerShareAtIssuance: pricePerShare, issuanceDate, acquisitionDate: acquisitionDate || undefined },
        representations: {
          metGrossAssetsTest,
          isQualifiedSmallBusinessStock: isQsbs,
          activeBusinessDescription,
          noDisqualifyingRedemptions,
          redemptionNotes: redemptionNotes || undefined,
        },
        hypotheticalDisposition: includeDisposition ? { dispositionDate, adjustedBasis, amountRealized } : undefined,
        letterDate,
      },
      "qsbs-attestation-letter.pdf"
    );
    setBusy(false);
    setError(err);
  }

  return (
    <fieldset style={{ border: `1px solid ${theme.border}`, borderRadius: 4, padding: "1rem", marginBottom: "1.5rem" }}>
      <legend style={{ fontWeight: 600 }}>QSBS attestation letter (downloads a PDF)</legend>
      <p style={{ color: theme.inkMuted, fontSize: "0.85rem", marginTop: 0 }}>
        A factual attestation letter for a shareholder's own tax advisor — not a substitute for their own eligibility
        determination. See the generated letter's own text for the full disclaimer.
      </p>
      <TextField label="Company legal name" value={companyName} onChange={setCompanyName} />
      <TextField label="State of incorporation" value={stateOfIncorporation} onChange={setStateOfIncorporation} />
      <TextField label="Company address" value={companyAddress} onChange={setCompanyAddress} />
      <TextField label="Signatory name" value={signatoryName} onChange={setSignatoryName} />
      <TextField label="Signatory title" value={signatoryTitle} onChange={setSignatoryTitle} />
      <TextField label="Shareholder name" value={shareholderName} onChange={setShareholderName} />
      <TextField label="Shareholder address" value={shareholderAddress} onChange={setShareholderAddress} />
      <TextField label="Class of stock" value={stockClass} onChange={setStockClass} />
      <DecimalField label="Shares covered" value={sharesCovered} onChange={setSharesCovered} />
      <DecimalField label="Price paid per share at issuance ($)" value={pricePerShare} onChange={setPricePerShare} />
      <DateField label="Issuance date" value={issuanceDate} onChange={setIssuanceDate} />
      <DateField label="Acquisition date (leave blank if same as issuance)" value={acquisitionDate} onChange={setAcquisitionDate} />
      <BoolField label="Issuer met the aggregate gross assets test at issuance" value={metGrossAssetsTest} onChange={setMetGrossAssetsTest} />
      <BoolField label="Is Qualified Small Business Stock (IRC 1202(c))" value={isQsbs} onChange={setIsQsbs} />
      <TextAreaField
        label="Active qualified trade or business description"
        value={activeBusinessDescription}
        onChange={setActiveBusinessDescription}
        placeholder="e.g. Since inception, the Company has been engaged in software development and has not conducted any excluded IRC 1202(e)(3) activity."
      />
      <BoolField
        label="No disqualifying redemptions (issuer-from-taxpayer or issuer's own significant redemptions)"
        value={noDisqualifyingRedemptions}
        onChange={setNoDisqualifyingRedemptions}
      />
      <TextAreaField label="Redemption notes (optional)" value={redemptionNotes} onChange={setRedemptionNotes} rows={2} />
      <DateField label="Letter date" value={letterDate} onChange={setLetterDate} />
      <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", margin: "0.75rem 0" }}>
        <input type="checkbox" checked={includeDisposition} onChange={(e) => setIncludeDisposition(e.target.checked)} />
        Include an illustrative exclusion calculation against an actual or planned sale
      </label>
      {includeDisposition && (
        <>
          <DateField label="Disposition date" value={dispositionDate} onChange={setDispositionDate} />
          <DecimalField label="Adjusted basis ($)" value={adjustedBasis} onChange={setAdjustedBasis} />
          <DecimalField label="Amount realized ($)" value={amountRealized} onChange={setAmountRealized} />
        </>
      )}
      <div>
        <button type="button" style={smallButtonStyle} onClick={handleGenerate} disabled={busy}>
          {busy ? "Generating…" : "Generate letter (PDF)"}
        </button>
      </div>
      {error && <p style={{ color: theme.danger.fg }}>{error}</p>}
    </fieldset>
  );
}

/**
 * v0.36.0 — generates a Form 3922 PDF for one ESPP purchase. Ad hoc, same reasoning
 * as every field on the API route: ESPP has no persisted purchase record in this
 * schema yet, so every field is entered directly here rather than looked up.
 */
function Form3922Generator() {
  const [entityName, setEntityName] = useState("");
  const [entityAddress, setEntityAddress] = useState("");
  const [entityEin, setEntityEin] = useState("");
  const [stakeholderName, setStakeholderName] = useState("");
  const [stakeholderAddress, setStakeholderAddress] = useState("");
  const [stakeholderTin, setStakeholderTin] = useState("");
  const [grantDate, setGrantDate] = useState("");
  const [exerciseDate, setExerciseDate] = useState("");
  const [fmvAtGrant, setFmvAtGrant] = useState("");
  const [fmvAtExercise, setFmvAtExercise] = useState("");
  const [pricePaid, setPricePaid] = useState("");
  const [shares, setShares] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleGenerate() {
    setError(null);
    setBusy(true);
    const err = await postForPdfDownload(
      "/api/reports/tax/form-3922",
      {
        entity: { name: entityName, address: entityAddress || undefined, employerIdentificationNumber: entityEin || undefined },
        stakeholder: { name: stakeholderName, address: stakeholderAddress || undefined, taxIdNumber: stakeholderTin || undefined },
        grantDate,
        exerciseDate,
        fairMarketValuePerShareAtGrant: fmvAtGrant,
        fairMarketValuePerShareAtExercise: fmvAtExercise,
        exercisePricePaidPerShare: pricePaid,
        sharesTransferred: shares,
      },
      "form-3922.pdf"
    );
    setBusy(false);
    setError(err);
  }

  return (
    <fieldset style={{ border: `1px solid ${theme.border}`, borderRadius: 4, padding: "1rem", marginBottom: "1.5rem" }}>
      <legend style={{ fontWeight: 600 }}>Form 3922 — ESPP purchase (downloads a PDF)</legend>
      <p style={{ color: theme.inkMuted, fontSize: "0.85rem", marginTop: 0 }}>
        Applies only to a Section 423(c) tax-qualified ESPP purchase — see espp.ts's doc comment. Generates Copies B
        and C only; Copy A must still be filed with the IRS separately (paper or e-file) — see the PDF's own footer.
      </p>
      <TextField label="Company (transferor) name" value={entityName} onChange={setEntityName} />
      <TextField label="Company address" value={entityAddress} onChange={setEntityAddress} />
      <TextField label="Company EIN" value={entityEin} onChange={setEntityEin} />
      <TextField label="Employee name" value={stakeholderName} onChange={setStakeholderName} />
      <TextField label="Employee address" value={stakeholderAddress} onChange={setStakeholderAddress} />
      <TextField label="Employee TIN" value={stakeholderTin} onChange={setStakeholderTin} />
      <DateField label="Date option granted (offering start)" value={grantDate} onChange={setGrantDate} />
      <DateField label="Date option exercised (purchase date)" value={exerciseDate} onChange={setExerciseDate} />
      <DecimalField label="FMV per share on grant date ($)" value={fmvAtGrant} onChange={setFmvAtGrant} />
      <DecimalField label="FMV per share on exercise date ($)" value={fmvAtExercise} onChange={setFmvAtExercise} />
      <DecimalField label="Exercise price paid per share ($)" value={pricePaid} onChange={setPricePaid} />
      <DecimalField label="Shares transferred" value={shares} onChange={setShares} />
      <div>
        <button type="button" style={smallButtonStyle} onClick={handleGenerate} disabled={busy}>
          {busy ? "Generating…" : "Generate Form 3922 (PDF)"}
        </button>
      </div>
      {error && <p style={{ color: theme.danger.fg }}>{error}</p>}
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
