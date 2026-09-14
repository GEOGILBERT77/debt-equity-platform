"use client";

import { useState, FormEvent } from "react";
import { theme, statusPillStyle } from "@/lib/theme";

interface AnalysisResult {
  id: string;
  status: "PENDING" | "ANALYZING" | "ANALYZED" | "FAILED";
  identifiedInstrumentType: string | null;
  confidence: string | null;
  summary: string | null;
  keyTerms: Record<string, string> | null;
  ascReferences: Array<{ reference: string; relevance: string }> | null;
  initialTreatment: string | null;
  subsequentTreatment: string | null;
  openQuestions: string[] | null;
  memoDraft: string | null;
  errorMessage: string | null;
}

/**
 * The "run AI analysis" action + result display for one DocumentVersion (see
 * src/app/documents/[id]/analysis/page.tsx). George, verbatim: "user should be able to
 * select whether a memo draft is required, since not all option grants need a memo" —
 * that's the checkbox below, sent as-is to `POST /api/document-versions/:id/analyze`.
 *
 * The route runs synchronously and returns the FINAL result in its response (see that
 * route's own doc comment on why — no background job runner exists in this app yet),
 * so this component just shows a "Analyzing…" state for the duration of the fetch —
 * no polling loop needed.
 *
 * DISCLAIMER: every result rendered here repeats, plainly, that this is an AI-
 * generated proposal for a human accountant to review — never a final determination,
 * and never something this app applies anywhere on its own (it doesn't create an
 * Instrument, a JournalEntry, or touch any accounting record).
 */
export function RunContractAnalysisForm({
  documentVersionId,
  pastAnalyses,
}: {
  documentVersionId: string;
  pastAnalyses: AnalysisResult[];
}) {
  const [memoRequested, setMemoRequested] = useState(false);
  const [additionalContext, setAdditionalContext] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<AnalysisResult[]>(pastAnalyses);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/document-versions/${documentVersionId}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memoRequested, additionalContext: additionalContext.trim() || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "Analysis request failed.");
        return;
      }
      setResults((prev) => [body.analysis, ...prev]);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
          padding: "1rem",
          border: `1px solid ${theme.border}`,
          borderRadius: 6,
          background: theme.surface,
          marginBottom: "1.5rem",
          maxWidth: 640,
        }}
      >
        <label style={{ fontSize: "0.9rem" }}>
          <input type="checkbox" checked={memoRequested} onChange={(e) => setMemoRequested(e.target.checked)} /> Draft a full
          technical accounting memo (not every grant needs one)
        </label>
        <label style={{ fontSize: "0.85rem", color: theme.inkMuted }}>
          Additional context for the reviewer (optional)
          <br />
          <textarea
            value={additionalContext}
            onChange={(e) => setAdditionalContext(e.target.value)}
            rows={2}
            style={{ width: "100%", padding: "0.4rem", border: `1px solid ${theme.border}`, borderRadius: 4, fontSize: "0.85rem" }}
            placeholder="e.g. this is a follow-on grant under the 2021 Plan"
          />
        </label>
        <button
          type="submit"
          disabled={running}
          style={{
            alignSelf: "flex-start",
            padding: "0.5rem 1rem",
            background: theme.primary,
            color: theme.onPrimary,
            border: "none",
            borderRadius: 4,
            cursor: running ? "default" : "pointer",
            fontWeight: 600,
          }}
        >
          {running ? "Analyzing… (this can take a minute)" : "Run AI analysis"}
        </button>
        {error && <span style={{ color: theme.danger.fg, fontSize: "0.85rem" }}>{error}</span>}
      </form>

      {results.length === 0 ? (
        <p style={{ color: theme.inkMuted }}>No analysis has been run against this document yet.</p>
      ) : (
        results.map((r) => <AnalysisResultCard key={r.id} result={r} />)
      )}
    </div>
  );
}

function AnalysisResultCard({ result }: { result: AnalysisResult }) {
  return (
    <div
      style={{
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        padding: "1rem",
        marginBottom: "1rem",
        background: theme.surface,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
        <span
          style={statusPillStyle(result.status === "ANALYZED" ? "success" : result.status === "FAILED" ? "danger" : "warning")}
        >
          {result.status}
        </span>
        {result.identifiedInstrumentType && <strong>{result.identifiedInstrumentType}</strong>}
        {result.confidence && <span style={{ color: theme.inkMuted, fontSize: "0.8rem" }}>({result.confidence} confidence)</span>}
      </div>

      {result.status === "FAILED" && <p style={{ color: theme.danger.fg }}>{result.errorMessage}</p>}

      {result.status === "ANALYZED" && (
        <>
          <p
            style={{
              fontSize: "0.75rem",
              color: theme.warning.fg,
              background: theme.warning.bg,
              padding: "0.5rem",
              borderRadius: 4,
              marginTop: 0,
            }}
          >
            This is an AI-generated proposal for a qualified accountant to review — not a final accounting determination.
            It is never applied automatically anywhere else in this app.
          </p>
          {result.summary && <p>{result.summary}</p>}
          {result.ascReferences && result.ascReferences.length > 0 && (
            <>
              <h4 style={{ marginBottom: "0.25rem" }}>ASC references</h4>
              <ul style={{ marginTop: 0 }}>
                {result.ascReferences.map((ref) => (
                  <li key={ref.reference}>
                    <strong>{ref.reference}</strong> — {ref.relevance}
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.initialTreatment && (
            <>
              <h4 style={{ marginBottom: "0.25rem" }}>Proposed initial treatment</h4>
              <p style={{ marginTop: 0 }}>{result.initialTreatment}</p>
            </>
          )}
          {result.subsequentTreatment && (
            <>
              <h4 style={{ marginBottom: "0.25rem" }}>Proposed subsequent treatment</h4>
              <p style={{ marginTop: 0 }}>{result.subsequentTreatment}</p>
            </>
          )}
          {result.keyTerms && Object.keys(result.keyTerms).length > 0 && (
            <>
              <h4 style={{ marginBottom: "0.25rem" }}>Key terms extracted</h4>
              <ul style={{ marginTop: 0 }}>
                {Object.entries(result.keyTerms).map(([k, v]) => (
                  <li key={k}>
                    <strong>{k}:</strong> {v}
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.openQuestions && result.openQuestions.length > 0 && (
            <>
              <h4 style={{ marginBottom: "0.25rem" }}>Open questions for the reviewer</h4>
              <ul style={{ marginTop: 0 }}>
                {result.openQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </>
          )}
          {result.memoDraft && (
            <>
              <h4 style={{ marginBottom: "0.25rem" }}>Draft memo</h4>
              <pre style={{ whiteSpace: "pre-wrap", fontFamily: theme.font.body, fontSize: "0.9rem", background: theme.surfaceAlt, padding: "0.75rem", borderRadius: 4 }}>
                {result.memoDraft}
              </pre>
            </>
          )}
        </>
      )}
    </div>
  );
}
