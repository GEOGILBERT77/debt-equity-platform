"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { theme } from "@/lib/theme";

/**
 * Stakeholder portal login (v0.35.0) — the one `/portal/**` page
 * `src/middleware.ts`'s portal branch lets through with no `portal_session` cookie.
 * Structurally identical to `src/app/login/page.tsx` (the admin login), posting to
 * `/api/portal/login` instead — see that route and `portalSession.ts` for why this is
 * a fully separate login system, not a shared one.
 */
export default function PortalLoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/portal";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setMessage(null);
    try {
      const res = await fetch("/api/portal/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Login failed");
        return;
      }
      router.push(next);
      router.refresh();
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Login failed");
    }
  }

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 400, margin: "0 auto" }}>
      <h1 style={{ fontFamily: theme.font.heading }}>Your holdings</h1>
      <p style={{ color: theme.inkMuted }}>Sign in to view your equity, vesting, and grant history.</p>
      <form onSubmit={handleSubmit}>
        <label style={labelStyle}>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={inputStyle}
          />
        </label>
        <button type="submit" disabled={status === "loading"} style={buttonStyle}>
          {status === "loading" ? "Signing in…" : "Sign in"}
        </button>
        {message && <p style={{ color: theme.danger.fg, marginTop: "0.5rem" }}>{message}</p>}
      </form>
      <p style={{ color: theme.inkMuted, fontSize: "0.85rem", marginTop: "1.5rem" }}>
        No account yet? The company you hold equity or debt with needs to send you an invite link first — there's
        no public self-service sign-up here.
      </p>
    </main>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: "none",
  borderRadius: 6,
  background: theme.primary,
  color: theme.onPrimary,
  fontWeight: 600,
  cursor: "pointer",
};
const labelStyle: React.CSSProperties = { display: "block", margin: "0.75rem 0", fontSize: "0.9rem", color: theme.ink };
const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "0.5rem 0.6rem",
  marginTop: "0.3rem",
  border: `1px solid ${theme.border}`,
  borderRadius: 6,
  background: theme.surface,
  color: theme.ink,
};
