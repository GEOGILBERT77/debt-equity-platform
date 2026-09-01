"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

const STAKEHOLDER_TYPES = ["INVESTOR", "DEBT_HOLDER", "EMPLOYEE", "ADVISOR", "ENTITY_HOLDER"] as const;

/** Adds an investor, debt holder, employee, or advisor to an entity — see
 * src/app/api/entities/[id]/stakeholders/route.ts. Requires ?entityId=... since a
 * stakeholder always belongs to exactly one entity. */
export default function NewStakeholderPage() {
  const router = useRouter();
  const entityId = useSearchParams().get("entityId");

  const [name, setName] = useState("");
  const [type, setType] = useState<(typeof STAKEHOLDER_TYPES)[number]>("INVESTOR");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  if (!entityId) {
    return (
      <main style={{ fontFamily: "sans-serif", padding: "2rem" }}>
        <p>
          Pass <code>?entityId=...</code>, or go to <Link href="/">the entity list</Link> and use "Add a
          stakeholder" from a specific entity's cap table.
        </p>
      </main>
    );
  }

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
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 500 }}>
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
        {message && <p style={{ color: "crimson", marginTop: "0.5rem" }}>{message}</p>}
      </form>
    </main>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: "1px solid #333",
  borderRadius: 4,
  background: "#f5f5f5",
  cursor: "pointer",
};
const labelStyle: React.CSSProperties = { display: "block", margin: "0.75rem 0", fontSize: "0.9rem" };
const inputStyle: React.CSSProperties = { display: "block", width: "100%", padding: "0.4rem", marginTop: "0.25rem" };
