import { db } from "@/lib/db";
import { Decimal } from "@/lib/accounting/types";

/**
 * "The strike price needs to be maintained for disclosure reasons — it should be
 * maintained as part of a grants report which has all the salient terms of each
 * grant by grant ID." Direct follow-up to strikePrice being added to
 * ServiceConditionGrant (see its doc comment in vesting.ts) — a field the expense
 * engine never reads is useless if nowhere ever shows it back. This is that report:
 * one row per equity award (STOCK_OPTION, RSU, RESTRICTED_STOCK — the three types
 * built on ServiceConditionGrant/RestrictedStockInstrumentTerms), reading the LATEST
 * term version's terms directly (this is a "what are this grant's terms right now"
 * report, not a history — see /reports/modification-audit for the history of how a
 * grant's terms changed over time, and /reports/audit-trail for the full chronological
 * feed).
 *
 * DELIBERATELY reads terms as JSON rather than going through the engine's typed
 * interfaces (ServiceConditionGrant, etc.) — this report only ever DISPLAYS fields,
 * never computes a schedule from them, so there's no need to cast through the engine
 * types the way dispatch.ts does. Every field is read defensively (optional chaining,
 * String()/Number() coercion) since a grant written before strikePrice/
 * servicePeriodEndDate existed simply won't have them — that's a normal, valid state
 * for an older grant, not a data problem, and shows up here as a blank cell rather
 * than an error.
 */

export interface GrantReportTranche {
  vestDate: string;
  quantity: string;
}

export interface GrantReportEntry {
  instrumentId: string;
  instrumentType: "STOCK_OPTION" | "RSU" | "RESTRICTED_STOCK";
  stakeholderId: string;
  stakeholderName: string;
  grantDate: string;
  quantity: string;
  /** Only ever populated for STOCK_OPTION — see ServiceConditionGrant.strikePrice's
   * doc comment in vesting.ts for why RSU/RESTRICTED_STOCK don't have one. Null (not
   * "0" or "—") both when the type doesn't have a strike AND when an older
   * STOCK_OPTION grant predates this field — the report page renders both the same
   * way, but the underlying reason differs and callers reading this data directly
   * should know that. */
  strikePrice: string | null;
  grantDateFairValuePerUnit: string;
  /** quantity * grantDateFairValuePerUnit — the total ASC 718 compensation cost of
   * the award, computed here (not stored) since it's a pure function of two fields
   * already on the row. */
  totalGrantDateFairValue: string;
  /** Only ever populated for RESTRICTED_STOCK. */
  purchasePricePerShare: string | null;
  attributionMethod: "straight-line" | "graded";
  tranches: GrantReportTranche[];
  /** The last tranche's own vest date — always populated, even when
   * servicePeriodEndDate is also set, so the report can show both and make the
   * difference between them visible rather than only showing whichever is "the" end
   * date. */
  lastVestDate: string;
  /** Set only when the grant's terms carry an explicit servicePeriodEndDate that
   * differs from lastVestDate — see ServiceConditionGrant.servicePeriodEndDate's doc
   * comment in vesting.ts. Null in the ordinary case (ASC 718 service period = the
   * vesting schedule), which is most grants. */
  servicePeriodEndDate: string | null;
  approvalStatus: "approved" | "stale" | "not-approved";
  approvedAt: string | null;
}

const GRANT_TYPES = ["STOCK_OPTION", "RSU", "RESTRICTED_STOCK"] as const;

function readTranches(terms: Record<string, unknown>): GrantReportTranche[] {
  if (!Array.isArray(terms.tranches)) return [];
  return (terms.tranches as Record<string, unknown>[]).map((t) => ({
    vestDate: String(t.vestDate ?? ""),
    quantity: String(t.quantity ?? ""),
  }));
}

/**
 * Builds the grants report for one entity: one row per STOCK_OPTION/RSU/
 * RESTRICTED_STOCK instrument, using each instrument's CURRENT (latest) term
 * version — see this file's module doc comment for why history isn't in scope here.
 */
export async function getGrantsReport(entityId: string): Promise<GrantReportEntry[]> {
  const instruments = await db.instrument.findMany({
    where: { entityId, type: { in: [...GRANT_TYPES] } },
    include: {
      stakeholder: true,
      termVersions: { orderBy: { effectiveDate: "asc" } },
      amortizationApprovals: { orderBy: { approvedAt: "desc" }, take: 1 },
    },
    orderBy: { issueDate: "asc" },
  });

  return instruments.map((inst) => {
    const latest = inst.termVersions[inst.termVersions.length - 1];
    const terms = (latest?.terms ?? {}) as Record<string, unknown>;
    const tranches = readTranches(terms);
    const lastVestDate = tranches.reduce((max, t) => (t.vestDate > max ? t.vestDate : max), tranches[0]?.vestDate ?? "");
    const servicePeriodEndDateRaw = terms.servicePeriodEndDate;
    const servicePeriodEndDate =
      typeof servicePeriodEndDateRaw === "string" && servicePeriodEndDateRaw > lastVestDate ? servicePeriodEndDateRaw : null;

    const quantity = String(terms.quantity ?? "");
    const grantDateFairValuePerUnit = String(terms.grantDateFairValuePerUnit ?? "");
    let totalGrantDateFairValue = "0.00";
    try {
      totalGrantDateFairValue = new Decimal(quantity || "0").times(grantDateFairValuePerUnit || "0").toFixed(2);
    } catch {
      // A grant with a malformed/missing quantity or fair value can't compute a
      // total — leave the default "0.00" rather than throwing and taking down the
      // whole report for one bad row.
    }

    const approval = inst.amortizationApprovals[0];
    const latestTermVersionId = latest?.id;
    let approvalStatus: GrantReportEntry["approvalStatus"] = "not-approved";
    let approvedAt: string | null = null;
    if (approval) {
      approvalStatus = approval.sourceTermVersionId === latestTermVersionId ? "approved" : "stale";
      approvedAt = approval.approvedAt.toISOString().slice(0, 10);
    }

    return {
      instrumentId: inst.id,
      instrumentType: inst.type as GrantReportEntry["instrumentType"],
      stakeholderId: inst.stakeholderId,
      stakeholderName: inst.stakeholder.name,
      grantDate: String(terms.grantDate ?? inst.issueDate.toISOString().slice(0, 10)),
      quantity,
      strikePrice: inst.type === "STOCK_OPTION" && terms.strikePrice !== undefined ? String(terms.strikePrice) : null,
      grantDateFairValuePerUnit,
      totalGrantDateFairValue,
      purchasePricePerShare:
        inst.type === "RESTRICTED_STOCK" && terms.purchasePricePerShare !== undefined ? String(terms.purchasePricePerShare) : null,
      attributionMethod: terms.attributionMethod === "graded" ? "graded" : "straight-line",
      tranches,
      lastVestDate,
      servicePeriodEndDate,
      approvalStatus,
      approvedAt,
    };
  });
}
