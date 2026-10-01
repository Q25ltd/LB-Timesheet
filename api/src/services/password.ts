/**
 * Password recovery and change (owner decision B7, 2026-10-01).
 *
 *   forgot  public: answers the SAME, at the same speed, whether or not the
 *           address has an account. The lookup, the token and the email all
 *           run after the reply, so neither the body nor a stopwatch tells
 *           the caller anything. Nobody is told whether a user belongs to any
 *           company — the flow never reads a membership.
 *   reset   public: the emailed token is the credential. The new password
 *           meets the canonical policy (D23). One transaction consumes the
 *           token, replaces the hash and revokes EVERY session.
 *   change  identity: the authenticated account, its current password, the
 *           canonical policy; every OTHER session revoked, this one kept.
 *
 * There is no input naming another account anywhere here. A company — admin
 * or not — has no route to a user's global credential.
 */
import { z } from "zod";
import { ACCOUNT_TOKEN_LIFETIME_MS, hashAccountToken, mintAccountToken } from "../lib/accountToken.js";
import { normaliseEmail } from "../lib/accountEmail.js";
import { passwordResetEmail } from "../lib/authEmails.js";
import type { BackgroundWork } from "../lib/backgroundWork.js";
import { AppError } from "../lib/errors.js";
import { hashPassword, LoginPasswordField, PasswordPolicy, verifyPassword } from "../lib/password.js";
import type { AccountTokenRepository } from "../repositories/accountTokenRepository.js";
import type { IdentityRepository } from "../repositories/identityRepository.js";
import type { PasswordRepository } from "../repositories/passwordRepository.js";
import type { AccountMail } from "./emailVerification.js";

/** Validated as login and registration validate an address. */
export const ForgotPasswordBody = z.object({
  email: z.string().trim().min(1).max(320).email(),
}).strict();

/** The token (43 base64url characters, capped at 64) and a NEW password under D23. */
export const ResetPasswordBody = z.object({
  token:    z.string().min(1).max(64),
  password: PasswordPolicy,
}).strict();

/**
 * `currentPassword` is checked as a login checks one — an account created
 * under an older policy must still be able to prove itself — and
 * `newPassword` is held to the policy for new credentials (D23).
 */
export const ChangePasswordBody = z.object({
  currentPassword: LoginPasswordField,
  newPassword:     PasswordPolicy,
}).strict();

export type ForgotPasswordInput = z.infer<typeof ForgotPasswordBody>;
export type ResetPasswordInput = z.infer<typeof ResetPasswordBody>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordBody>;

function tokenInvalid(): AppError {
  return new AppError(400, "This link is invalid or has expired", "TOKEN_INVALID");
}

/**
 * Schedule the reset email and return at once. Everything that differs
 * between "account" and "no account" happens inside the background task.
 */
export function forgotPassword(
  input: ForgotPasswordInput,
  accounts: IdentityRepository,
  tokens: AccountTokenRepository,
  mail: AccountMail,
  work: BackgroundWork,
): void {
  const email = normaliseEmail(input.email);
  work.run("password-reset", async () => {
    // B6, counted per request for the ADDRESS — before the lookup, so an
    // address with no account is counted exactly like one with an account.
    if (!mail.throttles.password_reset.allow(email)) return;
    const user = await accounts.findByEmail("driver", email);
    if (user === null) return;

    const token = mintAccountToken();
    const issuedAt = new Date();
    await tokens.issue({
      userId:    user.id,
      purpose:   "password_reset",
      tokenHash: hashAccountToken(token),
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + ACCOUNT_TOKEN_LIFETIME_MS.password_reset),
    });
    await mail.mailer.send(passwordResetEmail({
      to:        user.email,
      firstName: user.firstName,
      link:      `${mail.webAppUrl}/reset-password#token=${token}`,
    }));
  });
}

export async function resetPassword(input: ResetPasswordInput, passwords: PasswordRepository): Promise<void> {
  const tokenHash = hashAccountToken(input.token);
  const now = new Date();

  // Refused BEFORE hashing, so an attacker's junk token buys no bcrypt work.
  const userId = await passwords.liveResetTokenOwner(tokenHash, now);
  if (userId === null) throw tokenInvalid();

  const passwordHash = await hashPassword(input.password);
  const redeemed = await passwords.redeemReset({ tokenHash, userId, passwordHash, now: new Date() });
  if (!redeemed) throw tokenInvalid();
}

export async function changePassword(
  input: ChangePasswordInput,
  identity: { userId: string; sessionId: string },
  passwords: PasswordRepository,
): Promise<void> {
  const current = await passwords.currentHash(identity.userId);
  if (current === null) throw new AppError(401, "Not authenticated", "UNAUTHENTICATED");

  // D17's generic refusal: the session is fine, the request is not allowed.
  if (!await verifyPassword(input.currentPassword, current)) throw new AppError(403, "Not allowed", "FORBIDDEN");

  await passwords.changePassword({
    userId:        identity.userId,
    keepSessionId: identity.sessionId,
    passwordHash:  await hashPassword(input.newPassword),
    now:           new Date(),
  });
}
