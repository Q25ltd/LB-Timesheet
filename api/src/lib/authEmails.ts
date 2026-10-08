/**
 * The account emails — and only those. Shift reports are a separate,
 * unbuilt boundary (F-16) and do not belong here.
 *
 * Every value that came from a person (a first name) or carries a credential
 * (the link) is HTML-escaped before it enters the HTML part. The plain-text
 * part needs no escaping, and gets none.
 */
import type { MailMessage } from "./mailer.js";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => HTML_ESCAPES[character] ?? character);
}

interface AccountEmailInput {
  /** The account it is for (D56) — never shown in the email. */
  userId: string;
  to: string;
  firstName: string;
  link: string;
}

function htmlBody(firstName: string, paragraph: string, link: string, action: string, closing: string): string {
  const safeLink = escapeHtml(link);
  return [
    `<p>Hello ${escapeHtml(firstName)},</p>`,
    `<p>${paragraph}</p>`,
    `<p><a href="${safeLink}">${action}</a></p>`,
    `<p>If the button does not work, copy this address into your browser:<br>${safeLink}</p>`,
    `<p>${closing}</p>`,
    "<p>LogisticBay Timesheets</p>",
  ].join("\n");
}

/** Email-ownership verification (B4): the link is valid for 24 hours, once. */
export function verificationEmail(input: AccountEmailInput): MailMessage {
  return {
    sender: "accounts",
    userId: input.userId,
    to: input.to,
    subject: "Confirm your email address — LogisticBay Timesheets",
    text: [
      `Hello ${input.firstName},`,
      "",
      "Confirm that this is your email address by opening the link below. It works once and expires in 24 hours.",
      "",
      input.link,
      "",
      "If you did not create a LogisticBay Timesheets account, you can ignore this email.",
      "",
      "LogisticBay Timesheets",
    ].join("\n"),
    html: htmlBody(
      input.firstName,
      "Confirm that this is your email address. The link works once and expires in 24 hours.",
      input.link,
      "Confirm email address",
      "If you did not create a LogisticBay Timesheets account, you can ignore this email.",
    ),
  };
}

/** Self-service password recovery (B7): the link is valid for 30 minutes, once. */
export function passwordResetEmail(input: AccountEmailInput): MailMessage {
  return {
    sender: "security",
    userId: input.userId,
    to: input.to,
    subject: "Reset your password — LogisticBay Timesheets",
    text: [
      `Hello ${input.firstName},`,
      "",
      "Someone asked to reset the password for this LogisticBay Timesheets account. To choose a new password, open the link below. It works once and expires in 30 minutes.",
      "",
      input.link,
      "",
      "Resetting your password signs you out on every device. If you did not ask for this, ignore this email — your password has not changed.",
      "",
      "LogisticBay Timesheets",
    ].join("\n"),
    html: htmlBody(
      input.firstName,
      "Someone asked to reset the password for this account. The link works once and expires in 30 minutes. Resetting your password signs you out on every device.",
      input.link,
      "Choose a new password",
      "If you did not ask for this, ignore this email — your password has not changed.",
    ),
  };
}
