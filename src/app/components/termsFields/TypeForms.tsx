"use client";

import { useEffect, useState } from "react";
import {
  BoolField,
  DateField,
  DecimalField,
  FieldGroup,
  SelectField,
  TextAreaField,
  TextField,
  hintStyle,
  labelStyle,
  inputStyle,
  fieldsetStyle,
  legendStyle,
  noteStyle,
} from "./FieldPrimitives";
import { theme } from "@/lib/theme";
import {
  CashFlowArrayField,
  CashFlowRow,
  DeferredFeeArrayField,
  DeferredFeeRow,
  ObservationArrayField,
  ObservationRow,
  TrancheArrayField,
  TrancheRow,
} from "./ArrayEditors";

/**
 * One bespoke editable-state shape, default value, form component, and `terms`-object
 * converter per DISTINCT shape family the engine layer defines — not per instrument
 * type, since several types share an identical (or near-identical) shape:
 * `ServiceConditionGrant` (vesting.ts) backs STOCK_OPTION, RSU, RESTRICTED_STOCK (plus
 * one field), and a stock-settled SAR's `equityTerms`; `TermDebtInputs`
 * (debtAmortization.ts) backs TERM_LOAN, CONVERTIBLE_NOTE (plus one field), and
 * PREFERRED_STOCK's liability-classified `debtTerms`. Reusing one form component for a
 * shared shape (rather than four copy-pasted near-duplicates) is the same "reuse over
 * reinvention" principle the engine layer itself follows (see dispatch.ts's SAR/
 * PREFERRED_STOCK doc comments) — applied here to the UI layer instead.
 *
 * Every `toXTerms` function below produces exactly the JSON shape `termsValidation.ts`
 * checks and the corresponding engine consumes — field for field, same key names — so
 * there is no separate "form schema" to keep in sync with the engine's own types
 * beyond these converters themselves.
 */

// ---- ServiceConditionGrant (STOCK_OPTION, RSU, RESTRICTED_STOCK, SAR equityTerms) ---

export interface ServiceConditionGrantState {
  grantDate: string;
  quantity: string;
  grantDateFairValuePerUnit: string;
  attributionMethod: "straight-line" | "graded";
  tranches: TrancheRow[];
  /** Blank = "same as the last vesting tranche" (the ordinary case). Set this only
   * when the requisite SERVICE period is a fact independent of the vesting schedule —
   * see ServiceConditionGrant.servicePeriodEndDate's doc comment in vesting.ts. Only
   * consulted for straight-line attribution. */
  servicePeriodEndDate: string;
}

export function defaultServiceConditionGrantState(): ServiceConditionGrantState {
  return {
    grantDate: "2026-01-01",
    quantity: "10000",
    grantDateFairValuePerUnit: "2.50",
    attributionMethod: "straight-line",
    tranches: [
      { id: "t1", vestDate: "2027-01-01", quantity: "2500" },
      { id: "t2", vestDate: "2028-01-01", quantity: "2500" },
      { id: "t3", vestDate: "2029-01-01", quantity: "2500" },
      { id: "t4", vestDate: "2030-01-01", quantity: "2500" },
    ],
    servicePeriodEndDate: "",
  };
}

export function toServiceConditionGrantTerms(s: ServiceConditionGrantState) {
  return {
    grantDate: s.grantDate,
    quantity: s.quantity,
    grantDateFairValuePerUnit: s.grantDateFairValuePerUnit,
    attributionMethod: s.attributionMethod,
    tranches: s.tranches.map((t) => ({ id: t.id, vestDate: t.vestDate, quantity: t.quantity })),
    ...(s.servicePeriodEndDate ? { servicePeriodEndDate: s.servicePeriodEndDate } : {}),
  };
}

export function ServiceConditionGrantForm({
  value,
  onChange,
  fairValueLabel = "Grant-date fair value per unit",
}: {
  value: ServiceConditionGrantState;
  onChange: (v: ServiceConditionGrantState) => void;
  fairValueLabel?: string;
}) {
  return (
    <>
      <DateField label="Grant date" value={value.grantDate} onChange={(v) => onChange({ ...value, grantDate: v })} />
      <DecimalField label="Total quantity" value={value.quantity} onChange={(v) => onChange({ ...value, quantity: v })} />
      <DecimalField label={fairValueLabel} value={value.grantDateFairValuePerUnit} onChange={(v) => onChange({ ...value, grantDateFairValuePerUnit: v })} />
      <SelectField
        label="Attribution method"
        value={value.attributionMethod}
        options={["straight-line", "graded"] as const}
        onChange={(v) => onChange({ ...value, attributionMethod: v })}
      />
      <TrancheArrayField label="Vesting tranches" value={value.tranches} onChange={(t) => onChange({ ...value, tranches: t })} />
      <DateField
        label="Service period ends (optional)"
        value={value.servicePeriodEndDate}
        onChange={(v) => onChange({ ...value, servicePeriodEndDate: v })}
      />
      <p style={hintStyle}>
        Leave blank if the expense should be recognized straight-line through the LAST vesting tranche above (the
        ordinary case). Set this only if the requisite service period is longer than the vesting schedule implies —
        e.g. shares vest over 4 years but the award requires 6 years of service to be fully earned. Only affects the
        straight-line attribution method; graded ties each tranche's recognition to its own vest date regardless.
      </p>
    </>
  );
}

// ---- STOCK_OPTION only: ServiceConditionGrant + a required strike price -------------
// Split out from ServiceConditionGrantForm (rather than adding strikePrice to it
// directly) because RSU/RESTRICTED_STOCK/SAR's stock-settled equityTerms all share
// that same base shape and none of them have a strike price — same "wrap the shared
// form, add the one extra type-specific field" pattern RestrictedStockForm already
// uses below for purchasePricePerShare.

export interface StockOptionGrantState extends ServiceConditionGrantState {
  strikePrice: string;
  /** v0.37.0 — was a real, silent gap: `termsValidation.ts` and the engine (see
   * dispatch.ts's StockOptionServiceConditionTerms) have supported this field since
   * v0.33.0 (it drives Form 3921 / iso-100k / rule-701 eligibility — see
   * optionTaxCompliance.ts), but no guided form ever exposed a control for it, so the
   * only way to grant an ISO through this form was "Edit as raw JSON instead" and
   * adding the key by hand. Found while building the consolidated "Stock award" wizard
   * (see StockAwardWizard.tsx), which needed a real NQ-vs-ISO choice to hand off to
   * this field. Defaults to false (NQ/NSO) — unchanged behavior for every existing
   * grant that never set it. */
  isIncentiveStockOption: boolean;
}

export function defaultStockOptionGrantState(): StockOptionGrantState {
  return { ...defaultServiceConditionGrantState(), strikePrice: "9.45", isIncentiveStockOption: false };
}

export function toStockOptionGrantTerms(s: StockOptionGrantState) {
  return { ...toServiceConditionGrantTerms(s), strikePrice: s.strikePrice, isIncentiveStockOption: s.isIncentiveStockOption };
}

