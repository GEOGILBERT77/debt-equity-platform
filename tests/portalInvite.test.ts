import test from "node:test";
import assert from "node:assert/strict";
import { generateInviteToken, hashInviteToken, isInviteStillValid } from "../src/lib/auth/portalInvite.js";

test("generateInviteToken: produces a high-entropy, URL-safe token", () => {
  const token = generateInviteToken();
  assert.ok(token.length >= 32);
  assert.match(token, /^[A-Za-z0-9_-]+$/); // base64url alphabet only
});

test("generateInviteToken: two calls never produce the same token", () => {
  const a = generateInviteToken();
  const b = generateInviteToken();
  assert.notEqual(a, b);
});

test("hashInviteToken: is deterministic (same input -> same hash, needed for lookup-by-hash)", () => {
  const token = generateInviteToken();
  assert.equal(hashInviteToken(token), hashInviteToken(token));
});

test("hashInviteToken: different tokens hash differently", () => {
  const a = generateInviteToken();
  const b = generateInviteToken();
  assert.notEqual(hashInviteToken(a), hashInviteToken(b));
});

test("hashInviteToken: returns a 64-char hex SHA-256 digest", () => {
  const hash = hashInviteToken("anything");
  assert.match(hash, /^[a-f0-9]{64}$/);
});

test("isInviteStillValid: null invite (no row matched the hash at all) is never valid", () => {
  assert.equal(isInviteStillValid(null), false);
});

test("isInviteStillValid: an unexpired, unused invite is valid", () => {
  const invite = { expiresAt: new Date(Date.now() + 1000 * 60 * 60), usedAt: null };
  assert.equal(isInviteStillValid(invite), true);
});

test("isInviteStillValid: an expired invite is invalid even if unused", () => {
  const invite = { expiresAt: new Date(Date.now() - 1000), usedAt: null };
  assert.equal(isInviteStillValid(invite), false);
});

test("isInviteStillValid: a used invite is invalid even if not yet expired (one-time use, not use-until-expiry)", () => {
  const invite = { expiresAt: new Date(Date.now() + 1000 * 60 * 60), usedAt: new Date() };
  assert.equal(isInviteStillValid(invite), false);
});

test("isInviteStillValid: respects an explicit 'now' for deterministic testing", () => {
  const invite = { expiresAt: new Date("2026-01-01T00:00:00Z"), usedAt: null };
  assert.equal(isInviteStillValid(invite, new Date("2025-12-31T00:00:00Z")), true);
  assert.equal(isInviteStillValid(invite, new Date("2026-01-02T00:00:00Z")), false);
});
