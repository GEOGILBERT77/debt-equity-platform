import test from "node:test";
import assert from "node:assert/strict";
import { createSessionToken, verifySessionToken } from "../src/lib/auth/session.js";

/**
 * Real Web Crypto (crypto.subtle) HMAC signing/verification — this environment's
 * Node (v22) supports it globally, the same API src/middleware.ts relies on being
 * available in the Edge runtime. No mocking: these tests exercise the actual signature
 * math.
 */

const SECRET = "test-secret-do-not-use-in-real-deployments";

test("createSessionToken / verifySessionToken: round-trips a valid, unexpired token", async () => {
  const token = await createSessionToken("user_123", SECRET);
  const payload = await verifySessionToken(token, SECRET);
  assert.ok(payload);
  assert.equal(payload!.userId, "user_123");
  assert.ok(payload!.expiresAt > Date.now());
});

test("verifySessionToken: rejects a token signed with a different secret", async () => {
  const token = await createSessionToken("user_123", SECRET);
  const payload = await verifySessionToken(token, "a-completely-different-secret");
  assert.equal(payload, null);
});

test("verifySessionToken: rejects a tampered payload even if the signature segment is untouched", async () => {
  const token = await createSessionToken("user_123", SECRET);
  const [payloadB64, sigB64] = token.split(".");
  // Flip the payload to claim a different user, keeping the original (now-mismatched)
  // signature — this must fail, not silently authenticate as the tampered userId.
  const tamperedPayloadB64 = payloadB64.slice(0, -1) + (payloadB64.slice(-1) === "A" ? "B" : "A");
  const tampered = `${tamperedPayloadB64}.${sigB64}`;
  const payload = await verifySessionToken(tampered, SECRET);
  assert.equal(payload, null);
});

test("verifySessionToken: rejects an expired token", async () => {
  const token = await createSessionToken("user_123", SECRET, -1); // already expired
  const payload = await verifySessionToken(token, SECRET);
  assert.equal(payload, null);
});

test("verifySessionToken: rejects malformed tokens without throwing", async () => {
  for (const bad of ["", "no-dot-in-here", ".", "a.", ".b", "a.b.c"]) {
    await assert.doesNotReject(async () => {
      const result = await verifySessionToken(bad, SECRET);
      assert.equal(result, null);
    });
  }
});

test("createSessionToken: two tokens for the same user carry independent expiries and are not byte-identical (fresh JSON serialization each call)", async () => {
  const tokenA = await createSessionToken("user_123", SECRET, 3600);
  await new Promise((r) => setTimeout(r, 5));
  const tokenB = await createSessionToken("user_123", SECRET, 7200);
  assert.notEqual(tokenA, tokenB);
  const payloadA = await verifySessionToken(tokenA, SECRET);
  const payloadB = await verifySessionToken(tokenB, SECRET);
  assert.ok(payloadB!.expiresAt > payloadA!.expiresAt);
});

test("verifySessionToken: rejects a payload missing required fields even with a valid signature over it", async () => {
  // Build a validly-signed token whose payload is missing `userId` — verifySessionToken
  // must not blindly trust "well-formed JSON, correctly signed" as "usable." Built by
  // hand (not via createSessionToken, which always includes userId) to exercise
  // exactly this malformed-but-signed case.
  const encoder = new TextEncoder();
  function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = "";
    for (const b of arr) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  const key = await crypto.subtle.importKey("raw", encoder.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const badPayloadB64 = toBase64Url(encoder.encode(JSON.stringify({ expiresAt: Date.now() + 100000 })));
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(badPayloadB64));
  const token = `${badPayloadB64}.${toBase64Url(sig)}`;
  const payload = await verifySessionToken(token, SECRET);
  assert.equal(payload, null);
});

// --- v0.20.0: sessionVersion ("log out everywhere") and sliding idle timeout --------

import { refreshSessionToken } from "../src/lib/auth/session.js";

test("createSessionToken: defaults sessionVersion to 0 when not passed", async () => {
  const token = await createSessionToken("user_123", SECRET);
  const payload = await verifySessionToken(token, SECRET);
  assert.equal(payload!.sessionVersion, 0);
});

