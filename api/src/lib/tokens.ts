/**
 * Token minting and the two verification contracts (AUTH.md, D21).
 *
 * `check-rules`' `jwt-centralised` rule confines JWT verification to
 * `src/lib/auth.ts` and this file — the boundary was named for this module
 * before it existed. Verification of the IDENTITY token happens here because
 * its option set lives here; `requireAuth` keeps the tenant one.
 *
 * The product has exactly TWO token kinds and they are separated by JWT
 * AUDIENCE, not by a claim the code has to remember to read:
 *
 *   tenant   aud "timesheets-api"       sub, companyId, membershipId, sessionId
 *   identity aud "timesheets-identity"  sub, sessionId
 *
 * Each kind's verify options are stated COMPLETELY below rather than layered
 * on the plugin's registered defaults. `@fastify/jwt`'s `verify(token,
 * options)` replaces the default option set outright when options are passed
 * (it builds a fresh verifier from them), so a partial object here would
 * silently drop `algorithms` or `requiredClaims` — the two things that stop
 * an `alg:none` or an unexpiring token. Stating both sets in full also means
 * the difference between the kinds is one line of one object, visible on
 * read.
 */
import { randomBytes, createHash } from "node:crypto";
import type { FastifyJWTOptions, JWT } from "@fastify/jwt";

/**
 * The plugin's own verify-option type. Borrowed rather than restated so
 * `algorithms` is checked against fast-jwt's `Algorithm` union here, at the
 * definition, instead of failing at the two call sites.
 */
type VerifyOptions = NonNullable<FastifyJWTOptions["verify"]>;

/** Shared across both kinds: same product, same signing key, same issuer. */
const TOKEN_ISSUER    = "logisticbay-timesheets";
const TOKEN_ALGORITHM = "HS256";

/** The tenant access token's audience — unchanged since P1.2a. */
const TENANT_AUDIENCE = "timesheets-api";

/**
 * The identity token's audience. THE separation mechanism (D21): the verifier
 * refuses a foreign audience before a single identity claim is read, which is
 * the same property that makes a LogisticBay TMS token unusable here (D1).
 * Changing this value to overlap the tenant audience would collapse the two
 * kinds into one and is an architectural change, not a rename.
 */
const IDENTITY_AUDIENCE = "timesheets-identity";

/**
 * AUTH.md: 15 minutes, both kinds.
 *
 * SECONDS, and the unit is load-bearing. `@fastify/jwt` documents a numeric
 * `expiresIn` as seconds and multiplies by 1000 before handing it to
 * fast-jwt, which wants milliseconds — so passing milliseconds here mints a
 * token with a ~25-year declared lifetime that this API's own
 * `0 < exp - iat <= 900` check then refuses. Caught by the identity-token
 * claims test, not by the type system: both units are `number`.
 */
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** AUTH.md: the device session's ABSOLUTE lifetime. Not sliding, not extended. */
export const SESSION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The registered claims whose PRESENCE is required. Not optional hardening:
 * `allowedIss`/`allowedAud` are VALUE validators that skip a claim which is
 * absent, and expiry is only checked when `exp` exists — so without this, a
 * token simply omitting exp/iss/aud verifies, which is an unexpiring,
 * cross-product-usable token.
 */
const REQUIRED_CLAIMS = ["iat", "exp", "iss", "aud"] as const;

/** The complete verify option set for a TENANT access token. */
export const TENANT_VERIFY_OPTIONS: VerifyOptions = {
  algorithms:     [TOKEN_ALGORITHM],
  allowedIss:     TOKEN_ISSUER,
  allowedAud:     TENANT_AUDIENCE,
  requiredClaims: [...REQUIRED_CLAIMS],
};

/**
 * The complete verify option set for an IDENTITY token. Identical to the
 * tenant set except for `allowedAud` — which is the entire point, and is why
 * the two are written out side by side instead of one deriving from the other.
 */
