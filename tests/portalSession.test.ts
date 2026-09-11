import test from "node:test";
import assert from "node:assert/strict";
import { createPortalSessionToken, verifyPortalSessionToken } from "../src/lib/auth/portalSession.js";

/**
 * Same real-Web-Crypto, no-mocking approach as session.test.ts — this exercises the
 * actual HMAC signature math, just against portalSession.ts's separate payload shape
 * (`stakeholderUserId`, not `userId`) and cookie system.
 */

const SECRET = "test-secret-do-not-use-in-real-deployments";

test("createPortalSessionToken / verifyPortalSessionToken: round-trips a valid, unexpired token", async () => {
  const token = await createPortalSessionToken("stakeholderUser_123", SECRET);
  const payload = await verifyPortalSessionToken(token, SECRET);
  assert.ok(payload);
  assert.equal(payload!.stakeholderUserId, "stakeholderUser_123");
  assert.ok(payload!.expiresAt > Date.now());
});

test("verifyPortalSessionToken: rejects a token signed with a different secret", async () => {
  const token = await createPortalSessionToken("stakeholderUser_123", SECRET);
  const payload = await verifyPortalSessionToken(token, "a-completely-different-secret");
  assert.equal(payload, null);
});

test("verifyPortalSessionToken: rejects a tampered payload even if the signature segment is untouched", async () => {
  const token = await createPortalSessionToken("stakeholderUser_123", SECRET);
  const [payloadB64, sigB64] = token.split(".");
  const tamperedPayloadB64 = payloadB64.slice(0, -1) + (payloadB64.slice(-1) === "A" ? "B" : "A");
  const tampered = `${tamperedPayloadB64}.${sigB64}`;
  const payload = await verifyPortalSessionToken(tampered, SECRET);
  assert.equal(payload, null);
});

test("verifyPortalSessionToken: rejects an expired token", async () => {
  const token = await createPortalSessionToken("stakeholderUser_123", SECRET, -1);
  const payload = await verifyPortalSessionToken(token, SECRET);
  assert.equal(payload, null);
});

test("verifyPortalSessionToken: rejects a malformed token", async () => {
  assert.equal(await verifyPortalSessionToken("not-a-real-token", SECRET), null);
  assert.equal(await verifyPortalSessionToken("", SECRET), null);
  assert.equal(await verifyPortalSessionToken("abc.def", SECRET), null);
});

test("createPortalSessionToken: carries sessionVersion through for 'log out everywhere'", async () => {
  const token = await createPortalSessionToken("stakeholderUser_123", SECRET, undefined, 3);
  const payload = await verifyPortalSessionToken(token, SECRET);
  assert.equal(payload!.sessionVersion, 3);
});

test("an admin session token and a portal session token are never interchangeable formats by accident", async () => {
  // Both happen to produce "<base64url>.<base64url>" strings, so this isn't a format
  // check — it's confirming the payload SHAPES are different (stakeholderUserId vs
  // userId), which is what actually matters: portalAuthGuard.ts and authGuard.ts each
  // only ever call their own verify function against their own cookie, so there's no
  // code path where one token type could even be handed to the other's verifier.
  const portalToken = await createPortalSessionToken("stakeholderUser_123", SECRET);
  const payload = await verifyPortalSessionToken(portalToken, SECRET);
  assert.ok(payload);
  assert.ok(!("userId" in payload!));
});
