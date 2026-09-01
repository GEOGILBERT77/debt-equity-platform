"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Client component wrapping POST /api/instruments/:id/close. A plain button + fetch
 * rather than a server action, so the pending/error states are visible inline without
 * a full page reload until the call actually finishes — this is the one interactive
 * step in an otherwise read-only instrument page, and it's worth getting the feedback
 * right since it's the step that turns a live preview into a permanent, reported number.
 */
export function CloseInstrumentButton({ instrumentId }: { instrumentId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleClose() {
    setStatus("loading");
    setMessage(null);
    try {
      const res = await fetch(`/api/instruments/${instrumentId}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ through: new Date().toISOString().slice(0, 10) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Close failed");
        return;
      }
      setStatus("done");
      setMessage(
        data.committed
          ? `Closed ${data.periodsClosedCount} new period(s) through ${data.closedThrough}.`
          : data.message ?? "Nothing new to close."
      );
      router.refresh(); // re-run the server component so the persisted tables below update
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Close failed");
    }
  }

  return (
    <div style={{ margin: "1rem 0" }}>
      <button onClick={handleClose} disabled={status === "loading"} style={buttonStyle}>
        {status === "loading" ? "Closing…" : "Close through today"}
      </button>
      {message && (
        <p style={{ color: status === "error" ? "crimson" : "#166534", marginTop: "0.5rem" }}>{message}</p>
      )}
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: "1px solid #333",
  borderRadius: 4,
  background: "#f5f5f5",
  cursor: "pointer",
};
