import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/passwordHashing";
import { getCurrentUser, requireEntityAccess, AccessDeniedError } from "@/lib/auth/authGuard";
import { EntityRoleName } from "@/lib/auth/access";

const VALID_ROLES: EntityRoleName[] = ["OWNER", "EDITOR", "VIEWER"];

/**
 * POST /api/auth/users { "email", "password", "grantEntityId"?, "grantRole"? }
 *
 * Creates a new user account — this app's only way to add people beyond the bootstrap
 * user in db/seed.sql, since there's deliberately no public self-registration on a
 * financial app (anyone finding the URL and signing themselves up would defeat the
 * entire point of multi-tenancy). Creating a bare account with no entity access is
 * allowed (omit grantEntityId/grantRole) for a "set up the login first, grant access
 * later" flow, but the far more common case is both together in one call.
 *
 * REQUIRES THE CALLER TO BE LOGGED IN. If `grantEntityId` is supplied, the caller must
 * additionally be an OWNER of that specific entity (`requireEntityAccess`,
 * AccessDeniedError -> 404, per that error's own doc comment on why 404 and not 403) —
 * an EDITOR or VIEWER cannot invite anyone, by design (see the EntityRole enum's doc
 * comment in prisma/schema.prisma). This is intentionally the ONE place in this file
 * where a user needs no entity access at all to call it (there is no entity in play
 * yet if grantEntityId is omitted) — every other route in src/app/api requires it from
 * the first line.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser(req.headers.get("cookie"));
  if (!currentUser) {
    return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { email, password, grantEntityId, grantRole } = body ?? {};

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    return NextResponse.json({ error: "password is required and must be at least 8 characters." }, { status: 400 });
  }
  if (grantEntityId !== undefined && (grantRole === undefined || !VALID_ROLES.includes(grantRole))) {
    return NextResponse.json(
      { error: `grantRole is required when grantEntityId is set, and must be one of: ${VALID_ROLES.join(", ")}` },
      { status: 400 }
    );
  }

  if (grantEntityId) {
    try {
      await requireEntityAccess(currentUser.id, grantEntityId, "OWNER");
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        return NextResponse.json({ error: `No entity found with id "${grantEntityId}"` }, { status: 404 });
      }
      throw err;
    }
  }

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await db.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    return NextResponse.json({ error: "A user with this email already exists." }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);

  const user = await db.$transaction(async (tx) => {
    const created = await tx.user.create({ data: { email: normalizedEmail, passwordHash } });
    if (grantEntityId) {
      await tx.entityAccess.create({
        data: { userId: created.id, entityId: grantEntityId, role: grantRole as EntityRoleName },
      });
    }
    return created;
  });

  return NextResponse.json({ user: { id: user.id, email: user.email } }, { status: 201 });
}
