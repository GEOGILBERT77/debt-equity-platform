"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { theme } from "@/lib/theme";
import {
  TextField,
  TextAreaField,
  DateField,
  SelectField,
  primaryButtonStyle,
  labelStyle,
  inputStyle,
} from "@/app/components/termsFields/FieldPrimitives";

const CONSENT_TYPES = ["WRITTEN_CONSENT", "BOARD_MEETING"] as const;

/**
 * Admin-side form on entities/[id]/board-consents/page.tsx (v0.36.0): POSTs to
 * /api/entities/:id/board-consents to record a new board consent, optionally linking
 * it to one or more of this entity's instruments (the grants/issuances the consent
 * covers). See BoardConsent's doc comment in prisma/schema.prisma and the API route's
 * own doc comment for the load-bearing scope decision this rests on: this is a
 * governance/audit record, not an approval gate — recording one here doesn't change
 * any instrument's status.
 *
 * The instrument picker is a plain multi-select `<select multiple>` rather than a
 * fancier searchable widget — this app has no such component anywhere else yet (every
 * other picker in the codebase is a single-value `<select>`, see SelectField), and a
 * company's instrument count is small enough that a native multi-select is entirely
 * usable; worth revisiting if that stops being true.
 *
 * Calls `router.refresh()` on success rather than managing the consent list's state
 * itself — the parent page (a server component) re-fetches and re-renders, same
 * pattern as every other "create X, then refresh the list" flow in this app that
 * doesn't need optimistic UI (e.g. StakeholderRowActions.tsx).
 */
export function BoardConsentForm({
  entityId,
  instruments,
}: {
  entityId: string;
  instruments: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [consentType, setConsentType] = useState<(typeof CONSENT_TYPES)[number]>("WRITTEN_CONSENT");
  const [decisionDate, setDecisionDate] = useState(new Date().toISOString().slice(0, 10));
  const [selectedInstrumentIds, setSelectedInstrumentIds] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch(`/api/entities/${entityId}/board-consents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, consentType, decisionDate, instrumentIds: selectedInstrumentIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't record this board consent.");
      setTitle("");
      setDescription("");
      setConsentType("WRITTEN_CONSENT");
      setDecisionDate(new Date().toISOString().slice(0, 10));
      setSelectedInstrumentIds([]);
      setStatus("idle");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't record this board consent.");
      setStatus("error");
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{ border: `1px solid ${theme.border}`, borderRadius: 8, padding: "1.25rem", background: theme.surface, marginBottom: "1.5rem" }}
    >
      <h3 style={{ marginTop: 0 }}>Record a board consent</h3>
      <TextField label="Title" value={title} onChange={setTitle} placeholder="Approve Q3 option pool grants" />
      <TextAreaField
        label="Description"
        value={description}
        onChange={setDescription}
        placeholder="What the board approved, in the board's own words or a summary of the resolution."
      />
      <SelectField label="Type" value={consentType} options={CONSENT_TYPES} onChange={setConsentType} />
      <DateField label="Decision date" value={decisionDate} onChange={setDecisionDate} hint="The date the board actually acted, not today's date." />

      <label style={labelStyle}>
        Linked instruments (optional — the grants/issuances this consent covers)
        {instruments.length === 0 ? (
          <p style={{ color: theme.inkMuted, fontSize: "0.85rem", margin: "0.25rem 0 0" }}>
            No instruments recorded on this entity yet.
          </p>
        ) : (
          <select
            multiple
            value={selectedInstrumentIds}
            onChange={(e) => setSelectedInstrumentIds(Array.from(e.target.selectedOptions).map((o) => o.value))}
            style={{ ...inputStyle, height: "8rem" }}
          >
            {instruments.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
              </option>
            ))}
          </select>
        )}
      </label>

      {error && <p style={{ color: theme.danger.fg, fontSize: "0.85rem" }}>{error}</p>}
      <button type="submit" disabled={status === "saving" || !title || !description} style={primaryButtonStyle}>
        {status === "saving" ? "Saving…" : "Record consent"}
      </button>
    </form>
  );
}
