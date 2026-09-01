"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  CommonStockForm,
  CommonStockState,
  PikNoteForm,
  PikNoteState,
  PreferredStockForm,
  PreferredStockState,
  RestrictedStockForm,
  RestrictedStockState,
  RevolverForm,
  RevolverState,
  SarForm,
  SarState,
  ServiceConditionGrantForm,
  ServiceConditionGrantState,
  TermDebtForm,
  TermDebtState,
  WarrantForm,
  WarrantState,
  defaultCommonStockState,
  defaultPikNoteState,
  defaultPreferredStockState,
  defaultRestrictedStockState,
  defaultRevolverState,
  defaultSarState,
  defaultServiceConditionGrantState,
  defaultTermDebtState,
  defaultWarrantState,
  toCommonStockTerms,
  toPikNoteTerms,
  toPreferredStockTerms,
  toRestrictedStockTerms,
  toRevolverTerms,
  toSarTerms,
  toServiceConditionGrantTerms,
  toTermDebtTerms,
  toWarrantTerms,
} from "./termsFields/TypeForms";
import { hintStyle, labelStyle, inputStyle as fieldInputStyle } from "./termsFields/FieldPrimitives";

const INSTRUMENT_TYPES = [
  "STOCK_OPTION",
  "RSU",
  "TERM_LOAN",
  "PIK_NOTE",
  "REVOLVER",
  "CONVERTIBLE_NOTE",
  "WARRANT",
  "COMMON_STOCK",
  "PREFERRED_STOCK",
  "SAR",
  "RESTRICTED_STOCK",
] as const;
type InstrumentType = (typeof INSTRUMENT_TYPES)[number];

/**
 * As of v0.18.0, this is a bespoke, per-type form — not the single JSON textarea every
 * instrument type shared through v0.17.0. Each type gets its own guided fields, built
 * from the shared sub-forms in `./termsFields/TypeForms.tsx` (which themselves reuse
 * one form per underlying engine SHAPE — `ServiceConditionGrant`, `TermDebtInputs` —
 * across every instrument type that shares it, the same "reuse over reinvention"
 * principle the engine layer follows). An "edit as raw JSON instead" escape hatch
 * remains available per type for anything the guided form doesn't cover (a payload
 * copied from a spreadsheet, or a shape variant the guided form doesn't expose a
 * control for) — switching to it seeds the textarea with the current guided-form
 * state's JSON; switching back to the guided form DISCARDS any raw-JSON edits, since
 * there's no general way to parse arbitrary JSON back into the specific typed field
 * state without risking silently dropping something the JSON contained. This is a
 * deliberate, stated trade-off, not an oversight — see this component's own state
 * below for the mechanism.
 *
 * There is still no runtime schema validation on the CLIENT beyond what these forms
 * structurally constrain (a decimal field is just a text input — see
 * `FieldPrimitives.tsx`'s doc comment for why); the authoritative check remains
 * `termsValidation.ts` at the API boundary, same as before this pass. A malformed
 * value (e.g. a non-numeric quantity) still surfaces as a 400 with a specific field
 * path, just from the server rather than earlier client-side — closing that gap for
 * real needs the schema-library swap `termsValidation.ts`'s own doc comment describes.
 */
