/**
 * The ONE place a driver's identity becomes submission authority over one of
 * their memberships (D66; AUTH.md "Driver timesheet submission").
 *
 * The membership is loaded by its id AND the signed-in user's id AND role
 * `driver`, in one query: another driver's membership, an administrator's,
 * and one that does not exist are all the same 404 — the caller cannot tell
 * them apart. Active, deactivated and removed memberships ALL pass: that is
 * the point (D65 Option A). What differs is what the context's holder may do
 * with it, which each use decides — a start receipt requires an active one.
 */
import type { IdentityContext } from "./auth.js";
import { AppError } from "./errors.js";
import { SubmissionContext } from "./submissionContext.js";

export interface SubmissionMembershipLookup {
  /** The signed-in driver's own DRIVER membership by id, or null. */
  findOwnDriverMembership(userId: string, membershipId: string): Promise<{ companyId: string; active: boolean } | null>;
}

function notFound(): AppError {
  return new AppError(404, "Not found", "NOT_FOUND");
}

/** The generic refusal (D17): never says that the membership was withdrawn. */
function forbidden(): AppError {
  return new AppError(403, "Not allowed", "FORBIDDEN");
}

async function authorizeTimesheetSubmission(
  identity: IdentityContext,
  membershipId: string,
  memberships: SubmissionMembershipLookup,
): Promise<SubmissionContext> {
  const row = await memberships.findOwnDriverMembership(identity.userId, membershipId);
  if (row === null) throw notFound();
  return SubmissionContext.trust({ userId: identity.userId, membershipId, companyId: row.companyId, membershipActive: row.active });
}

/** A start receipt is evidence of an ACTIVE membership, so only an active one gets one. */
export async function authorizeStartReceipt(
  identity: IdentityContext,
  membershipId: string,
  memberships: SubmissionMembershipLookup,
): Promise<SubmissionContext> {
  const ctx = await authorizeTimesheetSubmission(identity, membershipId, memberships);
  if (!ctx.membershipActive) throw forbidden();
  return ctx;
}
