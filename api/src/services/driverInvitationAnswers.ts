/**
 * A driver answers a company's invitation (D63, stage 3).
 *
 * Only a DRIVER account (D51) whose email address is VERIFIED (D24, D63) sees
 * or answers invitations, and only those addressed to that address — read
 * from the account, never from the request. Accepting creates or reactivates
 * the membership and grants exactly what any membership grants: the driver
 * may then ask for that company's tenant authority (switch-company), and
 * nothing about anything recorded before. Declining creates nothing; the
 * company sees Declined (owner decision, 2026-10-11) — the app tells the
 * driver so before they decline.
 */
import { z } from "zod";
import type { IdentityContext } from "../lib/auth.js";
import { AppError } from "../lib/errors.js";
import type { IdentityRepository } from "../repositories/identityRepository.js";
import type { AccountMembership } from "../repositories/identityRepository.js";
import type { DriverInvitationAnswerRepository, AnswerOutcome } from "../repositories/driverInvitationAnswerRepository.js";

/** The id in the path — a cuid, as the database issues them. */
export const AnswerParams = z.object({ id: z.string().min(1).max(64) }).strict();

/** An open invitation, as the driver sees it: who, and what the company typed. Nothing of the company's internals. */
export interface DriverInvitationView {
  id: string;
  companyName: string;
  firstName: string;
  lastName: string;
  expiresAt: string;
}

const notFound = (): AppError => new AppError(404, "Not found", "NOT_FOUND");
const notPending = (): AppError => new AppError(409, "This invitation is no longer open", "INVITATION_NOT_PENDING");

/** The driver's verified address — or the refusal that says why there is none. */
async function verifiedDriverEmail(identity: IdentityContext, accounts: IdentityRepository): Promise<string> {
  const state = await accounts.findAccountState(identity.userId);
  if (state === null) throw new AppError(401, "Not authenticated", "UNAUTHENTICATED");
  if (state.accountKind !== "driver") throw new AppError(403, "Not allowed", "FORBIDDEN");
  if (!state.emailVerified) throw new AppError(403, "Confirm your email address to see invitations", "EMAIL_NOT_VERIFIED");
  return state.user.email;
}

function settled<T>(outcome: AnswerOutcome<T>): T {
  if (outcome.kind === "not_found") throw notFound();
  if (outcome.kind === "not_pending") throw notPending();
  if (outcome.kind === "inactive") throw new AppError(409, "This company has deactivated your access. Ask them to reactivate you.", "DRIVER_INACTIVE");
  return outcome.value;
}

export async function listMyInvitations(
  identity: IdentityContext,
  accounts: IdentityRepository,
  answers: DriverInvitationAnswerRepository,
  now: Date = new Date(),
): Promise<DriverInvitationView[]> {
  const email = await verifiedDriverEmail(identity, accounts);
  return (await answers.openFor(email, now)).map(row => ({ ...row, expiresAt: row.expiresAt.toISOString() }));
}

export async function acceptInvitation(
  identity: IdentityContext,
  id: string,
  accounts: IdentityRepository,
  answers: DriverInvitationAnswerRepository,
  now: Date = new Date(),
): Promise<AccountMembership> {
  const email = await verifiedDriverEmail(identity, accounts);
  const joined = settled(await answers.accept(identity.userId, email, id, now));
  return {
    membershipId: joined.membershipId, companyId: joined.companyId, companyName: joined.companyName, role: "driver",
    distanceUnit: joined.distanceUnit, volumeUnit: joined.volumeUnit,
  };
}

export async function declineInvitation(
  identity: IdentityContext,
  id: string,
  accounts: IdentityRepository,
  answers: DriverInvitationAnswerRepository,
  now: Date = new Date(),
): Promise<void> {
  const email = await verifiedDriverEmail(identity, accounts);
  settled(await answers.decline(email, id, now));
}
