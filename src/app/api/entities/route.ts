import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireApiUser } from "@/lib/auth/apiGuard";

/**
 * GET /api/entities — list every entity the CALLER has access to (never every entity
 * in the database — see prisma/schema.prisma's note on User/EntityAccess: an Entity is
 * otherwise invisible to everyone, including its creator, precisely so this list can't
 * leak other tenants' entities). Not currently used by any server component (the home
 * page queries `db` directly, which is the normal Next.js App Router pattern, and now
 * applies the identical `access: { some: { userId } }` filter itself — see
 * src/app/page.tsx), but kept here for symmetry with POST and for anything client-side
 * that needs an entity list without a full page navigation.
 *
 * POST /api/entities { "name", "reportingCurrency"? }
 * Creates the top of the data model hierarchy (Entity -> Stakeholder -> Instrument)
 * AND the caller's OWNER EntityAccess row, in the SAME transaction — this is what
 * satisfies the schema's own requirement that no Entity ever exist without an
 * EntityAccess row. Before this route existed, the only way to add a new entity was
 * db/seed.sql or a direct SQL insert via Supabase's Table Editor — see the note this
 * route removes in src/app/page.tsx.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function GET(req: NextRequest) {
  const user = await requireApiUser(req);
  if (user instanceof NextResponse) return user;

  const entities = await db.entity.findMany({
    where: { access: { some: { userId: user.id } } },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ entities });
}

export async function POST(req: NextRequest) {
  const user = await requireApiUser(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const { name, reportingCurrency } = body ?? {};

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  // Any authenticated user may create a new entity — there is no invite/approval step
  // for this, by design: creating an entity is how a user (an accountant, a founder)
  // starts managing a *new* client or company, and they become its sole OWNER the
  // instant it exists. Being able to create an entity says nothing about being able to
  // see or touch any OTHER entity, which is exactly what the EntityAccess join and
  // requireEntityAccess enforce everywhere else.
  const entity = await db.$transaction(async (tx) => {
    const created = await tx.entity.create({
      data: { name: name.trim(), reportingCurrency: reportingCurrency || undefined },
    });
    await tx.entityAccess.create({
      data: { userId: user.id, entityId: created.id, role: "OWNER" },
    });
    return created;
  });

  return NextResponse.json({ entity }, { status: 201 });
}
