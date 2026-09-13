"use client";

import Link from "next/link";
import { useState } from "react";
import {
  PikNoteForm,
  PikNoteState,
  TermDebtForm,
  TermDebtState,
  WarrantForm,
  WarrantState,
  defaultPikNoteState,
  defaultTermDebtState,
  defaultWarrantState,
  toPikNoteTerms,
  toTermDebtTerms,
  toWarrantTerms,
} from "./termsFields/TypeForms";
import { hintStyle, labelStyle, inputStyle as fieldInputStyle } from "./termsFields/FieldPrimitives";
import { theme } from "@/lib/theme";

type NoteType = "PIK" | "CONVERTIBLE" | "WARRANT_NOTE";

const NOTE_TYPE_INFO: Record<NoteType, { title: string; heading: string; blurb: string }> = {
  PIK: {
    title: "PIK note",
    heading: "New PIK Note",
    blurb: "Interest compounds onto the principal balance instead of being paid in cash (ASC 835-30) — no cash leg at all until it's repaid or converted.",
  },
  CONVERTIBLE: {
    title: "Convertible note",
    heading: "New Convertible Note",
    blurb: "A term note that converts into equity at a stated price per share instead of (or in addition to) being repaid in cash.",
  },
  WARRANT_NOTE: {
    title: "Note with warrants",
    heading: "New Note with Warrant Coverage",
    blurb: "A plain interest-bearing note issued together with a warrant (an equity \"kicker\") — the note itself doesn't convert; the warrant is the separate upside.",
  },
};

