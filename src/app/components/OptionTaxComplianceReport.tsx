"use client";

import { useState } from "react";
import { DecimalField, DateField, smallButtonStyle, labelStyle, inputStyle } from "./termsFields/FieldPrimitives";
import { theme } from "@/lib/theme";
import { ListingTable } from "./ListingTable";

/** FieldPrimitives.tsx's own SelectField is generic over a plain `readonly T[]` of
 * option VALUES, rendered as their own display text — it has no room for a separate
 * human-readable label per option, which an instrument/exercise picker (id as value,
 * "Jane Doe — granted 2025-01-01" as what's shown) genuinely needs. Rather than widen
 * that shared primitive for this one feature's shape, this is a small local
 * equivalent that matches its visual style. */
function LabeledSelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label style={labelStyle}>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface InstrumentOption {
  id: string;
  label: string;
}

interface ReportRow {
  filingType: "FORM_3921" | "W2_NSO_EXERCISE_INCOME" | "W2_ISO_DISQUALIFYING_DISPOSITION" | "ELECTION_83B_DEADLINE";
  taxYear: number;
  stakeholderId: string;
  instrumentId: string;
  exerciseEventId: string | null;
  description: string;
  amount: string | null;
  deadline: string | null;
  dueThisMonth: boolean;
  overdue: boolean;
  taxFilingRecordId: string | null;
  status: "PENDING" | "FILED" | "NOT_REQUIRED";
}

const FILING_TYPE_LABELS: Record<ReportRow["filingType"], string> = {
  FORM_3921: "Form 3921 (ISO exercise)",
  W2_NSO_EXERCISE_INCOME: "W-2 flag: NSO exercise income",
  W2_ISO_DISQUALIFYING_DISPOSITION: "W-2 flag: disqualifying disposition",
  ELECTION_83B_DEADLINE: "83(b) election deadline",
};

interface ExerciseOption {
  id: string;
  label: string;
}

/**
 * v0.33.0 — client half of the stock option tax/compliance report. Three jobs in one
 * component: (1) run/re-run the monthly report for a chosen month
 * (POST /api/reports/option-tax-compliance), (2) record the raw events the report
 * reads from (an option exercise, and optionally a later disposition of ISO shares),
 * (3) let a user mark a computed obligation FILED/NOT_REQUIRED and download a Form
 * 3921 PDF where one applies.
 *
 * Deliberately does NOT let a user hand-edit which obligations exist — those are
 * always DERIVED from recorded exercises/dispositions server-side (see
 * optionTaxCompliance.ts), never typed in directly. The only human judgment call this
 * UI exposes is the FILED/NOT_REQUIRED status itself, which is exactly the one thing
 * this platform genuinely cannot observe on its own (see TaxFilingRecord's schema doc
 * comment).
 */
