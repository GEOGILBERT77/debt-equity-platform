import { Decimal, DecimalValue } from "./types.js";
import { PreferredStockInstrumentTerms, InstrumentTypeForDispatch } from "./dispatch.js";
import { classifyInstrumentForCapTable, CapTableInstrumentInput } from "./capTable.js";
import { WaterfallClassInput } from "./exitWaterfall.js";

/**
 * The adapter `exitWaterfall.ts`'s own module doc comment says doesn't exist yet:
 * turns the REAL, stored cap table (the same `CapTableInstrumentInput[]` list
 * captable/page.tsx already builds for the ownership rollup) into the
 * `WaterfallClassInput[]` `buildExitWaterfall` needs — so "run a waterfall" means
 * reading this entity's actual seniority/preference/participation terms, not
 * re-typing them into a standalone calculator by hand.
 *
 * TWO KINDS OF CLASS, BUILT DIFFERENTLY:
 *  - Each PREFERRED_STOCK series (grouped by `liquidationPreference.seriesName`, or
 *    treated as its own one-off class when that's omitted) becomes its own waterfall
 *    class, using its ACTUAL seniority rank, preference multiple, and participation
 *    terms — see `LiquidationPreferenceTerms`'s doc comment in dispatch.ts for the
 *    shape and the per-as-converted-share derivation this function performs.
 *  - EVERY OTHER equity-classified instrument (COMMON_STOCK, STOCK_OPTION, RSU,
 *    RESTRICTED_STOCK, WARRANT, CONVERTIBLE_NOTE, a stock-settled SAR, preferred
 *    stock with no liquidation terms recorded) is pooled into ONE synthetic "Common
 *    (fully-diluted)" class — reusing `classifyInstrumentForCapTable`'s existing
 *    as-converted share counting rather than re-deriving it, so this stays in sync
 *    with the ordinary cap table's own dilution math with zero duplicated logic.
 *
 * DEBT IS DELIBERATELY EXCLUDED, NOT FLAGGED AS A GAP: TERM_LOAN/REVOLVER/PIK_NOTE
 * outstanding balances don't get a waterfall "seniority rank" the way preferred-vs-
 * common does — a real liquidation pays creditors in full (or by their own separate
 * priority scheme) before any equity waterfall begins at all. The `exitProceeds`
 * figure this module's caller feeds into `buildExitWaterfall` is assumed to already
 * be the equity value available for distribution AFTER outstanding debt is repaid —
 * the standard convention for a cap-table waterfall tool. A CONVERTIBLE_NOTE is the
 * one debt-shaped instrument still included here, because `classifyInstrumentForCapTable`
 * already treats it as an as-converted EQUITY claim (its holder is assumed to convert
 * rather than be repaid at exit) — see that function's own note on the simplification
 * this carries (as-converted on face value only, excluding accrued interest).
 *
 * WHAT GETS EXCLUDED AND WHY: a PREFERRED_STOCK instrument with no `liquidationPreference`
 * recorded, one whose `liquidationPreference.seriesName` group has internally
 * inconsistent seniority/preference/participation terms across its members (a real
 * data-entry mistake, not something to silently average away), or one missing the
 * `conversionTerms.quantity` needed to compute a total preference dollar amount — all
 * surfaced in the result's `excluded` list, never silently dropped or guessed at,
 * same "flag rather than hide a gap" posture `capTable.ts` itself takes.
 */

export interface ExcludedFromWaterfall {
  instrumentId: string;
  stakeholderName: string;
  type: InstrumentTypeForDispatch;
  reason: string;
}

export interface WaterfallClassesResult {
  classes: WaterfallClassInput[];
  excluded: ExcludedFromWaterfall[];
}

const COMMON_POOL_ID = "__common_pool__";

