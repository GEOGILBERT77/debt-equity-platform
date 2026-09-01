import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";
import { parsePagination, paginationMeta } from "@/lib/api/pagination";

/**
 * GET /api/entities/:id/stakeholders — list an entity's stakeholders (investors, debt
 * holders, employees, advisors). Requires at least VIEWER on the entity. Used by the
 * "new instrument" page to populate its stakeholder dropdown without a separate
 * client-side fetch — that page is a server component and queries this directly via
 * `db` (applying the same access check itself — see src/app/instruments/new/page.tsx),
 * this route exists for symmetry with POST and for any future client-side use.
 *
 * POST /api/entities/:id/stakeholders { "name", "type", "email"?, "phone"?, "address"? }
 * Requires at least EDITOR on the entity. `type` must be one of the StakeholderType
 * enum values (INVESTOR, DEBT_HOLDER, EMPLOYEE, ADVISOR, ENTITY_HOLDER) — see
 * prisma/schema.prisma. Validated against that list below before ever reaching
 * Postgres (see termsValidation.ts's doc comment for why this is a hand-rolled check
 * rather than a real schema library — same npm-registry constraint, same reasoning),
 * so an invalid `type` now gets a clean 400 naming the valid values instead of a raw
 * Postgres enum-constraint error.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
const VALID_STAKEHOLDER_TYPES = ["INVESTOR", "DEBT_HOLDER", "EMPLOYEE", "ADVISOR", "ENTITY_HOLDER"] as const;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireApiEntityAccess(req, params.id, "VIEWER");
  if (access instanceof NextResponse) return access;

  // PAGINATED as of v0.20.0 — see src/lib/api/pagination.ts and the matching note on
  // GET /api/instruments. src/app/instruments/new/page.tsx queries `db` directly for
  // its stakeholder dropdown (see this file's doc comment) rather than calling this
  // route, so an unpaginated dropdown isn't affected by this change.
  const pagination = parsePagination(req);
  const [stakeholders, totalCount] = await Promise.all([
    db.stakeholder.findMany({
      where: { entityId: params.id },
      orderBy: { name: "asc" },
      skip: pagination.skip,
      take: pagination.take,
    }),
    db.stakeholder.count({ where: { entityId: params.id } }),
  ]);
  return NextResponse.json({ stakeholders, pagination: paginationMeta(totalCount, pagination) });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireApiEntityAccess(req, params.id, "EDITOR");
  if (access instanceof NextResponse) return access;

  const body = await req.json().catch(() => ({}));
  const { name, type, email, phone, address } = body ?? {};

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (!type || !VALID_STAKEHOLDER_TYPES.includes(type)) {
    return NextResponse.json(
      { error: `type is required and must be one of: ${VALID_STAKEHOLDER_TYPES.join(", ")}` },
      { status: 400 }
    );
  }

  // requireApiEntityAccess above already confirms this entity exists (an
  // AccessDeniedError — 404 — is indistinguishable from "no such entity" from the
  // caller's side), so this second lookup is now purely about getting a row to attach
  // the stakeholder to; it can no longer be reached with a nonexistent entityId.
  const entity = await db.entity.findUnique({ where: { id: params.id } });
  if (!entity) {
    return NextResponse.json({ error: `No entity found with id "${params.id}"` }, { status: 404 });
  }

  const stakeholder = await db.stakeholder.create({
    data: {
      entityId: params.id,
      name: name.trim(),
      type,
      email: email || undefined,
      phone: phone || undefined,
      address: address || undefined,
    },
  });

  return NextResponse.json({ stakeholder }, { status: 201 });
}
