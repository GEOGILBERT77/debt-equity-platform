import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/lib/auth/passwordHashing.js";

/**
 * Real scrypt-based hashing via node:crypto (no npm package — see that file's doc
 * comment). These tests run the actual KDF, not a mock, so they exercise the same code
 * path production would.
 */

test("hashPassword: produces the documented scrypt:<saltHex>:<hashHex> format with non-trivial salt and hash lengths", async () => {
  const hash = await hashPassword("correct horse battery staple");
  const parts = hash.split(":");
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "scrypt");
  assert.equal(parts[1].length, 32); // 16 bytes -> 32 hex chars
  assert.equal(parts[2].length, 128); // 64 bytes -> 128 hex chars
});

test("hashPassword: two hashes of the same password are different (random salt per call)", async () => {
  const a = await hashPassword("same password");
  const b = await hashPassword("same password");
  assert.notEqual(a, b);
});

test("verifyPassword: accepts the correct password and rejects an incorrect one", async () => {
  const hash = await hashPassword("s3cur3-p@ssphrase");
  assert.equal(await verifyPassword("s3cur3-p@ssphrase", hash), true);
  assert.equal(await verifyPassword("wrong-password", hash), false);
  assert.equal(await verifyPassword("", hash), false);
});

test("verifyPassword: is case-sensitive and whitespace-sensitive", async () => {
  const hash = await hashPassword("CaseSensitive123");
  assert.equal(await verifyPassword("casesensitive123", hash), false);
  assert.equal(await verifyPassword("CaseSensitive123 ", hash), false);
});

test("verifyPassword: rejects malformed or unrecognized stored hashes without throwing", async () => {
  await assert.doesNotReject(async () => {
    assert.equal(await verifyPassword("anything", "not-the-right-format"), false);
    assert.equal(await verifyPassword("anything", "bcrypt:abc:def"), false); // right shape, wrong scheme tag
    assert.equal(await verifyPassword("anything", "scrypt:not-hex:also-not-hex"), false);
    assert.equal(await verifyPassword("anything", ""), false);
    assert.equal(await verifyPassword("anything", "scrypt::"), false);
  });
});

test("verifyPassword: a hash produced for one password never verifies against a different password's hash, even at the same length", async () => {
  const hashA = await hashPassword("passwordA");
  const hashB = await hashPassword("passwordB");
  assert.equal(await verifyPassword("passwordA", hashB), false);
  assert.equal(await verifyPassword("passwordB", hashA), false);
});
