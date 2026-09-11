import { db } from "@/lib/db";
import { computeFullSchedule, InstrumentTypeForDispatch } from "@/lib/accounting/dispatch";

/**
 * "An audit report of all modifications made" — direct follow-up to the "Modify
 * terms" feature (ModifyGrantForm.tsx / modifications/route.ts): a searchable,
 * date-ranged report over every MODIFICATION (never the original grant, never a
 * Correction — see correctionService.ts's doc comment on why those are different
 * concepts) an entity has recorded, showing which terms changed and what it did to
 * the numbers.
 *
 * DELIBERATELY SEPARATE from /reports/audit-trail (auditTrail.ts), which already
 * covers term versions AND corrections in one chronological feed, sorted by
 * `effectiveDate`/`discoveredDate`. This report is narrower but deeper: modifications
 * only, sorted and filtered by MODIFICATION DATE — explicitly defined, per the actual
 * ask, as `createdAt` (when the modification was COMMITTED), not `effectiveDate`
 * (when its terms take effect) — those two dates can differ (a modification recorded
 * today with an effective date next quarter), and "search for all modifications over
 * a date range" means "when did this actually get entered," not "when does it take
 * effect." Each row also carries a real field-level terms diff and the financial
 * (amortization-table) impact, neither of which auditTrail.ts computes today.
 *
 * "Modification" here means every InstrumentTermVersion for an instrument EXCEPT its
 * first (by createdAt) — the first is the origination, not an amendment. This mirrors
 * `isOriginal` in auditTrail.ts but is computed independently here since this module
 * needs the ordered list of prior versions anyway (to diff against and to compute the
 * before/after schedule).
 */

export interface TermFieldChange {
  field: string;
  before: string;
  after: string;
}

export interface ModificationAuditEntry {
  instrumentId: string;
  instrumentType: string;
  stakeholderId: string;
  stakeholderName: string;
  termVersionId: string;
  /** When this modification was COMMITTED — InstrumentTermVersion.createdAt. This is
   * what a date-range search filters on. */
  modificationDate: string;
  /** When the modified terms take EFFECT — may differ from modificationDate. */
  effectiveDate: string;
  label: string;
  modifiedByUserEmail?: string;
  changedFields: TermFieldChange[];
  /** false for a type with no natural end date (TERM_LOAN, etc.) — see
   * previewModificationImpact's identical distinction in amortizationSchedule.ts. */
  impactApplicable: boolean;
  impactMessage?: string;
  totalBeforeAmount: string;
  totalAfterAmount: string;
  totalDelta: string;
}

/** Renders one terms field's value for the summary table. Arrays (tranches,
 * cashFlows, ...) are summarized by count rather than dumped in full — this is a
 * SUMMARY report ("summary info of which terms changed" was the actual ask), not a
 * full line-by-line diff viewer; the full before/after JSON is always available on
 * the instrument's own term-version history if a deeper look is needed. When an array
 * changed but kept the same length (e.g. a tranche's quantity was edited without
 * adding/removing tranches), the length alone wouldn't show any difference, so that
 * case is called out explicitly rather than silently looking unchanged. */
function formatTermValue(value: unknown, other: unknown): string {
  if (value === undefined) return "(not set)";
  if (Array.isArray(value)) {
    if (Array.isArray(other) && other.length === value.length && JSON.stringify(other) !== JSON.stringify(value)) {
      return `${value.length} item(s) (values differ)`;
    }
    return `${value.length} item(s)`;
  }
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Shallow key-by-key diff between two terms objects — generic across every
 * instrument type's terms shape (no per-type special-casing), since this report
 * covers all eleven InstrumentTypes, not just the three with a typed Modify form. */
function diffTerms(before: unknown, after: unknown): TermFieldChange[] {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)])).sort();
  const changes: TermFieldChange[] = [];
  for (const key of keys) {
    if (JSON.stringify(b[key]) === JSON.stringify(a[key])) continue;
    changes.push({ field: key, before: formatTermValue(b[key], a[key]), after: formatTermValue(a[key], b[key]) });
  }
  return changes;
}

export interface ModificationAuditDateRange {
  /** Inclusive, "YYYY-MM-DD". Filters on modificationDate (createdAt), not effectiveDate. */
  from?: string;
  to?: string;
}

