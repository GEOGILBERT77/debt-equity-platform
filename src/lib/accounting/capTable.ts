import { Decimal, DecimalValue } from "./types.js";
import {
  InstrumentTypeForDispatch,
  WarrantInstrumentTerms,
  SarInstrumentTerms,
  PreferredStockInstrumentTerms,
  RestrictedStockInstrumentTerms,
} from "./dispatch.js";
import { classifyPreferredStock } from "./preferredStock.js";
import { ServiceConditionGrant } from "./vesting.js";
import { ConventionalConvertibleNoteInputs } from "./convertibleNote.js";

/**
 * Cap table rollup — original requirement #1 ("cap tables for investors/debt holders
 * incl. stock options/warrants"). Everything else in this codebase computes an
 * instrument's own periodic accounting; this module answers a different question that
 * nothing else does yet: across every instrument an entity has issued, what does the
 * fully diluted ownership picture actually look like, and separately, who holds how
 * much of the entity's debt.
 *
 * DELIBERATE SCOPE CUT — "fully diluted," not "as of a specific vesting/exercise
 * state": an unvested option and a vested one both count as one fully-diluted share
 * each, per standard cap table convention (fully diluted = every share that COULD be
 * outstanding if every option/warrant/convertible were exercised/converted today,
 * regardless of vesting or in-the-money-ness). If you need a separate "vested/
 * exercisable only" view, that's a different rollup built on the same per-instrument
 * classification below, filtered by each grant's vesting schedule — not built here.
 *
 * COMMON_STOCK gets a minimal, standalone terms shape here (`CommonStockTerms`)
 * because there is no other engine module for it — unlike every other type this file
 * touches, common stock has no periodic accounting to speak of (no vesting, no
 * amortization), so it never needed one. That's a real, load-bearing simplification:
 * it assumes plain, unrestricted common stock. Restricted stock, or common stock
 * subject to a repurchase right, needs the actual vesting engine (vesting.ts) instead,
 * the same way a stock option does.
 */

export interface CommonStockTerms {
  quantity: DecimalValue;
}

export type CapTableClassification =
  | { kind: "equity"; shares: Decimal; note?: string }
  | { kind: "debt"; outstandingBalance: Decimal | null }
  | { kind: "unsupported"; reason: string };

/**
 * Classifies one instrument for cap table purposes: how many fully-diluted shares it
 * represents (equity), how much it's currently owed (debt), or that this codebase
 * can't answer that yet for this type/terms combination (unsupported) — the last case
 * is surfaced to the caller rather than silently treated as zero, since a cap table
 * that silently drops an instrument is worse than one that visibly flags a gap.
 */
