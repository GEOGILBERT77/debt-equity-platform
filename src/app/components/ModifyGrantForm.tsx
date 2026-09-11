"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  RestrictedStockForm,
  RestrictedStockState,
  ServiceConditionGrantForm,
  StockOptionGrantForm,
  toRestrictedStockTerms,
  toServiceConditionGrantTerms,
  toStockOptionGrantTerms,
} from "./termsFields/TypeForms";
import { labelStyle, inputStyle as fieldInputStyle } from "./termsFields/FieldPrimitives";
import { theme } from "@/lib/theme";

type GrantType = "STOCK_OPTION" | "RSU" | "RESTRICTED_STOCK";

/** One editable-state shape big enough for all three grant types this form handles —
 * `purchasePricePerShare` is only meaningful (and only sent) for RESTRICTED_STOCK,
 * `strikePrice`/`isIncentiveStockOption` only for STOCK_OPTION; each is simply ignored
 * by the other types' `toXTerms` converter. Simpler than a discriminated union here
 * since every field a ServiceConditionGrant needs is shared across all three anyway.
 *
 * v0.37.0 — `isIncentiveStockOption` added alongside `strikePrice` when
 * StockOptionGrantState (TypeForms.tsx) picked up that same field: StockOptionGrantForm
 * now requires it, so modifying an existing STOCK_OPTION grant needs it here too, or
 * `toStockOptionGrantTerms(state)`/`<StockOptionGrantForm value={state} .../>` below
 * fail to type-check. Caught by Vercel's real compiler, not this sandbox — same
 * pattern as every other JsonValue-adjacent type mismatch this app has hit. */
type EditableGrantState = RestrictedStockState & { strikePrice: string; isIncentiveStockOption: boolean };

/** Turns the instrument's CURRENTLY STORED terms (raw JSON, as read from
 * InstrumentTermVersion.terms) into editable form state — the mirror image of
 * toServiceConditionGrantTerms/toStockOptionGrantTerms/toRestrictedStockTerms in
 * TypeForms.tsx, which only goes the other direction (state -> terms). Stored values
 * are already the same strings the form works with (see FieldPrimitives.tsx's doc
 * comment on why every numeric field is a string, never a JS `number`) — this just
 * needs a synthetic `id` per tranche for React's list key / the tranche editor's own
 * bookkeeping, since the stored shape has no `id` field at all. */
function hydrateFromTerms(terms: unknown): EditableGrantState {
  const t = (terms ?? {}) as Record<string, unknown>;
  const tranches = Array.isArray(t.tranches)
    ? (t.tranches as Record<string, unknown>[]).map((tr, i) => ({
        id: `existing-${i}`,
        vestDate: String(tr.vestDate ?? ""),
        quantity: String(tr.quantity ?? ""),
      }))
    : [];
  return {
    grantDate: String(t.grantDate ?? ""),
    quantity: String(t.quantity ?? ""),
    grantDateFairValuePerUnit: String(t.grantDateFairValuePerUnit ?? ""),
    attributionMethod: t.attributionMethod === "graded" ? "graded" : "straight-line",
    tranches,
    servicePeriodEndDate: String(t.servicePeriodEndDate ?? ""),
    purchasePricePerShare: String(t.purchasePricePerShare ?? "0"),
    strikePrice: String(t.strikePrice ?? ""),
    // Preserves the grant's existing ISO/NQ status when you open it to modify
    // something else — without this, every STOCK_OPTION modification would silently
    // reset a real ISO grant back to NQ the moment the form re-serializes it.
    isIncentiveStockOption: Boolean(t.isIncentiveStockOption),
  };
}

interface ModificationPreview {
  applicable: boolean;
  message?: string;
  perPeriodDeltas: { periodEnd: string; label: string; beforeAmount: string; afterAmount: string; delta: string }[];
  totalBeforeAmount: string;
  totalAfterAmount: string;
  totalDelta: string;
}

