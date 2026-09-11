/**
 * Sign-in's client-side validation.
 *
 * A COURTESY, never the authority — the server re-validates everything
 * (`api/src/services/login.ts`), and a field error the server returns is
 * rendered even when this passed.
 *
 * Deliberately THINNER than registration's. This form checks that the driver
 * has typed something in each box and nothing more: it must NOT apply D23's
 * ten-character minimum. A policy governs a NEW credential; authentication
 * checks the one the driver already has, and an account created under an
 * older policy has to be able to sign in. A client that refused a short
 * password here would lock those drivers out before the request was even
 * sent — the server would have accepted it.
 */
import { utf8ByteLength } from "../auth/passwordPolicy";

export interface SignInFields {
  email: string;
  password: string;
}

type FieldName = keyof SignInFields;
export type SignInFieldErrors = Partial<Record<FieldName, string>>;

/** Matches the server's cap (CLAUDE.md: emails 320). */
const EMAIL_MAX = 320;

/**
 * bcrypt reads at most 72 bytes, so the server refuses a longer credential as
 * a malformed request. Checked here only so the driver is told without a
 * round trip — it is arithmetic, not policy.
 */
const PASSWORD_MAX_BYTES = 72;

/** Deliberately permissive. Rejecting unusual-but-real addresses is worse
 *  than letting the server have the final word on one. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateSignIn(fields: SignInFields): SignInFieldErrors {
  const errors: SignInFieldErrors = {};

  const email = fields.email.trim();
  if (email === "") errors.email = "Enter your email address";
  else if (email.length > EMAIL_MAX) errors.email = "That email address is too long";
  else if (!EMAIL_SHAPE.test(email)) errors.email = "Enter a valid email address";

  // NOT trimmed, and NOT length-checked against the registration minimum:
  // whitespace is part of a password, and the minimum governs new ones only.
  if (fields.password === "") errors.password = "Enter your password";
  else if (utf8ByteLength(fields.password) > PASSWORD_MAX_BYTES) {
    errors.password = "That password is too long — please check it";
  }

  return errors;
}
