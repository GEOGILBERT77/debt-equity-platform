import { randomBytes, createHash } from "node:crypto";

/**
 * Pure token generation/hashing for the stakeholder portal's one-time invite links —
 * pulled out the same way `access.ts` is pulled out of `authGuard.ts`: no database, no
 * Next.js import, directly unit-testable.
 *
 * `node:crypto` (not Web Crypto) is fine here — unlike `session.ts`, nothing in this
 * file needs to run in `src/middleware.ts`'s Edge runtime. Invite generation happens in
 * an admin-side API route (`POST /api/stakeholders/[id]/portal-invite`) and invite
 * acceptance happens in `POST /api/portal/accept-invite` — both are ordinary Next.js
 * API routes, which run on the Node.js runtime by default.
 *
 * WHY SHA-256, NOT SCRYPT: `passwordHashing.ts`'s scrypt is deliberately slow, to make
 * brute-forcing a small, human-chosen password space expensive. An invite token is the
 * opposite case — a 256-bit random value with no human-guessable structure at all — so
 * a slow KDF buys nothing (there's no small space to brute-force) and would just make
 * every invite-acceptance request slower for no security benefit. A fast cryptographic
 * hash is the standard, correct tool for "store a lookup-able fingerprint of a
 * high-entropy secret, not the secret itself" — see PortalInvite.tokenHash's doc
 * comment in prisma/schema.prisma for the at-rest-leak reasoning.
 */

const TOKEN_BYTES = 32; // 256 bits of entropy
export const PORTAL_INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

/** A random, URL-safe token — this is what actually goes in the invite link
 * (`/portal/accept-invite?token=...`) and is shown to the inviting admin exactly once.
 * Never stored anywhere in this form; see `hashInviteToken`. */
export function generateInviteToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** SHA-256 hex digest of a raw token — this, not the token itself, is what
 * `PortalInvite.tokenHash` stores. Deterministic (same token always hashes the same
 * way), which is exactly what a lookup-by-hash needs and is fine here precisely
 * because the input already has 256 bits of entropy — no salt is needed to defend
 * against a space this large. */
export function hashInviteToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/** Given a `PortalInvite` row (or `null`, meaning no row matched the hash at all),
 * returns whether it's still valid to accept right now — unexpired AND unused. Pure
 * function over plain data so it's testable without a database; the actual DB lookup
 * lives in the API route. */
export function isInviteStillValid(invite: { expiresAt: Date; usedAt: Date | null } | null, now: Date = new Date()): boolean {
  if (!invite) return false;
  if (invite.usedAt !== null) return false;
  return invite.expiresAt.getTime() > now.getTime();
}
