import { NextRequest, NextResponse } from "next/server";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";
import { listPerformanceConditionsForEntity, createPerformanceCondition } from "@/lib/db/performanceConditions";

/**
 * v0.38.0 — shared PerformanceCondition CRUD for one entity. See PerformanceCondition's
 * doc comment in prisma/schema.prisma for the full design.
 *
 * GET /api/entities/:id/performance-conditions — lists every condition on file for this
 * entity, each with its most recent assessment (if any) and how many grants are
 * currently linked to it. This is the data source for the stock-award wizard's "link to
 * an existing condition" picker. VIEWER-or-above, same bar as every other read.
 *
 * POST /api/entities/:id/performance-conditions { "code", "description"? } — creates a
 * new shared condition (e.g. "Apr 2026 EBITDA Perf") that grants can then link to via
 * their InstrumentTermVersion.performanceConditionId. EDITOR-or-above. `code` must be
 * unique within this entity — see createPerformanceCondition's doc comment for the
 * friendly error returned instead of a raw constraint violation.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireApiEntityAccess(req, params.id, "VIEWER");
  if (access instanceof NextResponse) return access;

  const performanceConditions = await listPerformanceConditionsForEntity(params.id);
  return NextResponse.json({ performanceConditions });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireApiEntityAccess(req, params.id, "EDITOR");
  if (access instanceof NextResponse) return access;

  const body = await req.json().catch(() => ({}));
  const { code, description } = body ?? {};

  if (!code || typeof code !== "string" || code.trim().length === 0) {
    return NextResponse.json({ error: 'code is required (e.g. "Apr 2026 EBITDA Perf")' }, { status: 400 });
  }
  if (description !== undefined && typeof description !== "string") {
    return NextResponse.json({ error: "description must be a string if provided" }, { status: 400 });
  }

  try {
    const performanceCondition = await createPerformanceCondition(params.id, code, description);
    return NextResponse.json({ performanceCondition }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to create performance condition" }, { status: 400 });
  }
}