export const IDENTITY_VERIFY_OPTIONS: VerifyOptions = {
  algorithms:     [TOKEN_ALGORITHM],
  allowedIss:     TOKEN_ISSUER,
  allowedAud:     IDENTITY_AUDIENCE,
  requiredClaims: [...REQUIRED_CLAIMS],
};

/**
 * The identity token's payload. Exactly `sub` and `sessionId`; `iat`, `exp`,
 * `iss` and `aud` are added by the signer.
 *
 * There is no `companyId`, no `membershipId` and no `role`, and no optional
 * slot where one could later appear. That absence is the design (D21): a
 * token that sometimes carries tenant claims is not a smaller tenant token,
 * it is a different kind, and it gets a different audience.
 */
export interface IdentityTokenSubject {
  userId: string;
  sessionId: string;
}

/**
 * Mint an identity token for an authenticated account.
 *
 * `iat` is set by the signer from the server clock, so the future-`iat` bound
 * this product enforces on the way IN (F-19, `auth.ts`) can never be tripped
 * by our own minter unless the server clock is genuinely wrong.
 */
export function mintIdentityToken(jwt: JWT, subject: IdentityTokenSubject): string {
  return jwt.sign(
    { sub: subject.userId, sessionId: subject.sessionId },
    {
      algorithm: TOKEN_ALGORITHM,
      iss:       TOKEN_ISSUER,
      aud:       IDENTITY_AUDIENCE,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    },
  );
}

/**
 * The tenant access token's payload (AUTH.md, D13).
 *
 * `companyId` and `membershipId` are MANDATORY and never optional: a token
 * that sometimes omits them is not a smaller tenant token, it is a different
 * kind, and it gets a different audience.
 *
 * `role` is deliberately absent. Roles change, memberships get disabled,
 * owners remove drivers — a role baked into a token is authority that
 * outlives its revocation. `requireAuth` loads the membership row on every
 * request anyway, so the role is available there, fresh, at zero extra cost.
 */
export interface TenantTokenSubject {
  userId: string;
  companyId: string;
  membershipId: string;
  sessionId: string;
}

/**
 * Mint a tenant access token for ONE server-validated active membership.
 *
 * The caller must have loaded that membership from the database and confirmed
 * it belongs to the authenticated user and is active. Nothing here validates
 * anything: this function signs what it is given, so handing it a
 * client-supplied `companyId` would mint exactly the token AUTH.md forbids.
 * There is one production caller per entry point, and each loads the row
 * itself.
 *
 * Same secret, same issuer and the same 15-minute TTL as the identity token —
 * the audience is the only difference, and it is the whole separation.
 */
export function mintTenantToken(jwt: JWT, subject: TenantTokenSubject): string {
  return jwt.sign(
    {
      sub:          subject.userId,
      companyId:    subject.companyId,
      membershipId: subject.membershipId,
      sessionId:    subject.sessionId,
    },
    {
      algorithm: TOKEN_ALGORITHM,
      iss:       TOKEN_ISSUER,
      aud:       TENANT_AUDIENCE,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    },
  );
}

/**
 * AUTH.md's previous-refresh-token grace window: 60 seconds.
 *
 * Its purpose is a lost RESPONSE, not a lost request. A driver on a lorry
 * rotates successfully, the reply never arrives, and the client retries with
 * the only credential it still has — the one the server has just superseded.
 * Without this window that driver is logged out at exactly the wrong moment.
 *
 * Stored as an absolute DEADLINE on the Session rather than derived from a
 * rotation timestamp plus this constant, so changing the window can never
 * retroactively revive a token that was already dead.
 */
export const REFRESH_GRACE_MS = 60 * 1000;

/**
 * A refresh token: 32 random bytes, base64url (AUTH.md). Opaque, NOT a JWT —
 * it carries no claims, so it cannot be read, only looked up.
 */
export function mintRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The value stored in `Session.refreshTokenHash`.
 *
 * SHA-256, deterministically — not bcrypt. Refresh must find a session BY
 * this value, and a per-row salt makes that impossible. Safe here and not for
 * passwords for one reason: the input is 32 uniformly random bytes, so there
 * is no low-entropy guess space for a fast digest to expose.
 */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
