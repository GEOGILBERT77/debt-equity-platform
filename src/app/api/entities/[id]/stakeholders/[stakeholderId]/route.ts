import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

const VALID_STAKEHOLDER_TYPES = ["INVESTOR", "DEBT_HOLDER", "EMPLOYEE", "ADVISOR", "ENTITY_HOLDER"] as const;

/**
 * PATCH /api/entities/:id/stakeholders/:stakeholderId { "name"?, "type"?, "email"?,
 * "phone"?, "address"? } — edits a stakeholder's own record (who they are), never their
 * instruments' terms. Requires at least EDITOR on the parent entity, same bar the
 * sibling `POST .../stakeholders` route in `../route.ts` uses for creating one.
 * Changing `type` doesn't retroactively change how any of this stakeholder's existing
 * instruments are accounted for — `type` here is a descriptive/reporting label
 * (`StakeholderType`), not an input to any engine function; an instrument's actual GAAP
 * treatment comes entirely from ITS OWN `type` (STOCK_OPTION, TERM_LOAN, ...) and
 * `terms`, in `Instrument`, a completely separate model.
 *
 * DELETE /api/entities/:id/stakeholders/:stakeholderId — requires EDITOR. Blocked with
 * a clean 409 (not a raw foreign-key error) if this stakeholder still has any
 * instruments — `Instrument.stakeholderId` is `ON DELETE RESTRICT` (db/schema.sql), by
 * design: an instrument's own audit trail (term versions, closed schedule entries,
 * journal entries) must never be silently orphaned or cascade-deleted just because
 * someone removed the stakeholder record. Reassigning an instrument to a different
 * stakeholder isn't supported either (there's no UI or route for it) — the intended
 * fix for "this stakeholder record was created by mistake" is deleting it before any
 * instrument ever gets attached, not after.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string; stakeholderId: string } }) {
  const access = await requireApiEntityAccess(req, params.id, "EDITOR");
  if (access instanceof NextResponse) return access;

  const existing = await db.stakeholder.findUnique({ where: { id: params.stakeholderId } });
  if (!existing || existing.entityId !== params.id) {
    return NextResponse.json({ error: `No stakeholder found with id "${params.stakeholderId}" on this entity` }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const { name, type, email, phone, address } = body ?? {};

  const data: { name?: string; type?: (typeof VALID_STAKEHOLDER_TYPES)[number]; email?: string | null; phone?: string | null; address?: string | null } = {};
  if (name !== undefined) {
    if (typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json({ error: "name must be a non-empty string when provided" }, { status: 400 });
    }
    data.name = name.trim();
  }
  if (type !== undefined) {
    if (!VALID_STAKEHOLDER_TYPES.includes(type)) {
      return NextResponse.json({ error: `type must be one of: ${VALID_STAKEHOLDER_TYPES.join(", ")}` }, { status: 400 });
    }
    data.type = type;
  }
  if (email !== undefined) data.email = email || null;
  if (phone !== undefined) data.phone = phone || null;
  if (address !== undefined) data.address = address || null;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Provide at least one of: name, type, email, phone, address" }, { status: 400 });
  }

  const stakeholder = await db.stakeholder.update({ where: { id: params.stakeholderId }, data });
  return NextResponse.json({ stakeholder });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string; stakeholderId: string } }) {
  const access = await requireApiEntityAccess(req, params.id, "EDITOR");
  if (access instanceof NextResponse) return access;

  const existing = await db.stakeholder.findUnique({ where: { id: params.stakeholderId } });
  if (!existing || existing.entityId !== params.id) {
    return NextResponse.json({ error: `No stakeholder found with id "${params.stakeholderId}" on this entity` }, { status: 404 });
  }

  const instrumentCount = await db.instrument.count({ where: { stakeholderId: params.stakeholderId } });
  if (instrumentCount > 0) {
    return NextResponse.json(
      { error: `Can't delete this stakeholder — they still hold ${instrumentCount} instrument(s). Remove those first.` },
      { status: 409 }
    );
  }

  try {
    await db.stakeholder.delete({ where: { id: params.stakeholderId } });
  } catch (err) {
    return NextResponse.json(
      { error: "Can't delete this stakeholder — an instrument may have just been added to them." },
      { status: 409 }
    );
  }

  return NextResponse.json({ deleted: true });
}
