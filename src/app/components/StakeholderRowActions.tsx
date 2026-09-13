"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { theme } from "@/lib/theme";

const STAKEHOLDER_TYPES = ["INVESTOR", "DEBT_HOLDER", "EMPLOYEE", "ADVISOR", "ENTITY_HOLDER"] as const;
const INVESTOR_TYPES = ["INDIVIDUAL", "INSTITUTION"] as const;

/**
 * Inline edit/delete controls for one row of the cap table page's stakeholder table —
 * same pattern and reasoning as `EntityRowActions.tsx`, backed by `PATCH`/`DELETE
 * /api/entities/:entityId/stakeholders/:stakeholderId`. Delete is blocked (by the API,
 * with a clean message surfaced here) whenever this stakeholder still holds any
 * instruments — see that route's doc comment for why reassigning an instrument to a
 * different stakeholder isn't supported instead.
 *
 * v0.44.0 — added Phone/Mailing address (previously not editable anywhere in the UI
 * despite the API already accepting them) plus Investor type/Point of contact for the
 * "Investor Contacts" page (src/app/investors/contacts/page.tsx) — same conditional
 * "only for INVESTOR/ENTITY_HOLDER" visibility as NewStakeholderForm.tsx; see that
 * component's doc comment for the full reasoning.
 */
export function StakeholderRowActions({
  entityId,
  stakeholderId,
  initialName,
  initialType,
  initialEmail,
  initialPhone,
  initialAddress,
  initialInvestorType,
  initialContactName,
  hasInstruments,
}: {
  entityId: string;
  stakeholderId: string;
  initialName: string;
  initialType: (typeof STAKEHOLDER_TYPES)[number];
  initialEmail: string;
  initialPhone: string;
  initialAddress: string;
  initialInvestorType: (typeof INVESTOR_TYPES)[number] | "";
  initialContactName: string;
  hasInstruments: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initialName);
  const [type, setType] = useState(initialType);
  const [email, setEmail] = useState(initialEmail);
  const [phone, setPhone] = useState(initialPhone);
  const [address, setAddress] = useState(initialAddress);
  const [investorType, setInvestorType] = useState(initialInvestorType);
  const [contactName, setContactName] = useState(initialContactName);
  const [status, setStatus] = useState<"idle" | "saving" | "deleting" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const showInvestorFields = type === "INVESTOR" || type === "ENTITY_HOLDER";

  async function handleSave() {
    setStatus("saving");
    setMessage(null);
    try {
      const res = await fetch(`/api/entities/${entityId}/stakeholders/${stakeholderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          type,
          email: email || null,
          phone: phone || null,
          address: address || null,
          investorType: showInvestorFields ? investorType || null : null,
          contactName: showInvestorFields ? contactName || null : null,
        }),
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
    if (hasInstruments) {
      setMessage("This stakeholder still holds at least one instrument — remove those first.");
      setStatus("error");
      return;
    }
    if (!window.confirm(`Delete stakeholder "${initialName}"?`)) return;
    setStatus("deleting");
    setMessage(null);
    try {
      const res = await fetch(`/api/entities/${entityId}/stakeholders/${stakeholderId}`, { method: "DELETE" });
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
        <button
          type="button"
          onClick={handleDelete}
          disabled={status === "deleting"}
          title={hasInstruments ? "Still holds instruments — remove those first" : undefined}
          style={{ ...linkButtonStyle, color: hasInstruments ? theme.inkMuted : theme.danger.fg }}
        >
          {status === "deleting" ? "Deleting…" : "Delete"}
        </button>
        {message && <div style={{ color: theme.danger.fg, fontSize: "0.78rem" }}>{message}</div>}
      </span>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", maxWidth: 240 }}>
      <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={smallInputStyle} />
      <select value={type} onChange={(e) => setType(e.target.value as typeof type)} style={smallInputStyle}>
        {STAKEHOLDER_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <input type="email" placeholder="email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} style={smallInputStyle} />
      <input type="tel" placeholder="phone (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} style={smallInputStyle} />
      <textarea
        placeholder="mailing address (optional)"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        rows={2}
        style={{ ...smallInputStyle, resize: "vertical" }}
      />
      {showInvestorFields && (
        <>
          <select
            value={investorType}
            onChange={(e) => setInvestorType(e.target.value as typeof investorType)}
            style={smallInputStyle}
          >
            <option value="">Investor type: not set</option>
            <option value="INDIVIDUAL">Investor type: individual</option>
            <option value="INSTITUTION">Investor type: institution</option>
          </select>
          <input
            type="text"
            placeholder="point of contact (optional)"
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            style={smallInputStyle}
          />
        </>
      )}
      <div style={{ display: "flex", gap: "0.4rem" }}>
        <button type="button" onClick={handleSave} disabled={status === "saving"} style={smallButtonStyle}>
          {status === "saving" ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setName(initialName);
            setType(initialType);
            setEmail(initialEmail);
            setPhone(initialPhone);
            setAddress(initialAddress);
            setInvestorType(initialInvestorType);
            setContactName(initialContactName);
            setMessage(null);
          }}
          style={smallButtonStyle}
        >
          Cancel
        </button>
      </div>
      {message && <span style={{ color: theme.danger.fg, fontSize: "0.78rem" }}>{message}</span>}
    </div>
  );
}

const linkButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: theme.accent,
  cursor: "pointer",
  padding: 0,
  fontSize: "0.85rem",
  textDecoration: "underline",
};
const smallInputStyle: React.CSSProperties = { padding: "0.25rem", fontSize: "0.85rem" };
const smallButtonStyle: React.CSSProperties = {
  padding: "0.2rem 0.5rem",
  border: `1px solid ${theme.border}`,
  borderRadius: 4,
  background: theme.surface,
  cursor: "pointer",
  fontSize: "0.8rem",
};
