"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type PreviewResult = {
  perPeriodDeltas: { label: string; periodEnd: string; originalAmount: string; correctedAmount: string; delta: string }[];
  cumulativeDelta: string;
  correctionInputs: { targetEffectiveDate: string; correctedTerms: unknown; through: string | null };
};

/**
 * The preview-then-commit correction workflow (ASC 250), made clickable. This is the
 * one piece of the whole platform the project's design discussions came back to
 * repeatedly — a human has to see the computed impact and elect PROSPECTIVE or
 * RETROSPECTIVE before anything is written, and the commit call recomputes the preview
 * itself server-side rather than trusting whatever this component sends back (see
 * corrections/commit/route.ts's doc comment). This UI is a thin, honest wrapper around
 * that contract, not a shortcut around it: you cannot skip straight to "commit" without
 * a preview existing in this component's state first.
 *
 * `correctedTerms` is a raw JSON textarea rather than a generated form, because the
 * shape of "terms" is different per instrument type (see dispatch.ts) and a proper
 * per-type correction form is real, separate scope — not built in this minimal pass.
 */
export function CorrectionPanel({ instrumentId }: { instrumentId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [targetEffectiveDate, setTargetEffectiveDate] = useState("");
  const [reason, setReason] = useState("");
  const [correctedTermsText, setCorrectedTermsText] = useState("{\n  \n}");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [election, setElection] = useState<"PROSPECTIVE" | "RETROSPECTIVE">("RETROSPECTIVE");
  const [currentOpenPeriodEnd, setCurrentOpenPeriodEnd] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "committed">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handlePreview() {
    setStatus("loading");
    setMessage(null);
    setPreview(null);
    let correctedTerms: unknown;
    try {
      correctedTerms = JSON.parse(correctedTermsText);
    } catch {
      setStatus("error");
      setMessage("Corrected terms must be valid JSON.");
      return;
    }
    try {
      const res = await fetch(`/api/instruments/${instrumentId}/corrections/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetEffectiveDate, correctedTerms, reason }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Preview failed");
        return;
      }
      setPreview(data);
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Preview failed");
    }
  }

  async function handleCommit() {
    if (!preview) return;
    if (election === "PROSPECTIVE" && !currentOpenPeriodEnd) {
      setStatus("error");
      setMessage("currentOpenPeriodEnd is required for a PROSPECTIVE election.");
      return;
    }
    setStatus("loading");
    setMessage(null);
    try {
      const res = await fetch(`/api/instruments/${instrumentId}/corrections/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetEffectiveDate: preview.correctionInputs.targetEffectiveDate,
          correctedTerms: preview.correctionInputs.correctedTerms,
          reason,
          election,
          currentOpenPeriodEnd: election === "PROSPECTIVE" ? currentOpenPeriodEnd : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Commit failed");
        return;
      }
      setStatus("committed");
      setMessage(`Committed (${election}) as correction ${data.correctionId}.`);
      setPreview(null);
      router.refresh();
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Commit failed");
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={linkButtonStyle}>
        Report a correction (ASC 250) →
      </button>
    );
  }

  return (
    <div style={{ border: "1px solid #ccc", borderRadius: 4, padding: "1rem", marginTop: "1rem", maxWidth: 700 }}>
      <h3 style={{ marginTop: 0 }}>Correction — preview, then elect, then commit</h3>

      <label style={labelStyle}>
        Effective date of the corrected term version
        <input
          type="date"
          value={targetEffectiveDate}
          onChange={(e) => setTargetEffectiveDate(e.target.value)}
          style={inputStyle}
        />
      </label>

      <label style={labelStyle}>
        Reason (why this is a correction, not a modification)
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle} />
      </label>

      <label style={labelStyle}>
        Corrected terms (JSON — same shape as the instrument's existing terms, with the fixed value(s))
        <textarea
          value={correctedTermsText}
          onChange={(e) => setCorrectedTermsText(e.target.value)}
          rows={8}
          style={{ ...inputStyle, fontFamily: "monospace" }}
        />
      </label>

      <button onClick={handlePreview} disabled={status === "loading"} style={buttonStyle}>
        {status === "loading" && !preview ? "Computing…" : "Preview impact"}
      </button>

      {preview && (
        <div style={{ marginTop: "1rem" }}>
          <h4>Preview — nothing written yet</h4>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={cellStyle}>Period</th>
                <th style={cellStyle}>Original</th>
                <th style={cellStyle}>Corrected</th>
                <th style={cellStyle}>Delta</th>
              </tr>
            </thead>
            <tbody>
              {preview.perPeriodDeltas.map((d) => (
                <tr key={d.periodEnd}>
                  <td style={cellStyle}>{d.label}</td>
                  <td style={cellStyle}>{d.originalAmount}</td>
                  <td style={cellStyle}>{d.correctedAmount}</td>
                  <td style={cellStyle}>{d.delta}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            <strong>Cumulative delta: {preview.cumulativeDelta}</strong>
          </p>

          <label style={labelStyle}>
            Election
            <select
              value={election}
              onChange={(e) => setElection(e.target.value as "PROSPECTIVE" | "RETROSPECTIVE")}
              style={inputStyle}
            >
              <option value="RETROSPECTIVE">Retrospective (restate closed periods)</option>
              <option value="PROSPECTIVE">Prospective (single catch-up entry, closed periods untouched)</option>
            </select>
          </label>

          {election === "PROSPECTIVE" && (
            <label style={labelStyle}>
              Current open period end (where the single catch-up entry posts)
              <input
                type="date"
                value={currentOpenPeriodEnd}
                onChange={(e) => setCurrentOpenPeriodEnd(e.target.value)}
                style={inputStyle}
              />
            </label>
          )}

          <button onClick={handleCommit} disabled={status === "loading"} style={{ ...buttonStyle, background: "#fee2e2" }}>
            {status === "loading" ? "Committing…" : `Commit as ${election}`}
          </button>
        </div>
      )}

      {message && (
        <p style={{ color: status === "error" ? "crimson" : "#166534", marginTop: "0.5rem" }}>{message}</p>
      )}
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: "1px solid #333",
  borderRadius: 4,
  background: "#f5f5f5",
  cursor: "pointer",
};
const linkButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#1d4ed8",
  cursor: "pointer",
  padding: 0,
  font: "inherit",
};
const labelStyle: React.CSSProperties = { display: "block", margin: "0.75rem 0", fontSize: "0.9rem" };
const inputStyle: React.CSSProperties = { display: "block", width: "100%", padding: "0.4rem", marginTop: "0.25rem" };
const cellStyle: React.CSSProperties = { border: "1px solid #ccc", padding: "0.4rem", textAlign: "left" };
