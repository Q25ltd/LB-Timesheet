/**
 * The driver invitation email (D63) — fixed wording, owner-confirmed.
 *
 * A company is anyone who registered one, and its name is free text it chose,
 * so the name is the only thing a company puts in this email and it appears
 * ONLY as escaped plain text. The one link is the product's own website. The
 * email carries no token and accepts nothing: a driver accepts in the app,
 * signed in with a VERIFIED email address (D24). It is not an account's email
 * (`userId: null`); the invitation records its own send.
 */
import { escapeHtml } from "./authEmails.js";
import type { MailMessage } from "./mailer.js";

export interface InvitationEmailInput {
  to: string;
  companyName: string;
  firstName: string;
  expiresAt: Date;
  /** The website's address (WEB_APP_URL) — the email's one link. */
  websiteUrl: string;
}

/** "10 November 2026" — the day the invitation lapses, in words, in UTC. */
function dayOf(at: Date): string {
  return at.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export function driverInvitationEmail(input: InvitationEmailInput): MailMessage {
  const until = dayOf(input.expiresAt);
  const lines = {
    added:  `${input.companyName} has added you as a driver in LogisticBay Timesheets, the app for daily timesheets and vehicle checks.`,
    accept: `To accept, install the LogisticBay Timesheets app and sign in — or register — with this email address (${input.to}), then confirm the address when the app asks. The invitation will be waiting there until ${until}.`,
    ignore: `If you do not drive for ${input.companyName}, ignore this email: nothing happens unless you accept in the app.`,
  };
  return {
    sender: "accounts",
    userId: null,
    to: input.to,
    subject: "You have been added as a driver — LogisticBay Timesheets",
    text: [
      `Hello ${input.firstName},`,
      "",
      lines.added,
      "",
      lines.accept,
      "",
      `About LogisticBay Timesheets: ${input.websiteUrl}`,
      "",
      lines.ignore,
      "",
      "LogisticBay Timesheets",
    ].join("\n"),
    html: [
      `<p>Hello ${escapeHtml(input.firstName)},</p>`,
      `<p>${escapeHtml(lines.added)}</p>`,
      `<p>${escapeHtml(lines.accept)}</p>`,
      `<p><a href="${escapeHtml(input.websiteUrl)}">About LogisticBay Timesheets</a></p>`,
      `<p>${escapeHtml(lines.ignore)}</p>`,
      "<p>LogisticBay Timesheets</p>",
    ].join("\n"),
  };
}
