/**
 * Registration's client-side validation.
 *
 * Separated from the screen so it can be reasoned about and tested as rules
 * rather than as rendering. It is a COURTESY, never the authority: the server
 * re-validates everything (`api/src/services/registration.ts`), and a field
 * error the server returns is rendered even when this passed.
 */
import { passwordProblem } from "../auth/passwordPolicy";

/**
 * The form's fields — NOT the request body.
 *
 * `confirmPassword` exists only here. It is a typing check for the driver,
 * never a field the API accepts: the registration DTO is exactly four fields
 * and is `.strict()`, so sending a fifth is refused (D21). The screen builds
 * the request explicitly from four values rather than spreading this object,
 * and a test asserts the body that actually goes over the wire.
 */
export interface RegisterFields {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  confirmPassword: string;
}

type FieldName = keyof RegisterFields;
export type FieldErrors = Partial<Record<FieldName, string>>;

/** Matches the server's cap (CLAUDE.md: names 200, emails 320). */
const NAME_MAX = 200;
const EMAIL_MAX = 320;

/** Deliberately permissive. Rejecting unusual-but-real addresses is worse
 *  than letting the server have the final word on one. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateRegistration(fields: RegisterFields): FieldErrors {
  const errors: FieldErrors = {};

  if (fields.firstName.trim() === "") errors.firstName = "Enter your first name";
  else if (fields.firstName.trim().length > NAME_MAX) errors.firstName = "That first name is too long";

  if (fields.lastName.trim() === "") errors.lastName = "Enter your last name";
  else if (fields.lastName.trim().length > NAME_MAX) errors.lastName = "That last name is too long";

  const email = fields.email.trim();
  if (email === "") errors.email = "Enter your email address";
  else if (email.length > EMAIL_MAX) errors.email = "That email address is too long";
  else if (!EMAIL_SHAPE.test(email)) errors.email = "Enter a valid email address";

  // NOT trimmed: whitespace is part of a password, and silently trimming it
  // would change the driver's secret between the phone and the server.
  const password = passwordProblem(fields.password);
  if (password !== null) errors.password = password;

  // Only worth asking about once the password itself is usable — telling a
  // driver their confirmation does not match a password that is too short
  // gives them two problems to read and one to fix.
  if (password === null) {
    if (fields.confirmPassword === "") errors.confirmPassword = "Re-enter your password";
    // Compared exactly, for the same reason neither side is trimmed.
    else if (fields.confirmPassword !== fields.password) errors.confirmPassword = "Passwords do not match";
  }

  return errors;
}

/** Map the server's `details` paths onto the same field slots. */
export function fieldErrorsFromServer(details: { path: string; message: string }[] | undefined): FieldErrors {
  const errors: FieldErrors = {};
  if (details === undefined) return errors;
  const known: FieldName[] = ["firstName", "lastName", "email", "password"];
  for (const detail of details) {
    const field = known.find(name => name === detail.path);
    if (field !== undefined && errors[field] === undefined) errors[field] = detail.message;
  }
  return errors;
}