export default function OptionTaxComplianceReport({
  entityId,
  instruments,
  initialMonth,
}: {
  entityId: string;
  instruments: InstrumentOption[];
  initialMonth: string;
}) {
  const [targetMonth, setTargetMonth] = useState(initialMonth);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [iso100kRuleSkipped, setIso100kRuleSkipped] = useState(false);

  async function runReport(month: string) {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/reports/option-tax-compliance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId, targetMonth: month }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to build the report");
      setRows(data.rows);
      setIso100kRuleSkipped(Boolean(data.iso100kRuleSkipped));
      setStatus("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to build the report");
      setStatus("error");
    }
  }

  async function markStatus(recordId: string, newStatus: ReportRow["status"]) {
    const res = await fetch(`/api/tax-filing-records/${recordId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    if (res.ok) {
      setRows((prev) => prev?.map((r) => (r.taxFilingRecordId === recordId ? { ...r, status: newStatus } : r)) ?? null);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: "1rem", marginBottom: "1rem" }}>
        <label style={{ fontSize: "0.9rem" }}>
          Report month
          <input
            type="month"
            value={targetMonth}
            onChange={(e) => setTargetMonth(e.target.value)}
            style={{ display: "block", padding: "0.4rem", marginTop: "0.25rem" }}
          />
        </label>
        <button onClick={() => runReport(targetMonth)} disabled={status === "loading"} style={smallButtonStyle}>
          {status === "loading" ? "Running..." : "Run report"}
        </button>
      </div>

      {error && <p style={{ color: theme.danger.fg }}>{error}</p>}

      {iso100kRuleSkipped && (
        <p style={{ color: theme.warning.fg, fontSize: "0.9rem" }}>
          Note: at least one ISO grant here uses a performance or market vesting condition, which has no
          tranche-level vest schedule on file — the $100k rule couldn&apos;t be applied to its exercises, so they&apos;re
          treated as fully ISO-qualified. Review those manually.
        </p>
      )}

      {rows && (
        <div style={{ marginBottom: "2rem" }}>
          <ListingTable
            emptyMessage="No filing obligations on file yet — record an option exercise below to get started."
            columns={[
              { label: "Filing" },
              { label: "Tax year" },
              { label: "Description" },
              { label: "Amount", align: "right" },
              { label: "Deadline" },
              { label: "Status" },
              { label: "" },
            ]}
            rows={rows.map((r, i) => ({
              key: `${r.exerciseEventId ?? r.instrumentId}-${r.filingType}-${r.taxYear}-${i}`,
              cells: [
                FILING_TYPE_LABELS[r.filingType],
                r.taxYear,
                r.description,
                r.amount ? `$${Number(r.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "—",
                <>
                  {r.deadline ?? "—"}
                  {r.overdue && r.status === "PENDING" && <div style={{ color: theme.danger.fg, fontSize: "0.8rem" }}>Overdue</div>}
                  {!r.overdue && r.dueThisMonth && r.status === "PENDING" && (
                    <div style={{ color: theme.warning.fg, fontSize: "0.8rem" }}>Due this month</div>
                  )}
                </>,
                r.taxFilingRecordId ? (
                  <select
                    value={r.status}
                    onChange={(e) => markStatus(r.taxFilingRecordId as string, e.target.value as ReportRow["status"])}
                    style={{ padding: "0.25rem" }}
                  >
                    <option value="PENDING">Pending</option>
                    <option value="FILED">Filed</option>
                    <option value="NOT_REQUIRED">Not required</option>
                  </select>
                ) : (
                  "—"
                ),
                r.filingType === "FORM_3921" && r.taxFilingRecordId && (
                  <a href={`/api/tax-filing-records/${r.taxFilingRecordId}/form-3921`} style={smallButtonStyle}>
                    Download Form 3921
                  </a>
                ),
              ],
            }))}
          />
        </div>
      )}

      <RecordExerciseForm instruments={instruments} onRecorded={() => runReport(targetMonth)} />
      <RecordDispositionForm instruments={instruments} onRecorded={() => runReport(targetMonth)} />
    </div>
  );
}

function RecordExerciseForm({ instruments, onRecorded }: { instruments: InstrumentOption[]; onRecorded: () => void }) {
  const [instrumentId, setInstrumentId] = useState(instruments[0]?.id ?? "");
  const [exerciseDate, setExerciseDate] = useState("");
  const [quantityExercised, setQuantityExercised] = useState("");
  const [exercisePricePerShare, setExercisePricePerShare] = useState("");
  const [fmv, setFmv] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "error" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch(`/api/instruments/${instrumentId}/option-exercises`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exerciseDate,
          quantityExercised,
          exercisePricePerShare,
          fairMarketValuePerShareAtExercise: fmv,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to record the exercise");
      setStatus("saved");
      setExerciseDate("");
      setQuantityExercised("");
      setExercisePricePerShare("");
      setFmv("");
      onRecorded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record the exercise");
      setStatus("error");
    }
  }

  if (instruments.length === 0) {
    return <p style={{ color: theme.inkMuted }}>No stock option grants on file yet for this entity — record one first.</p>;
  }

  return (
    <fieldset style={{ border: `1px solid ${theme.border}`, borderRadius: 4, padding: "1rem", marginBottom: "1.5rem" }}>
      <legend>Record an option exercise</legend>
      <LabeledSelectField label="Grant" value={instrumentId} onChange={setInstrumentId} options={instruments.map((i) => ({ value: i.id, label: i.label }))} />
      <DateField label="Exercise date" value={exerciseDate} onChange={setExerciseDate} />
      <DecimalField label="Quantity exercised" value={quantityExercised} onChange={setQuantityExercised} />
      <DecimalField label="Exercise price per share" value={exercisePricePerShare} onChange={setExercisePricePerShare} />
      <DecimalField label="Fair market value per share on exercise date" value={fmv} onChange={setFmv} />
      {error && <p style={{ color: theme.danger.fg }}>{error}</p>}
      <button onClick={handleSubmit} disabled={status === "saving"} style={{ ...smallButtonStyle, marginTop: "0.5rem" }}>
        {status === "saving" ? "Recording..." : "Record exercise"}
      </button>
      {status === "saved" && <span style={{ marginLeft: "0.5rem", color: theme.success.fg }}>Recorded.</span>}
    </fieldset>
  );
}

