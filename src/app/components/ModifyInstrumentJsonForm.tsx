"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { labelStyle, inputStyle as fieldInputStyle } from "./termsFields/FieldPrimitives";
import { theme } from "@/lib/theme";

interface ModificationPreview {
  applicable: boolean;
  message?: string;
  perPeriodDeltas: { periodEnd: string; label: string; beforeAmount: string; afterAmount: string; delta: string }[];
  totalBeforeAmount: string;
  totalAfterAmount: string;
  totalDelta: string;
}

/**
 * Raw-JSON fallback for the "Modify" flow, used for every instrument type OTHER than
 * STOCK_OPTION/RSU/RESTRICTED_STOCK (see ModifyGrantForm.tsx for those three, which
 * get a proper typed form). Those eight remaining types (debt, warrants, preferred
 * stock, SAR) don't have a full amortization-table impact preview built yet — a
 * period-by-period roll-forward type gets `applicable: false` back from the preview
 * call with an explanation, which this form just displays as-is, same as
 * ModifyGrantForm does. Committing still works for every type: this is what makes
 * POST /api/instruments/:id/modifications reachable from the UI at all for the first
 * time (it previously had a route but no page calling it) — see MODIFICATION-IMPACT-
 * PLAN.md for why a typed form + dollar-impact preview for the other eight types is
 * future work, not a gap in this pass.
 */
export function ModifyInstrumentJsonForm({
  instrumentId,
  currentTerms,
  currentEffectiveDate,
}: {
  instrumentId: string;
  currentTerms: unknown;
  currentEffectiveDate: string;
}) {
  const router = useRouter();
  const [jsonText, setJsonText] = useState(() => JSON.stringify(currentTerms, null, 2));
  const [effectiveDate, setEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [label, setLabel] = useState("Modification");
  const [previewStatus, setPreviewStatus] = useState<"idle" | "loading" | "error">("idle");
  const [preview, setPreview] = useState<ModificationPreview | null>(null);
  const [commitStatus, setCommitStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function parseTerms(): unknown | null {
    try {
      return JSON.parse(jsonText);
    } catch {
      setErrorMessage("Terms must be valid JSON.");
      return null;
    }
  }

  async function handlePreview() {
    const terms = parseTerms();
    if (terms === null) return;
    setPreviewStatus("loading");
    setErrorMessage(null);
    setPreview(null);
    try {
      const res = await fetch(`/api/instruments/${instrumentId}/modifications/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ effectiveDate, terms, label }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPreviewStatus("error");
        setErrorMessage(data.error ?? "Failed to compute impact");
        return;
      }
      setPreviewStatus("idle");
      setPreview(data);
    } catch (err) {
      setPreviewStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Failed to compute impact");
    }
  }

  async function handleCommit() {
    const terms = parseTerms();
    if (terms === null) return;
    setCommitStatus("loading");
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/instruments/${instrumentId}/modifications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ effectiveDate, terms, label }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCommitStatus("error");
        setErrorMessage(data.error ?? "Failed to commit modification");
        return;
      }
      router.push(`/instruments/${instrumentId}`);
    } catch (err) {
      setCommitStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Failed to commit modification");
    }
  }

  return (
    <div>
      <p style={{ color: theme.warning.fg }}>
        This instrument type doesn't have a typed modification form yet — edit the raw terms JSON below. See
        MODIFICATION-IMPACT-PLAN.md for which types have a full dollar-impact preview today.
      </p>
      <label style={labelStyle}>
        Effective date of this modification (must be after {currentEffectiveDate})
        <input
          type="date"
          value={effectiveDate}
          onChange={(e) => {
            setEffectiveDate(e.target.value);
            setPreview(null);
          }}
          style={fieldInputStyle}
        />
      </label>
      <label style={labelStyle}>
        Label
        <input
          type="text"
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
            setPreview(null);
          }}
          style={fieldInputStyle}
        />
      </label>
      <label style={labelStyle}>
        Proposed terms (JSON)
        <textarea
          value={jsonText}
          onChange={(e) => {
            setJsonText(e.target.value);
            setPreview(null);
          }}
          rows={14}
          style={{ ...fieldInputStyle, fontFamily: theme.font.mono, fontSize: "0.85rem" }}
        />
      </label>

      <button type="button" onClick={handlePreview} disabled={previewStatus === "loading"} style={buttonStyle}>
        {previewStatus === "loading" ? "Computing impact…" : "Preview impact"}
      </button>
      {previewStatus === "error" && errorMessage && <p style={{ color: theme.danger.fg, marginTop: "0.5rem" }}>{errorMessage}</p>}

      {preview && (
        <div style={{ marginTop: "1rem" }}>
          <h3>Impact of this modification</h3>
          {!preview.applicable ? (
            <p style={{ color: theme.inkMuted }}>{preview.message}</p>
          ) : (
            <div style={{ display: "flex", gap: "2rem", margin: "0.75rem 0" }}>
              <div>
                <div style={{ fontSize: "0.8rem", color: theme.inkMuted }}>Current total</div>
                <div style={{ fontSize: "1.25rem", fontWeight: 600 }}>{preview.totalBeforeAmount}</div>
              </div>
              <div>
                <div style={{ fontSize: "0.8rem", color: theme.inkMuted }}>Proposed total</div>
                <div style={{ fontSize: "1.25rem", fontWeight: 600 }}>{preview.totalAfterAmount}</div>
              </div>
              <div>
                <div style={{ fontSize: "0.8rem", color: theme.inkMuted }}>Change</div>
                <div style={{ fontSize: "1.25rem", fontWeight: 600 }}>{preview.totalDelta}</div>
              </div>
            </div>
          )}
          <div style={{ marginTop: "1rem" }}>
            <button type="button" onClick={handleCommit} disabled={commitStatus === "loading"} style={buttonStyle}>
              {commitStatus === "loading" ? "Committing…" : "Commit this modification"}
            </button>
            {commitStatus === "error" && errorMessage && <p style={{ color: theme.danger.fg, marginTop: "0.5rem" }}>{errorMessage}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: `1px solid ${theme.ink}`,
  borderRadius: 4,
  background: theme.surfaceAlt,
  cursor: "pointer",
};