/**
 * "Notes" wizard (v0.41.0) — George's ask, verbatim: "the Notes should have a choice
 * for the user to identify PIK or convertible (with the resulting screen providing
 * inputs for those specific terms)... issuing debt with warrants should be another
 * option in the 'Notes' user choice." Consolidates NavBar's previously separate
 * "PIK note" / "Convertible note" links (see NavBar.tsx's DEBT_INSTRUMENT_TYPES) into
 * one guided flow, mirroring StockAwardWizard.tsx's pick-type-then-fill-details shape
 * (see that file's doc comment for the general rationale — this is the same pattern
 * applied to the debt side of "New transactions").
 *
 * "Term loan" and "Revolver/LOC" are NOT folded in here — those stay their own direct
 * NavBar links (see NavBar.tsx) since neither has a sibling type it's easily confused
 * with the way PIK/convertible/warrant-note do.
 *
 * NOTE WITH WARRANTS — TWO SEPARATE INSTRUMENTS, ON PURPOSE: this app's data model has
 * no single "debt-with-warrant" instrument type, and doesn't need one — a note issued
 * with warrant coverage is, in substance, two distinct instruments held by the same
 * lender (the note itself, and a warrant), each with its own accounting (ASC 835-30 for
 * the note; ASC 480/815-40 classification for the warrant, same as any other WARRANT).
 * The note is modeled as a plain TERM_LOAN (TermDebtForm) rather than a new type,
 * since — unlike a convertible note — it doesn't itself convert; the warrant is the
 * separate equity kicker. Submitting this path POSTs the note first, then the warrant,
 * both to the same stakeholder/issue date; if the note succeeds but the warrant fails
 * (or vice versa), the error message says exactly which one failed and that the other
 * was already created, rather than silently leaving a half-done pair with no
 * indication anything succeeded at all.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export function NotesWizard({
  entityId,
  stakeholders,
  initialStakeholderId,
}: {
  entityId: string;
  stakeholders: { id: string; name: string; type: string }[];
  initialStakeholderId?: string;
}) {
  const [step, setStep] = useState<"type" | "details">("type");
  const [noteType, setNoteType] = useState<NoteType | null>(null);

  const [stakeholderId, setStakeholderId] = useState(initialStakeholderId ?? stakeholders[0]?.id ?? "");
  const [issueDate, setIssueDate] = useState("2026-01-01");
  const [label, setLabel] = useState("Original terms");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [created, setCreated] = useState<{ noteId: string; warrantId?: string } | null>(null);

  const [pikNote, setPikNote] = useState<PikNoteState>(defaultPikNoteState);
  const [convertibleNote, setConvertibleNote] = useState<TermDebtState & { conversionPricePerShare: string }>(() => ({
    ...defaultTermDebtState(),
    conversionPricePerShare: "5.00",
  }));
  const [warrantNoteDebt, setWarrantNoteDebt] = useState<TermDebtState>(defaultTermDebtState);
  const [warrantNoteWarrant, setWarrantNoteWarrant] = useState<WarrantState>(defaultWarrantState);

  function chooseNoteType(t: NoteType) {
    setNoteType(t);
    setStep("details");
    setCreated(null);
    setStatus("idle");
    setMessage(null);
  }

  function goToStep(target: "type" | "details") {
    if (target === "details" && !noteType) return;
    setStep(target);
  }

  async function createInstrument(type: string, terms: unknown, instrumentLabel: string) {
    const res = await fetch("/api/instruments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityId, stakeholderId, type, issueDate, terms, label: instrumentLabel }),
    });
    const data = await res.json();
    if (!res.ok) {
      const detail = data.issues
        ? `${data.error}: ${data.issues.map((i: { path: string; message: string }) => `${i.path || "(root)"} ${i.message}`).join("; ")}`
        : data.error ?? "Failed to create instrument";
      throw new Error(detail);
    }
    return data.instrument.id as string;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stakeholderId) {
      setStatus("error");
      setMessage("Choose a stakeholder (add one first if the list below is empty).");
      return;
    }
    setStatus("loading");
    setMessage(null);
    setCreated(null);
    try {
      if (noteType === "PIK") {
        const id = await createInstrument("PIK_NOTE", toPikNoteTerms(pikNote), label);
        setCreated({ noteId: id });
      } else if (noteType === "CONVERTIBLE") {
        const terms = { ...toTermDebtTerms(convertibleNote), conversionPricePerShare: convertibleNote.conversionPricePerShare };
        const id = await createInstrument("CONVERTIBLE_NOTE", terms, label);
        setCreated({ noteId: id });
      } else if (noteType === "WARRANT_NOTE") {
        // The note first, then the warrant — see this component's doc comment on why
        // a partial failure needs to say exactly which half succeeded.
        const noteId = await createInstrument("TERM_LOAN", toTermDebtTerms(warrantNoteDebt), `${label} — note`);
        try {
          const warrantId = await createInstrument("WARRANT", toWarrantTerms(warrantNoteWarrant), `${label} — warrant coverage`);
          setCreated({ noteId, warrantId });
        } catch (warrantErr) {
          setStatus("error");
          setMessage(
            `The note was created, but the warrant failed: ${warrantErr instanceof Error ? warrantErr.message : "unknown error"}. ` +
              `You can add the warrant separately from "New transactions › Standalone warrants" for the same stakeholder.`
          );
          setCreated({ noteId });
          return;
        }
      }
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to create instrument");
    }
  }

  const canGoToDetails = !!noteType;

  return (
    <div>
      <h1>{noteType ? NOTE_TYPE_INFO[noteType].heading : "New Note"}</h1>

      <ol style={stepperStyle}>
        <li>
          <button type="button" onClick={() => goToStep("type")} style={stepPillStyle(step === "type", true)}>
            1. Note type
          </button>
        </li>
        <li>
          <button type="button" onClick={() => goToStep("details")} disabled={!canGoToDetails} style={stepPillStyle(step === "details", canGoToDetails)}>
            2. Details
          </button>
        </li>
      </ol>

      {step === "type" && (
        <div>
          <p style={{ color: theme.inkMuted }}>What kind of note is this?</p>
          <div style={{ display: "grid", gap: "0.75rem" }}>
            {(Object.keys(NOTE_TYPE_INFO) as NoteType[]).map((t) => (
              <button key={t} type="button" onClick={() => chooseNoteType(t)} style={tileStyle}>
                <div style={{ fontWeight: 600 }}>{NOTE_TYPE_INFO[t].title}</div>
                <div style={{ fontSize: "0.8rem", color: theme.inkMuted, marginTop: "0.15rem" }}>{NOTE_TYPE_INFO[t].blurb}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === "details" && noteType && !created && (
        <form onSubmit={handleSubmit}>
          <label style={labelStyle}>
            Stakeholder (lender)
            {stakeholders.length === 0 ? (
              <p style={{ color: theme.danger.fg }}>This entity has no stakeholders yet — add one first, then come back here.</p>
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
            Issue date
            <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} style={fieldInputStyle} />
          </label>

          <label style={labelStyle}>
            Label
            <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} style={fieldInputStyle} />
          </label>

          <div style={{ margin: "1rem 0", padding: "0.75rem", background: theme.surfaceAlt, border: `1px solid ${theme.border}`, borderRadius: 4 }}>
            {noteType === "PIK" && <PikNoteForm value={pikNote} onChange={setPikNote} />}
            {noteType === "CONVERTIBLE" && (
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
            {noteType === "WARRANT_NOTE" && (
              <>
                <p style={hintStyle}>
                  Two instruments will be created for the same stakeholder: the note below, then a warrant with the
                  terms further down.
                </p>
                <fieldset style={{ border: `1px solid ${theme.border}`, borderRadius: 4, padding: "0.75rem", marginBottom: "1rem" }}>
                  <legend style={{ padding: "0 0.4rem", fontWeight: 600, fontSize: "0.85rem" }}>The note</legend>
                  <TermDebtForm value={warrantNoteDebt} onChange={setWarrantNoteDebt} />
                </fieldset>
                <fieldset style={{ border: `1px solid ${theme.border}`, borderRadius: 4, padding: "0.75rem" }}>
                  <legend style={{ padding: "0 0.4rem", fontWeight: 600, fontSize: "0.85rem" }}>The warrant</legend>
                  <WarrantForm value={warrantNoteWarrant} onChange={setWarrantNoteWarrant} />
                </fieldset>
              </>
            )}
          </div>

          <button type="submit" disabled={status === "loading" || stakeholders.length === 0} style={buttonStyle}>
            {status === "loading" ? "Creating…" : "Create instrument"}
          </button>
          {message && <p style={{ color: theme.danger.fg, marginTop: "0.5rem" }}>{message}</p>}
        </form>
      )}

      {created && (
        <div>
          <p style={{ color: theme.success.fg }}>Created.</p>
          <ul>
            <li>
              <Link href={`/instruments/${created.noteId}`}>View the note &rarr;</Link>
            </li>
            {created.warrantId && (
              <li>
                <Link href={`/instruments/${created.warrantId}`}>View the warrant &rarr;</Link>
              </li>
            )}
          </ul>
          {message && <p style={{ color: theme.warning.fg }}>{message}</p>}
          <button
            type="button"
            style={buttonStyle}
            onClick={() => {
              setCreated(null);
              setStep("type");
              setNoteType(null);
              setStatus("idle");
              setMessage(null);
            }}
          >
            Create another note
          </button>
        </div>
      )}
    </div>
  );
}

const stepperStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  listStyle: "none",
  padding: 0,
  margin: "0 0 1.25rem",
  fontSize: "0.8rem",
};

function stepPillStyle(active: boolean, clickable: boolean): React.CSSProperties {
  return {
    font: "inherit",
    padding: "0.3rem 0.7rem",
    borderRadius: 999,
    background: active ? theme.accent : theme.surfaceAlt,
    color: active ? theme.onPrimary ?? "#fff" : theme.inkMuted,
    border: `1px solid ${active ? theme.accent : theme.border}`,
    cursor: clickable ? "pointer" : "not-allowed",
    opacity: clickable ? 1 : 0.5,
  };
}

const tileStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "0.85rem 1rem",
  border: `1px solid ${theme.border}`,
  borderRadius: 8,
  background: theme.surface,
  cursor: "pointer",
};

const buttonStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: `1px solid ${theme.ink}`,
  borderRadius: 4,
  background: theme.surfaceAlt,
  cursor: "pointer",
};
