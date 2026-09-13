"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  CommonStockForm,
  CommonStockState,
  PreferredStockForm,
  PreferredStockState,
  defaultCommonStockState,
  defaultPreferredStockState,
  toCommonStockTerms,
  toPreferredStockTerms,
} from "./termsFields/TypeForms";
import { labelStyle, inputStyle as fieldInputStyle, hintStyle } from "./termsFields/FieldPrimitives";
import { theme } from "@/lib/theme";
import type { PreferredStockInstrumentTerms } from "@/lib/accounting/dispatch";

type IssueMode = "existing" | "new";
type ClassKind = "COMMON" | "PREFERRED";

export interface ExistingPreferredSeries {
  seriesName: string;
  terms: PreferredStockInstrumentTerms;
}

/**
 * "New Equity Funding" wizard (v0.41.0) — George's ask, verbatim: "common stock and
 * preferred stock should be combined into 'New Equity Funding,' which has a user
 * choice to issue more of an existing class or create a new class." Replaces
 * NavBar's separate "Common stock" / "Preferred stock" links (see NavBar.tsx's
 * EQUITY_INSTRUMENT_TYPES) with one guided flow, same "pick the shape, then fill in
 * details" pattern StockAwardWizard.tsx and NotesWizard.tsx already use.
 *
 * "EXISTING CLASS" — WHAT THAT MEANS FOR EACH KIND, AND WHY:
 *  - PREFERRED: a "class" here is a `liquidationPreference.seriesName` group — see
 *    capTableWaterfall.ts's module doc comment. Picking an existing series PRE-FILLS
 *    this form with that series' actual seniority/preference-multiple/participation
 *    terms (fetched server-side — see equity-funding/page.tsx), because
 *    capTableWaterfall.ts's "Waterfall Analysis" report FLAGS AND EXCLUDES an entire
 *    series if its holders don't all agree on those terms. The fields stay editable
 *    (this form has no disabled/read-only mode, and the report's own inconsistency
 *    check is the safety net if someone changes one on purpose or by mistake — same
 *    "flag rather than silently constrain" posture the rest of this app takes) — the
 *    hint text next to the field group says so.
 *  - COMMON: this codebase has no dedicated "class name" field on COMMON_STOCK terms
 *    at all (`CommonStockState` is just a quantity — see TypeForms.tsx) — nothing
 *    downstream computes off a common share's class. So "existing class" for common
 *    reuses the free-text InstrumentTermVersion `label` some other COMMON_STOCK
 *    instrument on this entity already has (e.g. "Class A Common", set exactly this
 *    way by db/seed.sql's investor rows) — picking one just pre-fills THIS
 *    instrument's own label to match, purely for readability on the cap table and
 *    instrument list. It is not consumed by any engine or report.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export function EquityFundingWizard({
  entityId,
  stakeholders,
  initialStakeholderId,
  existingCommonClassLabels,
  existingPreferredSeries,
}: {
  entityId: string;
  stakeholders: { id: string; name: string; type: string }[];
  initialStakeholderId?: string;
  existingCommonClassLabels: string[];
  existingPreferredSeries: ExistingPreferredSeries[];
}) {
  const router = useRouter();
  const [step, setStep] = useState<"mode" | "kind" | "pick" | "details">("mode");
  const [issueMode, setIssueMode] = useState<IssueMode | null>(null);
  const [classKind, setClassKind] = useState<ClassKind | null>(null);
  const [pickedSeriesName, setPickedSeriesName] = useState<string | null>(null);

  const [stakeholderId, setStakeholderId] = useState(initialStakeholderId ?? stakeholders[0]?.id ?? "");
  const [issueDate, setIssueDate] = useState("2026-01-01");
  const [label, setLabel] = useState("Original terms");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const [commonStock, setCommonStock] = useState<CommonStockState>(defaultCommonStockState);
  const [preferredStock, setPreferredStock] = useState<PreferredStockState>(defaultPreferredStockState);

  const hasExistingClasses = existingCommonClassLabels.length > 0 || existingPreferredSeries.length > 0;

  function chooseMode(m: IssueMode) {
    setIssueMode(m);
    if (m === "existing") {
      setStep("pick");
    } else {
      setStep("kind");
    }
  }

  function chooseKind(k: ClassKind) {
    setClassKind(k);
    setPickedSeriesName(null);
    setStep("details");
  }

  function pickExistingCommon(existingLabel: string) {
    setClassKind("COMMON");
    setLabel(existingLabel);
    setStep("details");
  }

  function pickExistingPreferred(entry: ExistingPreferredSeries) {
    setClassKind("PREFERRED");
    setPickedSeriesName(entry.seriesName);
    const t = entry.terms;
    setPreferredStock((prev) => ({
      ...prev,
      mandatorilyRedeemable: t.classification.mandatorilyRedeemable,
      redeemableAtHolderOption: t.classification.redeemableAtHolderOption,
      redeemableUponContingentEventOutsideCompanyControl: t.classification.redeemableUponContingentEventOutsideCompanyControl,
      hasLiquidationPreference: !!t.liquidationPreference,
      seriesName: t.liquidationPreference?.seriesName ?? entry.seriesName,
      seniorityRank: t.liquidationPreference ? String(t.liquidationPreference.seniorityRank) : prev.seniorityRank,
      originalIssuePricePerShare: t.liquidationPreference ? String(t.liquidationPreference.originalIssuePricePerShare) : prev.originalIssuePricePerShare,
      liquidationPreferenceMultiple: t.liquidationPreference ? String(t.liquidationPreference.liquidationPreferenceMultiple) : prev.liquidationPreferenceMultiple,
      participating: t.liquidationPreference?.participating ?? prev.participating,
      hasParticipationCap: t.liquidationPreference?.participationCapMultiple !== undefined,
      participationCapMultiple:
        t.liquidationPreference?.participationCapMultiple !== undefined ? String(t.liquidationPreference.participationCapMultiple) : prev.participationCapMultiple,
      hasConversionTerms: !!t.conversionTerms,
      conversionRatio: t.conversionTerms ? String(t.conversionTerms.conversionRatio) : prev.conversionRatio,
      // conversionQuantity/accretionQuantity are THIS holder's own share count, not
      // copied from the series — left at the form's own defaults for them to fill in.
      accretionIssuePricePerShare: t.accretion ? String(t.accretion.issuePricePerShare) : prev.accretionIssuePricePerShare,
      accretionRedemptionDate: t.accretion?.redemptionDate ?? prev.accretionRedemptionDate,
      accretionRedemptionValuePerShare: t.accretion ? String(t.accretion.redemptionValuePerShare) : prev.accretionRedemptionValuePerShare,
    }));
    setLabel(entry.seriesName);
    setStep("details");
  }

  function goToStep(target: "mode" | "kind" | "pick" | "details") {
    if (target === "kind" && issueMode !== "new") return;
    if (target === "pick" && issueMode !== "existing") return;
    if (target === "details" && !classKind) return;
    setStep(target);
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
    try {
      const type = classKind === "PREFERRED" ? "PREFERRED_STOCK" : "COMMON_STOCK";
      const terms = classKind === "PREFERRED" ? toPreferredStockTerms(preferredStock) : toCommonStockTerms(commonStock);
      const res = await fetch("/api/instruments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId, stakeholderId, type, issueDate, terms, label }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setMessage(
          data.issues
            ? `${data.error}: ${data.issues.map((i: { path: string; message: string }) => `${i.path || "(root)"} ${i.message}`).join("; ")}`
            : data.error ?? "Failed to create instrument"
        );
        return;
      }
      router.push(`/instruments/${data.instrument.id}`);
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to create instrument");
    }
  }

  const canGoToKind = issueMode === "new";
  const canGoToPick = issueMode === "existing";
  const canGoToDetails = !!classKind;

  return (
    <div>
      <h1>New Equity Funding</h1>

      <ol style={stepperStyle}>
        <li>
          <button type="button" onClick={() => goToStep("mode")} style={stepPillStyle(step === "mode", true)}>
            1. Issue mode
          </button>
        </li>
        <li>
          {issueMode === "existing" ? (
            <button type="button" onClick={() => goToStep("pick")} disabled={!canGoToPick} style={stepPillStyle(step === "pick", canGoToPick)}>
              2. Pick a class
            </button>
          ) : (
            <button type="button" onClick={() => goToStep("kind")} disabled={!canGoToKind} style={stepPillStyle(step === "kind", canGoToKind)}>
              2. Class kind
            </button>
          )}
        </li>
        <li>
          <button type="button" onClick={() => goToStep("details")} disabled={!canGoToDetails} style={stepPillStyle(step === "details", canGoToDetails)}>
            3. Details
          </button>
        </li>
      </ol>

      {step === "mode" && (
        <div>
          <p style={{ color: theme.inkMuted }}>Are you issuing more of an existing class, or creating a new one?</p>
          <div style={{ display: "grid", gap: "0.75rem" }}>
            <button type="button" onClick={() => chooseMode("existing")} style={tileStyle} disabled={!hasExistingClasses}>
              <div style={{ fontWeight: 600 }}>Issue more of an existing class</div>
              <div style={{ fontSize: "0.8rem", color: theme.inkMuted, marginTop: "0.15rem" }}>
                {hasExistingClasses
                  ? "Add another holder to a common class or preferred series this entity already has."
                  : "No existing classes on this entity yet — create a new one instead."}
              </div>
            </button>
            <button type="button" onClick={() => chooseMode("new")} style={tileStyle}>
              <div style={{ fontWeight: 600 }}>Create a new class</div>
              <div style={{ fontSize: "0.8rem", color: theme.inkMuted, marginTop: "0.15rem" }}>
                A brand new common class or preferred series with its own terms.
              </div>
            </button>
          </div>
        </div>
      )}

      {step === "pick" && (
        <div>
          <p style={{ color: theme.inkMuted }}>Which existing class is this holder joining?</p>
          {existingPreferredSeries.length > 0 && (
            <>
              <div style={groupLabelStyle}>Preferred series</div>
              <div style={{ display: "grid", gap: "0.5rem", marginBottom: "1rem" }}>
                {existingPreferredSeries.map((s) => (
                  <button key={s.seriesName} type="button" onClick={() => pickExistingPreferred(s)} style={tileStyle}>
                    <div style={{ fontWeight: 600 }}>{s.seriesName}</div>
                  </button>
                ))}
              </div>
            </>
          )}
          {existingCommonClassLabels.length > 0 && (
            <>
              <div style={groupLabelStyle}>Common classes</div>
              <div style={{ display: "grid", gap: "0.5rem" }}>
                {existingCommonClassLabels.map((l) => (
                  <button key={l} type="button" onClick={() => pickExistingCommon(l)} style={tileStyle}>
                    <div style={{ fontWeight: 600 }}>{l}</div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {step === "kind" && (
        <div>
          <p style={{ color: theme.inkMuted }}>What kind of class is this?</p>
          <div style={{ display: "grid", gap: "0.75rem" }}>
            <button type="button" onClick={() => chooseKind("COMMON")} style={tileStyle}>
              <div style={{ fontWeight: 600 }}>Common stock</div>
            </button>
            <button type="button" onClick={() => chooseKind("PREFERRED")} style={tileStyle}>
              <div style={{ fontWeight: 600 }}>Preferred stock</div>
            </button>
          </div>
        </div>
      )}

      {step === "details" && classKind && (
        <form onSubmit={handleSubmit}>
          {issueMode === "existing" && classKind === "PREFERRED" && pickedSeriesName && (
            <p style={hintStyle}>
              Terms below were copied from <strong>{pickedSeriesName}</strong>&apos;s existing terms. They stay
              editable, but changing seniority, preference multiple, or participation will make this holder
              inconsistent with the rest of the series — the Waterfall Analysis report flags that rather than
              silently allowing it.
            </p>
          )}
          <label style={labelStyle}>
            Stakeholder (investor)
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
            {classKind === "COMMON" && <CommonStockForm value={commonStock} onChange={setCommonStock} />}
            {classKind === "PREFERRED" && <PreferredStockForm value={preferredStock} onChange={setPreferredStock} />}
          </div>

          <button type="submit" disabled={status === "loading" || stakeholders.length === 0} style={buttonStyle}>
            {status === "loading" ? "Creating…" : "Create instrument"}
          </button>
          {message && <p style={{ color: theme.danger.fg, marginTop: "0.5rem" }}>{message}</p>}
        </form>
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

const groupLabelStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  color: theme.inkMuted,
  margin: "0.5rem 0 0.35rem",
};

const buttonStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: `1px solid ${theme.ink}`,
  borderRadius: 4,
  background: theme.surfaceAlt,
  cursor: "pointer",
};
