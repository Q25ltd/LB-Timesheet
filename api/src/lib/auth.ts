import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "./errors.js";
import type { AuthStore } from "./authStore.js";
import type { MembershipRole } from "../generated/enums.js";

/**
 * The route-registration marker consumed by the default-deny `onRequest` hook
 * in app.ts, and (as a static hint only, never the security boundary) flagged
 * when absent by the `route-declares-auth` check-rules rule. F-10.
 */
declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * A route is public ONLY when this is exactly `true`. Anything else —
     * `false`, omitted, malformed future metadata — is protected. That
     * polarity is deliberate: an oversight fails closed, not open.
     */
    public?: boolean;
  }

  interface FastifyRequest {
    /**
     * Set by requireAuth, and only there. Optional because a public route
     * never runs it — a non-optional declaration would be a lie on exactly
     * the routes where being wrong matters most.
     */
    auth?: AuthContext;
  }
}

/**
 * AUTH.md's token identity, verified for THIS product. `iss`/`aud` are what
 * make a LogisticBay TMS token structurally unusable here even if a secret
 * were ever copied between the two (D1, enforced in the token format).
 */
export const ACCESS_TOKEN_ISSUER    = "logisticbay-timesheets";
export const ACCESS_TOKEN_AUDIENCE  = "timesheets-api";
export const ACCESS_TOKEN_ALGORITHM = "HS256";

/**
 * AUTH.md's frozen access-token TTL: 15 minutes. Enforced HERE rather than in
 * the verifier because no fast-jwt option relates two claims to each other --
 * `maxAge` measures the token's AGE against the server clock, which is a
 * different invariant: it would accept a 24-hour token for its first 15
 * minutes. `exp - iat` is computed from the token alone, so clock skew between
 * the issuer and this API cannot make a correct token fail or an over-long one
 * pass.
 */
const ACCESS_TOKEN_MAX_LIFETIME_SECONDS = 15 * 60;

/** AUTH.md's `"active" | "inactive"`, derived from CompanyMembership.active. */
type MembershipStatus = "active" | "inactive";

/**
 * The trusted identity a protected request carries. Exactly the six fields
 * AUTH.md freezes — no more. `role` is absent from the token on purpose and
 * comes from the membership row on every request, so a revoked or changed
 * role takes effect immediately instead of outliving its revocation.
 */
interface AuthContext {
  readonly userId: string;
  readonly companyId: string;
  readonly membershipId: string;
  readonly sessionId: string;
  readonly role: MembershipRole;
  readonly membershipStatus: MembershipStatus;
}

/**
 * The identity claims the pipeline reads. `iat`/`exp`/`iss`/`aud` are checked
 * by the verifier configured in app.ts, not here — one decision, one place.
 * Bounded per CLAUDE.md: identifiers cap at 64.
 */
const AccessTokenClaims = z.object({
  sub:          z.string().min(1).max(64),
  companyId:    z.string().min(1).max(64),
  membershipId: z.string().min(1).max(64),
  sessionId:    z.string().min(1).max(64),
  // NumericDate (RFC 7519 §2): seconds since the epoch. Their PRESENCE is
  // required by the verifier; they are parsed here because the declared
  // lifetime is a relationship between them, which no verifier option can
  // express. `.int()` rejects a fractional or non-finite value, so the
  // subtraction below is always between two real integers.
  iat:          z.number().int().positive(),
  exp:          z.number().int().positive(),
});

/**
 * The ONE failure this boundary produces. Every rejection below returns this
 * identical body, so the endpoint cannot be used as an oracle for which check
 * failed — whether a session exists, whether a membership exists, whether a
 * token expired, or whether a binding disagreed. Constructed fresh each time
 * rather than shared, so stacks stay honest.
 */
function unauthenticated(): AppError {
  return new AppError(401, "Not authenticated", "UNAUTHENTICATED");
}

/** The token from an `Authorization: Bearer …` header, or null. */
function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer +(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token === "" ? null : token;
}

/**
 * The ONE place that decides who gets through a protected route (AUTH.md,
 * "Every protected request").
 *
 * Authentication only. It answers "is there a valid identity", never "may
 * this identity do this" — an inactive membership authenticates and is
 * reported as inactive; the 403 rules that act on that belong to routes and
 * services, which do not exist yet.
 *
 * Every failure path throws; none returns. A path that returned early would
 * silently authenticate the request, which is why there is no `return` in the
 * body below other than through the final assignment.
 */
export async function requireAuth(request: FastifyRequest, store: AuthStore): Promise<void> {
  const token = bearerToken(request);
  if (token === null) throw unauthenticated();

  // Signature, expiry, issuer, audience and algorithm are enforced by the
  // verifier. Its errors (FST_JWT_*) are normalised here rather than being
  // allowed to reach the global handler: that handler masks anything it does
  // not recognise to a 500, and teaching it these codes would leak WHICH
  // check failed (F-05). The catch covers verification and claim shape only.
  let claims: z.infer<typeof AccessTokenClaims>;
  try {
    const payload: unknown = request.server.jwt.verify(token);
    claims = AccessTokenClaims.parse(payload);
  } catch {
    throw unauthenticated();
  }

  // The frozen 15-minute TTL. A token declaring a longer life is evidence of a
  // broken or hostile minter and is refused outright rather than honoured for
  // a window; a zero or negative lifetime is malformed. Combined with the
  // verifier's `exp > now` check this also bounds the token's age, since
  // now - iat < exp - iat <= 900.
  const declaredLifetimeSeconds = claims.exp - claims.iat;
  if (declaredLifetimeSeconds <= 0) throw unauthenticated();
  if (declaredLifetimeSeconds > ACCESS_TOKEN_MAX_LIFETIME_SECONDS) throw unauthenticated();

  const session = await store.findSession(claims.sessionId);
  if (session === null) throw unauthenticated();
  // Revocation is a decision and expiry is the passage of time; both end the
  // session. Checked on every request, so a logout takes effect at once
  // rather than lasting until the 15-minute access token runs out.
  if (session.revokedAt !== null) throw unauthenticated();
  if (session.expiresAt.getTime() <= Date.now()) throw unauthenticated();
  if (session.userId !== claims.sub) throw unauthenticated();

  const membership = await store.findMembership(claims.membershipId);
  if (membership === null) throw unauthenticated();
  if (membership.userId !== claims.sub) throw unauthenticated();
  // The token's companyId is a claim to VALIDATE against the row, never
  // authority in itself. The row wins, and a disagreement is a rejection.
  if (membership.companyId !== claims.companyId) throw unauthenticated();

  request.auth = {
    userId:           membership.userId,
    companyId:        membership.companyId,
    membershipId:     membership.id,
    sessionId:        session.id,
    role:             membership.role,
    // Explicit `=== true` rather than truthiness: anything that is not
    // exactly true resolves to inactive, the more restricted of the two.
    membershipStatus: membership.active === true ? "active" : "inactive",
  };
}