function RecordDispositionForm({ instruments, onRecorded }: { instruments: InstrumentOption[]; onRecorded: () => void }) {
  const [instrumentId, setInstrumentId] = useState(instruments[0]?.id ?? "");
  const [exercises, setExercises] = useState<ExerciseOption[]>([]);
  const [exerciseEventId, setExerciseEventId] = useState("");
  const [dispositionDate, setDispositionDate] = useState("");
  const [quantitySold, setQuantitySold] = useState("");
  const [salePricePerShare, setSalePricePerShare] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "error" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  async function loadExercises(id: string) {
    setInstrumentId(id);
    setExerciseEventId("");
    setExercises([]);
    if (!id) return;
    setStatus("loading");
    try {
      const res = await fetch(`/api/instruments/${id}/option-exercises`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load exercises");
      setExercises(
        data.exercises.map((e: { id: string; exerciseDate: string; quantityExercised: string }) => ({
          id: e.id,
          label: `${e.exerciseDate} — ${e.quantityExercised} sh`,
        }))
      );
      setStatus("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load exercises");
      setStatus("error");
    }
  }

  async function handleSubmit() {
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch(`/api/option-exercises/${exerciseEventId}/dispositions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dispositionDate, quantitySold, salePricePerShare }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to record the disposition");
      setStatus("saved");
      setDispositionDate("");
      setQuantitySold("");
      setSalePricePerShare("");
      onRecorded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record the disposition");
      setStatus("error");
    }
  }

  if (instruments.length === 0) return null;

  return (
    <fieldset style={{ border: `1px solid ${theme.border}`, borderRadius: 4, padding: "1rem", marginBottom: "1.5rem" }}>
      <legend>Record a share disposition (for disqualifying-disposition tracking)</legend>
      <LabeledSelectField label="Grant" value={instrumentId} onChange={loadExercises} options={instruments.map((i) => ({ value: i.id, label: i.label }))} />
      {exercises.length > 0 ? (
        <LabeledSelectField
          label="Which exercise was sold"
          value={exerciseEventId}
          onChange={setExerciseEventId}
          options={exercises.map((e) => ({ value: e.id, label: e.label }))}
        />
      ) : (
        <p style={{ color: theme.inkMuted, fontSize: "0.9rem" }}>
          {status === "loading" ? "Loading exercises..." : "This grant has no recorded exercises yet."}
        </p>
      )}
      <DateField label="Disposition (sale) date" value={dispositionDate} onChange={setDispositionDate} />
      <DecimalField label="Quantity sold" value={quantitySold} onChange={setQuantitySold} />
      <DecimalField label="Sale price per share" value={salePricePerShare} onChange={setSalePricePerShare} />
      {error && <p style={{ color: theme.danger.fg }}>{error}</p>}
      <button
        onClick={handleSubmit}
        disabled={status === "saving" || !exerciseEventId}
        style={{ ...smallButtonStyle, marginTop: "0.5rem" }}
      >
        {status === "saving" ? "Recording..." : "Record disposition"}
      </button>
      {status === "saved" && <span style={{ marginLeft: "0.5rem", color: theme.success.fg }}>Recorded.</span>}
    </fieldset>
  );
}
