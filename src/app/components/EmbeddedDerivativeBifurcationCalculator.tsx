"use client";

import { useState } from "react";
import { BoolField, smallButtonStyle, hintStyle, fieldsetStyle, legendStyle } from "./termsFields/FieldPrimitives";

/** Client-side calculator UI for POST /api/reports/embedded-derivative-bifurcation —
 * see embeddedDerivativeBifurcation.ts for the actual ASC 815-15-25 classification
 * this wraps. Same "collect inputs, render whatever the API returns" pattern as the
 * other calculators here. This is a classification triage only — it does not value a
 * derivative that comes back REQUIRED to bifurcate (that needs a lattice/Monte Carlo
 * model this codebase does not build). */
export default function EmbeddedDerivativeBifurcationCalculator() {
  const [netCashSettlementPossible, setNetCashSettlementPossible] = useState(false);
  const [indexedToOwnStockOnly, setIndexedToOwnStockOnly] = useState(true);
  const [hasDownRoundProtection, setHasDownRoundProtection] = useState(false);
  const [alreadyAtFairValue, setAlreadyAtFairValue] = useState(false);

  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ outcome: string; reason: string } | null>(null);

  async function handleCompute() {
    setStatus("loading");
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/reports/embedded-derivative-bifurcation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          netCashSettlementPossible,
          indexedToOwnStockOnly,
          hasDownRoundProtection,
          hybridInstrumentAlreadyAtFairValueThroughEarnings: alreadyAtFairValue,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setError(data.error ?? "Failed to classify the embedded feature");
        return;
      }
      setResult(data);
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to classify the embedded feature");
    }
  }

  const outcomeColor = result?.outcome === "REQUIRED" ? "crimson" : result?.outcome === "REVIEW" ? "#92400e" : "#166534";

  return (
    <div>
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>ASC 815-15-25 embedded conversion feature bifurcation assessment</legend>
        <BoolField
          label="The holder or issuer can demand net CASH settlement of the conversion feature"
          value={netCashSettlementPossible}
          onChange={setNetCashSettlementPossible}
        />
        <BoolField
          label="Indexed only to the issuer's own stock (fixed-for-fixed — no variable strike, no FX/other index)"
          value={indexedToOwnStockOnly}
          onChange={setIndexedToOwnStockOnly}
        />
        <BoolField label="Has down-round (full-ratchet or weighted-average anti-dilution) protection" value={hasDownRoundProtection} onChange={setHasDownRoundProtection} />
        <BoolField
          label="The whole hybrid instrument is already measured at fair value through earnings"
          value={alreadyAtFairValue}
          onChange={setAlreadyAtFairValue}
        />
        <span style={hintStyle}>
          This reuses the same fixed-for-fixed/net-settlement/down-round test warrantAllocation.ts already applies to
          warrants — see embeddedDerivativeBifurcation.ts.
        </span>
      </fieldset>

      <button type="button" style={{ ...smallButtonStyle, marginTop: "1rem" }} onClick={handleCompute} disabled={status === "loading"}>
        {status === "loading" ? "Computing…" : "Compute"}
      </button>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {result && (
        <>
          <h2 style={{ color: outcomeColor }}>{result.outcome === "NOT_REQUIRED" ? "Bifurcation NOT required" : result.outcome === "REQUIRED" ? "Bifurcation REQUIRED" : "Needs review"}</h2>
          <p>{result.reason}</p>
          {result.outcome === "REQUIRED" && (
            <p style={{ color: "#92400e" }}>
              This calculator does not value the resulting derivative — that needs a lattice or Monte Carlo model
              capturing the feature's full contingent-payment structure, which this codebase does not build. Consult
              a valuation specialist.
            </p>
          )}
        </>
      )}
    </div>
  );
}
