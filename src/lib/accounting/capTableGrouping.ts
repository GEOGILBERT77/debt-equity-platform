import { Decimal } from "./types.js";
import { InstrumentTypeForDispatch, PreferredStockInstrumentTerms } from "./dispatch.js";
import { CapTableRollup, StakeholderOwnership } from "./capTable.js";

/**
 * Shared grouping logic behind the "Interactive cap table" ownership view
 * (CapTableOwnershipTable.tsx) — pulled out of captable/page.tsx (v0.43.0) so the same
 * "By Instrument/Class" / "By Investor" groupings can be reused anywhere else a cap
 * table rollup needs the same ledger + expand/collapse presentation, without
 * duplicating this math per page. Currently used by captable/page.tsx (the admin cap
 * table) and portal/[stakeholderId]/page.tsx (the board-observer "full cap table"
 * view) — see each call site for what it passes in.
 */

export interface CapTableGroupMember {
  key: string;
  label: string;
  href?: string;
  shares: string;
  /** This member's share of its immediate parent group — the investor's % of THIS
   * class ("By Instrument/Class" mode), or the class's % of THIS investor's own
   * holdings ("By Investor" mode). Never shown at the collapsed/group-row level —
   * only meaningful once you've drilled into one specific group. */
  percentOfGroup: string;
  /** This member's share of the ENTIRE company's fully-diluted total — independent of
   * which group it's nested under, so an investor showing up under three different
   * classes has the same percentOfCompany value each time. Added alongside
   * percentOfGroup (v0.43.0) specifically so the two are never confused: "62% of this
   * class" and "8% of the whole company" are both true at once and easy to mistake
   * for each other without both columns visible side by side. */
  percentOfCompany: string;
}

export interface CapTableGroupRow {
  key: string;
  label: string;
  href?: string;
  /** "By Instrument/Class" mode: number of distinct investors in this class.
   *  "By Investor" mode: number of distinct classes/instrument types this investor holds. */
  memberCount: number;
  shares: string;
  ownershipPercent: string;
  members: CapTableGroupMember[];
}

/**
 * "Class" for the ownership table's "By Instrument/Class" grouping — not the same
 * grouping capTableWaterfall.ts uses for the Waterfall Analysis report (that one pools
 * everything non-preferred into a single "Common (fully-diluted)" bucket, which is
 * right for liquidation-preference math but too coarse for "what classes does this cap
 * table actually have"). Here, COMMON_STOCK classes by its term-version label (same
 * "class" concept EquityFundingWizard.tsx already uses for "issue more of an existing
 * class" — see that file's doc comment), PREFERRED_STOCK classes by
 * liquidationPreference.seriesName (falling back to its label if that's not set yet),
 * and every other equity-shaped type gets its own class named after the instrument
 * type, since lumping stock options in with warrants in with restricted stock would
 * hide exactly the breakdown a cap table's "by class" view exists to show.
 */
export function classKeyForInstrument(
  type: InstrumentTypeForDispatch,
  label: string,
  terms: unknown
): { key: string; displayLabel: string } {
  switch (type) {
    case "COMMON_STOCK": {
      const name = label.trim() || "Common stock";
      return { key: `COMMON:${name}`, displayLabel: name };
    }
    case "PREFERRED_STOCK": {
      const t = terms as PreferredStockInstrumentTerms;
      const name = t.liquidationPreference?.seriesName?.trim() || label.trim() || "Preferred stock";
      return { key: `PREFERRED:${name}`, displayLabel: name };
    }
    case "STOCK_OPTION":
      return { key: "STOCK_OPTION", displayLabel: "Stock options" };
    case "RSU":
      return { key: "RSU", displayLabel: "RSUs" };
    case "RESTRICTED_STOCK":
      return { key: "RESTRICTED_STOCK", displayLabel: "Restricted stock" };
    case "WARRANT":
      return { key: "WARRANT", displayLabel: "Standalone warrants" };
    case "SAR":
      return { key: "SAR", displayLabel: "Stock appreciation rights" };
    case "CONVERTIBLE_NOTE":
      return { key: "CONVERTIBLE_NOTE", displayLabel: "Convertible notes (as-converted)" };
    default:
      return { key: type, displayLabel: type };
  }
}

/**
 * Builds both groupings the toggle on CapTableOwnershipTable.tsx switches between, from
 * one already-computed CapTableRollup. `classKeyByInstrumentId` is the caller's own
 * `classKeyForInstrument(...)` result per instrument (computed by the caller, not here,
 * since it needs each instrument's term-version label and raw terms — data this
 * function's `rollup`/`ownershipByStakeholder` inputs no longer carry).
 *
 * `stakeholderHref` is optional and deliberately caller-supplied rather than hardcoded
 * to `/stakeholders/${id}`: the admin cap table links investor names to the admin
 * stakeholder detail page, but the portal's board-observer view has no business
 * sending a board-observer investor into an ADMIN-only route, so that caller omits it
 * and gets plain (non-linked) investor names instead.
 */
