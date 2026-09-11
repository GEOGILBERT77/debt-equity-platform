"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  MarketConditionGrantForm,
  MarketConditionGrantState,
  PerformanceConditionGrantForm,
  PerformanceConditionGrantState,
  RestrictedStockForm,
  RestrictedStockState,
  ServiceConditionGrantForm,
  ServiceConditionGrantState,
  StockOptionGrantForm,
  StockOptionGrantState,
  defaultMarketConditionGrantState,
  defaultPerformanceConditionGrantState,
  defaultRestrictedStockState,
  defaultServiceConditionGrantState,
  defaultStockOptionGrantState,
  toMarketConditionGrantTerms,
  toPerformanceConditionGrantTerms,
  toRestrictedStockTerms,
  toServiceConditionGrantTerms,
  toStockOptionGrantTerms,
} from "./termsFields/TypeForms";
import { hintStyle, labelStyle, inputStyle as fieldInputStyle } from "./termsFields/FieldPrimitives";
import { theme } from "@/lib/theme";

type AwardType = "NQ" | "ISO" | "RSU" | "RESTRICTED";
type VestingCondition = "service" | "performance" | "market";

const AWARD_TYPE_INFO: Record<AwardType, { title: string; blurb: string }> = {
  NQ: {
    title: "Stock option — Nonqualified (NQ)",
    blurb: "The default option grant. No IRC 422 eligibility requirements, but exercise income is ordinary income subject to withholding.",
  },
  ISO: {
    title: "Stock option — Incentive (ISO)",
    blurb: "Must meet IRC 422's requirements (this platform doesn't verify those). Drives Form 3921, the $100k limit, and AMT preference elsewhere in this app.",
  },
  RSU: {
    title: "RSU",
    blurb: "A promise to deliver shares for free once vesting conditions are met — nothing is purchased.",
  },
  RESTRICTED: {
    title: "Restricted stock",
    blurb: "Shares issued now, subject to forfeiture, usually for a nominal purchase price (or an early-exercised option's strike price).",
  },
};

