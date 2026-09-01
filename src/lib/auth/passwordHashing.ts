import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

/**
 * Real password hashing via scrypt (RFC 7914), using ONLY Node's built-in `node:crypto`
 * module — no npm package required, unlike bcrypt/argon2, which is exactly why scrypt
 * was chosen here: this sandbox has no outbound npm registry access (same constraint
 * documented in `decimal.ts` and `termsValidation.ts`), but `node:crypto` ships with
 * Node itself and needs no install. This is NOT a stand-in the way those two files are
 * — scrypt via `node:crypto` is a genuine, secure, industry-standard choice on its own
 * merits, not a placeholder for something better once npm access exists.
 *
 * RUNTIME NOTE: `node:crypto` is only available in the Node.js runtime, not the Edge
 * runtime — so this module must only ever be imported from API routes (which run on
 * Node.js by default in the Next.js App Router), never from `src/middleware.ts` (Edge
 * by default). Session token verification, which DOES need to run in middleware, uses
 * Web Crypto (`crypto.subtle`) instead — see `session.ts` — specifically because that
 * API is available in both runtimes.
 *
 * Stored format: `scrypt:<saltHex>:<hashHex>`. The scheme tag makes the format
 * self-describing (a future migration to a different KDF doesn't have to guess what an
 * existing hash was made with), and the salt travels alongside the hash in the same
 * column rather than a separate one, since the two are never used independently.
 */

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `scrypt:${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

/** Verifies `password` against a hash produced by `hashPassword`. Uses
 * `timingSafeEqual` for the final comparison (constant-time regardless of how many
 * leading bytes match) — the same reasoning as `basicAuthCredentials.ts`'s
 * `timingSafeEqualString`, just operating on raw bytes here since `node:crypto` is
 * available. Returns `false` (never throws) for any malformed stored hash — a
 * corrupted or unrecognized hash should behave exactly like a wrong password, not leak
 * information via a different error path. */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, saltHex, hashHex] = parts;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
