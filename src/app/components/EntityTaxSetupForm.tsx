"use client";

import { useState } from "react";
import { TextField, smallButtonStyle } from "./termsFields/FieldPrimitives";
import { theme } from "@/lib/theme";

export interface StakeholderMissingTaxId {
  id: string;
  name: string;
}

/**
 * v0.33.0 — a real, usable form for the two setup steps a Form 3921 needs (the
 * entity's EIN/address, each stakeholder's TIN), replacing what would otherwise be a
 * message telling a non-technical user to call a PATCH API endpoint directly. Lives
 * on the option-tax-compliance report page's setup banner, shown only when something
 * is actually missing.
 *
 * SECURITY: taxIdNumber is a government SSN/EIN — see prisma/schema.prisma's doc
 * comment on Stakeholder.taxIdNumber. This form doesn't change that column's
 * plain-text storage; it's just the UI for setting it. The security work (field-level
 * encryption) is a separate, explicitly-flagged infra task.
 */
export default function EntityTaxSetupForm({
  entityId,
  entityEin,
  entityAddress,
  stakeholdersMissingTaxId,
}: {
  entityId: string;
  entityEin: string | null;
  entityAddress: string | null;
  stakeholdersMissingTaxId: StakeholderMissingTaxId[];
}) {
  const [ein, setEin] = useState(entityEin ?? "");
  const [address, setAddress] = useState(entityAddress ?? "");
  const [entityStatus, setEntityStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [entityError, setEntityError] = useState<string | null>(null);

  async function saveEntity() {
    setEntityStatus("saving");
    setEntityError(null);
    try {
      const res = await fetch(`/api/entities/${entityId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employerIdentificationNumber: ein, address }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save");
      setEntityStatus("saved");
    } catch (err) {
      setEntityError(err instanceof Error ? err.message : "Failed to save");
      setEntityStatus("error");
    }
  }

  return (
    <div>
      {(!entityEin || !entityAddress) && (
        <div style={{ marginBottom: "1rem" }}>
          <TextField label="Company EIN (e.g. 12-3456789)" value={ein} onChange={setEin} />
          <TextField label="Company address" value={address} onChange={setAddress} />
          <button onClick={saveEntity} disabled={entityStatus === "saving"} style={{ ...smallButtonStyle, marginTop: "0.5rem" }}>
            {entityStatus === "saving" ? "Saving..." : "Save company tax info"}
          </button>
          {entityStatus === "saved" && <span style={{ marginLeft: "0.5rem", color: theme.success.fg }}>Saved.</span>}
          {entityError && <p style={{ color: theme.danger.fg }}>{entityError}</p>}
        </div>
      )}
      {stakeholdersMissingTaxId.length > 0 && (
        <div>
          {stakeholdersMissingTaxId.map((s) => (
            <StakeholderTaxIdRow key={s.id} entityId={entityId} stakeholder={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function StakeholderTaxIdRow({ entityId, stakeholder }: { entityId: string; stakeholder: StakeholderMissingTaxId }) {
  const [taxIdNumber, setTaxIdNumber] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch(`/api/entities/${entityId}/stakeholders/${stakeholder.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taxIdNumber }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save");
      setStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
      setStatus("error");
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: "0.5rem", marginBottom: "0.5rem" }}>
      <span style={{ minWidth: 160 }}>{stakeholder.name}</span>
      <input
        type="text"
        placeholder="SSN or EIN"
        value={taxIdNumber}
        onChange={(e) => setTaxIdNumber(e.target.value)}
        style={{ padding: "0.4rem" }}
      />
      <button onClick={save} disabled={status === "saving" || !taxIdNumber} style={smallButtonStyle}>
        {status === "saving" ? "Saving..." : "Save"}
      </button>
      {status === "saved" && <span style={{ color: theme.success.fg }}>Saved.</span>}
      {error && <span style={{ color: theme.danger.fg }}>{error}</span>}
    </div>
  );
}