/**
 * Builds the modification audit report for one entity. Fetches every term version
 * for every instrument in the entity (ordered by createdAt so index 0 per instrument
 * is unambiguously the origination), then for each instrument walks its versions
 * starting at index 1 (skipping the origination), filters by the requested date
 * range, and for each qualifying modification: diffs its terms against the
 * immediately preceding version, and computes the amortization-table impact by
 * running computeFullSchedule twice — once over the versions up to (not including)
 * this one, once including it — the same "before/after" shape
 * previewModificationImpact uses for a not-yet-committed proposal, just applied here
 * to what actually happened historically.
 */
export async function getModificationAuditReport(
  entityId: string,
  range: ModificationAuditDateRange
): Promise<ModificationAuditEntry[]> {
  const allVersions = await db.instrumentTermVersion.findMany({
    where: { instrument: { entityId } },
    include: {
      instrument: { include: { stakeholder: true } },
      createdByUser: { select: { email: true } },
    },
    orderBy: [{ instrumentId: "asc" }, { createdAt: "asc" }],
  });

  const byInstrument = new Map<string, typeof allVersions>();
  for (const v of allVersions) {
    const list = byInstrument.get(v.instrumentId);
    if (list) list.push(v);
    else byInstrument.set(v.instrumentId, [v]);
  }

  const fromDate = range.from ? new Date(`${range.from}T00:00:00.000Z`) : null;
  // Inclusive of the whole "to" day, since createdAt carries a time-of-day component.
  const toDate = range.to ? new Date(new Date(`${range.to}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000 - 1) : null;

  const entries: ModificationAuditEntry[] = [];

  for (const versions of byInstrument.values()) {
    for (let i = 1; i < versions.length; i++) {
      const version = versions[i];
      if (fromDate && version.createdAt < fromDate) continue;
      if (toDate && version.createdAt > toDate) continue;

      const previous = versions[i - 1];
      const type = version.instrument.type as InstrumentTypeForDispatch;
      const changedFields = diffTerms(previous.terms, version.terms);

      const asTermVersionRecord = (v: (typeof versions)[number]) => ({
        effectiveDate: v.effectiveDate.toISOString().slice(0, 10),
        label: v.label,
        terms: v.terms,
      });

      let impactApplicable = true;
      let impactMessage: string | undefined;
      let totalBeforeAmount = "0.00";
      let totalAfterAmount = "0.00";
      let totalDelta = "0.00";

      try {
        const beforeSchedule = computeFullSchedule(type, versions.slice(0, i).map(asTermVersionRecord));
        const afterSchedule = computeFullSchedule(type, versions.slice(0, i + 1).map(asTermVersionRecord));
        const totalBefore = beforeSchedule.reduce((sum, r) => sum + Number(r.amount.toFixed(4)), 0);
        const totalAfter = afterSchedule.reduce((sum, r) => sum + Number(r.amount.toFixed(4)), 0);
        totalBeforeAmount = totalBefore.toFixed(2);
        totalAfterAmount = totalAfter.toFixed(2);
        totalDelta = (totalAfter - totalBefore).toFixed(2);
      } catch (err) {
        impactApplicable = false;
        const message = err instanceof Error ? err.message : "Failed to compute impact";
        impactMessage = message.includes("has no natural end date")
          ? `No amortization-table impact to show for "${type}" — see the debt-modification report for this instrument's ASC 470-50 impact test instead.`
          : message;
      }

      entries.push({
        instrumentId: version.instrumentId,
        instrumentType: type,
        stakeholderId: version.instrument.stakeholderId,
        stakeholderName: version.instrument.stakeholder.name,
        termVersionId: version.id,
        modificationDate: version.createdAt.toISOString().slice(0, 10),
        effectiveDate: version.effectiveDate.toISOString().slice(0, 10),
        label: version.label,
        modifiedByUserEmail: version.createdByUser?.email,
        changedFields,
        impactApplicable,
        impactMessage,
        totalBeforeAmount,
        totalAfterAmount,
        totalDelta,
      });
    }
  }

  entries.sort((x, y) => (x.modificationDate < y.modificationDate ? -1 : x.modificationDate > y.modificationDate ? 1 : 0));
  return entries;
}
