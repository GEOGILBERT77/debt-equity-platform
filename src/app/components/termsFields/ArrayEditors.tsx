"use client";

import { DateField, DecimalField, TextField, removeButtonStyle, smallButtonStyle } from "./FieldPrimitives";

/**
 * Row-editable list controls for the four array shapes that recur across almost every
 * instrument type's terms: vesting tranches, debt cash flows, fair-value observations,
 * and revolver deferred-fee tranches. Each is a thin, generic (id, add, remove, update)
 * wrapper — the actual field TYPE per row differs (a tranche's `quantity` vs. an
 * observation's `fairValue`), so these are kept as separate small components rather
 * than one over-generalized "array of records" editor that would need a field-schema
 * abstraction to stay readable.
 *
 * All of these produce plain arrays of plain objects with string-valued numeric
 * fields — exactly the JSON shape `termsValidation.ts` checks and the engines
 * (`vesting.ts`, `debtAmortization.ts`, `fairValueRemeasurement.ts`,
 * `stockAppreciationRights.ts`) consume, so no conversion happens between "what the
 * form edits" and "what gets POSTed" beyond `JSON.stringify` at submit time.
 */

let idCounter = 0;
/** Generates a short, readable default id for a new row (`t3`, `f2`, ...) — purely a
 * convenience default; every id field remains freely editable, since a tranche/fee id
 * is just a human-readable label used in `meta.vestedTrancheIds`-style disclosure
 * output, not a database key. */
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}${idCounter}`;
}

export interface TrancheRow {
  id: string;
  vestDate: string;
  quantity: string;
}

export function TrancheArrayField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: TrancheRow[];
  onChange: (rows: TrancheRow[]) => void;
}) {
  const total = value.reduce((sum, t) => sum + (Number(t.quantity) || 0), 0);
  return (
    <div style={{ margin: "0.6rem 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong style={{ fontSize: "0.9rem" }}>{label}</strong>
        <span style={{ fontSize: "0.78rem", color: "#666" }}>Tranche quantities must sum to the grant's total quantity above.</span>
      </div>
      {value.map((row, i) => (
        <div key={i} style={rowStyle}>
          <div style={{ flex: "0 0 90px" }}>
            <TextField label="id" value={row.id} onChange={(v) => onChange(replaceAt(value, i, { ...row, id: v }))} />
          </div>
          <div style={{ flex: "0 0 160px" }}>
            <DateField label="Vest date" value={row.vestDate} onChange={(v) => onChange(replaceAt(value, i, { ...row, vestDate: v }))} />
          </div>
          <div style={{ flex: 1 }}>
            <DecimalField label="Quantity" value={row.quantity} onChange={(v) => onChange(replaceAt(value, i, { ...row, quantity: v }))} />
          </div>
          <button type="button" style={{ ...removeButtonStyle, alignSelf: "flex-end", marginBottom: "0.6rem" }} onClick={() => onChange(removeAt(value, i))}>
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        style={smallButtonStyle}
        onClick={() => onChange([...value, { id: nextId("t"), vestDate: "", quantity: "" }])}
      >
        + Add tranche
      </button>
      <span style={{ marginLeft: "0.75rem", fontSize: "0.78rem", color: "#666" }}>Tranche total: {total.toLocaleString()}</span>
    </div>
  );
}

export interface CashFlowRow {
  date: string;
  amount: string;
}

export function CashFlowArrayField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: CashFlowRow[];
  onChange: (rows: CashFlowRow[]) => void;
  hint?: string;
}) {
  return (
    <div style={{ margin: "0.6rem 0" }}>
      <strong style={{ fontSize: "0.9rem" }}>{label}</strong>
      {hint && <span style={{ display: "block", fontSize: "0.78rem", color: "#666" }}>{hint}</span>}
      {value.map((row, i) => (
        <div key={i} style={rowStyle}>
          <div style={{ flex: "0 0 160px" }}>
            <DateField label="Date" value={row.date} onChange={(v) => onChange(replaceAt(value, i, { ...row, date: v }))} />
          </div>
          <div style={{ flex: 1 }}>
            <DecimalField label="Amount" value={row.amount} onChange={(v) => onChange(replaceAt(value, i, { ...row, amount: v }))} />
          </div>
          <button type="button" style={{ ...removeButtonStyle, alignSelf: "flex-end", marginBottom: "0.6rem" }} onClick={() => onChange(removeAt(value, i))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" style={smallButtonStyle} onClick={() => onChange([...value, { date: "", amount: "" }])}>
        + Add cash flow
      </button>
    </div>
  );
}

export interface ObservationRow {
  date: string;
  value: string;
}

/** `valueLabel` names the numeric field per instrument (`"Fair value"` for WARRANT,
 * `"Fair value per unit"` for a cash-settled SAR) — the underlying JSON key
 * (`fairValue` vs. `fairValuePerUnit`) is handled by the caller when serializing, this
 * component only ever deals in the generic `{ date, value }` shape. */
export function ObservationArrayField({
  label,
  valueLabel,
  value,
  onChange,
  hint,
}: {
  label: string;
  valueLabel: string;
  value: ObservationRow[];
  onChange: (rows: ObservationRow[]) => void;
  hint?: string;
}) {
  return (
    <div style={{ margin: "0.6rem 0" }}>
      <strong style={{ fontSize: "0.9rem" }}>{label}</strong>
      {hint && <span style={{ display: "block", fontSize: "0.78rem", color: "#666" }}>{hint}</span>}
      {value.map((row, i) => (
        <div key={i} style={rowStyle}>
          <div style={{ flex: "0 0 160px" }}>
            <DateField label="Date" value={row.date} onChange={(v) => onChange(replaceAt(value, i, { ...row, date: v }))} />
          </div>
          <div style={{ flex: 1 }}>
            <DecimalField label={valueLabel} value={row.value} onChange={(v) => onChange(replaceAt(value, i, { ...row, value: v }))} />
          </div>
          <button type="button" style={{ ...removeButtonStyle, alignSelf: "flex-end", marginBottom: "0.6rem" }} onClick={() => onChange(removeAt(value, i))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" style={smallButtonStyle} onClick={() => onChange([...value, { date: "", value: "" }])}>
        + Add observation
      </button>
    </div>
  );
}

export interface DeferredFeeRow {
  id: string;
  amount: string;
  amortizationStart: string;
  amortizationEnd: string;
}

export function DeferredFeeArrayField({
  value,
  onChange,
}: {
  value: DeferredFeeRow[];
  onChange: (rows: DeferredFeeRow[]) => void;
}) {
  return (
    <div style={{ margin: "0.6rem 0" }}>
      <strong style={{ fontSize: "0.9rem" }}>Deferred financing fees</strong>
      <span style={{ display: "block", fontSize: "0.78rem", color: "#666" }}>
        The original closing fee, plus any later upsize/amendment fees — each amortizes only over what was actually remaining when it was incurred.
      </span>
      {value.map((row, i) => (
        <div key={i} style={{ ...rowStyle, flexWrap: "wrap" }}>
          <div style={{ flex: "0 0 90px" }}>
            <TextField label="id" value={row.id} onChange={(v) => onChange(replaceAt(value, i, { ...row, id: v }))} />
          </div>
          <div style={{ flex: "0 0 140px" }}>
            <DecimalField label="Amount" value={row.amount} onChange={(v) => onChange(replaceAt(value, i, { ...row, amount: v }))} />
          </div>
          <div style={{ flex: "0 0 160px" }}>
            <DateField
              label="Amortization start"
              value={row.amortizationStart}
              onChange={(v) => onChange(replaceAt(value, i, { ...row, amortizationStart: v }))}
            />
          </div>
          <div style={{ flex: "0 0 160px" }}>
            <DateField
              label="Amortization end"
              value={row.amortizationEnd}
              onChange={(v) => onChange(replaceAt(value, i, { ...row, amortizationEnd: v }))}
            />
          </div>
          <button type="button" style={{ ...removeButtonStyle, alignSelf: "flex-end", marginBottom: "0.6rem" }} onClick={() => onChange(removeAt(value, i))}>
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        style={smallButtonStyle}
        onClick={() => onChange([...value, { id: nextId("f"), amount: "", amortizationStart: "", amortizationEnd: "" }])}
      >
        + Add deferred fee
      </button>
    </div>
  );
}

function replaceAt<T>(arr: T[], i: number, next: T): T[] {
  const copy = arr.slice();
  copy[i] = next;
  return copy;
}
function removeAt<T>(arr: T[], i: number): T[] {
  return arr.slice(0, i).concat(arr.slice(i + 1));
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  alignItems: "flex-start",
  padding: "0.4rem 0",
  borderBottom: "1px dashed #eee",
};
