import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

/**
 * PATCH /api/entities/:id { "name"?, "reportingCurrency"? } — renames an entity and/or
 * changes its reporting currency. Requires at least EDITOR (the same bar `POST .../
 * stakeholders` and `POST /api/instruments` use for writes on an entity you already
 * have access to — OWNER is reserved for access-granting and the destructive DELETE
 * below, not for ordinary edits).
 *
 * DELETE /api/entities/:id — requires OWNER specifically: deleting the top of the
 * Entity -> Stakeholder -> Instrument hierarchy is irreversible and, per the schema's
 * `ON DELETE RESTRICT` on every foreign key into Entity (see prisma/schema.prisma's
 * doc comment and db/schema.sql), only actually succeeds when NOTHING still points at
 * it — no stakeholders, no instruments, no documents. Rather than let that surface as
 * a raw Postgres foreign-key-violation error, this route checks first and returns a
 * clean 409 naming what's still attached, then still wraps the actual delete in a
 * try/catch for the same "never trust a client-side check alone" reasoning
 * `requireApiEntityAccess` itself is built on (a concurrent request could add a
 * stakeholder between the check and the delete).
 *
 * `EntityAccess` is ALSO `ON DELETE RESTRICT` into Entity (db/schema.sql) — and every
 * entity has at least one such row by construction (its creator's OWNER grant, made in
 * the same transaction as the entity itself; see `POST /api/entities`'s doc comment).
 * That means a plain `db.entity.delete()` would always fail, even on an entity with no
 * stakeholders/instruments/documents at all, purely because of its own access-control
 * rows. Unlike those three, EntityAccess rows aren't independent user data worth
 * blocking a delete over — they're just "who can reach this entity," which stops
 * mattering the instant the entity is gone — so this route deletes them itself, inside
 * the same transaction as the entity delete, rather than asking the caller to somehow
 * revoke everyone's access first.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireApiEntityAccess(req, params.id, "EDITOR");
  if (access instanceof NextResponse) return access;

  const body = await req.json().catch(() => ({}));
  const { name, reportingCurrency } = body ?? {};

  const data: { name?: string; reportingCurrency?: string } = {};
  if (name !== undefined) {
    if (typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json({ error: "name must be a non-empty string when provided" }, { status: 400 });
    }
    data.name = name.trim();
  }
  if (reportingCurrency !== undefined) {
    if (typeof reportingCurrency !== "string" || reportingCurrency.trim().length === 0) {
      return NextResponse.json({ error: "reportingCurrency must be a non-empty string when provided" }, { status: 400 });
    }
    data.reportingCurrency = reportingCurrency.trim().toUpperCase();
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Provide at least one of: name, reportingCurrency" }, { status: 400 });
  }

  const entity = await db.entity.update({ where: { id: params.id }, data });
  return NextResponse.json({ entity });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireApiEntityAccess(req, params.id, "OWNER");
  if (access instanceof NextResponse) return access;

  const [stakeholderCount, instrumentCount, documentCount] = await Promise.all([
    db.stakeholder.count({ where: { entityId: params.id } }),
    db.instrument.count({ where: { entityId: params.id } }),
    db.document.count({ where: { entityId: params.id } }),
  ]);
  const blockers: string[] = [];
  if (stakeholderCount > 0) blockers.push(`${stakeholderCount} stakeholder(s)`);
  if (instrumentCount > 0) blockers.push(`${instrumentCount} instrument(s)`);
  if (documentCount > 0) blockers.push(`${documentCount} document(s)`);
  if (blockers.length > 0) {
    return NextResponse.json(
      { error: `Can't delete this entity — it still has ${blockers.join(", ")}. Remove those first.` },
      { status: 409 }
    );
  }

  try {
    await db.$transaction(async (tx) => {
      await tx.entityAccess.deleteMany({ where: { entityId: params.id } });
      await tx.entity.delete({ where: { id: params.id } });
    });
  } catch (err) {
    // Defense in depth against the check-then-act race described in this file's doc
    // comment — a foreign-key violation here means something got attached between the
    // count above and this delete.
    return NextResponse.json(
      { error: "Can't delete this entity — something is still attached to it (it may have just been added)." },
      { status: 409 }
    );
  }

  return NextResponse.json({ deleted: true });
}