export function StockOptionGrantForm({
  value,
  onChange,
}: {
  value: StockOptionGrantState;
  onChange: (v: StockOptionGrantState) => void;
}) {
  return (
    <>
      <ServiceConditionGrantForm value={value} onChange={(v) => onChange({ ...value, ...v })} />
      <DecimalField
        label="Strike price"
        value={value.strikePrice}
        onChange={(v) => onChange({ ...value, strikePrice: v })}
        hint="Disclosure only — not used by the expense schedule, which depends only on grant-date fair value. Required (a real exercise price, not a placeholder) whenever the ISO box below is checked, since Form 3921 needs it."
      />
      <BoolField
        label="Incentive stock option (ISO)"
        value={value.isIncentiveStockOption}
        onChange={(v) => onChange({ ...value, isIncentiveStockOption: v })}
      />
      <p style={hintStyle}>
        Leave unchecked for a nonqualified/nonstatutory option (NQ/NSO). Check this only for a grant that actually
        meets IRC 422's ISO requirements — it drives Form 3921 reporting, the IRC 422(d) $100k limit, and Rule 701
        eligibility elsewhere in this app. This platform doesn't verify ISO eligibility (10% owner limits, the
        $100k rule at grant time, plan/shareholder approval, etc.) — that's still on you.
      </p>
    </>
  );
}

// ---- STOCK_OPTION only: market condition (ASC 718-10-25, no reversal) --------------
// Simpler than the service-condition shape above: no tranches, no attribution method
// choice — a market-condition award's fair value already prices in the probability of
// achieving the hurdle (via the Monte Carlo/lattice model used to value it), so it's
// always a single straight-line allocation to the model's own derived service period.
// See StockOptionMarketConditionTerms's doc comment in dispatch.ts.

export interface MarketConditionGrantState {
  grantDate: string;
  quantity: string;
  grantDateFairValuePerUnit: string;
  strikePrice: string;
  derivedServiceEndDate: string;
  /** v0.37.0 — see StockOptionGrantState.isIncentiveStockOption's doc comment: the
   * same real gap (dispatch.ts's StockOptionMarketConditionTerms has supported this
   * since v0.33.0; no guided form ever exposed it), fixed here too rather than only on
   * the service-condition form it was first reported against. */
  isIncentiveStockOption: boolean;
  /** v0.38.0 — see the MARKET/PERFORMANCE CONDITION TRACKING doc comment further down.
   * Informational; not read by the engine — deliberately, for market conditions: see
   * that same doc comment for why a probability reassessment doesn't apply to them
   * under ASC 718-10-25 the way it does for a performance condition. */
  conditionDescription: string;
  /** v0.38.0 — same doc comment. */
  conditionCode: string;
  /** v0.38.0 — same doc comment; informational only, same reason. */
  expectedTimeToMeetMarketCondition: string;
}

export function defaultMarketConditionGrantState(): MarketConditionGrantState {
  return {
    grantDate: "2026-01-01",
    quantity: "10000",
    grantDateFairValuePerUnit: "3.50",
    strikePrice: "9.45",
    derivedServiceEndDate: "2032-01-01",
    isIncentiveStockOption: false,
    conditionDescription: "",
    conditionCode: "",
    expectedTimeToMeetMarketCondition: "",
  };
}

export function toMarketConditionGrantTerms(s: MarketConditionGrantState) {
  return {
    conditionType: "market" as const,
    grantDate: s.grantDate,
    quantity: s.quantity,
    grantDateFairValuePerUnit: s.grantDateFairValuePerUnit,
    strikePrice: s.strikePrice,
    derivedServiceEndDate: s.derivedServiceEndDate,
    isIncentiveStockOption: s.isIncentiveStockOption,
    ...(s.conditionDescription ? { conditionDescription: s.conditionDescription } : {}),
    ...(s.conditionCode ? { conditionCode: s.conditionCode } : {}),
    ...(s.expectedTimeToMeetMarketCondition ? { expectedTimeToMeetMarketCondition: s.expectedTimeToMeetMarketCondition } : {}),
  };
}

export function MarketConditionGrantForm({
  value,
  onChange,
}: {
  value: MarketConditionGrantState;
  onChange: (v: MarketConditionGrantState) => void;
}) {
  return (
    <>
      <p style={hintStyle}>
        Market condition: fair value (from an outside Monte Carlo / lattice valuation) already prices in the
        probability of achieving the hurdle, so expense is always straight-line over the valuation model&apos;s own
        derived service period, with no reversal even if the hurdle is ultimately missed.
      </p>
      <DateField label="Grant date" value={value.grantDate} onChange={(v) => onChange({ ...value, grantDate: v })} />
      <DecimalField label="Total quantity" value={value.quantity} onChange={(v) => onChange({ ...value, quantity: v })} />
      <DecimalField
        label="Grant-date fair value per unit"
        value={value.grantDateFairValuePerUnit}
        onChange={(v) => onChange({ ...value, grantDateFairValuePerUnit: v })}
        hint="From the outside valuation model — this platform doesn't compute a market-condition fair value itself."
      />
      <DecimalField
        label="Strike price"
        value={value.strikePrice}
        onChange={(v) => onChange({ ...value, strikePrice: v })}
        hint="Disclosure only — not used by the expense schedule. Required whenever the ISO box below is checked."
      />
      <DateField
        label="Derived service period end date"
        value={value.derivedServiceEndDate}
        onChange={(v) => onChange({ ...value, derivedServiceEndDate: v })}
        hint="From the same valuation model — not necessarily the award's stated contractual term."
      />
      <TextAreaField
        label="Market condition description (optional)"
        value={value.conditionDescription}
        onChange={(v) => onChange({ ...value, conditionDescription: v })}
        placeholder={'e.g. "Stock price closes at or above $50 for 20 consecutive trading days"'}
        rows={2}
      />
      <TextField
        label="Expected time to meet market condition (optional)"
        value={value.expectedTimeToMeetMarketCondition}
        onChange={(v) => onChange({ ...value, expectedTimeToMeetMarketCondition: v })}
        placeholder="e.g. 18 months, or a target date"
      />
      <p style={hintStyle}>
        Both boxes above are informational only — a market condition's fair value already prices in the probability
        of achievement, so (unlike a performance condition) nothing here changes the expense schedule, which stays
        fixed once granted with no reversal even if the hurdle is missed.
      </p>
      <TextField
        label="Condition code (optional)"
        value={value.conditionCode}
        onChange={(v) => onChange({ ...value, conditionCode: v })}
        placeholder="e.g. Apr 2026 Stock Price Mkt"
      />
      <p style={hintStyle}>
        A short tag for tracking this condition across grants — give two grants the SAME code when they actually
        vest on the same real-world condition.
        {value.conditionDescription.trim() && (
          <>
            {" "}
            Suggested:{" "}
            <button
              type="button"
              onClick={() => onChange({ ...value, conditionCode: suggestConditionCode(value.grantDate, value.conditionDescription, "Mkt") })}
              style={suggestionButtonStyle}
            >
              {suggestConditionCode(value.grantDate, value.conditionDescription, "Mkt")}
            </button>
          </>
        )}
      </p>
      <BoolField
        label="Incentive stock option (ISO)"
        value={value.isIncentiveStockOption}
        onChange={(v) => onChange({ ...value, isIncentiveStockOption: v })}
      />
      <p style={hintStyle}>
        Leave unchecked for a nonqualified option (NQ/NSO). See the service-condition form's ISO hint for what
        checking this drives elsewhere in the app — same field, same caveats, market-condition awards can be ISOs too.
      </p>
    </>
  );
}

