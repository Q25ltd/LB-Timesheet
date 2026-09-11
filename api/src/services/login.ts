/**
 * Driver login (AUTH.md "Login flow", D13, D17, D21, D22).
 *
 * Login proves WHO the driver is and nothing more. It issues account-level
 * identity material and creates one new device Session; it selects no
 * company, mints no tenant token on this path, and creates no Company,
 * CompanyMembership or Shift. A "personal" tenant is never invented to make
 * the response shape uniform (D21).
 *
 * THE FAILURE CONTRACT, which every branch below serves:
 *
 *   unknown email          → verify against a fixed dummy hash → 401
 *   wrong password         → verify against the real hash      → 401
 *   unreadable stored hash → verification fails closed         → 401
 *
 * One body, one status, one code, and the same ~230 ms of bcrypt work on all
 * three. A response that differs in content OR in timing is an oracle for
 * whether an account exists; registration's deliberate `409 EMAIL_IN_USE`
 * enumeration trade-off (D24) is scoped to registration and does NOT license
 * login to confirm the same fact.
 *
 * The service takes a validated DTO and returns a result. It never sees a
 * request object (`no-request-in-services`), and there is no `companyId`
 * anywhere in this file — there is no tenant to scope to.
 */
import { z } from "zod";
import type { JWT } from "@fastify/jwt";
import { normaliseEmail } from "../lib/accountEmail.js";
import { AppError } from "../lib/errors.js";
import { LoginPasswordField, verifyAgainstUnknownAccount, verifyPassword } from "../lib/password.js";
import {
  hashRefreshToken,
  mintIdentityToken,
  mintRefreshToken,
  mintTenantToken,
  SESSION_LIFETIME_MS,
} from "../lib/tokens.js";
import type {
  AccountMembership,
  AccountUser,
  IdentityRepository,
} from "../repositories/identityRepository.js";

/**
 * Exactly two fields. `.strict()` is the mechanism, not decoration: a client
 * sending `companyId`, `membershipId`, `userId`, `id`, `sessionId`, `role`,
 * `passwordHash`, `identityToken`, `refreshToken` or `memberships` is
 * REFUSED, not quietly ignored.
 *
 * That matters more here than at registration. Login is where a client would
 * most plausibly try to say which company it wants to be in, and AUTH.md is
 * unconditional: a `companyId` arriving in a request body is never authority.
 * Ignoring the attempt makes it invisible; a 400 makes it an error the client
 * and the log both see.
 *
 * `email` is validated exactly as registration validates it — trimmed, capped
 * at CLAUDE.md's 320, and required to be an address — so the same typed
 * address is accepted by both routes. `password` is `LoginPasswordField`,
 * NOT `PasswordPolicy`: see `lib/password.ts` for why a login must not
 * enforce a policy that governs new credentials.
 */
export const LoginBody = z.object({
  email:    z.string().trim().min(1).max(320).email(),
  password: LoginPasswordField,
}).strict();

export type LoginInput = z.infer<typeof LoginBody>;

/**
 * The success body (AUTH.md, "Login flow").
 *
 * Structurally identical to `RegistrationResult`, and deliberately built from
 * the SAME `AccountUser` / `AccountMembership` concepts rather than a second
 * set of equivalent fields under different names (CLAUDE.md, "one concept,
 * one name"). Registration and login both end in "this driver is now
 * authenticated"; the client should not have to learn two shapes for it.
 *
 * `memberships` is ALWAYS present and an empty array is a complete answer,
 * not a degraded one. For the branch implemented today it is always empty —
 * see `login` below.
 */
export interface LoginResult {
  user: AccountUser;
  identityToken: string;
  refreshToken: string;
  memberships: AccountMembership[];
  /**
   * Present ONLY when the driver holds exactly ONE active membership, which
   * the server then auto-selects (AUTH.md "Login flow"; D13, explicitly
   * unchanged by D21). Absent for zero memberships — there is no company —
   * and absent for two or more, where `memberships` is the list to choose
   * from and a tenant token must wait for an explicit, server-validated
   * selection.
   *
   * Optional on the TYPE, never optional in meaning: this is a second token
   * KIND, not a tenant token that sometimes omits its claims. When it is
   * present its `companyId` and `membershipId` are mandatory and come from
   * the membership row the server loaded.
   */
  tenantToken?: string;
}

