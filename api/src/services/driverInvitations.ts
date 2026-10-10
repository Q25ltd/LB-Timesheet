/**
 * A company adds its drivers (D63, stage 1): the company side of driver
 * invitations.
 *
 * Every operation passes D54's one company-web gate, `authorizeCompanyAdmin`,
 * and acts in the TenantContext it returns — the administrator's own
 * company, from the token's membership row, never from the request.
 *
 * What a company is told is exactly what it typed and where its own
 * invitation stands. Never whether a LogisticBay account uses an address,
 * and never whether its email went out: an address can be suppressed, or over
 * the cross-company cap because OTHER companies invited the same person, and
 * saying so would leak both.
 */
import { z } from "zod";
import type { AuthContext } from "../lib/auth.js";
import { authorizeCompanyAdmin } from "../lib/authorization.js";
import { normaliseEmail } from "../lib/accountEmail.js";
import { AppError } from "../lib/errors.js";
import { DriverInvitationStatus as STATUS } from "../generated/enums.js";
import type { Mailer } from "../lib/mailer.js";
import type { BackgroundWork } from "../lib/backgroundWork.js";
import { driverInvitationEmail } from "../lib/invitationEmail.js";
import type { TenantContext } from "../lib/tenantContext.js";
import type { DriverInvitationRepository, DriverInvitationRow } from "../repositories/driverInvitationRepository.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** An invitation is open this long (D63). */
const INVITATION_LIFETIME_MS = 30 * DAY_MS;
/** New invitations one company may make in any 24 hours (D63). */
const INVITATIONS_PER_COMPANY_PER_DAY = 50;
/** Invitation emails one address may receive in any 7 days, from all companies together (D63). */
const INVITATION_EMAILS_PER_ADDRESS_PER_WEEK = 3;
const ADDRESS_WINDOW_MS = 7 * DAY_MS;

const PersonName = z.string().trim().min(1).max(200);
/** A reference or code (CLAUDE.md): at most 64. Absent or blank is null — never "". */
const PayrollRef = z.string().trim().max(64).nullable().optional().transform(value => (value === undefined || value === null || value === "" ? null : value));

export const AddDriverBody = z.object({
  firstName:  PersonName,
  lastName:   PersonName,
  // `.trim()` before the format check, as registration does.
  email:      z.string().trim().min(1).max(320).email(),
  payrollRef: PayrollRef,
}).strict();

export type AddDriverInput = z.infer<typeof AddDriverBody>;

/** A correction of a pending invitation: names and payroll reference only — never its address, status or company. */
export const CorrectInvitationBody = z.object({
  firstName:  PersonName.optional(),
  lastName:   PersonName.optional(),
  payrollRef: z.string().trim().max(64).nullable().optional(),
}).strict().refine(body => Object.keys(body).length > 0, { message: "Nothing to correct" });

export type CorrectInvitationInput = z.infer<typeof CorrectInvitationBody>;

/** The id in a path — a cuid, as the database issues them. */
export const InvitationParams = z.object({ id: z.string().min(1).max(64) }).strict();

/** How the company sees an invitation: what it typed, and where it stands. */
export interface InvitationView {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  payrollRef: string | null;
  status: "pending" | "cancelled" | "expired";
  createdAt: string;
  expiresAt: string;
}

function viewOf(row: DriverInvitationRow, now: Date): InvitationView {
  const lapsed = row.status === STATUS.pending && row.expiresAt.getTime() <= now.getTime();
  return {
    id:         row.id,
    firstName:  row.firstName,
    lastName:   row.lastName,
    email:      row.email,
    payrollRef: row.payrollRef,
    status:     lapsed ? STATUS.expired : row.status,
    createdAt:  row.createdAt.toISOString(),
    expiresAt:  row.expiresAt.toISOString(),
  };
}

const invitationNotFound = (): AppError => new AppError(404, "Not found", "NOT_FOUND");
const notPending = (): AppError => new AppError(409, "This invitation is no longer pending", "INVITATION_NOT_PENDING");

export interface InvitationMail {
  mailer: Mailer;
  work: BackgroundWork;
  /** The website — the invitation email's one link. */
  websiteUrl: string;
  log: { error(details: object, message: string): void };
}