/** Suggests a short, human-readable identifier for a performance/market condition —
 * e.g. grantDate "2026-04-15" + description "EBITDA target of $5M" + kind "Perf" ->
 * "Apr 2026 EBITDA target Perf". Requested (with that exact example) so multiple
 * grants tied to the SAME actual condition (e.g. everyone's award vesting on the same
 * FY26 EBITDA target) can be tagged consistently without everyone independently
 * inventing their own label. This only SUGGESTS the code (via the helper text and
 * "Use suggested code" button next to the field below) — it never overwrites
 * `conditionCode` on its own, since the grant date or description can keep changing
 * as someone fills out the rest of the form. See MARKET/PERFORMANCE CONDITION
 * TRACKING's doc comment further down for the larger feature this is one building
 * block of. */
function suggestConditionCode(grantDate: string, description: string, kind: "Perf" | "Mkt"): string {
  const parsed = new Date(`${grantDate}T00:00:00.000Z`);
  const monthYear = Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  const shortDescription = description.trim().split(/\s+/).slice(0, 3).join(" ");
  return [monthYear, shortDescription, kind].filter(Boolean).join(" ");
}

/**
 * MARKET/PERFORMANCE CONDITION TRACKING (v0.38.0) — George's request: "we need to be
 * able to classify the grants with the same performance and market conditions... it
 * would be important to create a performance and market code... for each grant so
 * that these can be tracked and maintained by the system." `conditionCode` (this note
 * applies to both PerformanceConditionGrantState and MarketConditionGrantState below)
 * is that tag — a short, freely-editable string (auto-suggested via
 * `suggestConditionCode` above) that multiple grants can share when they're actually
 * tied to the same real-world condition (e.g. every officer's award that vests on the
 * same FY26 EBITDA target).
 *
 * UPDATE (still v0.38.0, later in the same pass): the "not done yet" gap above is now
 * closed FOR PERFORMANCE CONDITIONS. `conditionCode`/`conditionDescription` below are
 * still always sent as informational text on the grant's own `terms`, but
 * PerformanceConditionGrantForm now also renders PerformanceConditionLinkPicker,
 * which can create a REAL, reusable PerformanceCondition database record (see
 * prisma/schema.prisma) from those same two fields, or link this grant to one another
 * grant already created — see `sharedConditionLinkMode` on
 * PerformanceConditionGrantState and `resolvePerformanceConditionLink` below.
 * Reassessing a shared condition's probability (updating it for every grant linked to
 * it in one action, "as part of the preview process prior to posting") is done from
 * the instrument's own page via PerformanceConditionAssessmentPanel.tsx, right next to
 * ApproveAmortizationScheduleButton — not from this form.
 *
 * MARKET CONDITIONS SPECIFICALLY: unlike a performance condition, ASC 718-10-25 prices
 * a market condition's probability of achievement INTO its grant-date fair value (via
 * the Monte Carlo/lattice valuation) — expense is recognized on a fixed schedule with
 * NO subsequent reversal even if the hurdle is ultimately missed (see
 * MarketConditionGrantForm's existing hint above). A later "assess for inclusion in
 * amortization" step, if it changes how much expense posts, would only be correct for
 * PERFORMANCE conditions' existing cumulative-catch-up mechanic
 * (`probabilityAssessments` on PerformanceConditionGrantState) — a market condition's
 * `conditionCode`/`conditionDescription`/`expectedTimeToMeetMarketCondition` stay
 * informational-only for that reason, not just for this pass.
 */

// ---- STOCK_OPTION only: performance condition (ASC 718-10-25, cumulative catch-up) -
// The one genuinely stateful engine of the three — see vesting.ts's module doc
// comment. `probabilityAssessments` needs one entry per MONTH of the requisite
// service period; this form auto-fills all of them as "probable" (the ordinary case
// for an award granted on the expectation performance will be met — produces a plain
// straight-line schedule, same shape as the other two condition types) whenever the
// service period is set/changed. There's no per-month editing UI yet — reaching a
// not-fully-probable scenario today means switching to "Edit as raw JSON instead" and
// editing individual { date, probable } entries by hand, or using "Modify terms" once
// the assessment actually needs to change (a real accounting event, not a data-entry
// nicety) — see dispatch.ts's doc comment on why this is scoped the way it is.

export interface PerformanceConditionGrantState {
  grantDate: string;
  quantity: string;
  grantDateFairValuePerUnit: string;
  strikePrice: string;
  requisiteServiceEndDate: string;
  /** One entry per month from grantDate to requisiteServiceEndDate — see this form's
   * module comment for why this is auto-generated (all "probable") rather than
   * hand-edited row by row. */
  probabilityAssessments: { date: string; probable: boolean }[];
  /** v0.37.0 — see StockOptionGrantState.isIncentiveStockOption's doc comment: the
   * same real gap (dispatch.ts's StockOptionPerformanceConditionTerms has supported
   * this since v0.33.0; no guided form ever exposed it), fixed here too. */
  isIncentiveStockOption: boolean;
  /** v0.38.0 — see the MARKET/PERFORMANCE CONDITION TRACKING doc comment above.
   * Informational when `sharedConditionLinkMode` is "none"; when "new", this becomes
   * the new shared PerformanceCondition's own description. Not read by the engine
   * either way. */
  conditionDescription: string;
  /** v0.38.0 — same doc comment. When `sharedConditionLinkMode` is "new", this is the
   * REQUIRED code for the new shared PerformanceCondition record (must be unique per
   * entity — see createPerformanceCondition's doc comment). When "none", it's purely
   * informational text on this grant's own terms, same as before shared tracking
   * existed. */
  conditionCode: string;
  /** v0.38.0 — REAL shared-condition tracking (see PerformanceCondition's doc comment
   * in prisma/schema.prisma): "none" keeps today's behavior — conditionCode/
   * conditionDescription are just text on this grant's own terms, and this grant's
   * probability is whatever `probabilityAssessments` above says. "new" creates a real
   * PerformanceCondition record (from conditionCode/conditionDescription) that OTHER
   * grants can later link to. "existing" links this grant to an ALREADY-CREATED shared
   * condition via `existingPerformanceConditionId` instead of typing a code at all.
   * Only "new"/"existing" cause the wizard to send a `performanceConditionId` when
   * creating the instrument — see StockAwardWizard.tsx/NewInstrumentForm.tsx's
   * handleSubmit and PerformanceConditionLinkPicker below. */
  sharedConditionLinkMode: "none" | "new" | "existing";
  /** Set only when sharedConditionLinkMode === "existing" — the id of the
   * PerformanceCondition selected from PerformanceConditionLinkPicker's dropdown. */
  existingPerformanceConditionId: string;
}

export function defaultPerformanceConditionGrantState(): PerformanceConditionGrantState {
  return {
    grantDate: "2026-01-01",
    quantity: "10000",
    grantDateFairValuePerUnit: "3.50",
    strikePrice: "9.45",
    requisiteServiceEndDate: "2032-01-01",
    probabilityAssessments: [],
    isIncentiveStockOption: false,
    conditionDescription: "",
    conditionCode: "",
    sharedConditionLinkMode: "none",
    existingPerformanceConditionId: "",
  };
}

export function toPerformanceConditionGrantTerms(s: PerformanceConditionGrantState) {
  return {
    conditionType: "performance" as const,
    grantDate: s.grantDate,
    quantity: s.quantity,
    grantDateFairValuePerUnit: s.grantDateFairValuePerUnit,
    strikePrice: s.strikePrice,
    requisiteServiceEndDate: s.requisiteServiceEndDate,
    probabilityAssessments: s.probabilityAssessments,
    isIncentiveStockOption: s.isIncentiveStockOption,
    ...(s.conditionDescription ? { conditionDescription: s.conditionDescription } : {}),
    ...(s.conditionCode ? { conditionCode: s.conditionCode } : {}),
  };
}

