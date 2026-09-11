"use client";

import { theme } from "@/lib/theme";

/**
 * Small, dumb, controlled input primitives shared by every per-instrument-type terms
 * form in `TypeForms.tsx` — replacing the single JSON textarea `NewInstrumentForm.tsx`
 * used to hand every instrument type (v0.10.0 through v0.17.0). None of these know
 * anything about accounting; they're purely "labeled text/date/checkbox input bound to
 * a (value, onChange) pair," kept in one place so every bespoke form looks and behaves
 * consistently rather than each hand-rolling its own <label>/<input> markup.
 *
 * A DECIMAL FIELD IS A TEXT FIELD, DELIBERATELY: every numeric value an instrument's
 * terms carries (quantity, price, rate, amount) is a `DecimalValue` — `number | string`
 * — because the engine layer parses it through `Decimal.ts`'s own arbitrary-precision
 * parser, not JavaScript's floating-point `number` type (see `decimal.ts`'s doc comment
 * for why: `0.1 + 0.2 !== 0.3` in a share count or a dollar amount is a real, visible
 * bug in accounting software). An `<input type="number">` would round-trip the value
 * through a JS `number` on every keystroke, silently reintroducing the exact
 * floating-point imprecision `Decimal.ts` exists to avoid — so `DecimalField` below is
 * `<input type="text">` with light client-side shape hinting only (not used to reject
 * input eagerly), leaving the authoritative check to `termsValidation.ts`'s
 * `isDecimalValue` at submit time, same as every other field here.
 */

export function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label style={labelStyle}>
      {label}
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={inputStyle} />
    </label>
  );
}

/** v0.36.0 — a multi-line sibling of `TextField`, added when the first genuinely
 * free-text narrative fields showed up (a QSBS attestation letter's active-business
 * description, a board consent's description) — every prior field in this app was
 * short enough for a single-line input. */
export function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 4,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <label style={labelStyle}>
      {label}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        style={{ ...inputStyle, fontFamily: theme.font.body, resize: "vertical" }}
      />
    </label>
  );
}

/** See the module doc comment above for why this is a text input, not `type="number"`. */
export function DecimalField({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label style={labelStyle}>
      {label}
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={inputStyle}
      />
      {hint && <span style={hintStyle}>{hint}</span>}
    </label>
  );
}

export function DateField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <label style={labelStyle}>
      {label}
      <input type="date" value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
      {hint && <span style={hintStyle}>{hint}</span>}
    </label>
  );
}

export function BoolField({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: "0.5rem" }}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <label style={labelStyle}>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as T)} style={inputStyle}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A visual grouping for a nested sub-object's fields (e.g. WARRANT's `classification`
 * block, PREFERRED_STOCK's `accretion` block) — purely presentational, no state. */
export function FieldGroup({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <fieldset style={fieldsetStyle}>
      <legend style={legendStyle}>{title}</legend>
      {children}
      {note && <p style={noteStyle}>{note}</p>}
    </fieldset>
  );
}

// v0.34.0 — these were plain hardcoded greys/blacks before (see theme.ts's doc
// comment for why that changed); now every value comes from the shared "Slate"
// palette so a form field, a button, and a fieldset border all read as one system.
export const labelStyle: React.CSSProperties = {
  display: "block",
  margin: "0.6rem 0",
  fontSize: "0.9rem",
  color: theme.ink,
  fontWeight: 500,
};
export const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "0.5rem 0.6rem",
  marginTop: "0.3rem",
  fontSize: "0.92rem",
  color: theme.ink,
  background: theme.surface,
  border: `1px solid ${theme.border}`,
  borderRadius: 6,
};
export const hintStyle: React.CSSProperties = { display: "block", color: theme.inkMuted, fontSize: "0.78rem", marginTop: "0.25rem" };
export const fieldsetStyle: React.CSSProperties = {
  border: `1px solid ${theme.border}`,
  borderRadius: 6,
  padding: "0.75rem 1rem 1rem",
  margin: "1rem 0",
  background: theme.surfaceAlt,
};
export const legendStyle: React.CSSProperties = { padding: "0 0.4rem", fontWeight: 600, fontSize: "0.85rem", color: theme.ink };
export const noteStyle: React.CSSProperties = { color: theme.warning.fg, fontSize: "0.8rem", marginTop: "0.5rem" };
export const smallButtonStyle: React.CSSProperties = {
  padding: "0.35rem 0.75rem",
  border: `1px solid ${theme.border}`,
  borderRadius: 6,
  background: theme.surface,
  color: theme.ink,
  cursor: "pointer",
  fontSize: "0.82rem",
  fontWeight: 600,
};
export const removeButtonStyle: React.CSSProperties = { ...smallButtonStyle, color: theme.danger.fg, borderColor: theme.danger.fg };
/** A filled, primary-colored button — the "this is the main action on this form"
 * counterpart to `smallButtonStyle`'s neutral outline button. */
export const primaryButtonStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: "none",
  borderRadius: 6,
  background: theme.primary,
  color: theme.onPrimary,
  cursor: "pointer",
  fontSize: "0.88rem",
  fontWeight: 600,
};
