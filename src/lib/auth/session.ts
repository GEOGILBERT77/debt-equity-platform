/**
 * Signed session tokens for the login cookie — an HMAC-SHA256-signed JSON payload
 * (`{ userId, expiresAt }`), verified without a database round trip on every request
 * (see `access.ts` and every route/page for where the identity this resolves to is
 * then actually checked against `EntityAccess`).
 *
 * WHY WEB CRYPTO (`crypto.subtle`), NOT `node:crypto`: `src/middleware.ts` runs on
 * Next.js's Edge runtime by default, where `node:crypto` (and `Buffer`) aren't
 * available — but `crypto.subtle` is, since it's a standard Web API, not a Node
 * built-in. Using it here means this exact module verifies a session identically in
 * middleware (Edge) and in API routes (Node.js runtime, where `crypto.subtle` is ALSO
 * available as of Node 19+) — one implementation, not two that could drift apart.
 * `passwordHashing.ts` is the opposite case: it only ever runs from API routes, so it
 * uses `node:crypto`'s scrypt, which Web Crypto has no equivalent for.
 *
 * This is a signed token, not an encrypted one — anyone holding the cookie can read
 * `userId`/`expiresAt` (they're just base64url, not secret), but cannot forge or alter
 * either field without knowing `SESSION_SECRET`, since the signature covers the exact
 * payload bytes. That's the right tradeoff here: nothing in the payload is sensitive on
 * its own, and forgery (not disclosure) is the threat this needs to stop.
 *
 * SESSION SECURITY HARDENING (v0.20.0) — two additions to the payload, addressing the
 * "session security hardening (idle timeout, concurrent-session limits, 'log out
 * everywhere')" item in the task-status spreadsheet:
 *
 *  - `sessionVersion`: copied from `User.sessionVersion` (prisma/schema.prisma) at
 *    login. `authGuard.ts`'s `resolveUserFromToken` already does a `db.user.findUnique`
 *    on every authenticated request (to confirm the account still exists) — comparing
 *    the token's `sessionVersion` against the CURRENT `User.sessionVersion` there is
 *    free (no new DB round trip) and gives real "log out everywhere" capability:
 *    bumping `User.sessionVersion` (see `POST /api/auth/logout-everywhere`)
 *    instantly invalidates every previously-issued token for that user, since none of
 *    them carry the new number. Deliberately NOT checked here in `session.ts` itself,
 *    and NOT checked in `middleware.ts` (which stays database-free by design, per the
 *    doc comment on that file) — this is the same "middleware is the fast first gate,
 *    not the only one" split this codebase already applies to per-entity access.
 *  - `issuedAt`: set once at login and carried unchanged through every sliding
 *    refresh (`refreshSessionToken` below) — the anchor an absolute session-lifetime
 *    cap is measured from, so a continuously-active session can't slide forever.
 *
 * IDLE TIMEOUT, specifically: `expiresAt` now SLIDES forward on activity —
 * `middleware.ts` calls `refreshSessionToken` on every successfully-verified request
 * and sets the reissued cookie, extending `expiresAt` by `IDLE_TIMEOUT_SECONDS` from
 * "now" — but never past `issuedAt + ABSOLUTE_MAX_SESSION_MS`. A session actually
 * expires (via the existing `Date.now() > payload.expiresAt` check below) only after
 * `IDLE_TIMEOUT_SECONDS` of NO requests, which is what "idle timeout" means; the
 * absolute cap is the backstop against a session sliding forever under continuous use.
 *
 * NOT ADDRESSED HERE: concurrent-session LIMITS (capping how many devices/sessions a
 * user may have active at once) — that needs a persisted list of live sessions to
 * count and evict from, a bigger, genuinely stateful change this token-based design
 * doesn't have a natural home for yet; left as its own future item rather than
 * half-built here.
 */

