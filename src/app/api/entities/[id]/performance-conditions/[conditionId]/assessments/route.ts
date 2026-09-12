import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";
import { recordPerformanceConditionAssessment } from "@/lib/db/performanceConditions";

/**
 * POST /api/entities/:id/performance-conditions/:conditionId/assessments
 *   { "effectiveDate": "YYYY-MM-DD", "probable": boolean, "note"?: string }
 *
 * Records a new dated probability call against a shared PerformanceCondition —
 * APPEND-ONLY (see PerformanceConditionAssessment's doc comment in
 * prisma/schema.prisma). Every grant currently linked to this condition (via
 * InstrumentTermVersion.performanceConditionId) picks up the change the next time its
 * schedule is computed or its amortization approved — nothing on the grants themselves
 * needs to be touched.
 *
 * This is the natural home for "assess this condition as part of the preview process
 * prior to posting" — the per-instrument amortization preview screen, when it finds a
 * linked condition, should call this before re-previewing/approving.
 *
 * EDITOR-or-above, same bar as recording any other accounting judgment on this entity.
 * `conditionId` must belong to THIS entity — same "don't silently accept a foreign
 * record" posture as board-consents' instrumentIds check.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string; conditionId: string } }) {
  const access = await requireApiEntityAccess(req, params.id, "EDITOR");
  if (access instanceof NextResponse) return access;

  const condition = await db.performanceCondition.findFirst({ where: { id: params.conditionId, entityId: params.id } });
  if (!condition) {
    return NextResponse.json({ error: `No performance condition found with id "${params.conditionId}" on this entity` }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const { effectiveDate, probable, note } = body ?? {};

  if (!effectiveDate || typeof effectiveDate !== "string" || Number.isNaN(Date.parse(effectiveDate))) {
    return NextResponse.json({ error: "effectiveDate is required and must be a valid date (YYYY-MM-DD)" }, { status: 400 });
  }
  if (typeof probable !== "boolean") {
    return NextResponse.json({ error: "probable is required and must be true or false" }, { status: 400 });
  }
  if (note !== undefined && typeof note !== "string") {
    return NextResponse.json({ error: "note must be a string if provided" }, { status: 400 });
  }

  try {
    const assessment = await recordPerformanceConditionAssessment(params.conditionId, effectiveDate, probable, note, access.user.id);
    return NextResponse.json({ assessment }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to record assessment" }, { status: 400 });
  }
}