export function classifyInstrumentForCapTable(
  type: InstrumentTypeForDispatch,
  terms: unknown,
  outstandingBalance?: DecimalValue
): CapTableClassification {
  switch (type) {
    case "STOCK_OPTION":
    case "RSU": {
      const grant = terms as ServiceConditionGrant;
      if (grant.quantity === undefined || grant.quantity === null) {
        return { kind: "unsupported", reason: `${type} terms have no quantity field.` };
      }
      return { kind: "equity", shares: new Decimal(grant.quantity) };
    }
    case "RESTRICTED_STOCK": {
      // Counted fully-diluted at the grant's full quantity, same rule as STOCK_OPTION/
      // RSU above and for the same reason this file's own doc comment gives: fully
      // diluted counts every share that could be outstanding regardless of vesting, and
      // the shares underlying a RESTRICTED_STOCK grant are (from day one) actually
      // issued and outstanding — the repurchase right affects BALANCE SHEET
      // presentation of the purchase price (liability vs. equity — see
      // restrictedStock.ts), not whether the shares themselves count toward dilution.
      const r = terms as RestrictedStockInstrumentTerms;
      if (r.quantity === undefined || r.quantity === null) {
        return { kind: "unsupported", reason: "RESTRICTED_STOCK terms have no quantity field." };
      }
      return { kind: "equity", shares: new Decimal(r.quantity) };
    }
    case "COMMON_STOCK": {
      const t = terms as CommonStockTerms;
      if (t.quantity === undefined || t.quantity === null) {
        return { kind: "unsupported", reason: "COMMON_STOCK terms have no quantity field." };
      }
      return { kind: "equity", shares: new Decimal(t.quantity) };
    }
    case "WARRANT": {
      const w = terms as WarrantInstrumentTerms;
      if (w.sharesIssuable === undefined || w.sharesIssuable === null) {
        return {
          kind: "unsupported",
          reason: "Warrant terms have no sharesIssuable — can't compute its fully-diluted share contribution.",
        };
      }
      // Counted at face value regardless of equity/liability classification: a
      // liability-classified warrant is still a real potential claim on shares, and
      // dilution doesn't care which balance sheet line the fair value change runs
      // through. Classification (classifyWarrant) governs the P&L/balance-sheet
      // treatment in dispatch.ts; it has no bearing on the share count here.
      return { kind: "equity", shares: new Decimal(w.sharesIssuable) };
    }
    case "CONVERTIBLE_NOTE": {
      const n = terms as ConventionalConvertibleNoteInputs;
      if (!n.conversionPricePerShare || new Decimal(n.conversionPricePerShare).lessThanOrEqualTo(0)) {
        return { kind: "unsupported", reason: "Convertible note terms have no positive conversionPricePerShare." };
      }
      // As-converted on FACE VALUE only — a real simplification. Most conversion
      // mechanics also convert accrued-but-unpaid interest into additional shares at
      // the same conversion price; that would need this period's carrying value or
      // accrued-interest balance as an input, not just the static terms payload this
      // function receives. Flagged here rather than silently underrepresenting
      // dilution — treat this as a floor on the note's as-converted share count, not
      // the final answer, until accrued interest is wired in too.
      const shares = new Decimal(n.faceValue).div(n.conversionPricePerShare);
      return { kind: "equity", shares, note: "As-converted on face value only — excludes any accrued PIK/deferred interest." };
    }
    case "TERM_LOAN":
    case "REVOLVER":
    case "PIK_NOTE":
      return {
        kind: "debt",
        outstandingBalance: outstandingBalance !== undefined && outstandingBalance !== null ? new Decimal(outstandingBalance) : null,
      };
    case "SAR": {
      const s = terms as SarInstrumentTerms;
      if (s.settlementType === "STOCK") {
        const q = s.equityTerms?.quantity;
        if (q === undefined || q === null) {
          return { kind: "unsupported", reason: "Stock-settled SAR terms have no equityTerms.quantity field." };
        }
        // Dilutive on the same basis as a stock option: it settles in shares, so each
        // unit is one potential fully-diluted share regardless of vesting status.
        return { kind: "equity", shares: new Decimal(q) };
      }
      // CASH-settled: liability-classified, settled entirely in cash — it never
      // dilutes the fully-diluted share count (no shares are ever issued), but its
      // outstanding liability also isn't a "debt holder" balance in the sense
      // TERM_LOAN/REVOLVER/PIK_NOTE are (the employee holding it isn't a lender, and
      // showing it in the "Debt holders" table would misrepresent what it is).
      // Flagged as unsupported rather than silently placed in either existing bucket,
      // until this rollup grows a third category for liability-classified
      // compensation awards — see the README's cap table gaps note.
      return {
        kind: "unsupported",
        reason:
          "Cash-settled SAR is a liability settled entirely in cash — it never dilutes the fully-diluted share count, and this rollup doesn't yet have a category for a non-lender liability like this one (see its outstanding balance on the instrument's own page instead).",
      };
    }
    case "PREFERRED_STOCK": {
      const ps = terms as PreferredStockInstrumentTerms;
      if (ps.classification && classifyPreferredStock(ps.classification) === "liability") {
        // Mandatorily redeemable preferred is liability-classified and its schedule
        // comes straight from the effective-interest debt engine (see
        // preferredStock.ts) — the exact same "debt" treatment TERM_LOAN/REVOLVER/
        // PIK_NOTE already get here, for the same reason: it behaves like debt,
        // accounting-wise, so it belongs in the "Debt holders" table, not counted
        // toward the fully-diluted share denominator.
        return {
          kind: "debt",
          outstandingBalance: outstandingBalance !== undefined && outstandingBalance !== null ? new Decimal(outstandingBalance) : null,
        };
      }
      // Mezzanine and permanent-equity preferred: genuinely equity-like. As of
      // v0.20.0, an as-converted share count IS computable when the terms carry the
      // new (optional) `conversionTerms` field — quantity x conversionRatio, the same
      // as-converted mechanics CONVERTIBLE_NOTE already uses above. Preferred with no
      // `conversionTerms` at all (non-convertible preferred is real and common —
      // plenty of preferred stock has no conversion feature) still falls through to
      // the same "unsupported, no conversion ratio modeled" flag as before this field
      // existed — not every gap here is a bug, some preferred genuinely isn't
      // convertible, and this rollup has no way to distinguish "not convertible" from
      // "convertible but terms not entered yet" other than the caller supplying one.
      if (ps.conversionTerms) {
        const { quantity, conversionRatio } = ps.conversionTerms;
        if (quantity === undefined || quantity === null || conversionRatio === undefined || conversionRatio === null) {
          return { kind: "unsupported", reason: "PREFERRED_STOCK conversionTerms is present but missing quantity or conversionRatio." };
        }
        const shares = new Decimal(quantity).times(conversionRatio);
        return { kind: "equity", shares, note: "As-converted (quantity x conversionRatio) — see PreferredConversionTerms in dispatch.ts." };
      }
      return {
        kind: "unsupported",
        reason:
          "Cap table rollup doesn't compute an as-converted share count for mezzanine/permanent-equity preferred stock yet (no conversionTerms on this instrument) — see the README's \"Not started\" list.",
      };
    }
    default:
      return {
        kind: "unsupported",
        reason: `Cap table rollup doesn't support ${type} yet — see the README's "Not started" list.`,
      };
  }
}