/** Generates one "probable: true" entry per calendar month from `grantDate`
 * (exclusive) through `requisiteServiceEndDate` (inclusive) — mirrors
 * `buildMonthlyPeriods` (dateMath.ts) closely enough for the common case without
 * importing the engine's own period-splitting function into a form component; the
 * server-side computation is still the authority on exact period boundaries. */
function generateMonthlyProbableAssessments(grantDate: string, endDate: string): { date: string; probable: boolean }[] {
  const assessments: { date: string; probable: boolean }[] = [];
  const start = new Date(`${grantDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return assessments;
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate()));
  while (cursor < end) {
    assessments.push({ date: cursor.toISOString().slice(0, 10), probable: true });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate()));
  }
  assessments.push({ date: endDate, probable: true });
  return assessments;
}

/** Shape returned by GET /api/entities/:id/performance-conditions — see
 * PerformanceConditionSummary in src/lib/db/performanceConditions.ts (kept in sync by
 * hand, same posture as every other `toXTerms` shape in this file mirroring its
 * server-side counterpart without a shared generated type). */
export interface PerformanceConditionSummary {
  id: string;
  code: string;
  description: string | null;
  latestAssessment: { effectiveDate: string; probable: boolean } | null;
  linkedGrantCount: number;
}

/**
 * v0.38.0 — the "link to a shared condition" half of PerformanceConditionGrantForm,
 * pulled into its own component since it owns an independent data fetch (the entity's
 * existing conditions) that only ever needs to run when "existing" mode is selected.
 * Renders the three-way choice (none / create new / link existing) plus, in "existing"
 * mode, the picker itself.
 */
function PerformanceConditionLinkPicker({
  entityId,
  value,
  onChange,
}: {
  entityId: string;
  value: PerformanceConditionGrantState;
  onChange: (v: PerformanceConditionGrantState) => void;
}) {
  const [conditions, setConditions] = useState<PerformanceConditionSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (value.sharedConditionLinkMode !== "existing" || conditions !== null || loadError) return;
    let cancelled = false;
    fetch(`/api/entities/${entityId}/performance-conditions`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setConditions(Array.isArray(data.performanceConditions) ? data.performanceConditions : []);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Failed to load this entity's existing performance conditions.");
      });
    return () => {
      cancelled = true;
    };
  }, [entityId, value.sharedConditionLinkMode, conditions, loadError]);

  return (
    <>
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Shared condition tracking</legend>
        <p style={hintStyle}>
          Several grants can vest on the exact same real-world condition (e.g. every officer&apos;s award tied to the
          same FY26 EBITDA target). Linking them to one shared record means assessing the condition&apos;s
          probability ONCE updates amortization for every grant linked to it — see &quot;Assess for amortization&quot;
          on the amortization preview screen.
        </p>
        {(
          [
            { mode: "none" as const, label: "Don't share — track this grant on its own (default)" },
            { mode: "new" as const, label: "Create a new shared condition from the fields below" },
            { mode: "existing" as const, label: "Link to a condition another grant already created" },
          ]
        ).map(({ mode, label: optionLabel }) => (
          <label key={mode} style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem", margin: "0.3rem 0" }}>
            <input
              type="radio"
              name="sharedConditionLinkMode"
              checked={value.sharedConditionLinkMode === mode}
              onChange={() => onChange({ ...value, sharedConditionLinkMode: mode })}
            />
            {optionLabel}
          </label>
        ))}
        {value.sharedConditionLinkMode === "existing" && (
          <label style={labelStyle}>
            Existing shared condition
            {loadError ? (
              <p style={noteStyle}>{loadError}</p>
            ) : conditions === null ? (
              <p style={hintStyle}>Loading…</p>
            ) : conditions.length === 0 ? (
              <p style={hintStyle}>
                No shared conditions exist yet for this entity — choose &quot;Create a new shared condition&quot;
                instead.
              </p>
            ) : (
              <select
                value={value.existingPerformanceConditionId}
                onChange={(e) => onChange({ ...value, existingPerformanceConditionId: e.target.value })}
                style={inputStyle}
              >
                <option value="">Choose one…</option>
                {conditions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} — {c.linkedGrantCount} grant{c.linkedGrantCount === 1 ? "" : "s"} linked
                    {c.latestAssessment
                      ? `, last assessed ${c.latestAssessment.probable ? "probable" : "not probable"} as of ${c.latestAssessment.effectiveDate}`
                      : ", never assessed"}
                  </option>
                ))}
              </select>
            )}
          </label>
        )}
      </fieldset>
    </>
  );
}

export function PerformanceConditionGrantForm({
  value,
  onChange,
  entityId,
}: {
  value: PerformanceConditionGrantState;
  onChange: (v: PerformanceConditionGrantState) => void;
  /** v0.38.0 — when provided, renders PerformanceConditionLinkPicker above the
   * code/description fields so this grant can link to (or create) a real shared
   * PerformanceCondition record instead of only carrying informational text. Every
   * current call site (StockAwardWizard.tsx, NewInstrumentForm.tsx) has an entityId in
   * scope and passes it; it's optional only so a hypothetical future caller with no
   * entity context yet doesn't break. */
  entityId?: string;
}) {
  const probableCount = value.probabilityAssessments.filter((a) => a.probable).length;
  const linkedToExisting = value.sharedConditionLinkMode === "existing";
  return (
    <>
      <p style={hintStyle}>
        Performance condition: recognized only once achievement is probable, with a cumulative catch-up if that
        assessment changes and a full reversal if it becomes improbable. The probability assessment is an ongoing
        judgment, not a one-time input — see the &quot;Probability assessments&quot; note below.
      </p>
      <DateField label="Grant date" value={value.grantDate} onChange={(v) => onChange({ ...value, grantDate: v })} />
      <DecimalField label="Total quantity" value={value.quantity} onChange={(v) => onChange({ ...value, quantity: v })} />
      <DecimalField
        label="Grant-date fair value per unit"
        value={value.grantDateFairValuePerUnit}
        onChange={(v) => onChange({ ...value, grantDateFairValuePerUnit: v })}
      />
      <DecimalField
        label="Strike price"
        value={value.strikePrice}
        onChange={(v) => onChange({ ...value, strikePrice: v })}
        hint="Disclosure only — not used by the expense schedule."
      />
      <DateField
        label="Requisite service period end date"
        value={value.requisiteServiceEndDate}
        onChange={(v) =>
          onChange({
            ...value,
            requisiteServiceEndDate: v,
            probabilityAssessments: generateMonthlyProbableAssessments(value.grantDate, v),
          })
        }
      />
      <p style={hintStyle}>
        Probability assessments: {value.probabilityAssessments.length} month(s) populated, {probableCount} marked
        probable. Set above to auto-fill every month as probable (the ordinary case — produces a plain straight-line
        schedule). {linkedToExisting
          ? "Ignored once linked to an existing shared condition below — that condition's own assessment history drives amortization instead."
          : 'To record a change in assessment later, use "Modify terms" on the instrument\'s own page, or "Edit as raw JSON instead" below for a scenario needing per-month control now — or link/create a shared condition below for an ongoing, reassessable judgment.'}
      </p>
      {entityId && <PerformanceConditionLinkPicker entityId={entityId} value={value} onChange={onChange} />}
      {!linkedToExisting && (
        <>
          <TextAreaField
            label={value.sharedConditionLinkMode === "new" ? "Performance metric description" : "Performance metric description (optional)"}
            value={value.conditionDescription}
            onChange={(v) => onChange({ ...value, conditionDescription: v })}
            placeholder={'e.g. "EBITDA must exceed $5M for FY2026"'}
            rows={2}
          />
          <p style={hintStyle}>
            {value.sharedConditionLinkMode === "new"
              ? "Becomes the new shared condition's own description."
              : "Informational only — not used by the expense schedule or any calculation."}
          </p>
          <TextField
            label={value.sharedConditionLinkMode === "new" ? "Condition code" : "Condition code (optional)"}
            value={value.conditionCode}
            onChange={(v) => onChange({ ...value, conditionCode: v })}
            placeholder="e.g. Apr 2026 EBITDA Perf"
          />
          <p style={hintStyle}>
            {value.sharedConditionLinkMode === "new"
              ? "Required — this becomes the new shared condition's unique code within this entity, so other grants can find and link to it."
              : "A short tag for tracking this condition across grants."}
            {value.conditionDescription.trim() && (
              <>
                {" "}
                Suggested:{" "}
                <button
                  type="button"
                  onClick={() => onChange({ ...value, conditionCode: suggestConditionCode(value.grantDate, value.conditionDescription, "Perf") })}
                  style={suggestionButtonStyle}
                >
                  {suggestConditionCode(value.grantDate, value.conditionDescription, "Perf")}
                </button>
              </>
            )}
          </p>
        </>
      )}
      <BoolField
        label="Incentive stock option (ISO)"
        value={value.isIncentiveStockOption}
        onChange={(v) => onChange({ ...value, isIncentiveStockOption: v })}
      />
      <p style={hintStyle}>
        Leave unchecked for a nonqualified option (NQ/NSO). See the service-condition form's ISO hint for what
        checking this drives elsewhere in the app — same field, same caveats, performance-condition awards can be
        ISOs too.
      </p>
    </>
  );
}

/**
 * v0.38.0 — resolves `sharedConditionLinkMode` into the `performanceConditionId` to
 * send with POST /api/instruments (or the modification route), CREATING the shared
 * PerformanceCondition first if mode is "new". Returns `undefined` for "none" (no
 * link — today's behavior, unchanged) or when the required inputs for the chosen mode
 * are missing (an empty code for "new", or nothing picked for "existing") — the caller
 * treats that the same as "none" rather than blocking submission, since a
 * performance-condition grant is still perfectly valid without shared tracking. Throws
 * only when "new" mode's create call itself fails (e.g. a duplicate code), so the
 * caller can surface that as a real submission error rather than silently dropping the
 * link the user asked for.
 */
export async function resolvePerformanceConditionLink(
  entityId: string,
  s: PerformanceConditionGrantState
): Promise<string | undefined> {
  if (s.sharedConditionLinkMode === "existing") {
    return s.existingPerformanceConditionId || undefined;
  }
  if (s.sharedConditionLinkMode === "new") {
    const code = s.conditionCode.trim();
    if (!code) return undefined;
    const res = await fetch(`/api/entities/${entityId}/performance-conditions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, description: s.conditionDescription || undefined }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error ?? "Failed to create the shared performance condition");
    }
    return data.performanceCondition.id as string;
  }
  return undefined;
}

