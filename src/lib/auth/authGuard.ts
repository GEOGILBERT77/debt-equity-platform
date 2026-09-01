import { db } from "@/lib/db";
import { verifySessionToken, SESSION_COOKIE_NAME } from "./session";
import { hasRequiredRole, parseCookieHeader, EntityRoleName } from "./access";

/**
 * The Prisma-touching half of entity-scoped access control — built on the pure logic
 * in `access.ts` (role ranking, cookie parsing) and `session.ts` (token verification).
 * Split out the same way `closeService.ts` is split from `close/route.ts`: the pure
 * half is directly unit-testable in this sandbox (no database), this half needs a real
 * `@prisma/client` to run and so is NOT EXECUTED IN THIS SANDBOX — same caveat as every
 * other file under `src/app/` that imports `db`.
 *
 * `SESSION_SECRET` must be set for ANY session to verify — if it's unset,
 * `getCurrentUser` always returns `null` (never "logged in with an empty secret"),
 * matching the fail-closed posture the rest of this app's auth takes.
 */

export interface CurrentUser {
  id: string;
  email: string;
}

/** Shared by both public entry points below: verifies the session token's signature
 * and expiry (no DB hit for that part — see `session.ts`), then loads the user by id
 * to confirm the account still exists — a deleted user's old, still-unexpired session
 * token should stop working immediately, not linger until it naturally expires.
 *
 * ALSO enforces "log out everywhere" (v0.20.0): the token's `sessionVersion` must
 * match the CURRENT `User.sessionVersion` — a mismatch means this token was issued
 * before the user last revoked their other sessions (`POST
 * /api/auth/logout-everywhere`), so it's treated exactly like an expired token. This
 * check is free here (the `db.user.findUnique` below already runs for the
 * account-still-exists check) but deliberately does NOT live in `session.ts` itself
 * or in `middleware.ts` — see `session.ts`'s module doc comment for why.
 *
 * Returns `null` for anything short of a fully valid, live session — never throws,
 * since "not logged in" is a normal outcome every caller must handle, not an error. */
async function resolveUserFromToken(token: string | null): Promise<CurrentUser | null> {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !token) return null;

  const payload = await verifySessionToken(token, secret);
  if (!payload) return null;

  const user = await db.user.findUnique({ where: { id: payload.userId } });
  if (!user) return null;
  if (user.sessionVersion !== payload.sessionVersion) return null;

  return { id: user.id, email: user.email };
}

/** For API route handlers, which have the raw `Cookie` request header
 * (`req.headers.get("cookie")`) rather than a parsed cookie jar. */
export async function getCurrentUser(cookieHeader: string | null | undefined): Promise<CurrentUser | null> {
  return resolveUserFromToken(parseCookieHeader(cookieHeader, SESSION_COOKIE_NAME));
}

/** For server components, which get cookies pre-parsed via `next/headers`'s `cookies()`
 * rather than a raw header string — pass `cookies().get(SESSION_COOKIE_NAME)?.value`. */
export async function getCurrentUserFromToken(token: string | null | undefined): Promise<CurrentUser | null> {
  return resolveUserFromToken(token ?? null);
}

/** Thrown by `requireEntityAccess` when the user has no access to the entity at all,
 * OR has access below the required role. Deliberately ONE error for both cases —
 * every route catching this should respond with 404, not 403: telling an
 * unauthorized-but-authenticated user "this entity exists but you can't see it" (403)
 * confirms the entity ID is real, which is itself information this app shouldn't leak
 * to someone who has no relationship to it at all. A user who legitimately has VIEWER
 * access but attempted an EDITOR-only action gets the same 404 as a user with no
 * access whatsoever — indistinguishable from the outside, which is the point. */
export class AccessDeniedError extends Error {
  constructor(entityId: string) {
    super(`No access to entity "${entityId}" (or insufficient role).`);
    this.name = "AccessDeniedError";
  }
}

/** Throws `AccessDeniedError` unless `userId` has at least `minRole` on `entityId`;
 * otherwise resolves to their actual role (which may be higher than `minRole` — a
 * route that only needs to confirm VIEWER-or-above doesn't need to know whether the
 * caller is actually an OWNER, but a few call sites do care, e.g. deciding whether to
 * show the "grant access" UI). */
export async function requireEntityAccess(
  userId: string,
  entityId: string,
  minRole: EntityRoleName
): Promise<EntityRoleName> {
  const access = await db.entityAccess.findUnique({
    where: { userId_entityId: { userId, entityId } },
  });
  if (!access || !hasRequiredRole(access.role as EntityRoleName, minRole)) {
    throw new AccessDeniedError(entityId);
  }
  return access.role as EntityRoleName;
}
