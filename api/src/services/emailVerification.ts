/**
 * Email-ownership verification (owner decision B4, 2026-10-01).
 *
 * Proving an address is a property of the ACCOUNT. It does not gate login —
 * an unverified account authenticates exactly as before, on the phone and in
 * the browser — and it is what company creation requires, because a company
 * must not gain authority over an account merely because that account claimed
 * an address (D24).
 *
 *   request  identity-authenticated: (re)send to MY address. There is no
 *            "send to this email" form, so this cannot be pointed at someone
 *            else's mailbox and says nothing about whether other accounts
 *            exist.
 *   confirm  public: the emailed TOKEN is the credential. Every refusal —
 *            unknown, tampered, superseded, used, expired — is one identical
 *            400, so the endpoint cannot be probed for which.
 */
import { RecipientSuppressedError } from "../lib/emailDelivery.js";
import { z } from "zod";
import { ACCOUNT_TOKEN_LIFETIME_MS, hashAccountToken, mintAccountToken } from "../lib/accountToken.js";
import { verificationEmail } from "../lib/authEmails.js";
import { AppError } from "../lib/errors.js";
import type { BackgroundLog } from "../lib/backgroundWork.js";
import type { Mailer } from "../lib/mailer.js";
import type { SendThrottle } from "../lib/sendThrottle.js";
import type { AccountTokenPurpose } from "../generated/enums.js";
import type { AccountTokenRepository, EmailVerificationRedemption } from "../repositories/accountTokenRepository.js";
import type { AccountState, IdentityRepository } from "../repositories/identityRepository.js";

/**
 * Exactly one field. A token is 43 base64url characters; the cap is
 * CLAUDE.md's 64 for a code or reference.
 */
export const ConfirmEmailBody = z.object({
  token: z.string().min(1).max(64),
}).strict();

export type ConfirmEmailInput = z.infer<typeof ConfirmEmailBody>;

/** Where the emailed link points, and how a message leaves. */
export interface AccountMail {
  mailer: Mailer;
  /** The web origin links open — `WEB_APP_URL`, validated against the allowlist. */
  webAppUrl: string;
  /** Where a failed delivery is recorded; it is never swallowed. */
  log: BackgroundLog;
  /** B6: at most 3 emails of each purpose per address per hour. */
  throttles: Record<AccountTokenPurpose, SendThrottle>;
}

/** What issuing produced: nothing to do, too many already, or a message ready to go. */
export type VerificationIssue =
  | { kind: "already-verified" }
  | { kind: "throttled" }
  | { kind: "ready"; deliver: () => Promise<void> };

function rateLimited(): AppError {
  return new AppError(429, "Too many requests, try again shortly", "RATE_LIMITED");
}

/**
 * Issue a verification token for this account and return the message that
 * carries it, or null when the account is already verified. The caller
 * decides whether delivery is awaited or runs after the reply.
 *
 * The token travels in the link's FRAGMENT (`#token=`), which a browser never
 * sends to a server: it cannot land in the web host's access logs or in a
 * `Referer`. The web page reads it and posts it to `confirm`.
 */
export async function issueEmailVerification(
  state: AccountState,
  tokens: AccountTokenRepository,
  mail: AccountMail,
): Promise<VerificationIssue> {
  if (state.emailVerified) return { kind: "already-verified" };
  // Counted before a token is minted, so a throttled request changes nothing:
  // the token already in the person's inbox stays the valid one.
  if (!mail.throttles.email_verification.allow(state.user.email)) return { kind: "throttled" };

  const token = mintAccountToken();
  const issuedAt = new Date();
  await tokens.issue({
    userId:    state.user.id,
    purpose:   "email_verification",
    tokenHash: hashAccountToken(token),
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + ACCOUNT_TOKEN_LIFETIME_MS.email_verification),
  });

  const message = verificationEmail({
    userId:    state.user.id,
    to:        state.user.email,
    firstName: state.user.firstName,
    link:      `${mail.webAppUrl}/verify-email#token=${token}`,
  });
  return { kind: "ready", deliver: async () => { await mail.mailer.send(message); } };
}

/**
 * The account's own address is suppressed after a hard bounce or complaint
 * (D56). Said to the owner only — never on a public route.
 */
export function emailUndeliverable(): AppError {
  return new AppError(409, "Email cannot be delivered to this address. Correct your email address.", "EMAIL_UNDELIVERABLE");
}

/**
 * `POST /auth/email-verification` — identity posture. Delivery is AWAITED:
 * the caller is the account owner, so there is nothing to hide, and a failure
 * is reported to them honestly rather than swallowed.
 */
export async function requestEmailVerification(
  userId: string,
  accounts: IdentityRepository,
  tokens: AccountTokenRepository,
  mail: AccountMail,
): Promise<void> {
  const state = await accounts.findAccountState(userId);
  if (state === null) throw new AppError(401, "Not authenticated", "UNAUTHENTICATED");

  const issued = await issueEmailVerification(state, tokens, mail);
  if (issued.kind === "already-verified") return;
  // The caller is the account's owner, so the throttle may say so honestly.
  if (issued.kind === "throttled") throw rateLimited();

  try {
    await issued.deliver();
  } catch (error) {
    // The address is known not to receive mail (D56): asking again cannot
    // help, so the owner is told to correct it rather than to wait.
    if (error instanceof RecipientSuppressedError) throw emailUndeliverable();
    // The provider's error goes to the server log; the account owner is told
    // only that it did not go, and may ask again (the new token supersedes).
    mail.log.error({ err: error, task: "email-verification" }, "verification email could not be sent");
    throw new AppError(503, "The email could not be sent. Try again shortly.", "EMAIL_UNAVAILABLE");
  }
}

/**
 * `POST /auth/email-verification/confirm` — public; the token is the
 * credential. For a company registration, confirming completes it (D51): the
 * answer says so, and says nothing else — no company name, no account.
 */
export async function confirmEmail(input: ConfirmEmailInput, tokens: AccountTokenRepository): Promise<EmailVerificationRedemption> {
  const redeemed = await tokens.redeemEmailVerification(hashAccountToken(input.token), new Date());
  if (redeemed === null) throw new AppError(400, "This link is invalid or has expired", "TOKEN_INVALID");
  return redeemed;
}