/**
 * "Functionality that allows us to preview and report on the impacts of
 * modifications" — for the three instrument types with a full amortization table
 * (STOCK_OPTION, RSU, RESTRICTED_STOCK). Reuses the exact same per-type sub-forms
 * NewInstrumentForm.tsx uses for creating a grant (ServiceConditionGrantForm /
 * RestrictedStockForm), pre-filled with the instrument's CURRENT terms so a person
 * only edits what's actually changing.
 *
 * Flow: edit the proposed terms -> "Preview impact" (POST .../modifications/preview,
 * nothing persisted) shows the current vs. proposed amortization table and the dollar
 * delta -> "Commit this modification" (POST .../modifications) records it for real.
 * The commit button only appears once a preview has been run, matching this app's
 * intended (though not server-enforced — see the commit route's doc comment)
 * preview-before-commit relationship. Committing bundles this modification's one
 * required approval — see modifications/route.ts's doc comment — so there's no
 * further step after commit.
 */
export function ModifyGrantForm({
  instrumentId,
  type,
  currentTerms,
  currentEffectiveDate,
}: {
  instrumentId: string;
  type: GrantType;
  currentTerms: unknown;
  currentEffectiveDate: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<EditableGrantState>(() => hydrateFromTerms(currentTerms));
  const [effectiveDate, setEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [label, setLabel] = useState("Modification");
  const [previewStatus, setPreviewStatus] = useState<"idle" | "loading" | "error">("idle");
  const [preview, setPreview] = useState<ModificationPreview | null>(null);
  const [commitStatus, setCommitStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function buildTerms(): unknown {
    if (type === "RESTRICTED_STOCK") return toRestrictedStockTerms(state);
    if (type === "STOCK_OPTION") return toStockOptionGrantTerms(state);
    return toServiceConditionGrantTerms(state);
  }

  function invalidatePreview() {
    setPreview(null);
  }

  async function handlePreview() {
    setPreviewStatus("loading");
    setErrorMessage(null);
    setPreview(null);
    try {
      const res = await fetch(`/api/instruments/${instrumentId}/modifications/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ effectiveDate, terms: buildTerms(), label }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPreviewStatus("error");
        setErrorMessage(data.error ?? "Failed to compute impact");
        return;
      }
      setPreviewStatus("idle");
      setPreview(data);
    } catch (err) {
      setPreviewStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Failed to compute impact");
    }
  }

  async function handleCommit() {
    setCommitStatus("loading");
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/instruments/${instrumentId}/modifications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ effectiveDate, terms: buildTerms(), label }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCommitStatus("error");
        setErrorMessage(data.error ?? "Failed to commit modification");
        return;
      }
      router.push(`/instruments/${instrumentId}`);
    } catch (err) {
      setCommitStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Failed to commit modification");
    }
  }

  return (
    <div>
      <label style={labelStyle}>
        Effective date of this modification (must be after {currentEffectiveDate})
        <input
          type="date"
          value={effectiveDate}
          onChange={(e) => {
            setEffectiveDate(e.target.value);
            invalidatePreview();
          }}
          style={fieldInputStyle}
        />
      </label>
      <label style={labelStyle}>
        Label
        <input
          type="text"
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
            invalidatePreview();
          }}
          style={fieldInputStyle}
        />
      </label>

      <div style={{ margin: "1rem 0", padding: "0.75rem", background: theme.surfaceAlt, border: `1px solid ${theme.border}`, borderRadius: 4 }}>
        <p style={{ color: theme.inkMuted, marginTop: 0 }}>
          Pre-filled with this grant's current terms — edit whatever is actually changing (an extended vesting
          period, a new fair value, an added tranche) and leave the rest as-is.
        </p>
        {type === "RESTRICTED_STOCK" ? (
          <RestrictedStockForm
            value={state}
            onChange={(v) => {
              setState({ ...state, ...v });
              invalidatePreview();
            }}
          />
        ) : type === "STOCK_OPTION" ? (
          <StockOptionGrantForm
            value={state}
            onChange={(v) => {
              setState({ ...state, ...v });
              invalidatePreview();
            }}
          />
        ) : (
          <ServiceConditionGrantForm
            value={state}
            onChange={(v) => {
              setState({ ...state, ...v });
              invalidatePreview();
            }}
          />
        )}
      </div>

      <button type="button" onClick={handlePreview} disabled={previewStatus === "loading"} style={buttonStyle}>
        {previewStatus === "loading" ? "Computing impact…" : "Preview impact"}
      </button>
      {previewStatus === "error" && errorMessage && <p style={{ color: theme.danger.fg, marginTop: "0.5rem" }}>{errorMessage}</p>}

      {preview && (
        <div style={{ marginTop: "1rem" }}>
          <h3>Impact of this modification</h3>
          {!preview.applicable ? (
            <p style={{ color: theme.inkMuted }}>{preview.message}</p>
          ) : (
            <>
              <div style={{ display: "flex", gap: "2rem", margin: "0.75rem 0" }}>
                <div>
                  <div style={{ fontSize: "0.8rem", color: theme.inkMuted }}>Current total</div>
                  <div style={{ fontSize: "1.25rem", fontWeight: 600 }}>{preview.totalBeforeAmount}</div>
                </div>
                <div>
                  <div style={{ fontSize: "0.8rem", color: theme.inkMuted }}>Proposed total</div>
                  <div style={{ fontSize: "1.25rem", fontWeight: 600 }}>{preview.totalAfterAmount}</div>
                </div>
                <div>
                  <div style={{ fontSize: "0.8rem", color: theme.inkMuted }}>Change</div>
                  <div
                    style={{
                      fontSize: "1.25rem",
                      fontWeight: 600,
                      color: Number(preview.totalDelta) === 0 ? theme.inkMuted : Number(preview.totalDelta) > 0 ? theme.success.fg : theme.warning.fg,
                    }}
                  >
                    {Number(preview.totalDelta) > 0 ? "+" : ""}
                    {preview.totalDelta}
                  </div>
                </div>
              </div>
              <div style={{ maxHeight: 300, overflowY: "auto", border: `1px solid ${theme.border}` }}>
                <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.9rem" }}>
                  <thead>
                    <tr>
                      <th style={cellStyle}>Period</th>
                      <th style={cellStyle}>Current</th>
                      <th style={cellStyle}>Proposed</th>
                      <th style={cellStyle}>Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.perPeriodDeltas.map((d) => (
                      <tr key={d.periodEnd}>
                        <td style={cellStyle}>{d.label}</td>
                        <td style={cellStyle}>{d.beforeAmount}</td>
                        <td style={cellStyle}>{d.afterAmount}</td>
                        <td style={{ ...cellStyle, color: Number(d.delta) === 0 ? "inherit" : Number(d.delta) > 0 ? theme.success.fg : theme.warning.fg }}>
                          {Number(d.delta) > 0 ? "+" : ""}
                          {d.delta}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <div style={{ marginTop: "1rem" }}>
            <button type="button" onClick={handleCommit} disabled={commitStatus === "loading"} style={buttonStyle}>
              {commitStatus === "loading" ? "Committing…" : "Commit this modification"}
            </button>
            {commitStatus === "error" && errorMessage && <p style={{ color: theme.danger.fg, marginTop: "0.5rem" }}>{errorMessage}</p>}
            <p style={{ color: theme.inkMuted, fontSize: "0.85rem" }}>
              Committing records this as a new, permanent term version and immediately approves the resulting
              schedule — this is the one approval this modification needs; nothing further to do afterward.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: `1px solid ${theme.ink}`,
  borderRadius: 4,
  background: theme.surfaceAlt,
  cursor: "pointer",
};
const cellStyle: React.CSSProperties = { border: `1px solid ${theme.border}`, padding: "0.4rem", textAlign: "left" };
