"use client";

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

export function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={labelStyle}>
      {label}
      <input type="date" value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
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

export const labelStyle: React.CSSProperties = { display: "block", margin: "0.6rem 0", fontSize: "0.9rem" };
export const inputStyle: React.CSSProperties = { display: "block", width: "100%", padding: "0.4rem", marginTop: "0.25rem" };
export const hintStyle: React.CSSProperties = { display: "block", color: "#666", fontSize: "0.78rem", marginTop: "0.2rem" };
export const fieldsetStyle: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 4,
  padding: "0.75rem 1rem 1rem",
  margin: "1rem 0",
};
export const legendStyle: React.CSSProperties = { padding: "0 0.4rem", fontWeight: 600, fontSize: "0.85rem" };
export const noteStyle: React.CSSProperties = { color: "#92400e", fontSize: "0.8rem", marginTop: "0.5rem" };
export const smallButtonStyle: React.CSSProperties = {
  padding: "0.25rem 0.6rem",
  border: "1px solid #999",
  borderRadius: 4,
  background: "#fff",
  cursor: "pointer",
  fontSize: "0.8rem",
};
export const removeButtonStyle: React.CSSProperties = { ...smallButtonStyle, color: "#a33", borderColor: "#a33" };