// ---- TermDebtInputs (TERM_LOAN, CONVERTIBLE_NOTE, PREFERRED_STOCK debtTerms) --------

export interface TermDebtState {
  faceValue: string;
  netProceeds: string;
  effectiveAnnualYield: string;
  cashFlows: CashFlowRow[];
}

export function defaultTermDebtState(): TermDebtState {
  return {
    faceValue: "1000000",
    netProceeds: "980000",
    effectiveAnnualYield: "0.07",
    cashFlows: [{ date: "2027-01-01", amount: "70000" }],
  };
}

export function toTermDebtTerms(s: TermDebtState) {
  return {
    faceValue: s.faceValue,
    netProceeds: s.netProceeds,
    effectiveAnnualYield: s.effectiveAnnualYield,
    cashFlows: s.cashFlows.map((cf) => ({ date: cf.date, amount: cf.amount })),
  };
}

export function TermDebtForm({ value, onChange }: { value: TermDebtState; onChange: (v: TermDebtState) => void }) {
  return (
    <>
      <DecimalField label="Face value" value={value.faceValue} onChange={(v) => onChange({ ...value, faceValue: v })} />
      <DecimalField label="Net proceeds" value={value.netProceeds} onChange={(v) => onChange({ ...value, netProceeds: v })} hint="Cash actually received, after issuance costs and any discount." />
      <DecimalField
        label="Effective annual yield"
        value={value.effectiveAnnualYield}
        onChange={(v) => onChange({ ...value, effectiveAnnualYield: v })}
        hint="As a decimal (0.07 = 7%). Use solveEffectiveYield if you only have the stated cash flows, not the yield itself."
      />
      <CashFlowArrayField
        label="Cash flows"
        value={value.cashFlows}
        onChange={(cf) => onChange({ ...value, cashFlows: cf })}
        hint="Exactly one entry per annual period from issuance to today — add another each year as time passes, in chronological order."
      />
    </>
  );
}

// ---- PIK_NOTE ------------------------------------------------------------------------

export interface PikNoteState {
  initialPrincipal: string;
  annualPikRate: string;
}
export function defaultPikNoteState(): PikNoteState {
  return { initialPrincipal: "500000", annualPikRate: "0.10" };
}
export function toPikNoteTerms(s: PikNoteState) {
  return { initialPrincipal: s.initialPrincipal, annualPikRate: s.annualPikRate };
}
export function PikNoteForm({ value, onChange }: { value: PikNoteState; onChange: (v: PikNoteState) => void }) {
  return (
    <>
      <DecimalField label="Initial principal" value={value.initialPrincipal} onChange={(v) => onChange({ ...value, initialPrincipal: v })} />
      <DecimalField
        label="Annual PIK rate"
        value={value.annualPikRate}
        onChange={(v) => onChange({ ...value, annualPikRate: v })}
        hint="As a decimal (0.10 = 10%). Compounds onto the growing balance — no cash payments."
      />
    </>
  );
}

// ---- REVOLVER --------------------------------------------------------------------

