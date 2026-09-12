import { db } from "@/lib/db";
import { TermVersionRecord } from "@/lib/accounting/dispatch";

/**
 * v0.38.0 — DB-aware layer for shared PerformanceCondition tracking. See
 * PerformanceCondition's doc comment in prisma/schema.prisma for the full design, and
 * src/lib/accounting/performanceConditions.ts for the pure resolution math this feeds.
 *
 * This file has exactly two jobs: (1) CRUD for PerformanceCondition/
 * PerformanceConditionAssessment records, and (2) `attachPerformanceConditionAssessments`
 * — the bridge every caller of computeFullSchedule/computeVisibleSchedule/
 * computeScheduleForInstrument (dispatch.ts) needs to call BEFORE handing it
 * termVersions, so that any version linked to a shared condition gets that condition's
 * dated assessment history attached. `computeScheduleForInstrument` does the actual
 * per-period resolution internally (`enrichTermVersionsWithPerformanceConditions`) —
 * this file's job stops at fetching the raw assessment rows and shaping them onto the
 * right TermVersionRecord.
 */

interface RawTermVersionForAttach {
  effectiveDate: Date;
  label: string;
  terms: unknown;
  performanceConditionId: string | null;
}

type AssessmentsByCondition = Map<string, { effectiveDate: string; probable: boolean }[]>;

/** Fetches every assessment for the given PerformanceCondition ids, in one query,
 * keyed by condition id. Split out from `attachPerformanceConditionAssessments` below
 * so a caller that needs to enrich MANY overlapping term-version slices in a loop
 * (modificationAudit.ts's before/after-per-modification report) can fetch once for the
 * whole report and reuse the map via `shapeTermVersionsWithAssessments`, instead of
 * re-querying the database on every slice. */
export async function fetchPerformanceConditionAssessmentsByConditionIds(conditionIds: string[]): Promise<AssessmentsByCondition> {
  const assessmentsByCondition: AssessmentsByCondition = new Map();
  const uniqueIds = Array.from(new Set(conditionIds));
  if (uniqueIds.length === 0) return assessmentsByCondition;

  const rows = await db.performanceConditionAssessment.findMany({
    where: { performanceConditionId: { in: uniqueIds } },
    orderBy: { effectiveDate: "asc" },
  });
  for (const row of rows) {
    const list = assessmentsByCondition.get(row.performanceConditionId) ?? [];
    list.push({ effectiveDate: row.effectiveDate.toISOString().slice(0, 10), probable: row.probable });
    assessmentsByCondition.set(row.performanceConditionId, list);
  }
  return assessmentsByCondition;
}

/**
 * Pure/synchronous half of `attachPerformanceConditionAssessments` below — shapes raw
 * term versions into TermVersionRecord[], attaching each one's
 * `performanceConditionAssessments` from an already-fetched map (see
 * `fetchPerformanceConditionAssessmentsByConditionIds`). A version linked to a
 * condition that has NO assessments recorded yet gets an EMPTY array (not left
 * undefined) — that's the correct, conservative "opted in but never assessed" state,
 * which `resolvePerformanceConditionProbabilities` already treats as `probable: false`
 * for every period. A version with no `performanceConditionId` at all gets
 * `performanceConditionAssessments` left undefined, so its own inline
 * `terms.probabilityAssessments` (if any) is used completely unchanged.
 */
export function shapeTermVersionsWithAssessments(
  termVersions: RawTermVersionForAttach[],
  assessmentsByCondition: AssessmentsByCondition
): TermVersionRecord[] {
  return termVersions.map((v) => ({
    effectiveDate: v.effectiveDate.toISOString().slice(0, 10),
    label: v.label,
    terms: v.terms,
    performanceConditionAssessments: v.performanceConditionId ? assessmentsByCondition.get(v.performanceConditionId) ?? [] : undefined,
  }));
}

/**
 * Fetches every assessment for every distinct PerformanceCondition referenced across
 * `termVersions`, in one query, and returns the equivalent TermVersionRecord[] with
 * `performanceConditionAssessments` populated wherever `performanceConditionId` was
 * set.
 *
 * Call this once, on an instrument's FULL termVersions list, before passing the result
 * into computeFullSchedule/computeVisibleSchedule/computeScheduleForInstrument — never
 * on a partial list, since a shared condition's assessment history is only meaningful
 * read against the complete timeline. A caller that needs to enrich several
 * overlapping slices of the same instrument's versions (e.g. a before/after diff)
 * should instead call `fetchPerformanceConditionAssessmentsByConditionIds` once and
 * `shapeTermVersionsWithAssessments` per slice, to avoid re-querying per slice.
 */