/**
 * Consolidated "new stock award" wizard (v0.37.0) — replaces separately picking "Stock
 * option", "RSU", or "Restricted stock" from NavBar's "New transactions" menu (each of
 * which landed on the general-purpose NewInstrumentForm.tsx pre-set to that one type)
 * with a single guided flow: pick the award type, then choose manual entry or bulk
 * upload. Built in direct response to a user report that the three felt like redundant,
 * overlapping screens for what is conceptually one decision tree (see NavBar.tsx's doc
 * comment on the entity switcher for the shape of this kind of report — this is a
 * separate, later one, about instrument-creation entry points rather than navigation).
 *
 * WHY A SEPARATE COMPONENT RATHER THAN EXTENDING NewInstrumentForm: that component's
 * single `type` dropdown covers all eleven instrument types (debt included) and is
 * still the right home for anyone who wants it — this wizard only narrows the path for
 * the three types that are conceptually "the same decision, three checkboxes apart"
 * (see the ServiceConditionGrant family note atop TypeForms.tsx). Reusing its guided
 * sub-forms (imported above) rather than its dropdown-driven shell keeps one
 * implementation of each actual FORM, with just a different picker in front of it.
 * NewInstrumentForm.tsx, `/instruments/new`, and `/instruments/bulk-upload` are all
 * still there and unchanged — this wizard's "Enter manually" path POSTs to the same
 * /api/instruments endpoint with the same payload shape, and its "Bulk upload" path
 * hands off to the existing generalized bulk-upload page rather than duplicating that
 * flow.
 *
 * ISO vs NQ: both map to the STOCK_OPTION instrument type — the only difference is the
 * `isIncentiveStockOption` boolean on its terms (see StockOptionGrantState's doc
 * comment in TypeForms.tsx for why that field had no UI control at all until this
 * wizard needed one). Picking "ISO" or "NQ" here just seeds that box's starting value
 * on whichever vesting-condition form you land on next — it's still shown and still
 * editable there, so changing your mind mid-form doesn't mean starting over.
 *
 * BULK UPLOAD CAVEAT: the bulk-upload template (bulkUploadServiceConditionGrants.ts)
 * has no per-row ISO/NQ column — every stock-option grant it creates comes in as NQ
 * (isIncentiveStockOption left unset). If "ISO" was picked here and the user then
 * chooses bulk upload, a warning says so before they leave; there's no way to close
 * that gap without adding a column to the template and re-generating it, which is a
 * separate, larger piece of work (see BULK-UPLOAD-PLAN.md) than this wizard.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export function StockAwardWizard({
  entityId,
  stakeholders,
  initialStakeholderId,
}: {
  entityId: string;
  stakeholders: { id: string; name: string; type: string }[];
  initialStakeholderId?: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"type" | "path" | "manual">("type");
  const [awardType, setAwardType] = useState<AwardType | null>(null);
  const [vestingCondition, setVestingCondition] = useState<VestingCondition>("service");

  const [stakeholderId, setStakeholderId] = useState(initialStakeholderId ?? stakeholders[0]?.id ?? "");
  const [issueDate, setIssueDate] = useState("2026-01-01");
  const [label, setLabel] = useState("Original terms");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const [stockOption, setStockOption] = useState<StockOptionGrantState>(defaultStockOptionGrantState);
  const [stockOptionPerformance, setStockOptionPerformance] = useState<PerformanceConditionGrantState>(defaultPerformanceConditionGrantState);
  const [stockOptionMarket, setStockOptionMarket] = useState<MarketConditionGrantState>(defaultMarketConditionGrantState);
  const [rsu, setRsu] = useState<ServiceConditionGrantState>(defaultServiceConditionGrantState);
  const [restrictedStock, setRestrictedStock] = useState<RestrictedStockState>(defaultRestrictedStockState);

  function chooseAwardType(next: AwardType) {
    setAwardType(next);
    // Seeds the ISO checkbox on all three option-shaped forms from this choice — see
    // this component's doc comment. Only matters for NQ/ISO; RSU/restricted stock don't
    // carry the field at all.
    if (next === "NQ" || next === "ISO") {
      const isIso = next === "ISO";
      setStockOption((s) => ({ ...s, isIncentiveStockOption: isIso }));
      setStockOptionPerformance((s) => ({ ...s, isIncentiveStockOption: isIso }));
      setStockOptionMarket((s) => ({ ...s, isIncentiveStockOption: isIso }));
    }
    setStep("path");
  }

  function instrumentType(): "STOCK_OPTION" | "RSU" | "RESTRICTED_STOCK" {
    if (awardType === "RSU") return "RSU";
    if (awardType === "RESTRICTED") return "RESTRICTED_STOCK";
    return "STOCK_OPTION";
  }

  function currentTerms(): unknown {
    if (awardType === "RSU") return toServiceConditionGrantTerms(rsu);
    if (awardType === "RESTRICTED") return toRestrictedStockTerms(restrictedStock);
    // NQ or ISO
    if (vestingCondition === "performance") return toPerformanceConditionGrantTerms(stockOptionPerformance);
    if (vestingCondition === "market") return toMarketConditionGrantTerms(stockOptionMarket);
    return toStockOptionGrantTerms(stockOption);
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
      const res = await fetch("/api/instruments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId, stakeholderId, type: instrumentType(), issueDate, terms: currentTerms(), label }),
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

  const bulkUploadType = awardType === "RSU" ? "RSU" : awardType === "RESTRICTED" ? "RESTRICTED_STOCK" : "STOCK_OPTION";

  return (
    <div>
      <ol style={stepperStyle}>
        <li style={stepPillStyle(step === "type")}>1. Award type</li>
        <li style={stepPillStyle(step === "path")}>2. Manual or bulk</li>
        <li style={stepPillStyle(step === "manual")}>3. Details</li>
      </ol>

      {step === "type" && (
        <div>
          <p style={{ color: theme.inkMuted }}>What kind of stock award are you granting?</p>
          <div style={{ display: "grid", gap: "0.75rem" }}>
            {(Object.keys(AWARD_TYPE_INFO) as AwardType[]).map((t) => (
              <button key={t} type="button" onClick={() => chooseAwardType(t)} style={tileStyle}>
                <div style={{ fontWeight: 600 }}>{AWARD_TYPE_INFO[t].title}</div>
                <div style={{ fontSize: "0.8rem", color: theme.inkMuted, marginTop: "0.15rem" }}>{AWARD_TYPE_INFO[t].blurb}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === "path" && awardType && (
        <div>
          <p>
            <button type="button" onClick={() => setStep("type")} style={linkButtonStyle}>
              &larr; Change award type
            </button>
          </p>
          <p style={{ color: theme.inkMuted }}>
            Granting a <strong>{AWARD_TYPE_INFO[awardType].title}</strong>. How do you want to enter it?
          </p>
          <div style={{ display: "grid", gap: "0.75rem" }}>
            <button type="button" onClick={() => setStep("manual")} style={tileStyle}>
              <div style={{ fontWeight: 600 }}>Enter manually</div>
              <div style={{ fontSize: "0.8rem", color: theme.inkMuted, marginTop: "0.15rem" }}>
                One grantee, guided fields — full control over vesting, tranches, and conditions.
              </div>
            </button>
            <div style={tileStyle}>
              <div style={{ fontWeight: 600 }}>Bulk upload from a template</div>
              <div style={{ fontSize: "0.8rem", color: theme.inkMuted, margin: "0.15rem 0 0.5rem" }}>
                For multiple grantees on a standard vesting schedule (a total period, optional cliff, monthly
                thereafter). One row per grantee.
              </div>
              {awardType === "ISO" && (
                <p style={{ ...hintStyle, color: theme.warning.fg, margin: "0 0 0.5rem" }}>
                  Heads up: the bulk-upload template has no per-row ISO/NQ column — every grant it creates comes in
                  as nonqualified. To grant real ISOs, use "Enter manually" instead (or bulk-upload as NQ and fix
                  each one up afterward via "Modify terms").
                </p>
              )}
              <Link href={`/instruments/bulk-upload?entityId=${entityId}&type=${bulkUploadType}`} style={buttonLinkStyle}>
                Go to bulk upload &rarr;
              </Link>
            </div>
          </div>
        </div>
      )}

      {step === "manual" && awardType && (
        <form onSubmit={handleSubmit}>
          <p>
            <button type="button" onClick={() => setStep("path")} style={linkButtonStyle}>
              &larr; Back
            </button>
          </p>

          <label style={labelStyle}>
            Stakeholder
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
            {(awardType === "NQ" || awardType === "ISO") && (
              <>
                <label style={labelStyle}>
                  Vesting condition
                  <select
                    value={vestingCondition}
                    onChange={(e) => setVestingCondition(e.target.value as VestingCondition)}
                    style={fieldInputStyle}
                  >
                    <option value="service">Service (time-based)</option>
                    <option value="performance">Performance</option>
                    <option value="market">Market</option>
                  </select>
                </label>
                {vestingCondition === "service" && <StockOptionGrantForm value={stockOption} onChange={setStockOption} />}
                {vestingCondition === "performance" && (
                  <PerformanceConditionGrantForm value={stockOptionPerformance} onChange={setStockOptionPerformance} />
                )}
                {vestingCondition === "market" && <MarketConditionGrantForm value={stockOptionMarket} onChange={setStockOptionMarket} />}
              </>
            )}
            {awardType === "RSU" && <ServiceConditionGrantForm value={rsu} onChange={setRsu} />}
            {awardType === "RESTRICTED" && <RestrictedStockForm value={restrictedStock} onChange={setRestrictedStock} />}
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

function stepPillStyle(active: boolean): React.CSSProperties {
  return {
    padding: "0.3rem 0.7rem",
    borderRadius: 999,
    background: active ? theme.accent : theme.surfaceAlt,
    color: active ? theme.onPrimary ?? "#fff" : theme.inkMuted,
    border: `1px solid ${active ? theme.accent : theme.border}`,
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

const buttonLinkStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "0.4rem 0.8rem",
  border: `1px solid ${theme.ink}`,
  borderRadius: 4,
  background: theme.surfaceAlt,
  textDecoration: "none",
  color: "inherit",
};

const linkButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: theme.accent,
  cursor: "pointer",
  padding: 0,
  fontSize: "0.85rem",
  textDecoration: "underline",
};
