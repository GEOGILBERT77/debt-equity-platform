"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { theme } from "@/lib/theme";

type ApproveAllResult = {
  totalInstruments: number;
  approvedCount: number;
  skippedCount: number;
  errorCount: number;
  results: {
    instrumentId: string;
    stakeholderName: string;
    status: "approved" | "skipped-current" | "error";
    message?: string;
  }[];
};

/**
 * Entity-wide counterpart to ApproveAmortizationScheduleButton.tsx — runs POST
 * /api/entities/:id/amortization-schedule/approve-all, approving every instrument of
 * `type` in this entity that needs it in ONE action. This is what makes "approval
 * before going live" practical at volume instead of a real burden: a batch of
 * bulk-uploaded grants gets exactly one approval click covering the whole batch (see
 * BulkUploadStockOptionsForm.tsx, which renders this button right after an upload),
 * and it doubles as the catch-all on the amortization report for anything entered
 * individually and not yet approved.
 */
export function ApproveAllAmortizationSchedulesButton({ entityId, type, label }: { entityId: string; type: string; label: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<ApproveAllResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleApproveAll() {
    setStatus("loading");
    setResult(null);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/entities/${entityId}/amortization-schedule/approve-all?type=${type}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setErrorMessage(data.error ?? "Approve-all failed");
        return;
      }
      setStatus("done");
      setResult(data);
      router.refresh(); // re-run the server component so the aggregate report below updates
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Approve-all failed");
    }
  }

  const errors = result?.results.filter((r) => r.status === "error") ?? [];

  return (
    <div style={{ margin: "1rem 0" }}>
      <button onClick={handleApproveAll} disabled={status === "loading"} style={buttonStyle}>
        {status === "loading" ? `Approving all ${label}…` : `Approve all ${label} amortization schedules`}
      </button>
      {status === "error" && errorMessage && <p style={{ color: theme.danger.fg, marginTop: "0.5rem" }}>{errorMessage}</p>}
      {status === "done" && result && (
        <div style={{ marginTop: "0.5rem", fontSize: "0.9rem" }}>
          <p style={{ color: theme.success.fg, margin: "0 0 0.25rem" }}>
            {result.approvedCount} approved, {result.skippedCount} already current, {result.errorCount} failed — out
            of {result.totalInstruments} total.
          </p>
          {errors.length > 0 && (
            <ul style={{ color: theme.danger.fg, margin: 0 }}>
              {errors.map((e) => (
                <li key={e.instrumentId}>
                  <Link href={`/instruments/${e.instrumentId}`}>{e.stakeholderName}</Link>: {e.message}
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
