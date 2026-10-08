/**
 * Correcting an email address that cannot receive mail (D56).
 *
 *   POST /auth/email/correction   identity — the account's OWN address only
 *
 * Who may: the account itself, re-proving its password (a stolen access token
 * alone cannot repoint where reset links go). When: only when the address is
 * KNOWN to be a problem — SES suppressed it after a hard bounce or complaint —
 * or a company registration is still waiting for its confirmation link (a
 * mistyped address can never confirm, and may never bounce visibly). This is
 * a correction, not a general change of email.
 *
 * What happens, all or nothing: the new address (normalised, unique within the
 * account's KIND — a driver and a company account stay independent, D51)
 * replaces the old, the account becomes UNVERIFIED, and every outstanding
 * verification and reset link is invalidated. Then a fresh confirmation link
 * goes to the new address. Sessions are kept: the password was just proved.
 */
import { z } from "zod";
import { normaliseEmail } from "../lib/accountEmail.js";
import { deliveryProblem } from "../lib/emailDelivery.js";
import { AppError } from "../lib/errors.js";
import { LoginPasswordField, verifyPassword } from "../lib/password.js";
import type { AccountTokenRepository } from "../repositories/accountTokenRepository.js";
import type { EmailCorrectionRepository } from "../repositories/emailCorrectionRepository.js";
import type { EmailDeliveryRepository } from "../repositories/emailDeliveryRepository.js";
import type { IdentityRepository } from "../repositories/identityRepository.js";
import type { PasswordRepository } from "../repositories/passwordRepository.js";
import { emailUndeliverable, issueEmailVerification, type AccountMail } from "./emailVerification.js";
import { emailInUse } from "./registration.js";

export const CorrectEmailBody = z.object({
  email:           z.string().trim().min(1).max(320).email(),
  currentPassword: LoginPasswordField,
}).strict();
export type CorrectEmailInput = z.infer<typeof CorrectEmailBody>;

export interface EmailCorrectionDeps {
  accounts: IdentityRepository;
  passwords: PasswordRepository;
  delivery: EmailDeliveryRepository;
  corrections: EmailCorrectionRepository;
  tokens: AccountTokenRepository;
  mail: AccountMail;
}

function notAllowed(): AppError {
  return new AppError(403, "Not allowed", "FORBIDDEN");
}

export async function correctEmail(userId: string, input: CorrectEmailInput, deps: EmailCorrectionDeps): Promise<void> {
  const state = await deps.accounts.findAccountState(userId);
  const currentHash = await deps.passwords.currentHash(userId);
  if (state === null || currentHash === null) throw new AppError(401, "Not authenticated", "UNAUTHENTICATED");
  if (!await verifyPassword(input.currentPassword, currentHash)) throw notAllowed();

  const known = deliveryProblem(await deps.delivery.suppressionReasons(state.user.email));
  const registering = await deps.accounts.findPendingCompanyRegistration(userId);
  if (known === null && registering === null) throw notAllowed();

  const email = normaliseEmail(input.email);
  if (email === normaliseEmail(state.user.email)) throw new AppError(400, "That is already your email address", "VALIDATION");
  if ((await deps.delivery.suppressionReasons(email)).length > 0) throw emailUndeliverable();
  if (await deps.corrections.correct(userId, email) === "email-in-use") throw emailInUse();

  // The confirmation link for the NEW address. Awaited: the owner is here.
  const issued = await issueEmailVerification(
    { user: { ...state.user, email }, accountKind: state.accountKind, emailVerified: false },
    deps.tokens,
    deps.mail,
  );
  if (issued.kind !== "ready") return;
  try {
    await issued.deliver();
  } catch (error) {
    // The address IS corrected; only the email failed. The owner can send a
    // new link from the same page.
    deps.mail.log.error({ err: error, task: "email-correction" }, "the confirmation email for a corrected address could not be sent");
    throw new AppError(503, "Your email address was changed, but the email could not be sent. Send a new link shortly.", "EMAIL_UNAVAILABLE");
  }
}
