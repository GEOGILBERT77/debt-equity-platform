"use client";

import { BoolField, DateField, DecimalField, FieldGroup, SelectField, TextField, hintStyle } from "./FieldPrimitives";
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
  };
}

export function toServiceConditionGrantTerms(s: ServiceConditionGrantState) {
  return {
    grantDate: s.grantDate,
    quantity: s.quantity,
    grantDateFairValuePerUnit: s.grantDateFairValuePerUnit,
    attributionMethod: s.attributionMethod,
    tranches: s.tranches.map((t) => ({ id: t.id, vestDate: t.vestDate, quantity: t.quantity })),
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
    </>
  );
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
        <p style={{ color: "crimson", fontSize: "0.8rem" }}>A revolver needs at least a commitment fee or a deferred fee.</p>
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
          <p style={{ color: "crimson", fontSize: "0.8rem" }}>
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