export async function attachPerformanceConditionAssessments(termVersions: RawTermVersionForAttach[]): Promise<TermVersionRecord[]> {
  const conditionIds = termVersions.map((v) => v.performanceConditionId).filter((id): id is string => id !== null);
  const assessmentsByCondition = await fetchPerformanceConditionAssessmentsByConditionIds(conditionIds);
  return shapeTermVersionsWithAssessments(termVersions, assessmentsByCondition);
}

export interface PerformanceConditionSummary {
  id: string;
  code: string;
  description: string | null;
  /** Most recent assessment on file, if any — shown in the picker so a user linking a
   * new grant to an existing condition can see its current call before doing so. */
  latestAssessment: { effectiveDate: string; probable: boolean } | null;
  /** How many term versions (across any instrument) currently link to this condition —
   * shown in the picker so "3 grants" makes clear this is a shared record, not a
   * per-grant label. */
  linkedGrantCount: number;
}

/** Lists every PerformanceCondition on file for an entity, newest-assessment-first
 * context included — the data source for the wizard's "link to an existing condition"
 * picker (see GET /api/entities/[id]/performance-conditions). */
export async function listPerformanceConditionsForEntity(entityId: string): Promise<PerformanceConditionSummary[]> {
  const conditions = await db.performanceCondition.findMany({
    where: { entityId },
    include: {
      assessments: { orderBy: { effectiveDate: "desc" }, take: 1 },
      _count: { select: { termVersions: true } },
    },
    orderBy: { code: "asc" },
  });

  return conditions.map((c) => ({
    id: c.id,
    code: c.code,
    description: c.description,
    latestAssessment: c.assessments[0]
      ? { effectiveDate: c.assessments[0].effectiveDate.toISOString().slice(0, 10), probable: c.assessments[0].probable }
      : null,
    linkedGrantCount: c._count.termVersions,
  }));
}

export interface CreatePerformanceConditionResult {
  id: string;
  code: string;
  description: string | null;
}

/** Creates a new shared PerformanceCondition for an entity. Throws a friendly error
 * (rather than letting the unique-constraint violation surface raw) when `code` is
 * already in use for this entity — the caller should be pointing the user at linking
 * to that existing condition instead, not creating a near-duplicate. */
export async function createPerformanceCondition(
  entityId: string,
  code: string,
  description?: string
): Promise<CreatePerformanceConditionResult> {
  const trimmedCode = code.trim();
  if (!trimmedCode) {
    throw new Error('A performance condition needs a short code (e.g. "Apr 2026 EBITDA Perf").');
  }

  const existing = await db.performanceCondition.findUnique({
    where: { entityId_code: { entityId, code: trimmedCode } },
  });
  if (existing) {
    throw new Error(
      `A performance condition code "${trimmedCode}" already exists for this entity — link the grant to that existing ` +
        `condition instead of creating a duplicate.`
    );
  }

  const created = await db.performanceCondition.create({
    data: { entityId, code: trimmedCode, description: description?.trim() || null },
  });
  return { id: created.id, code: created.code, description: created.description };
}

export interface PerformanceConditionAssessmentResult {
  id: string;
  effectiveDate: string;
  probable: boolean;
  note: string | null;
}

/** Records a new dated probability call against an existing PerformanceCondition —
 * APPEND-ONLY (see PerformanceConditionAssessment's doc comment): this never updates or
 * removes a prior assessment, it only ever adds a new one with a later (or equal;
 * enforced by the caller, not here — see that model's "LAST one wins" note in
 * performanceConditions.ts) effective date. Every grant linked to this condition picks
 * up the change the next time its schedule is computed — nothing needs to be re-saved
 * on the grants themselves. */
export async function recordPerformanceConditionAssessment(
  performanceConditionId: string,
  effectiveDate: string,
  probable: boolean,
  note?: string,
  createdByUserId?: string
): Promise<PerformanceConditionAssessmentResult> {
  const condition = await db.performanceCondition.findUnique({ where: { id: performanceConditionId } });
  if (!condition) {
    throw new Error(`No performance condition found with id "${performanceConditionId}"`);
  }

  const created = await db.performanceConditionAssessment.create({
    data: {
      performanceConditionId,
      effectiveDate: new Date(effectiveDate),
      probable,
      note: note?.trim() || null,
      createdByUserId: createdByUserId ?? null,
    },
  });

  return {
    id: created.id,
    effectiveDate: created.effectiveDate.toISOString().slice(0, 10),
    probable: created.probable,
    note: created.note,
  };
}
