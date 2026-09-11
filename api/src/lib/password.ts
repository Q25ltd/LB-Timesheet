/**
 * The ONE place a password is validated, hashed or checked (D23).
 *
 * Narrow on purpose. bcrypt calls scattered across services drift in cost
 * factor, and a policy expressed at each call site drifts in every direction
 * at once. Everything about a password lives here: the rule, the byte cap,
 * the cost, and the two operations.
 *
 * Nothing in this module logs, and nothing returns the plaintext or the hash
 * to a caller that did not already have it.
 */
import { compare, hash } from "bcryptjs";
import { z } from "zod";

/**
 * D23, frozen. Length-led, with NO composition requirements: mandatory
 * uppercase/digit/symbol rules produce `Password1`, not entropy.
 */
const PASSWORD_MIN_CHARACTERS = 10;

/**
 * D23, frozen — and the reason this module exists rather than a `.min()` in a
 * DTO. **bcrypt reads at most 72 BYTES.** A longer password is not rejected
 * by bcrypt; it is silently truncated, so two different passwords sharing a
 * 72-byte prefix become the same credential. 72 UTF-8 bytes is as few as 18
 * accented characters or 18 emoji, so the cap CANNOT be expressed as a
 * character count — see `PasswordPolicy` below.
 */
const PASSWORD_MAX_BYTES = 72;

/**
 * Cost 12. Measured on Node 22.13 before adoption: ~230 ms to hash, ~231 ms
 * to verify (cost 10 ≈ 64 ms, cost 13 ≈ 469 ms). Do not lower this silently —
 * D23 requires measured evidence and an owner decision, not a quiet edit.
 *
 * Re-measure on the deployment target before public deployment: this figure
 * is from a developer machine, and pure-JS bcrypt on a smaller shared CPU
 * will be materially slower.
 */
const PASSWORD_BCRYPT_COST = 12;

/** What the UI is allowed to tell the driver. One rule, in their language. */
const PASSWORD_RULE_TEXT = `At least ${String(PASSWORD_MIN_CHARACTERS)} characters`;

/**
 * The password field, as every request schema must declare it.
 *
 * `.max(PASSWORD_MAX_BYTES)` on CHARACTERS is not the guarantee — it satisfies
 * check-rules' `zod-max` and cheaply bounds the input, but a character can be
 * four bytes, so the byte check below is what actually enforces D23. Both are
 * present deliberately; only the second one is load-bearing.
 *
 * Deliberately NOT `.trim()`, unlike every other user-visible string in this
 * codebase: trimming a password silently changes the driver's secret, so a
 * password chosen with a leading space would stop working the day the trim
 * was added. Whitespace is part of the credential.
 */
export const PasswordPolicy = z
  .string()
  .min(PASSWORD_MIN_CHARACTERS, PASSWORD_RULE_TEXT)
  .max(PASSWORD_MAX_BYTES)
  .refine(
    value => Buffer.byteLength(value, "utf8") <= PASSWORD_MAX_BYTES,
    { message: `Password must be at most ${String(PASSWORD_MAX_BYTES)} bytes` },
  );

/**
 * The password field as a LOGIN request must declare it.
 *
 * Deliberately NOT `PasswordPolicy`. A policy governs a NEW credential; a
 * login checks the credential the driver actually has. Enforcing today's
 * minimum here would lock every existing account out the day the minimum
 * changed, and would answer a short password `400` where every other
 * authentication failure is `401` — a difference an attacker can read.
 *
 * What survives is the part that is not policy but arithmetic: bcrypt reads
 * at most 72 BYTES, so a longer input cannot be anyone's stored credential
 * and is refused as a malformed request rather than hashed. The character
 * `.max()` alongside it satisfies check-rules' `zod-max` and cheaply bounds
 * a public endpoint; the byte check is the load-bearing one.
 *
 * Not `.trim()`ed, for the same reason `PasswordPolicy` is not: whitespace is
 * part of the credential, and trimming it at login would refuse a password
 * the driver legitimately chose.
 */
export const LoginPasswordField = z
  .string()
  .min(1)
  .max(PASSWORD_MAX_BYTES)
  .refine(
    value => Buffer.byteLength(value, "utf8") <= PASSWORD_MAX_BYTES,
    { message: `Password must be at most ${String(PASSWORD_MAX_BYTES)} bytes` },
  );

/**
 * A fixed, valid cost-12 bcrypt hash, used ONLY to make the unknown-email
 * path cost what the wrong-password path costs.
 *
 * Measured on Node 22.13 before adoption: bcrypt verification is ~230 ms and
 * returning early without one is ~0 ms. A login that skips the comparison
 * when no account exists therefore answers an unknown email roughly 230 ms
 * faster than a wrong password — an account-enumeration oracle that survives
 * a byte-identical response body. Verifying against this constant closes it.
 *
 * It is a CONSTANT, not a per-request hash: hashing on the fly would cost a
 * further ~230 ms and make the unknown-email path the SLOWER one, inverting
 * the oracle instead of removing it.
 *
 * The plaintext it was derived from was 32 random bytes, generated once and
 * discarded — it was never chosen, never stored and never known, so no input
 * can match this digest and no account can ever carry it.
 */
const UNKNOWN_ACCOUNT_HASH = "$2b$12$jj05ATzjNPB4aCy3Kv9UAeGIrqJLB..focy4KxX1866BVZxBP9ULq";

/** Hash a password for storage. The plaintext never leaves this call. */
export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, PASSWORD_BCRYPT_COST);
}

/**
 * Does this plaintext match the stored hash?
 *
 * FAIL-CLOSED on a malformed or unsupported stored hash, and that is not
 * defensive tidiness — it was measured. `bcryptjs.compare` returns `false`
 * for an empty string, a non-bcrypt string, a truncated hash and an argon2
 * hash, but THROWS on an unknown salt revision (`$2z$...`: "Invalid salt
 * revision"). An escaping throw reaches the global handler as
 * `500 { "error": "Something went wrong", "code": "INTERNAL" }`, which is a
 * DIFFERENT answer from the canonical 401 — so a single legacy or corrupted
 * row would turn this boundary into an oracle for "that account's stored
 * hash is broken". Catching it makes every stored-hash state answer alike.
 *
 * Nothing here logs. A log line at this point is a log line containing the
 * moment a specific account failed to authenticate, and the error text names
 * the stored hash's shape.
 */
export async function verifyPassword(plaintext: string, storedHash: string): Promise<boolean> {
  try {
    return await compare(plaintext, storedHash);
  } catch {
    // A hash this build cannot read is not a credential that matches.
    return false;
  }
}

/**
 * Spend the same verification work as a real account would, and match
 * nothing. The ONLY caller is login's unknown-email path.
 *
 * Returns `Promise<void>` rather than the `false` it always produces: a
 * boolean invites a caller to branch on it, and there is nothing to branch
 * on — the answer is already "no account".
 */
export async function verifyAgainstUnknownAccount(plaintext: string): Promise<void> {
  await verifyPassword(plaintext, UNKNOWN_ACCOUNT_HASH);
}