export interface CapTableInstrumentInput {
  instrumentId: string;
  stakeholderId: string;
  stakeholderName: string;
  type: InstrumentTypeForDispatch;
  /** The instrument's current (latest) terms — for equity types this is what
   * determines its share count; for debt types it's ignored (only
   * `outstandingBalance` matters) but still required for a uniform input shape. */
  terms: unknown;
  /** Current outstanding balance, for debt types only — typically the ending balance
   * of the most recent schedule row (live-computed or closed, caller's choice; see
   * the README's "Live preview vs. closed/reported numbers" distinction for why that
   * choice belongs to the caller, not this engine). Ignored for equity types. */
  outstandingBalance?: DecimalValue;
}

export interface CapTableRow {
  instrumentId: string;
  stakeholderId: string;
  stakeholderName: string;
  type: InstrumentTypeForDispatch;
  shares?: Decimal;
  ownershipPercent?: Decimal;
  outstandingBalance?: Decimal;
  note?: string;
}

export interface UnsupportedCapTableRow {
  instrumentId: string;
  stakeholderId: string;
  stakeholderName: string;
  type: InstrumentTypeForDispatch;
  reason: string;
}

export interface CapTableRollup {
  totalFullyDilutedShares: Decimal;
  equityRows: CapTableRow[];
  debtRows: CapTableRow[];
  /** Instruments this rollup could not classify — surfaced, never silently dropped.
   * A cap table missing a real instrument (and not saying so) is worse than one that
   * visibly admits a gap. */
  unsupported: UnsupportedCapTableRow[];
}

export function buildCapTableRollup(instruments: CapTableInstrumentInput[]): CapTableRollup {
  const equityRows: CapTableRow[] = [];
  const debtRows: CapTableRow[] = [];
  const unsupported: UnsupportedCapTableRow[] = [];

  for (const inst of instruments) {
    const classification = classifyInstrumentForCapTable(inst.type, inst.terms, inst.outstandingBalance);
    if (classification.kind === "equity") {
      equityRows.push({
        instrumentId: inst.instrumentId,
        stakeholderId: inst.stakeholderId,
        stakeholderName: inst.stakeholderName,
        type: inst.type,
        shares: classification.shares,
        note: classification.note,
      });
    } else if (classification.kind === "debt") {
      debtRows.push({
        instrumentId: inst.instrumentId,
        stakeholderId: inst.stakeholderId,
        stakeholderName: inst.stakeholderName,
        type: inst.type,
        outstandingBalance: classification.outstandingBalance ?? undefined,
      });
    } else {
      unsupported.push({
        instrumentId: inst.instrumentId,
        stakeholderId: inst.stakeholderId,
        stakeholderName: inst.stakeholderName,
        type: inst.type,
        reason: classification.reason,
      });
    }
  }

  const totalFullyDilutedShares = equityRows.reduce((sum, r) => sum.plus(r.shares ?? 0), new Decimal(0));

  // Ownership % left undefined (not zero) when there are no fully-diluted shares at
  // all yet — "0% of a cap table that doesn't exist" is a misleading number to show,
  // as opposed to genuinely owning 0% of a real, nonzero total.
  if (totalFullyDilutedShares.greaterThan(0)) {
    for (const row of equityRows) {
      row.ownershipPercent = row.shares!.div(totalFullyDilutedShares).times(100);
    }
  }

  return { totalFullyDilutedShares, equityRows, debtRows, unsupported };
}

/** Rolls per-instrument equity rows up to one row per stakeholder — the view an
 * investor actually wants ("what's my total ownership"), as opposed to the per-
 * instrument view above (useful for auditing which specific grant contributes what). */
export interface StakeholderOwnership {
  stakeholderId: string;
  stakeholderName: string;
  shares: Decimal;
  ownershipPercent?: Decimal;
}

export function aggregateByStakeholder(rollup: CapTableRollup): StakeholderOwnership[] {
  const byStakeholder = new Map<string, StakeholderOwnership>();
  for (const row of rollup.equityRows) {
    const existing = byStakeholder.get(row.stakeholderId);
    if (existing) {
      existing.shares = existing.shares.plus(row.shares ?? 0);
    } else {
      byStakeholder.set(row.stakeholderId, {
        stakeholderId: row.stakeholderId,
        stakeholderName: row.stakeholderName,
        shares: row.shares ?? new Decimal(0),
      });
    }
  }
  const result = [...byStakeholder.values()];
  if (rollup.totalFullyDilutedShares.greaterThan(0)) {
    for (const s of result) {
      s.ownershipPercent = s.shares.div(rollup.totalFullyDilutedShares).times(100);
    }
  }
  return result.sort((a, b) => (a.shares.greaterThan(b.shares) ? -1 : 1));
}