export interface RevolverState {
  hasCommitmentFee: boolean;
  totalCommitmentFee: string;
  commitmentStart: string;
  commitmentEnd: string;
  deferredFees: DeferredFeeRow[];
}
export function defaultRevolverState(): RevolverState {
  return {
    hasCommitmentFee: true,
    totalCommitmentFee: "20000",
    commitmentStart: "2026-01-01",
    commitmentEnd: "2028-01-01",
    deferredFees: [{ id: "closing", amount: "60000", amortizationStart: "2026-01-01", amortizationEnd: "2028-01-01" }],
  };
}
export function toRevolverTerms(s: RevolverState) {
  const terms: Record<string, unknown> = {};
  if (s.hasCommitmentFee) {
    terms.commitmentFee = {
      totalCommitmentFee: s.totalCommitmentFee,
      commitmentStart: s.commitmentStart,
      commitmentEnd: s.commitmentEnd,
    };
  }
  if (s.deferredFees.length > 0) {
    terms.deferredFees = s.deferredFees.map((f) => ({
      id: f.id,
      amount: f.amount,
      amortizationStart: f.amortizationStart,
      amortizationEnd: f.amortizationEnd,
    }));
  }
  return terms;
}
export function RevolverForm({ value, onChange }: { value: RevolverState; onChange: (v: RevolverState) => void }) {
  return (
    <>
      <p style={hintStyle}>Covers the unused-commitment fee and deferred financing fee amortization only — interest on the drawn balance isn't modeled.</p>
      <BoolField label="This facility has an unused-commitment fee" value={value.hasCommitmentFee} onChange={(v) => onChange({ ...value, hasCommitmentFee: v })} />
      {value.hasCommitmentFee && (
        <FieldGroup title="Commitment fee">
          <DecimalField label="Total commitment fee" value={value.totalCommitmentFee} onChange={(v) => onChange({ ...value, totalCommitmentFee: v })} />
          <DateField label="Commitment start" value={value.commitmentStart} onChange={(v) => onChange({ ...value, commitmentStart: v })} />
          <DateField label="Commitment end" value={value.commitmentEnd} onChange={(v) => onChange({ ...value, commitmentEnd: v })} />
        </FieldGroup>
      )}
      <DeferredFeeArrayField value={value.deferredFees} onChange={(f) => onChange({ ...value, deferredFees: f })} />
      {!value.hasCommitmentFee && value.deferredFees.length === 0 && (
        <p style={{ color: theme.danger.fg, fontSize: "0.8rem" }}>A revolver needs at least a commitment fee or a deferred fee.</p>
      )}
    </>
  );
}

// ---- WARRANT -----------------------------------------------------------------------

export interface WarrantState {
  netCashSettlementPossible: boolean;
  indexedToOwnStockOnly: boolean;
  hasDownRoundProtection: boolean;
  sharesIssuable: string;
  instrumentAccountName: string;
  hasRemeasurement: boolean;
  inceptionDate: string;
  inceptionFairValue: string;
  observations: ObservationRow[];
}
export function defaultWarrantState(): WarrantState {
  return {
    netCashSettlementPossible: false,
    indexedToOwnStockOnly: true,
    hasDownRoundProtection: false,
    sharesIssuable: "5000",
    instrumentAccountName: "Warrant Liability",
    hasRemeasurement: false,
    inceptionDate: "2026-01-01",
    inceptionFairValue: "100000",
    observations: [{ date: "2027-01-01", value: "120000" }],
  };
}
export function toWarrantTerms(s: WarrantState) {
  const terms: Record<string, unknown> = {
    classification: {
      netCashSettlementPossible: s.netCashSettlementPossible,
      indexedToOwnStockOnly: s.indexedToOwnStockOnly,
      hasDownRoundProtection: s.hasDownRoundProtection,
    },
    sharesIssuable: s.sharesIssuable,
  };
  if (s.instrumentAccountName.trim()) terms.instrumentAccountName = s.instrumentAccountName;
  if (s.hasRemeasurement) {
    terms.remeasurement = {
      inceptionDate: s.inceptionDate,
      inceptionFairValue: s.inceptionFairValue,
      observations: s.observations.map((o) => ({ date: o.date, fairValue: o.value })),
    };
  }
  return terms;
}
export function WarrantForm({ value, onChange }: { value: WarrantState; onChange: (v: WarrantState) => void }) {
  const likelyLiability = value.netCashSettlementPossible || !value.indexedToOwnStockOnly;
  return (
    <>
      <FieldGroup title="Classification (ASC 480 / ASC 815-40)">
        <BoolField
          label="Net cash settlement is possible (the company could be required to settle in cash)"
          value={value.netCashSettlementPossible}
          onChange={(v) => onChange({ ...value, netCashSettlementPossible: v })}
        />
        <BoolField
          label="Indexed to the company's own stock only (fixed-for-fixed, no variable strike/share count)"
          value={value.indexedToOwnStockOnly}
          onChange={(v) => onChange({ ...value, indexedToOwnStockOnly: v })}
        />
        <BoolField
          label="Has down-round protection"
          value={value.hasDownRoundProtection}
          onChange={(v) => onChange({ ...value, hasDownRoundProtection: v })}
        />
        {value.hasDownRoundProtection && (
          <p style={{ color: theme.danger.fg, fontSize: "0.8rem" }}>
            Down-round protection means classification needs a human judgment call (ASU 2017-11 may still permit
            equity) — the schedule can't be computed until that's resolved outside this form.
          </p>
        )}
        {!value.hasDownRoundProtection && (
          <p style={hintStyle}>
            {likelyLiability
              ? "This combination classifies as liability-classified — fill in the remeasurement block below."
              : "This combination classifies as equity-classified — no periodic remeasurement needed."}
          </p>
        )}
      </FieldGroup>
      <DecimalField
        label="Shares issuable"
        value={value.sharesIssuable}
        onChange={(v) => onChange({ ...value, sharesIssuable: v })}
        hint="Used by the cap table's fully-diluted rollup, regardless of equity/liability classification."
      />
      <BoolField
        label="This warrant is liability-classified and needs fair-value remeasurement"
        value={value.hasRemeasurement}
        onChange={(v) => onChange({ ...value, hasRemeasurement: v })}
      />
      {value.hasRemeasurement && (
        <FieldGroup title="Fair value remeasurement (ASC 815-40)">
          <TextField label="Balance-sheet account name" value={value.instrumentAccountName} onChange={(v) => onChange({ ...value, instrumentAccountName: v })} />
          <DateField label="Inception date" value={value.inceptionDate} onChange={(v) => onChange({ ...value, inceptionDate: v })} />
          <DecimalField label="Inception fair value" value={value.inceptionFairValue} onChange={(v) => onChange({ ...value, inceptionFairValue: v })} />
          <ObservationArrayField
            label="Fair value observations"
            valueLabel="Fair value"
            value={value.observations}
            onChange={(o) => onChange({ ...value, observations: o })}
            hint="One entry per period you want visible, in chronological order, each after inceptionDate."
          />
        </FieldGroup>
      )}
    </>
  );
}

// ---- COMMON_STOCK --------------------------------------------------------------------

export interface CommonStockState {
  quantity: string;
}
export function defaultCommonStockState(): CommonStockState {
  return { quantity: "100000" };
}
export function toCommonStockTerms(s: CommonStockState) {
  return { quantity: s.quantity };
}
export function CommonStockForm({ value, onChange }: { value: CommonStockState; onChange: (v: CommonStockState) => void }) {
  return (
    <>
      <DecimalField label="Quantity" value={value.quantity} onChange={(v) => onChange({ ...value, quantity: v })} />
      <p style={hintStyle}>No periodic schedule engine exists for plain common stock — there's nothing to vest or amortize.</p>
    </>
  );
}

// ---- PREFERRED_STOCK -------------------------------------------------------------

