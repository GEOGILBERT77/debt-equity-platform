"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Inline rename/change-currency and delete controls for one row of the home page's
 * entity table (v0.18.0 — "editing/delete flows" pass). Backed by `PATCH`/`DELETE
 * /api/entities/:id` (see that route's doc comment for the access-level and
 * foreign-key-safety reasoning). Kept as a small client component embedded in the
 * home page's server component, rather than a separate "edit entity" page, since a
 * rename is a one-field, low-ceremony action that doesn't warrant a full page
 * navigation — contrast with creating an entity or an instrument, which stay full
 * pages because they involve more fields and, for an instrument, an entire bespoke
 * terms form.
 *
 * Delete only ever succeeds when the entity has no stakeholders/instruments/documents
 * left (the API enforces this; the confirm dialog here just sets expectations before
 * the request is even made) — this component doesn't attempt to also offer "delete
 * everything underneath it first," since a cascading multi-entity delete is exactly
 * the kind of destructive, hard-to-undo action this project's RESTRICT-everywhere
 * schema design (see prisma/schema.prisma's doc comment) deliberately makes you do
 * one deliberate step at a time.
 */
export function EntityRowActions({
  entityId,
  initialName,
  initialReportingCurrency,
}: {
  entityId: string;
  initialName: string;
  initialReportingCurrency: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initialName);
  const [reportingCurrency, setReportingCurrency] = useState(initialReportingCurrency);
  const [status, setStatus] = useState<"idle" | "saving" | "deleting" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleSave() {
    setStatus("saving");
    setMessage(null);
    try {
      const res = await fetch(`/api/entities/${entityId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, reportingCurrency }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Failed to save changes");
        return;
      }
      setStatus("idle");
      setEditing(false);
      router.refresh();
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to save changes");
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete "${initialName}"? This only works if it has no stakeholders, instruments, or documents left.`)) {
      return;
    }
    setStatus("deleting");
    setMessage(null);
    try {
      const res = await fetch(`/api/entities/${entityId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Failed to delete");
        return;
      }
      router.refresh();
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  if (!editing) {
    return (
      <span style={{ fontSize: "0.85rem" }}>
        <button type="button" onClick={() => setEditing(true)} style={linkButtonStyle}>
          Edit
        </button>{" "}
        <button type="button" onClick={handleDelete} disabled={status === "deleting"} style={{ ...linkButtonStyle, color: "#a33" }}>
          {status === "deleting" ? "Deleting…" : "Delete"}
        </button>
        {message && <div style={{ color: "crimson", fontSize: "0.78rem" }}>{message}</div>}
      </span>
    );
  }

  return (
    <span style={{ display: "inline-flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
      <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={smallInputStyle} />
      <input
        type="text"
        value={reportingCurrency}
        onChange={(e) => setReportingCurrency(e.target.value)}
        style={{ ...smallInputStyle, width: "4.5rem" }}
      />
      <button type="button" onClick={handleSave} disabled={status === "saving"} style={smallButtonStyle}>
        {status === "saving" ? "Saving…" : "Save"}
      </button>
      <button
        type="button"
        onClick={() => {
          setEditing(false);
          setName(initialName);
          setReportingCurrency(initialReportingCurrency);
          setMessage(null);
        }}
        style={smallButtonStyle}
      >
        Cancel
      </button>
      {message && <span style={{ color: "crimson", fontSize: "0.78rem" }}>{message}</span>}
    </span>
  );
}

const linkButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#2563eb",
  cursor: "pointer",
  padding: 0,
  fontSize: "0.85rem",
  textDecoration: "underline",
};
const smallInputStyle: React.CSSProperties = { padding: "0.25rem", fontSize: "0.85rem", width: "8rem" };
const smallButtonStyle: React.CSSProperties = {
  padding: "0.2rem 0.5rem",
  border: "1px solid #999",
  borderRadius: 4,
  background: "#fff",
  cursor: "pointer",
  fontSize: "0.8rem",
};
