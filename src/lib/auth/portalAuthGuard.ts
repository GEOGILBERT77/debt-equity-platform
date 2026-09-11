import { db } from "@/lib/db";
import { verifyPortalSessionToken, PORTAL_SESSION_COOKIE_NAME } from "./portalSession";
import { parseCookieHeader } from "./access";

/**
 * The Prisma-touching half of the stakeholder portal's access control — the exact same
 * split as `authGuard.ts` (pure token/cookie logic in `portalSession.ts`/`access.ts`,
 * database lookups here). See `StakeholderUser`'s doc comment in prisma/schema.prisma
 * for why this is a fully separate identity system from the admin side, not a
 * `Stakeholder`-flavored wrapper around `authGuard.ts`.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file that imports `db`.
 */

export interface CurrentPortalUser {
  id: string;
  email: string;
}

/** Mirrors `authGuard.ts`'s `resolveUserFromToken`: verifies the token, then confirms
 * the account still exists and the token's `sessionVersion` matches the CURRENT
 * `StakeholderUser.sessionVersion` (the portal's own independent "log out everywhere,"
 * unrelated to the admin side's). Returns `null` for anything short of a fully valid,
 * live session — never throws. */
async function resolvePortalUserFromToken(token: string | null): Promise<CurrentPortalUser | null> {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !token) return null;

  const payload = await verifyPortalSessionToken(token, secret);
  if (!payload) return null;

  const stakeholderUser = await db.stakeholderUser.findUnique({ where: { id: payload.stakeholderUserId } });
  if (!stakeholderUser) return null;
  if (stakeholderUser.sessionVersion !== payload.sessionVersion) return null;

  return { id: stakeholderUser.id, email: stakeholderUser.email };
}

/** For API route handlers — the raw `Cookie` request header. */
export async function getCurrentPortalUser(cookieHeader: string | null | undefined): Promise<CurrentPortalUser | null> {
  return resolvePortalUserFromToken(parseCookieHeader(cookieHeader, PORTAL_SESSION_COOKIE_NAME));
}

/** For server components — `cookies().get(PORTAL_SESSION_COOKIE_NAME)?.value`. */
export async function getCurrentPortalUserFromToken(token: string | null | undefined): Promise<CurrentPortalUser | null> {
  return resolvePortalUserFromToken(token ?? null);
}

/** Thrown by `requireStakeholderAccess` when the StakeholderUser has no
 * `StakeholderAccess` row for the given Stakeholder — i.e. this person was never
 * invited to (or never accepted an invite for) that specific stakeholder record. Every
 * caller responds with a 404/not-found, same "don't confirm the id even exists"
 * reasoning as `AccessDeniedError` on the admin side. */
export class PortalAccessDeniedError extends Error {
  constructor(stakeholderId: string) {
    super(`No portal access to stakeholder "${stakeholderId}".`);
    this.name = "PortalAccessDeniedError";
  }
}

export interface StakeholderAccessGrant {
  /** True when this specific access grant was marked "board observer" (v0.36.0) — see
   * `StakeholderAccess.boardObserver`'s doc comment in prisma/schema.prisma. A caller
   * that cares about the distinction (currently just
   * `src/app/portal/[stakeholderId]/page.tsx`) uses this to decide whether to also
   * render the entity's full cap table, in addition to this stakeholder's own
   * holdings — see that page's doc comment for why it's additive, not a replacement. */
  boardObserver: boolean;
}

/** Throws `PortalAccessDeniedError` unless `stakeholderUserId` has a granted
 * `StakeholderAccess` row for `stakeholderId`. There's no role/tier here (unlike
 * `requireEntityAccess`'s VIEWER/EDITOR/OWNER) — v1 of the portal is entirely
 * read-only, so access is simply granted or not; `boardObserver` on the returned grant
 * is the one exception, a single flag rather than a real tier (see its doc comment). */
export async function requireStakeholderAccess(stakeholderUserId: string, stakeholderId: string): Promise<StakeholderAccessGrant> {
  const access = await db.stakeholderAccess.findUnique({
    where: { stakeholderUserId_stakeholderId: { stakeholderUserId, stakeholderId } },
  });
  if (!access) {
    throw new PortalAccessDeniedError(stakeholderId);
  }
  return { boardObserver: access.boardObserver };
}

/** Every Stakeholder record this StakeholderUser can see, with enough of the parent
 * Entity to render a picker ("you have access to: Acme Inc, Beta Co — which one?") on
 * the portal's landing page when there's more than one. */
export async function listAccessibleStakeholders(stakeholderUserId: string) {
  const access = await db.stakeholderAccess.findMany({
    where: { stakeholderUserId },
    include: { stakeholder: { include: { entity: { select: { id: true, name: true } } } } },
    orderBy: { createdAt: "asc" },
  });
  return access.map((a) => a.stakeholder);
}