export async function addDriver(
  auth: AuthContext,
  input: AddDriverInput,
  invitations: DriverInvitationRepository,
  mail: InvitationMail,
  now: Date = new Date(),
): Promise<InvitationView> {
  const ctx = authorizeCompanyAdmin(auth);
  const email = normaliseEmail(input.email);

  if (await invitations.countCreatedSince(ctx, new Date(now.getTime() - DAY_MS)) >= INVITATIONS_PER_COMPANY_PER_DAY) {
    throw new AppError(429, "You have added the most drivers allowed in one day. Try again tomorrow.", "INVITATION_LIMIT");
  }
  // The one refusal that names a person: the company's OWN active driver.
  if (await invitations.isActiveDriver(ctx, email)) {
    throw new AppError(409, "This person is already one of your drivers", "ALREADY_A_DRIVER");
  }

  const outcome = await invitations.create(ctx, {
    email,
    firstName:  input.firstName,
    lastName:   input.lastName,
    payrollRef: input.payrollRef,
    createdAt:  now,
    expiresAt:  new Date(now.getTime() + INVITATION_LIFETIME_MS),
  });
  if (outcome.kind === "exists") {
    throw new AppError(409, "This email address already has an open invitation", "INVITATION_EXISTS");
  }

  const invitation = outcome.invitation;
  mail.work.run("driver-invitation", () => sendInvitationEmail(ctx, invitation, invitations, mail));
  return viewOf(invitation, now);
}

/**
 * The invitation email, after the answer: its outcome is never part of what
 * the company is told. Skipped — silently — when the address has had its
 * week's invitation emails from all companies together; a suppressed address
 * is refused by the tracked mailer itself.
 */
async function sendInvitationEmail(
  ctx: TenantContext,
  invitation: DriverInvitationRow,
  invitations: DriverInvitationRepository,
  mail: InvitationMail,
): Promise<void> {
  const since = new Date(Date.now() - ADDRESS_WINDOW_MS);
  if (await invitations.emailsSentToSince(invitation.email, since) >= INVITATION_EMAILS_PER_ADDRESS_PER_WEEK) return;
  const companyName = await invitations.companyName(ctx);
  if (companyName === null) return;
  const sesMessageId = await mail.mailer.send(driverInvitationEmail({
    to:          invitation.email,
    companyName,
    firstName:   invitation.firstName,
    expiresAt:   invitation.expiresAt,
    websiteUrl:  mail.websiteUrl,
  }));
  if (sesMessageId !== null) await invitations.recordSent(ctx, invitation.id, sesMessageId, new Date());
}

export async function listInvitations(auth: AuthContext, invitations: DriverInvitationRepository, now: Date = new Date()): Promise<InvitationView[]> {
  const ctx = authorizeCompanyAdmin(auth);
  return (await invitations.list(ctx)).map(row => viewOf(row, now));
}

/**
 * Correct or cancel a pending invitation. Another company's invitation and one
 * that does not exist are the same 404; this company's invitation that is no
 * longer pending (cancelled, or lapsed) is a 409.
 */
async function pendingChange(
  ctx: TenantContext,
  id: string,
  invitations: DriverInvitationRepository,
  now: Date,
  change: () => Promise<boolean>,
): Promise<InvitationView> {
  if (!await change()) {
    if (await invitations.find(ctx, id) === null) throw invitationNotFound();
    throw notPending();
  }
  const row = await invitations.find(ctx, id);
  if (row === null) throw invitationNotFound();
  return viewOf(row, now);
}

export function correctInvitation(
  auth: AuthContext,
  id: string,
  input: CorrectInvitationInput,
  invitations: DriverInvitationRepository,
  now: Date = new Date(),
): Promise<InvitationView> {
  const ctx = authorizeCompanyAdmin(auth);
  const correction = {
    ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
    ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
    ...(input.payrollRef === undefined ? {} : { payrollRef: input.payrollRef === null || input.payrollRef === "" ? null : input.payrollRef }),
  };
  return pendingChange(ctx, id, invitations, now, () => invitations.correct(ctx, id, correction, now));
}

export function cancelInvitation(auth: AuthContext, id: string, invitations: DriverInvitationRepository, now: Date = new Date()): Promise<InvitationView> {
  const ctx = authorizeCompanyAdmin(auth);
  return pendingChange(ctx, id, invitations, now, () => invitations.cancel(ctx, id, now));
}