export interface PreferredStockState {
  mandatorilyRedeemable: boolean;
  redeemableAtHolderOption: boolean;
  redeemableUponContingentEventOutsideCompanyControl: boolean;
  debtTerms: TermDebtState;
  accretionIssueDate: string;
  accretionQuantity: string;
  accretionIssuePricePerShare: string;
  accretionRedemptionDate: string;
  accretionRedemptionValuePerShare: string;
  // v0.41.0 — liquidation preference / exit-waterfall terms (dispatch.ts's
  // LiquidationPreferenceTerms + PreferredConversionTerms). Both optional and OFF by
  // default (hasLiquidationPreference/hasConversionTerms both false), so nothing about
  // this addition changes toPreferredStockTerms's output for anyone who doesn't touch
  // it — the exact same {classification, debtTerms|accretion} shape as before this
  // existed. Added specifically so "New Equity Funding"'s "create a new preferred
  // class" path (EquityFundingWizard.tsx) can actually record what MAKES a preferred
  // class a class — seniority, preference multiple, participation — which this form
  // had no fields for at all before (only reachable via NewInstrumentForm's "edit as
  // raw JSON" escape hatch). capTableWaterfall.ts's own "Waterfall Analysis" report
  // is what actually reads these; nothing in this file's own schedule/journal-entry
  // path (preferredStock.ts) consumes them.
  hasLiquidationPreference: boolean;
  seriesName: string;
  seniorityRank: string;
  originalIssuePricePerShare: string;
  liquidationPreferenceMultiple: string;
  participating: boolean;
  hasParticipationCap: boolean;
  participationCapMultiple: string;
  hasConversionTerms: boolean;
  conversionQuantity: string;
  conversionRatio: string;
}
export function defaultPreferredStockState(): PreferredStockState {
  return {
    mandatorilyRedeemable: false,
    redeemableAtHolderOption: true,
    redeemableUponContingentEventOutsideCompanyControl: false,
    debtTerms: defaultTermDebtState(),
    accretionIssueDate: "2026-01-01",
    accretionQuantity: "100000",
    accretionIssuePricePerShare: "1.00",
    accretionRedemptionDate: "2031-01-01",
    accretionRedemptionValuePerShare: "1.30",
    hasLiquidationPreference: false,
    seriesName: "",
    seniorityRank: "1",
    originalIssuePricePerShare: "1.00",
    liquidationPreferenceMultiple: "1",
    participating: false,
    hasParticipationCap: false,
    participationCapMultiple: "3",
    hasConversionTerms: false,
    conversionQuantity: "100000",
    conversionRatio: "1",
  };
}
function classifyPreferredLocally(s: PreferredStockState): "liability" | "mezzanine" | "permanent_equity" {
  if (s.mandatorilyRedeemable) return "liability";
  if (s.redeemableAtHolderOption || s.redeemableUponContingentEventOutsideCompanyControl) return "mezzanine";
  return "permanent_equity";
}
export function toPreferredStockTerms(s: PreferredStockState) {
  const classification = {
    mandatorilyRedeemable: s.mandatorilyRedeemable,
    redeemableAtHolderOption: s.redeemableAtHolderOption,
    redeemableUponContingentEventOutsideCompanyControl: s.redeemableUponContingentEventOutsideCompanyControl,
  };
  const kind = classifyPreferredLocally(s);
  const terms: Record<string, unknown> = { classification };
  if (kind === "liability") {
    terms.debtTerms = toTermDebtTerms(s.debtTerms);
  } else if (kind === "mezzanine") {
    terms.accretion = {
      issueDate: s.accretionIssueDate,
      quantity: s.accretionQuantity,
      issuePricePerShare: s.accretionIssuePricePerShare,
      redemptionDate: s.accretionRedemptionDate,
      redemptionValuePerShare: s.accretionRedemptionValuePerShare,
    };
  }
  if (s.hasLiquidationPreference) {
    terms.liquidationPreference = {
      ...(s.seriesName.trim() ? { seriesName: s.seriesName.trim() } : {}),
      seniorityRank: Number(s.seniorityRank),
      originalIssuePricePerShare: s.originalIssuePricePerShare,
      liquidationPreferenceMultiple: s.liquidationPreferenceMultiple,
      participating: s.participating,
      ...(s.participating && s.hasParticipationCap ? { participationCapMultiple: s.participationCapMultiple } : {}),
    };
  }
  if (s.hasConversionTerms) {
    terms.conversionTerms = { quantity: s.conversionQuantity, conversionRatio: s.conversionRatio };
  }
  return terms;
}
export function PreferredStockForm({ value, onChange }: { value: PreferredStockState; onChange: (v: PreferredStockState) => void }) {
  const kind = classifyPreferredLocally(value);
  return (
    <>
      <FieldGroup title="Classification (ASC 480-10-25-4 / 480-10-S99-3A)">
        <BoolField
          label="Mandatorily redeemable (a fixed date, or upon an event certain to occur)"
          value={value.mandatorilyRedeemable}
          onChange={(v) => onChange({ ...value, mandatorilyRedeemable: v })}
        />
        <BoolField
          label="Redeemable at the holder's option"
          value={value.redeemableAtHolderOption}
          onChange={(v) => onChange({ ...value, redeemableAtHolderOption: v })}
        />
        <BoolField
          label="Redeemable upon a contingent event outside the company's control (change of control, deemed liquidation)"
          value={value.redeemableUponContingentEventOutsideCompanyControl}
          onChange={(v) => onChange({ ...value, redeemableUponContingentEventOutsideCompanyControl: v })}
        />
        <p style={hintStyle}>
          Classification: <strong>{kind}</strong>
          {kind === "permanent_equity" && " — no periodic schedule at all."}
        </p>
      </FieldGroup>
      {kind === "liability" && (
        <FieldGroup title="Debt terms (liability-classified — accretes like a term loan, ASC 480-10-35-3)">
          <TermDebtForm value={value.debtTerms} onChange={(v) => onChange({ ...value, debtTerms: v })} />
        </FieldGroup>
      )}
      {kind === "mezzanine" && (
        <FieldGroup title="Accretion (mezzanine equity, straight-line to redemption value)" note="Leave this section's defaults if there's no determinable redemption date/value yet — that's a valid mezzanine state with no periodic schedule.">
          <DateField label="Issue date" value={value.accretionIssueDate} onChange={(v) => onChange({ ...value, accretionIssueDate: v })} />
          <DecimalField label="Quantity" value={value.accretionQuantity} onChange={(v) => onChange({ ...value, accretionQuantity: v })} />
          <DecimalField label="Issue price per share" value={value.accretionIssuePricePerShare} onChange={(v) => onChange({ ...value, accretionIssuePricePerShare: v })} />
          <DateField label="Redemption date" value={value.accretionRedemptionDate} onChange={(v) => onChange({ ...value, accretionRedemptionDate: v })} />
          <DecimalField label="Redemption value per share" value={value.accretionRedemptionValuePerShare} onChange={(v) => onChange({ ...value, accretionRedemptionValuePerShare: v })} />
        </FieldGroup>
      )}
      <FieldGroup
        title="Liquidation preference (optional — drives the Waterfall Analysis report)"
        note="Leave unchecked for a preferred class you don't need in an exit waterfall yet. If this holder is joining an EXISTING series, match its seniority/preference/participation exactly — the Waterfall Analysis report flags (and excludes) a series whose holders disagree with each other."
      >
        <BoolField
          label="Record liquidation preference / seniority terms"
          value={value.hasLiquidationPreference}
          onChange={(v) => onChange({ ...value, hasLiquidationPreference: v })}
        />
        {value.hasLiquidationPreference && (
          <>
            <TextField
              label="Series name"
              value={value.seriesName}
              onChange={(v) => onChange({ ...value, seriesName: v })}
              placeholder="e.g. Series A-1 Preferred"
            />
            <DecimalField
              label="Seniority rank"
              value={value.seniorityRank}
              onChange={(v) => onChange({ ...value, seniorityRank: v })}
              hint="Lower = paid first. Common is always last, so 1 is fine for a single preferred series."
            />
            <DecimalField
              label="Original issue price per share"
              value={value.originalIssuePricePerShare}
              onChange={(v) => onChange({ ...value, originalIssuePricePerShare: v })}
            />
            <DecimalField
              label="Liquidation preference multiple"
              value={value.liquidationPreferenceMultiple}
              onChange={(v) => onChange({ ...value, liquidationPreferenceMultiple: v })}
              hint="e.g. 1 for '1x', 1.5, 2."
            />
            <BoolField label="Participating" value={value.participating} onChange={(v) => onChange({ ...value, participating: v })} />
            {value.participating && (
              <>
                <BoolField
                  label="Participation is capped"
                  value={value.hasParticipationCap}
                  onChange={(v) => onChange({ ...value, hasParticipationCap: v })}
                />
                {value.hasParticipationCap && (
                  <DecimalField
                    label="Participation cap multiple"
                    value={value.participationCapMultiple}
                    onChange={(v) => onChange({ ...value, participationCapMultiple: v })}
                    hint="Total return per original share (preference + participation), e.g. 3 for 'capped at 3x'."
                  />
                )}
              </>
            )}
          </>
        )}
      </FieldGroup>
      <FieldGroup
        title="Conversion terms (optional — as-converted share count for the cap table)"
        note="Most VC-backed preferred converts 1:1 absent a down-round anti-dilution adjustment."
      >
        <BoolField
          label="Record conversion terms"
          value={value.hasConversionTerms}
          onChange={(v) => onChange({ ...value, hasConversionTerms: v })}
        />
        {value.hasConversionTerms && (
          <>
            <DecimalField
              label="Preferred share quantity"
              value={value.conversionQuantity}
              onChange={(v) => onChange({ ...value, conversionQuantity: v })}
            />
            <DecimalField
              label="Conversion ratio"
              value={value.conversionRatio}
              onChange={(v) => onChange({ ...value, conversionRatio: v })}
              hint="Common shares issued per one preferred share on conversion."
            />
          </>
        )}
      </FieldGroup>
    </>
  );
}

