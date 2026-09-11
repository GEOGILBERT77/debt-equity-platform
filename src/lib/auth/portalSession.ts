/**
 * Signed session tokens for the stakeholder PORTAL login cookie — same HMAC-SHA256,
 * Web-Crypto-based signing as `session.ts`, but a deliberately SEPARATE module, cookie
 * name, and payload type rather than a reused `SessionPayload`/`SESSION_COOKIE_NAME`.
 *
 * WHY SEPARATE, NOT SHARED: `session.ts`'s payload carries a `userId` — every existing
 * caller (`authGuard.ts`, `middleware.ts`, every route that reads `CurrentUser`)
 * assumes that id resolves to a `User` row. The portal's principal is a
 * `StakeholderUser` row instead — a completely different identity system (see that
 * model's doc comment in prisma/schema.prisma for why it's not just `User` reused).
 * Keeping these as two independently-typed, independently-verified token systems with
 * two different cookie names (`session` vs `portal_session`) means a bug can never
 * cause one to be accepted as the other — there is no code path that even ATTEMPTS to
 * verify a `portal_session` cookie as an admin session or vice versa, so "a portal
 * login somehow grants admin access" isn't a mistake that's even possible to make here,
 * rather than one that's merely guarded against.
 *
 * DELIBERATELY SIMPLER THAN session.ts FOR v1: no sliding idle timeout, just a fixed
 * TTL from login. The admin session's idle-timeout/absolute-cap design (see
 * session.ts's module doc comment) is real, valuable hardening — but this is a v1,
 * VIEW-ONLY portal (no financial transactions, no writes at all yet — see this
 * feature's module doc comment on the Stakeholder model), so the fixed-TTL version is
 * a deliberate, stated scope reduction, not an oversight. Add sliding refresh here the
 * same way `middleware.ts` does for admin sessions if/when the portal grows a write
 * path worth the extra hardening.
 */

export interface PortalSessionPayload {
  stakeholderUserId: string;
  expiresAt: number; // epoch milliseconds
  /** Same "log out everywhere" mechanism as the admin session — see
   * StakeholderUser.sessionVersion's doc comment in prisma/schema.prisma. */
  sessionVersion: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function getSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return arr;
}

// A portal session lasts 30 days — longer than the admin session's 7-day idle window.
// Stakeholders check their holdings occasionally, not daily the way an admin working
// the platform does; a shorter TTL here would just mean more re-logins for no real
// security benefit, given this is a read-only surface with no write path yet.
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30;

async function signPayload(payload: PortalSessionPayload, secret: string): Promise<string> {
  const payloadB64 = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await getSigningKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
  return `${payloadB64}.${toBase64Url(signature)}`;
}

export async function createPortalSessionToken(
  stakeholderUserId: string,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
  sessionVersion: number = 0
): Promise<string> {
  const payload: PortalSessionPayload = {
    stakeholderUserId,
    sessionVersion,
    expiresAt: Date.now() + ttlSeconds * 1000,
  };
  return signPayload(payload, secret);
}

/** Verifies a token's signature and expiry, returning the payload if both hold, or
 * `null` for anything else — same one-return-type-for-every-failure-mode reasoning as
 * `session.ts`'s `verifySessionToken`. */
export async function verifyPortalSessionToken(token: string, secret: string): Promise<PortalSessionPayload | null> {
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) return null;
  const payloadB64 = token.slice(0, dotIndex);
  const signatureB64 = token.slice(dotIndex + 1);
  if (!payloadB64 || !signatureB64) return null;

  let signatureBytes: Uint8Array<ArrayBuffer>;
  try {
    signatureBytes = fromBase64Url(signatureB64);
  } catch {
    return null;
  }

  const key = await getSigningKey(secret);
  const valid = await crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(payloadB64));
  if (!valid) return null;

  try {
    const json = decoder.decode(fromBase64Url(payloadB64));
    const payload = JSON.parse(json) as Partial<PortalSessionPayload>;
    if (typeof payload.stakeholderUserId !== "string" || typeof payload.expiresAt !== "number") return null;
    if (Date.now() > payload.expiresAt) return null;
    const sessionVersion = typeof payload.sessionVersion === "number" ? payload.sessionVersion : 0;
    return { stakeholderUserId: payload.stakeholderUserId, expiresAt: payload.expiresAt, sessionVersion };
  } catch {
    return null;
  }
}

export const PORTAL_SESSION_COOKIE_NAME = "portal_session";
