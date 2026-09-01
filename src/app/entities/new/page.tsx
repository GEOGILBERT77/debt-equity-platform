"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The first step of the data-entry flow this front end was missing entirely until
 * now: previously the only way to add an Entity was db/seed.sql or a direct SQL
 * insert via Supabase's Table Editor (see the note this removes from
 * src/app/page.tsx). Posts to POST /api/entities, then sends you straight to that
 * entity's cap table, where "Add a stakeholder" is the natural next step.
 */
export default function NewEntityPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [reportingCurrency, setReportingCurrency] = useState("USD");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setMessage(null);
    try {
      const res = await fetch("/api/entities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, reportingCurrency }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Failed to create entity");
        return;
      }
      router.push(`/captable?entityId=${data.entity.id}`);
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to create entity");
    }
  }

  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 500 }}>
      <p>
        <Link href="/">&larr; All entities</Link>
      </p>
      <h1>New entity</h1>
      <form onSubmit={handleSubmit}>
        <label style={labelStyle}>
          Name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required style={inputStyle} />
        </label>
        <label style={labelStyle}>
          Reporting currency
          <input
            type="text"
            value={reportingCurrency}
            onChange={(e) => setReportingCurrency(e.target.value.toUpperCase())}
            maxLength={3}
            style={inputStyle}
          />
        </label>
        <button type="submit" disabled={status === "loading"} style={buttonStyle}>
          {status === "loading" ? "Creating…" : "Create entity"}
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
