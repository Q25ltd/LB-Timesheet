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
import { hash } from "bcryptjs";
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

/** Hash a password for storage. The plaintext never leaves this call. */
export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, PASSWORD_BCRYPT_COST);
}

// NOTE: there is deliberately no `verifyPassword` here yet. Login is the
// next increment, and a comparison function with no caller is code written
// and never imported (CLAUDE.md, "Register what you create"). It belongs in
// this module when the increment that calls it lands.
