"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * The only page src/middleware.ts lets through without a valid session — see that
 * file's PUBLIC_PATHS. `?next=` (set by the middleware's redirect) sends the user back
 * to whatever page they were trying to reach before being bounced here, defaulting to
 * the home page.
 */
export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setMessage(null);
    try {
      const res = await fetch("/api/auth/login", {
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
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 400, margin: "0 auto" }}>
      <h1>Debt &amp; Equity Platform</h1>
      <p style={{ color: "#555" }}>Sign in to view or manage your entities.</p>
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
        {message && <p style={{ color: "crimson", marginTop: "0.5rem" }}>{message}</p>}
      </form>
      <p style={{ color: "#888", fontSize: "0.85rem", marginTop: "1.5rem" }}>
        No account yet? An existing user with access to your entity needs to create one for
        you — see the README's "Real authentication and multi-tenancy" section. There's no
        public self-service sign-up on a financial app.
      </p>
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