test("createSessionToken: carries an explicit sessionVersion through to the verified payload", async () => {
  const token = await createSessionToken("user_123", SECRET, 3600, 7);
  const payload = await verifySessionToken(token, SECRET);
  assert.equal(payload!.sessionVersion, 7);
});

test("createSessionToken: sets issuedAt to (approximately) now", async () => {
  const before = Date.now();
  const token = await createSessionToken("user_123", SECRET);
  const payload = await verifySessionToken(token, SECRET);
  const after = Date.now();
  assert.ok(payload!.issuedAt >= before && payload!.issuedAt <= after);
});

test("verifySessionToken: a hand-crafted token missing sessionVersion/issuedAt defaults sessionVersion to 0 (not a security check, just shape leniency)", async () => {
  // Simulates a token signed before v0.20.0 — see session.ts's leniency comment for
  // why this defaults rather than rejects.
  const encoder = new TextEncoder();
  function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = "";
    for (const b of arr) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  const key = await crypto.subtle.importKey("raw", encoder.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const oldShapePayload = { userId: "user_123", expiresAt: Date.now() + 100000 };
  const payloadB64 = toBase64Url(encoder.encode(JSON.stringify(oldShapePayload)));
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
  const token = `${payloadB64}.${toBase64Url(sig)}`;
  const payload = await verifySessionToken(token, SECRET);
  assert.ok(payload);
  assert.equal(payload!.sessionVersion, 0);
  assert.ok(typeof payload!.issuedAt === "number");
});

test("refreshSessionToken: slides expiresAt forward while preserving userId, sessionVersion, and issuedAt", async () => {
  const original = await createSessionToken("user_123", SECRET, 60, 3); // expires in 60s
  const originalPayload = await verifySessionToken(original, SECRET);
  await new Promise((r) => setTimeout(r, 5));
  const refreshed = await refreshSessionToken(originalPayload!, SECRET);
  const refreshedPayload = await verifySessionToken(refreshed, SECRET);

  assert.ok(refreshedPayload);
  assert.equal(refreshedPayload!.userId, "user_123");
  assert.equal(refreshedPayload!.sessionVersion, 3);
  assert.equal(refreshedPayload!.issuedAt, originalPayload!.issuedAt); // unchanged
  assert.ok(refreshedPayload!.expiresAt > originalPayload!.expiresAt); // slid forward
});

test("refreshSessionToken: never slides expiresAt past issuedAt + the absolute session cap (30 days)", async () => {
  // Fabricate a payload whose issuedAt is far in the past — close to the absolute cap
  // — so refreshing it should clamp expiresAt at the cap rather than extending a full
  // fresh idle window past it.
  const almostAtCap: import("../src/lib/auth/session.js").SessionPayload = {
    userId: "user_123",
    sessionVersion: 0,
    issuedAt: Date.now() - 1000 * 60 * 60 * 24 * 29, // issued 29 days ago
    expiresAt: Date.now() + 1000, // arbitrary, about to be replaced
  };
  const refreshed = await refreshSessionToken(almostAtCap, SECRET);
  const refreshedPayload = await verifySessionToken(refreshed, SECRET);
  const absoluteCap = almostAtCap.issuedAt + 1000 * 60 * 60 * 24 * 30;
  assert.ok(refreshedPayload);
  assert.equal(refreshedPayload!.expiresAt, absoluteCap);
});

test("refreshSessionToken: a session issued well within the cap slides a full idle window forward, not clamped", async () => {
  const fresh: import("../src/lib/auth/session.js").SessionPayload = {
    userId: "user_123",
    sessionVersion: 0,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 1000,
  };
  const refreshed = await refreshSessionToken(fresh, SECRET);
  const refreshedPayload = await verifySessionToken(refreshed, SECRET);
  const sevenDaysMs = 1000 * 60 * 60 * 24 * 7;
  // Should land close to now + 7 days, nowhere near the 30-day cap.
  assert.ok(Math.abs(refreshedPayload!.expiresAt - (Date.now() + sevenDaysMs)) < 5000);
});