export function buildWaterfallClassesFromCapTable(instruments: CapTableInstrumentInput[]): WaterfallClassesResult {
  const excluded: ExcludedFromWaterfall[] = [];

  // Group PREFERRED_STOCK instruments by seriesName (falling back to the instrument's
  // own id, so a series with no seriesName is simply a one-member "group").
  type PreferredMember = {
    instrumentId: string;
    stakeholderName: string;
    lp: NonNullable<PreferredStockInstrumentTerms["liquidationPreference"]>;
    originalQuantity: DecimalValue;
    asConvertedShares: Decimal;
  };
  const preferredGroups = new Map<string, PreferredMember[]>();

  let commonShares = new Decimal(0);

  for (const inst of instruments) {
    if (inst.type === "PREFERRED_STOCK") {
      const terms = inst.terms as PreferredStockInstrumentTerms;
      const lp = terms.liquidationPreference;
      if (!lp) {
        excluded.push({
          instrumentId: inst.instrumentId,
          stakeholderName: inst.stakeholderName,
          type: inst.type,
          reason: "No liquidationPreference terms recorded — this preferred stock has no seniority/preference data to place it in the waterfall. Add liquidationPreference to its terms to include it.",
        });
        continue;
      }
      const classification = classifyInstrumentForCapTable(inst.type, inst.terms);
      if (classification.kind !== "equity") {
        excluded.push({
          instrumentId: inst.instrumentId,
          stakeholderName: inst.stakeholderName,
          type: inst.type,
          reason:
            classification.kind === "unsupported"
              ? classification.reason
              : "Could not determine an as-converted share count for this preferred stock.",
        });
        continue;
      }
      const originalQuantity = terms.conversionTerms?.quantity;
      if (originalQuantity === undefined || originalQuantity === null) {
        excluded.push({
          instrumentId: inst.instrumentId,
          stakeholderName: inst.stakeholderName,
          type: inst.type,
          reason:
            "liquidationPreference is set but conversionTerms.quantity is missing — the original preferred share count is needed to compute the total preference amount, not just the as-converted share count.",
        });
        continue;
      }
      const key = lp.seriesName ?? `__instrument_${inst.instrumentId}__`;
      const group = preferredGroups.get(key) ?? [];
      group.push({
        instrumentId: inst.instrumentId,
        stakeholderName: inst.stakeholderName,
        lp,
        originalQuantity,
        asConvertedShares: classification.shares,
      });
      preferredGroups.set(key, group);
      continue;
    }

    const classification = classifyInstrumentForCapTable(inst.type, inst.terms, inst.outstandingBalance);
    if (classification.kind === "equity") {
      commonShares = commonShares.plus(classification.shares);
    } else if (classification.kind === "unsupported") {
      excluded.push({
        instrumentId: inst.instrumentId,
        stakeholderName: inst.stakeholderName,
        type: inst.type,
        reason: classification.reason,
      });
    }
    // classification.kind === "debt" — excluded on purpose, see module doc comment.
  }

  const classes: WaterfallClassInput[] = [];

  for (const [key, members] of preferredGroups) {
    const first = members[0].lp;
    const inconsistent = members.some(
      (m) =>
        m.lp.seniorityRank !== first.seniorityRank ||
        !new Decimal(m.lp.originalIssuePricePerShare).equals(first.originalIssuePricePerShare) ||
        !new Decimal(m.lp.liquidationPreferenceMultiple).equals(first.liquidationPreferenceMultiple) ||
        m.lp.participating !== first.participating ||
        (m.lp.participationCapMultiple === undefined) !== (first.participationCapMultiple === undefined) ||
        (m.lp.participationCapMultiple !== undefined &&
          first.participationCapMultiple !== undefined &&
          !new Decimal(m.lp.participationCapMultiple).equals(first.participationCapMultiple))
    );
    if (inconsistent) {
      for (const m of members) {
        excluded.push({
          instrumentId: m.instrumentId,
          stakeholderName: m.stakeholderName,
          type: "PREFERRED_STOCK",
          reason: `Series "${key}" has inconsistent liquidationPreference terms across its ${members.length} holders (seniority rank, preference multiple, participation, or cap don't all match) — fix the mismatch rather than averaging it away.`,
        });
      }
      continue;
    }

    const totalOriginalQuantity = members.reduce((sum, m) => sum.plus(m.originalQuantity), new Decimal(0));
    const totalAsConvertedShares = members.reduce((sum, m) => sum.plus(m.asConvertedShares), new Decimal(0));
    const totalPreference = totalOriginalQuantity.times(first.originalIssuePricePerShare).times(first.liquidationPreferenceMultiple);
    const liquidationPreferencePerShare = totalAsConvertedShares.isZero()
      ? new Decimal(0)
      : totalPreference.div(totalAsConvertedShares);

    let participationCap: Decimal | undefined;
    if (first.participating && first.participationCapMultiple !== undefined && first.participationCapMultiple !== null) {
      const totalCap = totalOriginalQuantity.times(first.originalIssuePricePerShare).times(first.participationCapMultiple);
      participationCap = totalAsConvertedShares.isZero() ? new Decimal(0) : totalCap.div(totalAsConvertedShares);
    }

    classes.push({
      id: key,
      name: first.seriesName ?? `${members[0].stakeholderName} (Preferred, ${members[0].instrumentId})`,
      seniorityRank: first.seniorityRank,
      shares: totalAsConvertedShares,
      liquidationPreferencePerShare,
      participating: first.participating,
      participationCap,
    });
  }

  if (commonShares.greaterThan(0)) {
    classes.push({
      id: COMMON_POOL_ID,
      name: "Common (fully-diluted — common stock, options, RSUs, warrants, as-converted notes)",
      // Ranked after every preferred class (common is always paid last, per
      // exitWaterfall.ts's own convention) — Number.MAX_SAFE_INTEGER rather than a
      // guessed "99" so this can never accidentally collide with a real rank.
      seniorityRank: Number.MAX_SAFE_INTEGER,
      shares: commonShares,
      liquidationPreferencePerShare: 0,
      participating: false,
    });
  }

  return { classes, excluded };
}
