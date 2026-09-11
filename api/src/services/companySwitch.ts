/**
 * Company selection — the second security event (AUTH.md "Company switch",
 * D12, D13, D21).
 *
 * Login proves WHO the driver is. THIS proves WHICH company authority they
 * are using. Keeping them separate is the whole reason the product has two
 * token kinds: an identity token can never reach tenant data, and the only
 * way to obtain tenant authority is to name a membership and have the server
 * validate it against the authenticated user.
 *
 * THE VALIDATION ORDER IS THE CONTRACT (AUTH.md):
 *
 *   membership exists
 *   membership.userId === authenticated user     ← never skip
 *   membership.active === true
 *   session is valid and not revoked              ← already true: identity posture
 *   no open shift under a DIFFERENT membership
 *   → tenant token scoped to that membership, SAME session
 *
 * The client supplies a `membershipId` as a REQUESTED choice, never as
 * authority. Every field of the minted token comes from the row the server
 * loaded — `companyId` in particular is read from the database and is never
 * accepted from, or compared against, anything the client said. That is why
 * this DTO has no `companyId` at all (and why `check-rules`'
 * `no-company-id-in-dto` would fail the build if it did).
 *
 * No new Session is created. A switch keeps the device session it was made
 * on, so switching company does not log the other tokens' device out and
 * does not multiply sessions.
 */
import { z } from "zod";
import type { JWT } from "@fastify/jwt";
import { AppError } from "../lib/errors.js";
import { mintTenantToken } from "../lib/tokens.js";
import type { AccountMembership, IdentityRepository } from "../repositories/identityRepository.js";
import type { RefreshRepository } from "../repositories/refreshRepository.js";

/**
 * Exactly one field. `.strict()`, so `companyId`, `userId`, `sessionId`,
 * `role`, `active` or any unknown key is REFUSED, not ignored.
 *
 * `membershipId` is legitimately client-supplied — AUTH.md says so
 * explicitly, and this endpoint is the reason. What makes it safe is not the
 * linter but the validation below, and the tests that prove it.
 */
export const SwitchCompanyBody = z.object({
  membershipId: z.string().min(1).max(64),
}).strict();

export type SwitchCompanyInput = z.infer<typeof SwitchCompanyBody>;

/**
 * The tenant material a selected company yields.
 *
 * `membership` is echoed back so the client can label its UI without a second
 * round trip — from the row the SERVER loaded, not from the request. There is
 * no refresh token here: selecting a company does not touch the device
 * session's credential lineage.
 */
export interface SwitchCompanyResult {
  tenantToken: string;
  membership: AccountMembership;
}

/**
 * D17's generic authorization failure. It must not reveal that the membership
 * belongs to another user, or that it is inactive, or that it does not exist
 * — a talkative 403 is an oracle for account and company state.
 */
function notAllowed(): AppError {
  return new AppError(403, "Not allowed", "FORBIDDEN");
}

/**
 * The frozen open-shift conflict, reusing Start Shift's exact code and
 * wording (CLAUDE.md, "one concept, one name").
 *
 * Opaque on purpose: it never says which company the open shift belongs to,
 * so company B cannot learn that the driver is on shift for company A.
 */
function shiftAlreadyOpen(): AppError {
  return new AppError(409, "You already have an open shift", "SHIFT_ALREADY_OPEN");
}

export async function switchCompany(
  input: SwitchCompanyInput,
  identity: { userId: string; sessionId: string },
  accounts: IdentityRepository,
  sessions: RefreshRepository,
  jwt: JWT,
): Promise<SwitchCompanyResult> {
  // Loaded by id and filtered by the AUTHENTICATED user in the same query, so
  // there is no window in which a membership belonging to someone else has
  // been fetched and is waiting to be checked. `active` is required by the
  // same read: an inactive membership is not a company that can be selected,
  // and it is refused identically to one that does not exist.
  const membership = await accounts.findActiveMembership(identity.userId, input.membershipId);
  if (membership === null) throw notAllowed();

  // AUTH.md: a switch is refused while the driver has an open shift, because
  // "which company is this shift for" must never be ambiguous. Scoped to
  // shifts OUTSIDE the membership being selected — a driver whose open shift
  // belongs to the company they are selecting is not ambiguous at all, and
  // refusing them would lock them out of their own open shift.
  //
  // The user identity comes from the authenticated session; the query returns
  // a boolean and nothing else.
  if (await sessions.hasOpenShiftOutsideMembership(identity.userId, membership.membershipId)) {
    throw shiftAlreadyOpen();
  }

  return {
    // Every claim from the row the server loaded. The SAME sessionId the
    // identity token carried — a switch reuses its device session (AUTH.md).
    tenantToken: mintTenantToken(jwt, {
      userId:       identity.userId,
      companyId:    membership.companyId,
      membershipId: membership.membershipId,
      sessionId:    identity.sessionId,
    }),
    membership,
  };
}