export function buildCapTableGroupings(params: {
  rollup: CapTableRollup;
  ownershipByStakeholder: StakeholderOwnership[];
  classKeyByInstrumentId: Map<string, { key: string; displayLabel: string }>;
  stakeholderHref?: (stakeholderId: string) => string;
}): { byClass: CapTableGroupRow[]; byInvestor: CapTableGroupRow[] } {
  const { rollup, ownershipByStakeholder, classKeyByInstrumentId, stakeholderHref } = params;

  // "By Instrument/Class" — one row per class, each investor's shares within that
  // class combined into one member row even if they hold more than one instrument of
  // it (e.g. two separate option grants). Sorted largest-class-first, same convention
  // the sample "Ledger summary" format uses.
  const classGroups = new Map<string, { label: string; shares: Decimal; members: Map<string, { name: string; shares: Decimal }> }>();
  for (const row of rollup.equityRows) {
    const ck = classKeyByInstrumentId.get(row.instrumentId) ?? { key: row.type, displayLabel: row.type };
    let group = classGroups.get(ck.key);
    if (!group) {
      group = { label: ck.displayLabel, shares: new Decimal(0), members: new Map() };
      classGroups.set(ck.key, group);
    }
    group.shares = group.shares.plus(row.shares ?? 0);
    const existingMember = group.members.get(row.stakeholderId);
    if (existingMember) {
      existingMember.shares = existingMember.shares.plus(row.shares ?? 0);
    } else {
      group.members.set(row.stakeholderId, { name: row.stakeholderName, shares: row.shares ?? new Decimal(0) });
    }
  }
  const byClass: CapTableGroupRow[] = [...classGroups.entries()]
    .sort(([, a], [, b]) => (b.shares.greaterThan(a.shares) ? 1 : -1))
    .map(([key, group]) => ({
      key,
      label: group.label,
      memberCount: group.members.size,
      shares: group.shares.toString(),
      ownershipPercent: rollup.totalFullyDilutedShares.greaterThan(0)
        ? group.shares.div(rollup.totalFullyDilutedShares).times(100).toFixed(2)
        : "0.00",
      members: [...group.members.entries()]
        .sort(([, a], [, b]) => (b.shares.greaterThan(a.shares) ? 1 : -1))
        .map(([stakeholderId, m]) => ({
          key: stakeholderId,
          label: m.name,
          href: stakeholderHref?.(stakeholderId),
          shares: m.shares.toString(),
          percentOfGroup: group.shares.greaterThan(0) ? m.shares.div(group.shares).times(100).toFixed(2) : "0.00",
          percentOfCompany: rollup.totalFullyDilutedShares.greaterThan(0)
            ? m.shares.div(rollup.totalFullyDilutedShares).times(100).toFixed(2)
            : "0.00",
        })),
    }));

  // "By Investor" — one row per investor (same rollup aggregateByStakeholder already
  // computes for the total), each expanding to that investor's own classes combined
  // the same way (two option grants in the same class become one member row).
  const byInvestor: CapTableGroupRow[] = ownershipByStakeholder.map((s) => {
    const classesForStakeholder = new Map<string, { label: string; shares: Decimal }>();
    for (const row of rollup.equityRows) {
      if (row.stakeholderId !== s.stakeholderId) continue;
      const ck = classKeyByInstrumentId.get(row.instrumentId) ?? { key: row.type, displayLabel: row.type };
      const existing = classesForStakeholder.get(ck.key);
      if (existing) {
        existing.shares = existing.shares.plus(row.shares ?? 0);
      } else {
        classesForStakeholder.set(ck.key, { label: ck.displayLabel, shares: row.shares ?? new Decimal(0) });
      }
    }
    return {
      key: s.stakeholderId,
      label: s.stakeholderName,
      href: stakeholderHref?.(s.stakeholderId),
      memberCount: classesForStakeholder.size,
      shares: s.shares.toString(),
      ownershipPercent: s.ownershipPercent ? s.ownershipPercent.toFixed(2) : "0.00",
      members: [...classesForStakeholder.entries()]
        .sort(([, a], [, b]) => (b.shares.greaterThan(a.shares) ? 1 : -1))
        .map(([key, c]) => ({
          key,
          label: c.label,
          shares: c.shares.toString(),
          percentOfGroup: s.shares.greaterThan(0) ? c.shares.div(s.shares).times(100).toFixed(2) : "0.00",
          percentOfCompany: rollup.totalFullyDilutedShares.greaterThan(0)
            ? c.shares.div(rollup.totalFullyDilutedShares).times(100).toFixed(2)
            : "0.00",
        })),
    };
  });

  return { byClass, byInvestor };
}
