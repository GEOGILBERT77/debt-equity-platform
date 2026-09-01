import test from "node:test";
import assert from "node:assert/strict";
import { hasRequiredRole, parseCookieHeader } from "../src/lib/auth/access.js";

test("hasRequiredRole: OWNER satisfies every requirement, VIEWER satisfies only VIEWER, EDITOR satisfies VIEWER and EDITOR but not OWNER", () => {
  assert.equal(hasRequiredRole("OWNER", "OWNER"), true);
  assert.equal(hasRequiredRole("OWNER", "EDITOR"), true);
  assert.equal(hasRequiredRole("OWNER", "VIEWER"), true);

  assert.equal(hasRequiredRole("EDITOR", "OWNER"), false);
  assert.equal(hasRequiredRole("EDITOR", "EDITOR"), true);
  assert.equal(hasRequiredRole("EDITOR", "VIEWER"), true);

  assert.equal(hasRequiredRole("VIEWER", "OWNER"), false);
  assert.equal(hasRequiredRole("VIEWER", "EDITOR"), false);
  assert.equal(hasRequiredRole("VIEWER", "VIEWER"), true);
});

test("parseCookieHeader: finds the named cookie among several, ignoring whitespace around pairs", () => {
  assert.equal(parseCookieHeader("session=abc123; theme=dark; other=xyz", "session"), "abc123");
  assert.equal(parseCookieHeader("session=abc123; theme=dark; other=xyz", "theme"), "dark");
  assert.equal(parseCookieHeader("  session=abc123 ;  theme=dark  ", "theme"), "dark");
});

test("parseCookieHeader: returns null for a missing cookie, an empty header, or a null/undefined header", () => {
  assert.equal(parseCookieHeader("theme=dark", "session"), null);
  assert.equal(parseCookieHeader("", "session"), null);
  assert.equal(parseCookieHeader(null, "session"), null);
  assert.equal(parseCookieHeader(undefined, "session"), null);
});

test("parseCookieHeader: URI-decodes the value", () => {
  assert.equal(parseCookieHeader("session=abc%3Bdef", "session"), "abc;def");
});

test("parseCookieHeader: a value containing '=' (as this app's own base64url session tokens can, unpadded so rarely but a general cookie value legitimately might) is captured whole, not truncated at the first '='", () => {
  assert.equal(parseCookieHeader("session=header.payload=withequals", "session"), "header.payload=withequals");
});
