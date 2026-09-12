import { db } from "@/lib/db";
import { computeFullSchedule, InstrumentTypeForDispatch } from "@/lib/accounting/dispatch";
import { ScheduleRow } from "@/lib/accounting/types";
import { attachPerformanceConditionAssessments } from "@/lib/db/performanceConditions";

/**
 * v0.26.0 — CORRECTED WORKFLOW. A brief v0.25.0 attempt made approval fully automatic
 * (triggered silently by data entry) in response to "there should only be approval on
 * the initial upload or input of new options... not need any additional approvals
 * after that." That went too far: direct follow-up feedback clarified the actual
 * requirement is "there should be an approve function prior to the grant going live
 * and being included in reporting" — i.e. a REAL, explicit review gate is required,
 * it just shouldn't be a RECURRING one. The two statements together mean:
 *
 *   Every discrete data-entry EVENT for a grant — its initial creation (by hand or
 *   bulk upload), or a later modification to its terms — gets EXACTLY ONE approval
 *   checkpoint before that event's numbers are live in reporting. Nothing needs a
 *   second approval once it's already been approved, and nothing skips approval
 *   entirely.
 *
 * What that means for each entry point:
 * - Manual creation (POST /api/instruments): creates the instrument only. Its own
 *   page then shows the full-schedule PREVIEW and a required "Approve this schedule"
 *   action (ApproveAmortizationScheduleButton.tsx) — one click, one grant.
 * - Bulk upload (importParsedGrantRows): creates every row's instrument, none
 *   approved yet. The upload UI then shows one "Approve all uploaded grants" action
 *   (ApproveAllAmortizationSchedulesButton.tsx) covering the WHOLE batch — one click,
 *   however many grants were in the file, since the upload was itself one event.
 * - Modification (POST /api/instruments/:id/modifications): see
 *   previewModificationImpact and that route's doc comment below — a modification
 *   gets its own preview-then-commit flow, where committing (only reachable after
 *   reviewing the preview) bundles that ONE approval for the change, rather than
 *   requiring a further separate click after commit.
 *
 * The database model (AmortizationScheduleApproval, append-only — see its doc comment
 * in prisma/schema.prisma) and the underlying compute/persist functions below are
 * unchanged from v0.22.0/v0.24.0; what changed across v0.25.0 → v0.26.0 is only which
 * code paths call them and when.
 */

export interface AmortizationScheduleRowResult {
  periodStart: string;
  periodEnd: string;
  label: string;
  amount: string;
  endingBalance: string | null;
  currency: string;
}

function toRowResult(currency: string) {
  return (row: ScheduleRow): AmortizationScheduleRowResult => ({
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    label: row.label,
    amount: row.amount.toFixed(4),
    endingBalance: row.endingBalance?.toFixed(4) ?? null,
    currency: row.currency ?? currency,
  });
}

/** Computes (without persisting) the full monthly amortization table for an
 * instrument's current terms — the preview shown before approval. Throws the same
 * "no natural end date" error `computeFullSchedule` throws for a type this doesn't
 * apply to (TERM_LOAN, etc.) — callers should only invoke this for types where a full
 * schedule is a meaningful concept in the first place. */
export async function previewAmortizationSchedule(instrumentId: string): Promise<AmortizationScheduleRowResult[]> {
  const instrument = await db.instrument.findUnique({
    where: { id: instrumentId },
    include: { termVersions: { orderBy: { effectiveDate: "asc" } } },
  });
  if (!instrument) {
    throw new Error(`No instrument found with id "${instrumentId}"`);
  }

  const rows = computeFullSchedule(
    instrument.type as InstrumentTypeForDispatch,
    await attachPerformanceConditionAssessments(instrument.termVersions)
  );

  return rows.map(toRowResult(instrument.currency));
}

/**
 * Recomputes the full monthly schedule from the instrument's CURRENT latest term
 * version and persists it as a new AmortizationScheduleApproval + its rows, in one
 * transaction. Always creates a NEW approval rather than overwriting a prior one —
 * see the append-only reasoning in AmortizationScheduleApproval's doc comment — so
 * re-approving after a modification keeps the old (now-superseded) approval around as
 * history rather than losing it.
 *
 * This is the REQUIRED gate a grant's schedule must pass through before any report
 * includes it — see this file's top-of-file doc comment. Called directly by
 * POST /api/instruments/:id/amortization-schedule (one grant) and by
 * approveAllAmortizationSchedulesForEntity below (a whole batch at once), and bundled
 * into a reviewed modification commit (see previewModificationImpact).
 */
