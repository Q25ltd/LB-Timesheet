/**
 * Driver registration (D21–D24).
 *
 * The whole product invariant this increment exists for: **a driver account
 * does not require a company.** Registration creates a User and a Session and
 * NOTHING else — no Company, no CompanyMembership, no Shift, and no
 * "personal" tenant standing in for the absence of one. Zero memberships is a
 * successful outcome, not a degraded one.
 *
 * The service takes a validated DTO and returns a result. It never sees a
 * request object (`no-request-in-services`), and there is no `companyId`
 * anywhere in this file — there is no tenant to scope to yet.
 */
import { z } from "zod";
import type { JWT } from "@fastify/jwt";
import { AppError } from "../lib/errors.js";
import { hashPassword, PasswordPolicy } from "../lib/password.js";
import {
  hashRefreshToken,
  mintIdentityToken,
  mintRefreshToken,
  SESSION_LIFETIME_MS,
} from "../lib/tokens.js";
import {
  prismaErrorCode,
  UNIQUE_VIOLATION_CODE,
  type AccountMembership,
  type AccountUser,
  type IdentityRepository,
} from "../repositories/identityRepository.js";

/**
 * Exactly four fields (D21). `.strict()` is the mechanism, not decoration: a
 * client sending `companyId`, `membershipId`, `userId`, `id`, `role`,
 * `passwordHash` or `memberships` is REFUSED, not quietly ignored. Ignoring
 * an attempt to name server-owned identity makes the attempt invisible; a
 * 400 makes it an error the client and the log both see.
 *
 * Caps are CLAUDE.md's: names 200, emails 320. The password's own bound lives
 * in `lib/password.ts` because it is measured in UTF-8 bytes, not characters.
 */
export const RegisterBody = z.object({
  firstName: z.string().trim().min(1).max(200),
  lastName:  z.string().trim().min(1).max(200),
  // `.trim()` before the format check, so "  driver@example.com  " is an
  // address rather than a validation failure the driver cannot see the cause of.
  email:     z.string().trim().min(1).max(320).email(),
  password:  PasswordPolicy,
}).strict();

export type RegisterInput = z.infer<typeof RegisterBody>;

/** The frozen success body (AUTH.md, "Registration"). */
export interface RegistrationResult {
  user: AccountUser;
  identityToken: string;
  refreshToken: string;
  memberships: AccountMembership[];
}

/**
 * D24, and deliberately the ONLY thing a collision discloses.
 *
 * No user id, no name, no account status, no membership or company
 * information, and no timestamps. This is a knowingly accepted
 * account-enumeration trade-off for V1: the privacy-preserving alternative
 * needs an email provider and a verification lifecycle, neither of which
 * exists — and a driver who mistypes their own address has to be told.
 */
function emailInUse(): AppError {
  return new AppError(409, "Email already registered", "EMAIL_IN_USE");
}

/**
 * The canonical stored form of an email identity: trimmed and lowercased
 * (D22). Deliberately nothing else — `+`-tags and dots are NOT stripped,
 * because those forms address genuinely different mailboxes and merging them
 * would be a worse bug than the casing one this fixes.
 *
 * This is the convenience, not the guarantee. `User.email` is `citext`, so
 * the DATABASE refuses a case variant even if some future write path forgets
 * to call this (D16).
 */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function register(
  input: RegisterInput,
  accounts: IdentityRepository,
  jwt: JWT,
): Promise<RegistrationResult> {
  const email = normaliseEmail(input.email);

  // A courtesy pre-read, NOT the guarantee — between this and the insert,
  // another request can create the same identity. The unique constraint is
  // what actually decides; this only turns the common case into a clean 409
  // instead of a caught database error.
  if (await accounts.findByEmail(email) !== null) throw emailInUse();

  const passwordHash = await hashPassword(input.password);

  // Minted BEFORE the write so the value stored is provably the digest of the
  // value returned: the plaintext exists only in this scope and in the
  // response, and is never written anywhere.
  const refreshToken = mintRefreshToken();

  let created;
  try {
    created = await accounts.createAccount({
      email,
      firstName:        input.firstName,
      lastName:         input.lastName,
      passwordHash,
      // AUTH.md: ABSOLUTE, 90 days from login. Not sliding, and not extended
      // by anything later.
      sessionExpiresAt: new Date(Date.now() + SESSION_LIFETIME_MS),
      refreshTokenHash: hashRefreshToken(refreshToken),
    });
  } catch (error) {
    // The race the pre-read above cannot close. Mapped to the SAME 409 a
    // sequential duplicate gets, so a concurrent registration is answered as
    // a conflict rather than surfacing as a 500 — and so the two paths are
    // indistinguishable from outside.
    if (prismaErrorCode(error) === UNIQUE_VIOLATION_CODE) throw emailInUse();
    throw error;
  }

  return {
    user:          created.user,
    identityToken: mintIdentityToken(jwt, { userId: created.user.id, sessionId: created.sessionId }),
    refreshToken,
    // Always empty at registration — a brand-new account has no employer.
    // Stated explicitly rather than omitted, so the client reads "none" as
    // data instead of inferring it from an absent field.
    memberships:   [],
  };
}

/** The account state an identity-authenticated request may read (D21). */
export interface AccountView {
  user: AccountUser;
  memberships: AccountMembership[];
}

/**
 * `GET /auth/me`'s answer. Deliberately narrow — this is the minimum the
 * mobile app needs to restore an authenticated state, not a profile API.
 *
 * A driver with no memberships is a SUCCESS with an empty list. Requiring one
 * here would reintroduce the "0 memberships → denied" rule D21 superseded.
 */
export async function accountView(userId: string, accounts: IdentityRepository): Promise<AccountView> {
  const [user, memberships] = await Promise.all([
    accounts.findById(userId),
    accounts.listActiveMemberships(userId),
  ]);

  // The session authenticated, but the account behind it is gone. Not a
  // client error to explain — the identity is simply no longer valid, and it
  // fails exactly as every other authentication failure does.
  if (user === null) throw new AppError(401, "Not authenticated", "UNAUTHENTICATED");

  return { user, memberships };
}
