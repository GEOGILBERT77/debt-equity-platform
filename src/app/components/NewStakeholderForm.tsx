"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { theme } from "@/lib/theme";

const STAKEHOLDER_TYPES = ["INVESTOR", "DEBT_HOLDER", "EMPLOYEE", "ADVISOR", "ENTITY_HOLDER"] as const;

/**
 * The actual interactive form for stakeholders/new/page.tsx (v0.36.0) — split out of
 * that page so the page itself could become a server component and pick up the same
 * "fall back to the user's default entity" redirect every other entity-scoped page has
 * had since v0.21.0 (see instruments/new/page.tsx's doc comment for the original
 * pattern this mirrors: a server component wrapper handling entityId/redirect, handing
 * off to a client component for the actual form). `entityId` is now a required prop
 * rather than read from `useSearchParams()` directly, since the wrapper page has
 * already resolved and validated it before this component ever renders.
 */
export function NewStakeholderForm({ entityId }: { entityId: string }) {
  const router = useRouter();

  const [name, setName] = useState("");
  const [type, setType] = useState<(typeof STAKEHOLDER_TYPES)[number]>("INVESTOR");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setMessage(null);
    try {
      const res = await fetch(`/api/entities/${entityId}/stakeholders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, type, email: email || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Failed to create stakeholder");
        return;
      }
      router.push(`/instruments/new?entityId=${entityId}&stakeholderId=${data.stakeholder.id}`);
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to create stakeholder");
    }
  }

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 500 }}>
      <p>
        <Link href={`/captable?entityId=${entityId}`}>&larr; Cap table</Link>
      </p>
      <h1>New stakeholder</h1>
      <form onSubmit={handleSubmit}>
        <label style={labelStyle}>
          Name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required style={inputStyle} />
        </label>
        <label style={labelStyle}>
          Type
          <select value={type} onChange={(e) => setType(e.target.value as typeof type)} style={inputStyle}>
            {STAKEHOLDER_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Email (optional)
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} />
        </label>
        <button type="submit" disabled={status === "loading"} style={buttonStyle}>
          {status === "loading" ? "Creating…" : "Create stakeholder, then add an instrument"}
        </button>
        {message && <p style={{ color: theme.danger.fg, marginTop: "0.5rem" }}>{message}</p>}
      </form>
    </main>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: `1px solid ${theme.ink}`,
  borderRadius: 4,
  background: theme.surfaceAlt,
  cursor: "pointer",
};
const labelStyle: React.CSSProperties = { display: "block", margin: "0.75rem 0", fontSize: "0.9rem" };
const inputStyle: React.CSSProperties = { display: "block", width: "100%", padding: "0.4rem", marginTop: "0.25rem" };