export async function approveAmortizationSchedule(instrumentId: string, approvedByUserId: string) {
  const instrument = await db.instrument.findUnique({
    where: { id: instrumentId },
    include: { termVersions: { orderBy: { effectiveDate: "asc" } } },
  });
  if (!instrument) {
    throw new Error(`No instrument found with id "${instrumentId}"`);
  }

  const latestTermVersion = instrument.termVersions[instrument.termVersions.length - 1];
  const rows = computeFullSchedule(
    instrument.type as InstrumentTypeForDispatch,
    await attachPerformanceConditionAssessments(instrument.termVersions)
  );

  const approval = await db.$transaction(async (tx) => {
    return tx.amortizationScheduleApproval.create({
      data: {
        instrumentId: instrument.id,
        sourceTermVersionId: latestTermVersion.id,
        approvedByUserId,
        rows: {
          create: rows.map((row) => ({
            periodStart: new Date(row.periodStart),
            periodEnd: new Date(row.periodEnd),
            label: row.label,
            amount: row.amount.toFixed(4),
            endingBalance: row.endingBalance?.toFixed(4),
            currency: row.currency ?? instrument.currency,
          })),
        },
      },
      include: { rows: { orderBy: { periodEnd: "asc" } } },
    });
  });

  return approval;
}

export interface ApprovalIfApplicableResult {
  approved: boolean;
  error?: string;
}

/**
 * Thin wrapper around approveAmortizationSchedule used ONLY by the modification
 * commit route (POST /api/instruments/:id/modifications) — never called
 * automatically by instrument creation or bulk upload, which require their own
 * separate explicit approval (see this file's top-of-file doc comment). Committing a
 * modification is only reachable after the caller has already fetched a preview via
 * previewModificationImpact, so that commit action itself IS this modification's one
 * required approval — this helper just performs it without letting a "not
 * applicable" type (TERM_LOAN, etc.) turn into a hard failure of the commit, since the
 * new InstrumentTermVersion write it follows has already succeeded and is correct
 * regardless of whether a projection table applies to this instrument type at all.
 */
