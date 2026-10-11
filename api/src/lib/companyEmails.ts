/**
 * Emails to a COMPANY's addresses (D66) — never an account's: each has
 * `userId: null`, so nothing in it enters an account's email records (D56).
 * Sent from `timesheets@`, the sender for timesheet reports (D55).
 */
import { escapeHtml } from "./authEmails.js";
import type { MailMessage } from "./mailer.js";

/** How long a report-address link stays valid. */
export const REPORT_EMAIL_LINK_LIFETIME_MS = 72 * 60 * 60 * 1000;

export function reportAddressConfirmationEmail(input: { to: string; companyName: string; link: string }): MailMessage {
  const safeLink = escapeHtml(input.link);
  const company = escapeHtml(input.companyName);
  return {
    sender: "timesheets",
    userId: null,
    to: input.to,
    subject: "Confirm your timesheet report address — LogisticBay Timesheets",
    text: [
      "Hello,",
      "",
      `${input.companyName} has asked for the timesheets its drivers submit in LogisticBay Timesheets to be emailed to this address.`,
      "",
      "Confirm that reports may be sent here by opening the link below. It works once and expires in 72 hours.",
      "",
      input.link,
      "",
      "If you did not expect this, you can ignore this email: nothing is sent here until the address is confirmed.",
      "",
      "LogisticBay Timesheets",
    ].join("\n"),
    html: [
      "<p>Hello,</p>",
      `<p>${company} has asked for the timesheets its drivers submit in LogisticBay Timesheets to be emailed to this address.</p>`,
      "<p>Confirm that reports may be sent here by opening the link below. It works once and expires in 72 hours.</p>",
      `<p><a href="${safeLink}">Confirm this address</a></p>`,
      `<p>If the button does not work, copy this address into your browser:<br>${safeLink}</p>`,
      "<p>If you did not expect this, you can ignore this email: nothing is sent here until the address is confirmed.</p>",
      "<p>LogisticBay Timesheets</p>",
    ].join("\n"),
  };
}
