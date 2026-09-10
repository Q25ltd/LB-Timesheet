/**
 * The client's copy of the frozen password policy (D23).
 *
 * The SERVER is the authority — this exists so the driver is told before a
 * round trip, not so the rule lives in two places with two meanings. The
 * values below must match `api/src/lib/password.ts`; if they ever disagree,
 * the server wins and the driver sees a 400 the client failed to predict.
 *
 * What the driver is shown is deliberately ONE line. The reference mockup's
 * "a number / an uppercase letter / 8 characters" list was a visual
 * placeholder, superseded by D23 — composition rules produce `Password1`.
 */
const PASSWORD_MIN_CHARACTERS = 10;
const PASSWORD_MAX_BYTES = 72;

/** The only password guidance the UI shows up front. */
export const PASSWORD_RULE_TEXT = `At least ${String(PASSWORD_MIN_CHARACTERS)} characters`;

/**
 * UTF-8 byte length, which is NOT the string's length: an accented character
 * is two bytes and an emoji is four, so 72 bytes can be as few as 18
 * characters. Measured with TextEncoder because React Native has no Buffer.
 */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Why this password is unusable, or null. Mirrors the server's rule, and
 * deliberately does NOT mention bytes unless the input actually trips that
 * bound — "at most 72 bytes" is an implementation detail to a driver, and
 * showing it up front would be noise on every registration.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_CHARACTERS) return PASSWORD_RULE_TEXT;
  if (utf8ByteLength(password) > PASSWORD_MAX_BYTES) return "That password is too long — please choose a shorter one";
  return null;
}
