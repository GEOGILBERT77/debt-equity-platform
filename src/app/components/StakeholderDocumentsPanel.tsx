"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { theme, statusPillStyle } from "@/lib/theme";

interface PanelDocument {
  id: string;
  title: string;
  category: string | null;
  instrument: { id: string; type: string } | null;
  versions: { id: string; status: string; versionNumber: number }[];
  contractAnalyses: { id: string; status: string; identifiedInstrumentType: string | null }[];
}

/**
 * George, verbatim: "ideally, we can click on an investor in the cap table, for
 * instance, and a pane on the right shows up and shows currently retained
 * documentation." This is that pane — a fixed slide-out on the right edge of the
 * screen, fetching `GET /api/stakeholders/:id/documents` (union of documents linked
 * directly to the stakeholder and documents linked to any instrument they hold — see
 * that route's own doc comment) the first time it's opened.
 *
 * Deliberately fetches lazily (only once `open` first becomes true), not on every
 * page load that happens to render a trigger for this stakeholder — most cap table
 * rows are never clicked in a given session, so eagerly fetching every row's documents
 * up front would be a lot of wasted queries for a rarely-used panel.
 *
 * Read-only by design: uploading happens on the document library page
 * (documents/page.tsx), which this panel deep-links to with `?stakeholderId=`
 * preselected via its own "+ Upload" link, rather than duplicating the upload form
 * inside this narrow side panel.
 */
export function StakeholderDocumentsPanel({
  entityId,
  stakeholderId,
  stakeholderName,
  open,
  onClose,
}: {
  entityId: string;
  stakeholderId: string;
  stakeholderName: string;
  open: boolean;
  onClose: () => void;
}) {
  const [documents, setDocuments] = useState<PanelDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(false);

  useEffect(() => {
    if (!open || hasFetched) return;
    setHasFetched(true);
    fetch(`/api/stakeholders/${stakeholderId}/documents`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Failed to load documents.");
        setDocuments(body.documents);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load documents."));
  }, [open, hasFetched, stakeholderId]);

  if (!open) return null;

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(28,39,51,0.35)", zIndex: 40 }}
      />
      <div
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: 420,
          maxWidth: "90vw",
          background: theme.surface,
          borderLeft: `1px solid ${theme.border}`,
          boxShadow: "-4px 0 16px rgba(0,0,0,0.12)",
          zIndex: 41,
          padding: "1.5rem",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h2 style={{ margin: 0 }}>{stakeholderName}</h2>
            <p style={{ margin: "0.25rem 0 0", color: theme.inkMuted, fontSize: "0.85rem" }}>Documents on file</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: "none", border: "none", fontSize: "1.3rem", cursor: "pointer", color: theme.inkMuted }}
          >
            ×
          </button>
        </div>

        <p style={{ marginTop: "1rem" }}>
          <Link href={`/documents?entityId=${entityId}&stakeholderId=${stakeholderId}`}>+ Upload a document for {stakeholderName}</Link>
        </p>

        {error && <p style={{ color: theme.danger.fg }}>{error}</p>}
        {!error && documents === null && <p style={{ color: theme.inkMuted }}>Loading…</p>}
        {documents !== null && documents.length === 0 && <p style={{ color: theme.inkMuted }}>Nothing retained for this investor yet.</p>}

        {documents?.map((doc) => {
          const latestVersion = doc.versions[0];
          const latestAnalysis = doc.contractAnalyses[0];
          return (
            <div key={doc.id} style={{ borderTop: `1px solid ${theme.border}`, padding: "0.75rem 0" }}>
              <div style={{ fontWeight: 600 }}>{doc.title}</div>
              <div style={{ fontSize: "0.8rem", color: theme.inkMuted }}>
                {doc.category ?? "Uncategorized"}
                {doc.instrument && <> · {doc.instrument.type}</>}
              </div>
              <div style={{ marginTop: "0.4rem", display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
                {latestVersion && (
                  <a href={`/api/documents/${doc.id}/download`} target="_blank" rel="noreferrer" style={{ fontSize: "0.85rem" }}>
                    Download
                  </a>
                )}
                <Link href={`/documents/${doc.id}/analysis`} style={{ fontSize: "0.85rem" }}>
                  Analysis
                </Link>
                {latestAnalysis && (
                  <span style={statusPillStyle(latestAnalysis.status === "ANALYZED" ? "success" : latestAnalysis.status === "FAILED" ? "danger" : "warning")}>
                    {latestAnalysis.status}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