/**
 * The ONE failure this service produces, byte-identical to every other
 * authentication failure in the product (D17, AUTH.md). Constructed fresh
 * each time rather than shared, so stacks stay honest.
 *
 * It never says which half was wrong, never names the account, never mentions
 * the stored hash, and never mentions memberships.
 */
function notAuthenticated(): AppError {
  return new AppError(401, "Not authenticated", "UNAUTHENTICATED");
}

export async function login(
  input: LoginInput,
  accounts: IdentityRepository,
  jwt: JWT,
): Promise<LoginResult> {
  const email = normaliseEmail(input.email);

  const credential = await accounts.findCredentialByEmail(email);

  // No such account. The verification below matches NOTHING — its only job is
  // to spend the same ~230 ms a real account spends, so the two paths cannot
  // be told apart by a stopwatch. Returning here without it would make an
  // unknown email answer roughly 230 ms faster than a wrong password, which
  // is an account-enumeration oracle no amount of response-body sameness
  // closes.
  if (credential === null) {
    await verifyAgainstUnknownAccount(input.password);
    throw notAuthenticated();
  }

  // Fails CLOSED on a stored hash this build cannot read, so a corrupted or
  // legacy row answers 401 like every other failure rather than escaping as
  // a 500 that would identify the account as the broken one.
  if (!await verifyPassword(input.password, credential.passwordHash)) throw notAuthenticated();

  // From here the credential is proven and `credential.passwordHash` is never
  // touched again: only `credential.user` travels on.

  // Minted BEFORE the write so the value stored is provably the digest of the
  // value returned: the plaintext exists only in this scope and in the
  // response, and is never written anywhere.
  const refreshToken = mintRefreshToken();

  // A NEW session on every successful login (owner decision, 2026-09-11).
  // Device-session reuse is not expressible honestly: `Session` carries no
  // device identity, and inventing one to make the word literal was
  // explicitly refused. Multiple live sessions per user are legitimate, and
  // nothing here revokes or touches another one — a driver signing in on a
  // second phone must not sign the first one out.
  //
  // The session carries NO company, because a Session never does: it survives
  // company switching, and a switch reuses this same session (AUTH.md).
  const { sessionId } = await accounts.createSession({
    userId:           credential.user.id,
    // AUTH.md: ABSOLUTE, 90 days. Not sliding, and not extended by anything
    // later — rotation will not move it either.
    expiresAt:        new Date(Date.now() + SESSION_LIFETIME_MS),
    refreshTokenHash: hashRefreshToken(refreshToken),
  });

  // ACTIVE memberships only. An inactive membership is not offered (AUTH.md
  // contract test 5) and is not a company to select: a driver whose only
  // membership has been deactivated logs in exactly like a driver who has
  // never had one — identity, and no tenant authority of any kind.
  const memberships = await accounts.listActiveMemberships(credential.user.id);

  const result: LoginResult = {
    user:          credential.user,
    identityToken: mintIdentityToken(jwt, { userId: credential.user.id, sessionId }),
    refreshToken,
    memberships,
  };

  // EXACTLY ONE active membership is auto-selected (AUTH.md "Login flow";
  // D12's "single-company drivers never see the picker and lose no taps").
  //
  // The claims come from the membership row this server just loaded — the
  // client named nothing, so there is no client-supplied company authority to
  // distrust. Two or more memberships deliberately get the LIST and no tenant
  // token: choosing between real companies is an explicit security event and
  // belongs to `POST /auth/switch-company`.
  //
  // The open-shift guard is NOT applied here. It protects a SWITCH — moving
  // authority from one company to another while work is open. A login is not
  // a switch: there is no prior tenant authority to move away from, and
  // refusing it would lock a driver out of their own open shift. The database
  // still enforces one open shift per user regardless (D15).
  const only = memberships.length === 1 ? memberships[0] : undefined;
  if (only !== undefined) {
    result.tenantToken = mintTenantToken(jwt, {
      userId:       credential.user.id,
      companyId:    only.companyId,
      membershipId: only.membershipId,
      sessionId,
    });
  }

  return result;
}
