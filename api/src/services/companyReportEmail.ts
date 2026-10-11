/**
 * A company's report address (D66): one address, set by an administrator,
 * confirmed through a single-use, expiring link bound to that exact address.
 * Reports are delivered only to a confirmed address.
 *
 * Setting it passes D54's company-web gate. Confirming is public: the token
 * in the link is the credential, and proves the mailbox is reachable.
 */
import { z } from "zod";
import { hashAccountToken, mintAccountToken } from "../lib/accountToken.js";
import { normaliseEmail } from "../lib/accountEmail.js";
import type { AuthContext } from "../lib/auth.js";
import { authorizeCompanyAdmin } from "../lib/authorization.js";
import { REPORT_EMAIL_LINK_LIFETIME_MS, reportAddressConfirmationEmail } from "../lib/companyEmails.js";
import { RecipientSuppressedError } from "../lib/emailDelivery.js";
import { AppError } from "../lib/errors.js";
import type { Mailer } from "../lib/mailer.js";
import type { ReportEmailRepository, ReportEmailView } from "../repositories/reportEmailRepository.js";
import { emailUndeliverable } from "./emailVerification.js";

/** One address, nothing else. */
export const ReportEmailBody = z.object({
  email: z.string().trim().min(3).max(320).email(),
}).strict();

export type ReportEmailInput = z.infer<typeof ReportEmailBody>;

/** The emailed token: 43 base64url characters; CLAUDE.md's 64 for a code. */
export const ConfirmReportEmailBody = z.object({
  token: z.string().min(1).max(64),
}).strict();

/** Confirmation emails one company may cause in any hour. */
const REQUESTS_PER_COMPANY_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

export interface ReportEmailMail {
  mailer: Mailer;
  /** The web origin links open — `WEB_APP_URL`. */
  webAppUrl: string;
  log: { error(details: object, message: string): void };
  /** Whether SES will not deliver to the address (D56). */
  isSuppressed: (email: string) => Promise<boolean>;
}

export function readReportEmail(auth: AuthContext, reports: ReportEmailRepository): Promise<ReportEmailView> {
  return reports.view(authorizeCompanyAdmin(auth));
}

/**
 * Set or change the address. Delivery of the link is AWAITED: the caller is
 * the company's administrator, and a failure is said to them honestly.
 */
export async function setReportEmail(
  auth: AuthContext,
  input: ReportEmailInput,
  reports: ReportEmailRepository,
  mail: ReportEmailMail,
  now: Date = new Date(),
): Promise<ReportEmailView> {
  const ctx = authorizeCompanyAdmin(auth);
  const email = normaliseEmail(input.email);

  const current = await reports.view(ctx);
  if (current.address === email && current.verified) return current;
  if (await mail.isSuppressed(email)) throw emailUndeliverable();
  if (await reports.requestsSince(ctx, new Date(now.getTime() - HOUR_MS)) >= REQUESTS_PER_COMPANY_PER_HOUR) {
    throw new AppError(429, "Too many requests, try again shortly", "RATE_LIMITED");
  }

  const token = mintAccountToken();
  const issued = await reports.request(ctx, {
    email,
    tokenHash: hashAccountToken(token),
    createdAt: now,
    expiresAt: new Date(now.getTime() + REPORT_EMAIL_LINK_LIFETIME_MS),
  });
  if (issued.kind === "already-verified") return reports.view(ctx);

  try {
    await mail.mailer.send(reportAddressConfirmationEmail({
      to:          email,
      companyName: issued.companyName,
      link:        `${mail.webAppUrl}/confirm-report-email#token=${token}`,
    }));
  } catch (error) {
    if (error instanceof RecipientSuppressedError) throw emailUndeliverable();
    mail.log.error({ err: error, task: "report-email-confirmation" }, "report address confirmation could not be sent");
    throw new AppError(503, "The email could not be sent. Try again shortly.", "EMAIL_UNAVAILABLE");
  }
  return { address: email, verified: false };
}

/** `POST /company/settings/report-email/confirm` — public; the token is the credential. */
export async function confirmReportEmail(token: string, reports: ReportEmailRepository, now: Date = new Date()): Promise<{ companyName: string }> {
  const confirmed = await reports.redeem(hashAccountToken(token), now);
  if (confirmed === null) throw new AppError(400, "This link is invalid or has expired", "TOKEN_INVALID");
  return confirmed;
}
