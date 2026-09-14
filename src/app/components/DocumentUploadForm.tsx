"use client";

import { useRouter } from "next/navigation";
import { useState, FormEvent } from "react";
import { theme } from "@/lib/theme";

/**
 * Upload form for the document library (src/app/documents/page.tsx) — POSTs
 * multipart/form-data to `POST /api/entities/:id/documents`. `defaultStakeholderId`/
 * `defaultInstrumentId` let the page preselect a link (e.g. arriving here via
 * StakeholderDocumentsPanel's "+ Upload" link, which passes `?stakeholderId=`)
 * without this component needing to know anything about where it was linked from.
 *
 * Deliberately does NOT trigger AI analysis itself — a plain upload always just
 * retains the file. Running the analyzer is a separate, explicit action from the
 * document's own row (see the "Analyze" link into
 * /documents/[id]/analysis) so uploading something you just want on file never
 * silently spends an API call.
 */
export function DocumentUploadForm({
  entityId,
  stakeholders,
  instruments,
  defaultStakeholderId,
  defaultInstrumentId,
}: {
  entityId: string;
  stakeholders: { id: string; name: string }[];
  instruments: { id: string; type: string; stakeholderId: string }[];
  defaultStakeholderId?: string;
  defaultInstrumentId?: string;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [stakeholderId, setStakeholderId] = useState(defaultStakeholderId ?? "");
  const [instrumentId, setInstrumentId] = useState(defaultInstrumentId ?? "");
  const [status, setStatus] = useState<"idle" | "uploading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const visibleInstruments = stakeholderId ? instruments.filter((i) => i.stakeholderId === stakeholderId) : instruments;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file) {
      setError("Choose a file to upload.");
      return;
    }
    setStatus("uploading");
    setError(null);

    const formData = new FormData();
    formData.append("file", file);
    if (title.trim()) formData.append("title", title.trim());
    if (category.trim()) formData.append("category", category.trim());
    if (stakeholderId) formData.append("stakeholderId", stakeholderId);
    if (instrumentId) formData.append("instrumentId", instrumentId);

    const res = await fetch(`/api/entities/${entityId}/documents`, { method: "POST", body: formData });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus("error");
      setError(body.error ?? "Upload failed.");
      return;
    }
    setStatus("idle");
    setFile(null);
    setTitle("");
    setCategory("");
    router.refresh();
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "0.75rem",
        alignItems: "flex-end",
        padding: "1rem",
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        background: theme.surface,
        marginBottom: "1.5rem",
      }}
    >
      <div>
        <label style={labelStyle}>File</label>
        <br />
        <input
          type="file"
          accept=".pdf,.docx,.png,.jpg,.jpeg"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          style={{ fontSize: "0.85rem" }}
        />
      </div>
      <div>
        <label style={labelStyle}>Title (optional)</label>
        <br />
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={file?.name ?? "Untitled"} style={inputStyle} />
      </div>
      <div>
        <label style={labelStyle}>Category (optional)</label>
        <br />
        <input
          type="text"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Option Agreement, NDA, ..."
          style={inputStyle}
        />
      </div>
      <div>
        <label style={labelStyle}>Investor / stakeholder</label>
        <br />
        <select
          value={stakeholderId}
          onChange={(e) => {
            setStakeholderId(e.target.value);
            setInstrumentId("");
          }}
          style={inputStyle}
        >
          <option value="">Not linked to a specific investor</option>
          {stakeholders.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label style={labelStyle}>Instrument (optional)</label>
        <br />
        <select value={instrumentId} onChange={(e) => setInstrumentId(e.target.value)} style={inputStyle}>
          <option value="">Not linked to a specific instrument</option>
          {visibleInstruments.map((i) => (
            <option key={i.id} value={i.id}>
              {i.type} ({i.id.slice(0, 8)})
            </option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        disabled={status === "uploading"}
        style={{
          padding: "0.5rem 1rem",
          background: theme.primary,
          color: theme.onPrimary,
          border: "none",
          borderRadius: 4,
          cursor: status === "uploading" ? "default" : "pointer",
          fontWeight: 600,
        }}
      >
        {status === "uploading" ? "Uploading…" : "Upload"}
      </button>
      {error && <span style={{ color: theme.danger.fg, fontSize: "0.85rem" }}>{error}</span>}
    </form>
  );
}

const labelStyle: React.CSSProperties = { fontSize: "0.72rem", color: theme.inkMuted, fontWeight: 600 };
const inputStyle: React.CSSProperties = {
  padding: "0.4rem 0.5rem",
  border: `1px solid ${theme.border}`,
  borderRadius: 4,
  fontSize: "0.85rem",
  minWidth: 160,
};
