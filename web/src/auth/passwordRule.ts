/**
 * D23, for the form's benefit only — the API re-validates every password and
 * is the authority. At least 10 characters; at most 72 UTF-8 BYTES, because
 * bcrypt reads no further (a byte count, not a character count).
 */
export const PASSWORD_RULE = "At least 10 characters";

export function passwordProblem(password: string): string | null {
  if (password.length < 10) return PASSWORD_RULE;
  if (new TextEncoder().encode(password).length > 72) return "That password is too long";
  return null;
}
