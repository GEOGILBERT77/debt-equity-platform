/**
 * Pure, dependency-free logic behind entity-scoped access control — role ranking and
 * cookie parsing — pulled out from `authGuard.ts` the same way `basicAuthCredentials.ts`
 * is pulled out from `middleware.ts` and `closeService.ts` from `close/route.ts`: so it
 * can be unit-tested directly, without a database or either Next.js runtime involved.
 * `authGuard.ts` is the Prisma-touching layer built on top of this file's exports.
 */

export type EntityRoleName = "OWNER" | "EDITOR" | "VIEWER";

/** Higher rank = more privilege. OWNER can do everything EDITOR can plus grant/revoke
 * access; EDITOR can do everything VIEWER can plus write. See the `EntityRole` enum's
 * doc comment in prisma/schema.prisma for what each role means in practice. */
const ROLE_RANK: Record<EntityRoleName, number> = {
  VIEWER: 0,
  EDITOR: 1,
  OWNER: 2,
};

/** Is `actual` privileged enough to satisfy a check that requires at least `required`?
 * A route that requires EDITOR accepts an EDITOR or an OWNER, but not a VIEWER. */
export function hasRequiredRole(actual: EntityRoleName, required: EntityRoleName): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

/** Parses an HTTP `Cookie` header (`"a=1; b=2; c=3"`) and returns the value for `name`,
 * or `null` if absent. Values are URI-decoded (cookies are allowed to contain
 * percent-encoded characters); a malformed individual pair is skipped rather than
 * failing the whole parse, since one bad cookie set by something else on the same
 * domain shouldn't take down session lookup for this app's own cookie. */
export function parseCookieHeader(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex === -1) continue;
    const key = pair.slice(0, eqIndex).trim();
    if (key !== name) continue;
    const rawValue = pair.slice(eqIndex + 1).trim();
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return null;
}