export function NewInstrumentForm({
  entityId,
  stakeholders,
  initialStakeholderId,
}: {
  entityId: string;
  stakeholders: { id: string; name: string; type: string }[];
  initialStakeholderId?: string;
}) {
  const router = useRouter();
  const [stakeholderId, setStakeholderId] = useState(initialStakeholderId ?? stakeholders[0]?.id ?? "");
  const [type, setType] = useState<InstrumentType>("STOCK_OPTION");
  // Deliberately not today's date: the TERM_LOAN/CONVERTIBLE_NOTE defaults each assume
  // exactly one annual period has elapsed since issuance (one cashFlows entry) —
  // issuing "today" would mean zero elapsed periods, immediately mismatching that
  // count. Change this to your real issue date; add/remove cash flow rows to match.
  const [issueDate, setIssueDate] = useState("2026-01-01");
  const [label, setLabel] = useState("Original terms");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  // One editable-state slot per type, so switching the type dropdown back and forth
  // preserves whatever was already entered for each — a nice-to-have this pass adds
  // for free by keeping all eleven states around rather than resetting on every switch
  // the way the old single-JSON-textarea version had to.
  const [stockOption, setStockOption] = useState<ServiceConditionGrantState>(defaultServiceConditionGrantState);
  const [rsu, setRsu] = useState<ServiceConditionGrantState>(defaultServiceConditionGrantState);
  const [termLoan, setTermLoan] = useState<TermDebtState>(defaultTermDebtState);
  const [pikNote, setPikNote] = useState<PikNoteState>(defaultPikNoteState);
  const [revolver, setRevolver] = useState<RevolverState>(defaultRevolverState);
  const [convertibleNote, setConvertibleNote] = useState<TermDebtState & { conversionPricePerShare: string }>(() => ({
    ...defaultTermDebtState(),
    conversionPricePerShare: "5.00",
  }));
  const [warrant, setWarrant] = useState<WarrantState>(defaultWarrantState);
  const [commonStock, setCommonStock] = useState<CommonStockState>(defaultCommonStockState);
  const [preferredStock, setPreferredStock] = useState<PreferredStockState>(defaultPreferredStockState);
  const [sar, setSar] = useState<SarState>(defaultSarState);
  const [restrictedStock, setRestrictedStock] = useState<RestrictedStockState>(defaultRestrictedStockState);

  const [mode, setMode] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState("");

  function currentTerms(): unknown {
    switch (type) {
      case "STOCK_OPTION":
        return toServiceConditionGrantTerms(stockOption);
      case "RSU":
        return toServiceConditionGrantTerms(rsu);
      case "TERM_LOAN":
        return toTermDebtTerms(termLoan);
      case "PIK_NOTE":
        return toPikNoteTerms(pikNote);
      case "REVOLVER":
        return toRevolverTerms(revolver);
      case "CONVERTIBLE_NOTE":
        return { ...toTermDebtTerms(convertibleNote), conversionPricePerShare: convertibleNote.conversionPricePerShare };
      case "WARRANT":
        return toWarrantTerms(warrant);
      case "COMMON_STOCK":
        return toCommonStockTerms(commonStock);
      case "PREFERRED_STOCK":
        return toPreferredStockTerms(preferredStock);
      case "SAR":
        return toSarTerms(sar);
      case "RESTRICTED_STOCK":
        return toRestrictedStockTerms(restrictedStock);
    }
  }

  const jsonPreview = useMemo(() => {
    try {
      return JSON.stringify(currentTerms(), null, 2);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    } catch {
      return "";
    }
    // Recompute whenever anything that feeds currentTerms() changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, stockOption, rsu, termLoan, pikNote, revolver, convertibleNote, warrant, commonStock, preferredStock, sar, restrictedStock]);

  function switchToJsonMode() {
    setJsonText(jsonPreview);
    setMode("json");
  }
  function switchToFormMode() {
    setMode("form");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setMessage(null);

    let terms: unknown;
    if (mode === "json") {
      try {
        terms = JSON.parse(jsonText);
      } catch {
        setStatus("error");
        setMessage("Terms must be valid JSON.");
        return;
      }
    } else {
      terms = currentTerms();
    }

    if (!stakeholderId) {
      setStatus("error");
      setMessage("Choose a stakeholder (add one first if the list below is empty).");
      return;
    }

    try {
      const res = await fetch("/api/instruments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId, stakeholderId, type, issueDate, terms, label }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setMessage(data.issues ? `${data.error}: ${data.issues.map((i: { path: string; message: string }) => `${i.path || "(root)"} ${i.message}`).join("; ")}` : data.error ?? "Failed to create instrument");
        return;
      }
      router.push(`/instruments/${data.instrument.id}`);
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to create instrument");
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <label style={labelStyle}>
        Stakeholder
        {stakeholders.length === 0 ? (
          <p style={{ color: "crimson" }}>This entity has no stakeholders yet — add one first, then come back here.</p>
        ) : (
          <select value={stakeholderId} onChange={(e) => setStakeholderId(e.target.value)} style={fieldInputStyle}>
            {stakeholders.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.type})
              </option>
            ))}
          </select>
        )}
      </label>

      <label style={labelStyle}>
        Instrument type
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value as InstrumentType);
            if (mode === "json") setMode("form"); // a JSON edit for one type doesn't carry over to a different type
          }}
          style={fieldInputStyle}
        >
          {INSTRUMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>

      <label style={labelStyle}>
        Issue date
        <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} style={fieldInputStyle} />
      </label>

      <label style={labelStyle}>
        Label
        <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} style={fieldInputStyle} />
      </label>

      <div style={{ margin: "1rem 0", padding: "0.75rem", background: "#fafafa", border: "1px solid #eee", borderRadius: 4 }}>
        {mode === "form" ? (
          <>
            {type === "STOCK_OPTION" && <ServiceConditionGrantForm value={stockOption} onChange={setStockOption} />}
            {type === "RSU" && <ServiceConditionGrantForm value={rsu} onChange={setRsu} />}
            {type === "TERM_LOAN" && <TermDebtForm value={termLoan} onChange={setTermLoan} />}
            {type === "PIK_NOTE" && <PikNoteForm value={pikNote} onChange={setPikNote} />}
            {type === "REVOLVER" && <RevolverForm value={revolver} onChange={setRevolver} />}
            {type === "CONVERTIBLE_NOTE" && (
              <>
                <TermDebtForm value={convertibleNote} onChange={(v) => setConvertibleNote({ ...convertibleNote, ...v })} />
                <label style={labelStyle}>
                  Conversion price per share
                  <input
                    type="text"
                    inputMode="decimal"
                    value={convertibleNote.conversionPricePerShare}
                    onChange={(e) => setConvertibleNote({ ...convertibleNote, conversionPricePerShare: e.target.value })}
                    style={fieldInputStyle}
                  />
                </label>
              </>
            )}
            {type === "WARRANT" && <WarrantForm value={warrant} onChange={setWarrant} />}
            {type === "COMMON_STOCK" && <CommonStockForm value={commonStock} onChange={setCommonStock} />}
            {type === "PREFERRED_STOCK" && <PreferredStockForm value={preferredStock} onChange={setPreferredStock} />}
            {type === "SAR" && <SarForm value={sar} onChange={setSar} />}
            {type === "RESTRICTED_STOCK" && <RestrictedStockForm value={restrictedStock} onChange={setRestrictedStock} />}
            <button type="button" onClick={switchToJsonMode} style={{ ...linkButtonStyle, marginTop: "0.5rem" }}>
              Edit as raw JSON instead
            </button>
          </>
        ) : (
          <>
            <label style={labelStyle}>
              Terms (raw JSON)
              <textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} rows={14} style={{ ...fieldInputStyle, fontFamily: "monospace" }} />
            </label>
            <button type="button" onClick={switchToFormMode} style={linkButtonStyle}>
              Back to guided form (discards JSON edits)
            </button>
          </>
        )}
      </div>

      <button type="submit" disabled={status === "loading" || stakeholders.length === 0} style={buttonStyle}>
        {status === "loading" ? "Creating…" : "Create instrument"}
      </button>
      {message && <p style={{ color: "crimson", marginTop: "0.5rem" }}>{message}</p>}
      <p style={hintStyle}>
        There is still no server-side conversion assistant — a malformed value comes back as a specific field-level
        error after you submit, not before.
      </p>
    </form>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: "1px solid #333",
  borderRadius: 4,
  background: "#f5f5f5",
  cursor: "pointer",
};
const linkButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#2563eb",
  cursor: "pointer",
  padding: 0,
  fontSize: "0.85rem",
  textDecoration: "underline",
};
