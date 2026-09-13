"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ApproveAllAmortizationSchedulesButton } from "@/app/components/ApproveAllAmortizationSchedulesButton";
import { theme } from "@/lib/theme";
import { ListingTable } from "@/app/components/ListingTable";

type RowResult = { rowNumber: number; status: "created" | "error"; granteeName?: string; message?: string };
type UploadResponse = { totalRows: number; createdCount: number; errorCount: number; results: RowResult[] };

const LABELS: Record<string, string> = {
  STOCK_OPTION: "stock option",
  RSU: "RSU",
  RESTRICTED_STOCK: "restricted stock",
};

/**
 * The interactive half of the bulk-upload page (see
 * instruments/bulk-upload/page.tsx) — posts the chosen .xlsx file as
 * multipart/form-data to POST /api/entities/:id/instruments/bulk-upload and renders
 * the per-row breakdown it returns (see that route's doc comment for why it's a
 * breakdown rather than one pass/fail message).
 *
 * A row created here is NOT yet included in any report — per the "approve before
 * going live" requirement, the whole batch gets exactly ONE approval gate rather than
 * a per-row auto-approval: once the upload finishes, this shows an
 * ApproveAllAmortizationSchedulesButton right in the results panel so reviewing and
 * approving the batch is the very next, obvious action instead of a separate trip to
 * the amortization report.
 */
export function BulkUploadStockOptionsForm({ entityId, type }: { entityId: string; type: string }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [result, setResult] = useState<UploadResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setStatus("error");
      setErrorMessage("Choose a file first.");
      return;
    }

    setStatus("uploading");
    setErrorMessage(null);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/entities/${entityId}/instruments/bulk-upload?type=${type}`, { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setErrorMessage(data.error ?? "Upload failed");
        return;
      }
      setStatus("done");
      setResult(data);
      router.refresh();
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Upload failed");
    }
  }

  return (
    <div>
      <form onSubmit={handleSubmit}>
        <input ref={fileInputRef} type="file" accept=".xlsx" style={{ display: "block", marginBottom: "0.75rem" }} />
        <button type="submit" disabled={status === "uploading"} style={buttonStyle}>
          {status === "uploading" ? "Uploading…" : "Upload"}
        </button>
      </form>
      {status === "error" && errorMessage && <p style={{ color: theme.danger.fg, marginTop: "0.75rem" }}>{errorMessage}</p>}
      {status === "done" && result && (
        <div style={{ marginTop: "1rem" }}>
          <p style={{ color: result.errorCount > 0 ? theme.warning.fg : theme.success.fg }}>
            {result.createdCount} of {result.totalRows} row(s) created
            {result.errorCount > 0 && `, ${result.errorCount} failed`}.
          </p>
          <ListingTable
            columns={[{ label: "Row", align: "right" }, { label: "Grantee" }, { label: "Result" }]}
            rows={result.results.map((r) => ({
              key: r.rowNumber,
              cells: [
                r.rowNumber,
                r.granteeName ?? "—",
                <span style={{ color: r.status === "created" ? theme.success.fg : theme.danger.fg }}>
                  {r.status === "created" ? "Created" : r.message}
                </span>,
              ],
            }))}
          />
          {result.createdCount > 0 && (
            <div style={{ marginTop: "1rem", padding: "0.75rem", border: `1px solid ${theme.border}`, borderRadius: 4 }}>
              <p style={{ margin: "0 0 0.5rem", fontWeight: 600 }}>Next step: review and approve this batch</p>
              <p style={{ color: theme.inkMuted, margin: "0 0 0.5rem", fontSize: "0.9rem" }}>
                These {result.createdCount} grant(s) won't show up in any report until approved. Approving puts
                the whole batch live at once — you don't need to open each grant individually.
              </p>
              <ApproveAllAmortizationSchedulesButton entityId={entityId} type={type} label={LABELS[type] ?? type} />
            </div>
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