export interface SessionPayload {
  userId: string;
  expiresAt: number; // epoch milliseconds
  /** Defaults to 0 when verifying a token that predates this field — see
   * `verifySessionToken`'s leniency note below. */
  sessionVersion: number;
  /** Epoch milliseconds this session was originally created — unchanged by sliding
   * refreshes. Defaults to an estimate when verifying a token that predates this
   * field (see `verifySessionToken`) — a pre-v0.20.0 token has no real answer for
   * "when did this session start," so the estimate exists only so the absolute-cap
   * math below has SOME anchor, not to be treated as historically accurate. */
  issuedAt: number;
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

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return arr;
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days — also the idle-timeout window (IDLE_TIMEOUT_SECONDS below)
const IDLE_TIMEOUT_SECONDS = DEFAULT_TTL_SECONDS;
const ABSOLUTE_MAX_SESSION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days — hard cap regardless of activity

async function signPayload(payload: SessionPayload, secret: string): Promise<string> {
  const payloadB64 = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await getSigningKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
  return `${payloadB64}.${toBase64Url(signature)}`;
}

/** Builds `<base64url payload>.<base64url HMAC signature>` for a FRESH login (sets
 * `issuedAt` to now). `secret` is always passed explicitly (rather than read from
 * `process.env` inside this module) so this stays testable without environment-
 * variable setup, and so the one call site that DOES read `SESSION_SECRET` (see the
 * API routes / middleware) is the only place that can get that wrong.
 *
 * `sessionVersion` defaults to 0 (a brand-new `User` row's default — see
 * `prisma/schema.prisma`) so every pre-existing call site that doesn't pass it keeps
 * working unchanged; real call sites (the login route) pass the user's actual current
 * `sessionVersion`. */
export async function createSessionToken(
  userId: string,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
  sessionVersion: number = 0
): Promise<string> {
  const now = Date.now();
  const payload: SessionPayload = { userId, sessionVersion, issuedAt: now, expiresAt: now + ttlSeconds * 1000 };
  return signPayload(payload, secret);
}

/** Reissues a token for an ALREADY-verified payload, sliding `expiresAt` forward by
 * `IDLE_TIMEOUT_SECONDS` from now — but never past `issuedAt + ABSOLUTE_MAX_SESSION_MS`
 * — while carrying `userId`, `sessionVersion`, and the original `issuedAt` through
 * unchanged. `middleware.ts` calls this on every successfully-verified request; see
 * this file's module doc comment for the full idle-timeout design. Never called on an
 * unverified/tampered payload — the caller must have already run this through
 * `verifySessionToken` first. */
export async function refreshSessionToken(payload: SessionPayload, secret: string): Promise<string> {
  const now = Date.now();
  const absoluteCap = payload.issuedAt + ABSOLUTE_MAX_SESSION_MS;
  const refreshed: SessionPayload = {
    userId: payload.userId,
    sessionVersion: payload.sessionVersion,
    issuedAt: payload.issuedAt,
    expiresAt: Math.min(now + IDLE_TIMEOUT_SECONDS * 1000, absoluteCap),
  };
  return signPayload(refreshed, secret);
}

/** Verifies a token's signature and expiry, returning the payload if both hold or
 * `null` for anything else (bad shape, bad signature, expired, or unparseable JSON) —
 * deliberately one return type for every failure mode rather than throwing, since every
 * caller's response to "this session isn't valid" is identical (require login again)
 * regardless of which specific way it failed. */
export async function verifySessionToken(token: string, secret: string): Promise<SessionPayload | null> {
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) return null;
  const payloadB64 = token.slice(0, dotIndex);
  const signatureB64 = token.slice(dotIndex + 1);
  if (!payloadB64 || !signatureB64) return null;

  let signatureBytes: Uint8Array;
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
    const payload = JSON.parse(json) as Partial<SessionPayload>;
    if (typeof payload.userId !== "string" || typeof payload.expiresAt !== "number") return null;
    if (Date.now() > payload.expiresAt) return null;
    // Lenient on the two v0.20.0 additions — a token signed before this version had
    // neither field. sessionVersion 0 matches a fresh User row's default (so an old
    // token isn't spuriously treated as already-revoked); issuedAt is estimated
    // backward from expiresAt/DEFAULT_TTL_SECONDS purely so the absolute-cap math in
    // refreshSessionToken has SOME anchor — not a claim about when that session
    // actually started. This app has no real deployment yet (see DEPLOYMENT.md), so
    // there's no live legacy-token population this leniency is actually protecting;
    // it's here so a stale token from local testing doesn't need a fresh login.
    const sessionVersion = typeof payload.sessionVersion === "number" ? payload.sessionVersion : 0;
    const issuedAt =
      typeof payload.issuedAt === "number" ? payload.issuedAt : payload.expiresAt - DEFAULT_TTL_SECONDS * 1000;
    return { userId: payload.userId, expiresAt: payload.expiresAt, sessionVersion, issuedAt };
  } catch {
    return null;
  }
}

export const SESSION_COOKIE_NAME = "session";