// ---- SAR -----------------------------------------------------------------------------

export interface SarState {
  settlementType: "STOCK" | "CASH";
  equityTerms: ServiceConditionGrantState;
  cashGrantDate: string;
  cashQuantity: string;
  strikePrice: string;
  cashTranches: TrancheRow[];
  observations: ObservationRow[];
}
export function defaultSarState(): SarState {
  return {
    settlementType: "STOCK",
    equityTerms: {
      grantDate: "2026-01-01",
      quantity: "4000",
      grantDateFairValuePerUnit: "2.50",
      attributionMethod: "straight-line",
      tranches: [
        { id: "t1", vestDate: "2027-01-01", quantity: "1000" },
        { id: "t2", vestDate: "2028-01-01", quantity: "1000" },
        { id: "t3", vestDate: "2029-01-01", quantity: "1000" },
        { id: "t4", vestDate: "2030-01-01", quantity: "1000" },
      ],
      servicePeriodEndDate: "",
    },
    cashGrantDate: "2026-01-01",
    cashQuantity: "1000",
    strikePrice: "10",
    cashTranches: [{ id: "t1", vestDate: "2028-01-01", quantity: "1000" }],
    observations: [],
  };
}
export function toSarTerms(s: SarState) {
  if (s.settlementType === "STOCK") {
    return { settlementType: "STOCK", equityTerms: toServiceConditionGrantTerms(s.equityTerms) };
  }
  return {
    settlementType: "CASH",
    cashTerms: {
      grantDate: s.cashGrantDate,
      quantity: s.cashQuantity,
      strikePrice: s.strikePrice,
      tranches: s.cashTranches.map((t) => ({ id: t.id, vestDate: t.vestDate, quantity: t.quantity })),
      observations: s.observations.map((o) => ({ date: o.date, fairValuePerUnit: o.value })),
    },
  };
}
export function SarForm({ value, onChange }: { value: SarState; onChange: (v: SarState) => void }) {
  return (
    <>
      <SelectField
        label="Settlement type"
        value={value.settlementType}
        options={["STOCK", "CASH"] as const}
        onChange={(v) => onChange({ ...value, settlementType: v })}
      />
      {value.settlementType === "STOCK" ? (
        <FieldGroup title="Stock-settled (ASC 718-10 — measured like a stock option)">
          <ServiceConditionGrantForm value={value.equityTerms} onChange={(v) => onChange({ ...value, equityTerms: v })} />
        </FieldGroup>
      ) : (
        <FieldGroup title="Cash-settled (ASC 718-30 — remeasured to fair value every period)">
          <DateField label="Grant date" value={value.cashGrantDate} onChange={(v) => onChange({ ...value, cashGrantDate: v })} />
          <DecimalField label="Quantity" value={value.cashQuantity} onChange={(v) => onChange({ ...value, cashQuantity: v })} />
          <DecimalField label="Strike price" value={value.strikePrice} onChange={(v) => onChange({ ...value, strikePrice: v })} />
          <TrancheArrayField label="Vesting tranches" value={value.cashTranches} onChange={(t) => onChange({ ...value, cashTranches: t })} />
          <ObservationArrayField
            label="Fair value observations"
            valueLabel="Fair value per unit"
            value={value.observations}
            onChange={(o) => onChange({ ...value, observations: o })}
            hint="One entry per period you want visible, in chronological order, each after grantDate — may start empty and be added via a modification as fair value gets remeasured."
          />
        </FieldGroup>
      )}
    </>
  );
}

// ---- RESTRICTED_STOCK ------------------------------------------------------------

export interface RestrictedStockState extends ServiceConditionGrantState {
  purchasePricePerShare: string;
}
export function defaultRestrictedStockState(): RestrictedStockState {
  return {
    grantDate: "2026-01-01",
    quantity: "8000",
    grantDateFairValuePerUnit: "2.00",
    purchasePricePerShare: "0.01",
    attributionMethod: "straight-line",
    tranches: [
      { id: "t1", vestDate: "2027-01-01", quantity: "2000" },
      { id: "t2", vestDate: "2028-01-01", quantity: "2000" },
      { id: "t3", vestDate: "2029-01-01", quantity: "2000" },
      { id: "t4", vestDate: "2030-01-01", quantity: "2000" },
    ],
    servicePeriodEndDate: "",
  };
}
export function toRestrictedStockTerms(s: RestrictedStockState) {
  return { ...toServiceConditionGrantTerms(s), purchasePricePerShare: s.purchasePricePerShare };
}
export function RestrictedStockForm({ value, onChange }: { value: RestrictedStockState; onChange: (v: RestrictedStockState) => void }) {
  return (
    <>
      <p style={hintStyle}>
        Covers both restricted stock (usually a nominal purchase price) and early-exercised stock options (purchase
        price = the option's strike price).
      </p>
      <ServiceConditionGrantForm
        value={value}
        onChange={(v) => onChange({ ...value, ...v })}
        fairValueLabel="Grant-date fair value per unit (net of purchase price)"
      />
      <DecimalField
        label="Purchase price per share"
        value={value.purchasePricePerShare}
        onChange={(v) => onChange({ ...value, purchasePricePerShare: v })}
        hint="What the holder actually paid — drives the liability-to-equity reclassification as each tranche vests."
      />
    </>
  );
}

/** Inline text-button styling for the "Suggested: <code>" affordance next to a
 * condition-code field above — deliberately not `smallButtonStyle` (a boxed outline
 * button), since this reads as part of a sentence rather than a standalone action. */
const suggestionButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
  color: theme.accent,
  textDecoration: "underline",
  cursor: "pointer",
};
