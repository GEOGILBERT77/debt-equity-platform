import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

const VALID_STATUSES = ["PENDING", "FILED", "NOT_REQUIRED"] as const;

/**
 * PATCH /api/tax-filing-records/:id { "status", "notes"? }
 *
 * Marks a compliance obligation FILED (a human actually filed it), NOT_REQUIRED (it
 * was computed and then determined not to actually apply — e.g. an ISO exercise that
 * turned out, on closer review, to have been entirely recharacterized to NSO some
 * other way this platform doesn't model), or back to PENDING. See
 * prisma/schema.prisma's doc comment on TaxFilingRecord.status for why this state is
 * never recomputed away — the report's history has to stay a complete, auditable
 * record of every obligation it ever evaluated, not just the ones that stuck.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const record = await db.taxFilingRecord.findUnique({ where: { id: params.id } });
  if (!record) {
    return NextResponse.json({ error: `No tax filing record found with id "${params.id}"` }, { status: 404 });
  }

  const access = await requireApiEntityAccess(req, record.entityId, "EDITOR");
  if (access instanceof NextResponse) return access;

  const body = await req.json().catch(() => ({}));
  const { status, notes } = body ?? {};

  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` }, { status: 400 });
  }
  if (status === undefined && notes === undefined) {
    return NextResponse.json({ error: "Provide at least one of: status, notes" }, { status: 400 });
  }

  const updated = await db.taxFilingRecord.update({
    where: { id: params.id },
    data: {
      ...(status !== undefined
        ? {
            status,
            filedDate: status === "FILED" ? new Date() : status === "PENDING" ? null : record.filedDate,
            filedByUserId: status === "FILED" ? access.user.id : status === "PENDING" ? null : record.filedByUserId,
          }
        : {}),
      ...(notes !== undefined ? { notes: notes || null } : {}),
    },
  });

  return NextResponse.json({
    record: {
      id: updated.id,
      status: updated.status,
      filedDate: updated.filedDate?.toISOString().slice(0, 10) ?? null,
      notes: updated.notes,
    },
  });
}