export async function approveAmortizationScheduleIfApplicable(
  instrumentId: string,
  approvedByUserId: string
): Promise<ApprovalIfApplicableResult> {
  try {
    await approveAmortizationSchedule(instrumentId, approvedByUserId);
    return { approved: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate amortization schedule";
    if (message.includes("has no natural end date")) {
      return { approved: false };
    }
    return { approved: false, error: message };
  }
}

export interface BulkApprovalResult {
  instrumentId: string;
  stakeholderName: string;
  status: "approved" | "skipped-current" | "error";
  message?: string;
}

/**
 * Bulk counterpart to approveAmortizationSchedule — approves every instrument of the
 * given TYPE in one entity that needs it, in a single action. This is the normal way
 * to clear the required approval gate for a whole batch at once (e.g. right after a
 * bulk upload — see BulkUploadStockOptionsForm.tsx, which renders the button wired to
 * this immediately after an upload finishes) instead of opening every grant's own
 * page individually. Same "flag rather than crash" pattern as
 * closeAllInstrumentsForEntity — one instrument's failure (e.g. terms that don't
 * validate) is collected as an error for that row and never blocks approving the rest.
 *
 * An instrument whose most recent approval ALREADY matches its current (latest) term
 * version is SKIPPED, not re-approved — every approval is a permanent row (see
 * AmortizationScheduleApproval's append-only doc comment in prisma/schema.prisma), so
 * running this repeatedly (e.g. from the amortization report, as a catch-all for
 * anything still pending) never creates pointless duplicate approvals for grants
 * nothing has changed on.
 *
 * Only meaningful for types with a natural end date (STOCK_OPTION, RSU,
 * RESTRICTED_STOCK) — same restriction as computeFullSchedule/approveAmortizationSchedule.
 * Calling this with a type like TERM_LOAN would just collect a "no natural end date"
 * error for every instrument; callers should pass a type this actually applies to.
 */
export async function approveAllAmortizationSchedulesForEntity(
  entityId: string,
  type: InstrumentTypeForDispatch,
  approvedByUserId: string
): Promise<BulkApprovalResult[]> {
  const instruments = await db.instrument.findMany({
    where: { entityId, type },
    include: {
      stakeholder: true,
      termVersions: { orderBy: { effectiveDate: "asc" }, select: { id: true } },
      amortizationApprovals: { orderBy: { approvedAt: "desc" }, take: 1, select: { sourceTermVersionId: true } },
    },
    orderBy: { issueDate: "asc" },
  });

  const results: BulkApprovalResult[] = [];

  for (const inst of instruments) {
    const latestTermVersionId = inst.termVersions[inst.termVersions.length - 1]?.id;
    const currentApproval = inst.amortizationApprovals[0];

    if (currentApproval && currentApproval.sourceTermVersionId === latestTermVersionId) {
      results.push({ instrumentId: inst.id, stakeholderName: inst.stakeholder.name, status: "skipped-current" });
      continue;
    }

    try {
      await approveAmortizationSchedule(inst.id, approvedByUserId);
      results.push({ instrumentId: inst.id, stakeholderName: inst.stakeholder.name, status: "approved" });
    } catch (err) {
      results.push({
        instrumentId: inst.id,
        stakeholderName: inst.stakeholder.name,
        status: "error",
        message: err instanceof Error ? err.message : "Failed to approve this instrument's schedule",
      });
    }
  }

  return results;
}

export interface ModificationImpactPeriodDelta {
  periodEnd: string;
  label: string;
  beforeAmount: string;
  afterAmount: string;
  delta: string;
}

export interface ModificationImpactPreview {
  /** false for a type with no natural end date (TERM_LOAN, REVOLVER, ...) — a full
   * amortization-table impact preview isn't a meaningful concept for a period-by-
   * period roll-forward. `message` explains why and points elsewhere when false. */
  applicable: boolean;
  message?: string;
  before: AmortizationScheduleRowResult[];
  after: AmortizationScheduleRowResult[];
  perPeriodDeltas: ModificationImpactPeriodDelta[];
  totalBeforeAmount: string;
  totalAfterAmount: string;
  totalDelta: string;
}

/**
 * "Functionality that allows us to preview and report on the impacts of
 * modifications" — computes the full amortization table BEFORE the proposed change
 * (the instrument's current terms) and AFTER (as if the proposed term version were
 * appended), and diffs them period by period. Nothing is persisted here — this is the
 * "run it and view the impact" step, the same role previewCorrection plays for
 * corrections (see correctionService.ts's doc comment on why modifications and
 * corrections are deliberately different concepts/code paths). The commit route
 * (POST /api/instruments/:id/modifications) takes the same `proposedTerms` /
 * `proposedEffectiveDate` inputs and is expected to be called only after a human has
 * looked at this preview — see that route's doc comment.
 *
 * Only STOCK_OPTION/RSU/RESTRICTED_STOCK (types with a natural end date) get a real
 * before/after table; every other type comes back with `applicable: false` and a
 * pointer to where its modification impact IS covered today (the debt-modification
 * report's ASC 470-50 test for TERM_LOAN) rather than silently returning an empty or
 * misleading diff. The UI still allows committing the modification either way — the
 * dollar-impact preview is an enhancement for the types it applies to, not a
 * precondition for recording an amendment at all.
 */
export async function previewModificationImpact(
  instrumentId: string,
  proposedEffectiveDate: string,
  proposedTerms: unknown,
  proposedLabel?: string
): Promise<ModificationImpactPreview> {
  const instrument = await db.instrument.findUnique({
    where: { id: instrumentId },
    include: { termVersions: { orderBy: { effectiveDate: "asc" } } },
  });
  if (!instrument) {
    throw new Error(`No instrument found with id "${instrumentId}"`);
  }

  const type = instrument.type as InstrumentTypeForDispatch;
  const currentTermVersions = await attachPerformanceConditionAssessments(instrument.termVersions);

  let before: ScheduleRow[];
  try {
    before = computeFullSchedule(type, currentTermVersions);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to compute the current schedule";
    if (message.includes("has no natural end date")) {
      return {
        applicable: false,
        message:
          `A full amortization-table impact preview isn't a meaningful concept for "${type}" — it's a ` +
          `period-by-period roll-forward, not a fixed-total allocation. For a TERM_LOAN, see the ` +
          `debt-modification report for this instrument's ASC 470-50 impact test instead.`,
        before: [],
        after: [],
        perPeriodDeltas: [],
        totalBeforeAmount: "0.00",
        totalAfterAmount: "0.00",
        totalDelta: "0.00",
      };
    }
    throw err;
  }

  const proposedTermVersions = [
    ...currentTermVersions,
    { effectiveDate: proposedEffectiveDate, label: proposedLabel ?? "Proposed modification (preview only)", terms: proposedTerms },
  ];
  const after = computeFullSchedule(type, proposedTermVersions);

  // Union of both sets of period-ends, not a 1:1 zip — a modification that changes
  // the schedule's total length (e.g. extending vesting) means "before" and "after"
  // won't have the same number of periods, or the same period-end dates past the
  // point of change.
  const beforeByPeriod = new Map(before.map((r) => [r.periodEnd, r]));
  const afterByPeriod = new Map(after.map((r) => [r.periodEnd, r]));
  const allPeriodEnds = Array.from(new Set([...beforeByPeriod.keys(), ...afterByPeriod.keys()])).sort();

  const perPeriodDeltas: ModificationImpactPeriodDelta[] = allPeriodEnds.map((periodEnd) => {
    const b = beforeByPeriod.get(periodEnd);
    const a = afterByPeriod.get(periodEnd);
    const beforeAmount = b?.amount.toFixed(4) ?? "0.0000";
    const afterAmount = a?.amount.toFixed(4) ?? "0.0000";
    return {
      periodEnd,
      label: (a ?? b)!.label,
      beforeAmount: Number(beforeAmount).toFixed(2),
      afterAmount: Number(afterAmount).toFixed(2),
      delta: (Number(afterAmount) - Number(beforeAmount)).toFixed(2),
    };
  });

  const totalBefore = before.reduce((sum, r) => sum + Number(r.amount.toFixed(4)), 0);
  const totalAfter = after.reduce((sum, r) => sum + Number(r.amount.toFixed(4)), 0);

  return {
    applicable: true,
    before: before.map(toRowResult(instrument.currency)),
    after: after.map(toRowResult(instrument.currency)),
    perPeriodDeltas,
    totalBeforeAmount: totalBefore.toFixed(2),
    totalAfterAmount: totalAfter.toFixed(2),
    totalDelta: (totalAfter - totalBefore).toFixed(2),
  };
}
