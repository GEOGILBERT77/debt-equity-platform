"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { theme } from "@/lib/theme";

type CloseAllResult = {
  totalInstruments: number;
  committedCount: number;
  nothingToCloseCount: number;
  errorCount: number;
  results: (
    | { status: "committed"; instrumentId: string; periodsClosedCount: number; closedThrough: string }
    | { status: "nothing-to-close"; instrumentId: string }
    | { status: "error"; instrumentId: string; message: string }
  )[];
};

/**
 * Entity-wide counterpart to CloseInstrumentButton.tsx — runs POST
 * /api/entities/:id/close, which closes every instrument in this entity through today
 * in one action instead of opening each instrument's own page. Built directly for the
 * requirement that "each company must have the ability to use the accounting engines
 * to build schedules for each instrument's accounting treatment, that are stored and
 * recoverable in reporting" — this is that ability, at the company (entity) level
 * rather than one instrument at a time. See closeInstrument.ts's doc comment for why a
 * failure on one instrument doesn't block the others — this component reflects that by
 * showing a real per-instrument breakdown, not just one pass/fail message.
 */
export function CloseAllInstrumentsButton({ entityId }: { entityId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<CloseAllResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleClose() {
    setStatus("loading");
    setResult(null);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/entities/${entityId}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ through: new Date().toISOString().slice(0, 10) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setErrorMessage(data.error ?? "Close failed");
        return;
      }
      setStatus("done");
      setResult(data);
      router.refresh(); // re-run the server component so reports/pages reading closed data update
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Close failed");
    }
  }

  const errors = result?.results.filter((r) => r.status === "error") ?? [];

  return (
    <div style={{ margin: "1rem 0" }}>
      <button onClick={handleClose} disabled={status === "loading"} style={buttonStyle}>
        {status === "loading" ? "Closing all instruments…" : "Close all instruments through today"}
      </button>
      {status === "error" && errorMessage && <p style={{ color: theme.danger.fg, marginTop: "0.5rem" }}>{errorMessage}</p>}
      {status === "done" && result && (
        <div style={{ marginTop: "0.5rem", fontSize: "0.9rem" }}>
          <p style={{ color: theme.success.fg, margin: "0 0 0.25rem" }}>
            {result.committedCount} instrument(s) closed with new periods, {result.nothingToCloseCount} already
            up to date, {result.errorCount} failed — out of {result.totalInstruments} total.
          </p>
          {errors.length > 0 && (
            <ul style={{ color: theme.danger.fg, margin: 0 }}>
              {errors.map((e) => (
                <li key={e.instrumentId}>
                  <Link href={`/instruments/${e.instrumentId}`}>{e.instrumentId}</Link>: {(e as { message: string }).message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: `1px solid ${theme.border}`,
  borderRadius: 4,
  background: theme.surfaceAlt,
  cursor: "pointer",
};
