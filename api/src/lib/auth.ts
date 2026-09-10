import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "./errors.js";
import type { AuthStore } from "./authStore.js";
import type { MembershipRole } from "../generated/enums.js";
import { IDENTITY_VERIFY_OPTIONS } from "./tokens.js";

/**
 * The route-registration marker consumed by the default-deny `onRequest` hook
 * in app.ts, and (as a static hint only, never the security boundary) flagged
 * when absent by the `route-declares-auth` check-rules rule. F-10, extended
 * to three postures by D21.
 *
 * The three route postures (D21). Their ORDER of authority is what the hook
 * in app.ts implements: anything that is not exactly `"public"` or exactly
 * `"identity"` is tenant-protected.
 */
type AuthPosture = "public" | "identity" | "tenant";

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * A route is public ONLY when this is exactly `"public"`, and
     * identity-scoped ONLY when it is exactly `"identity"`. Anything else —
     * `"tenant"`, omitted, a typo, malformed future metadata — is
     * tenant-protected. That polarity is deliberate and unchanged from F-10:
     * an oversight fails closed to the STRICTEST posture, never to the
     * loosest, and adding a third posture must not create a way to become
     * public by accident.
     */
    authPosture?: AuthPosture;
  }

  interface FastifyRequest {
    /**
     * Set by requireAuth, and only there. Optional because a public route
     * never runs it — a non-optional declaration would be a lie on exactly
     * the routes where being wrong matters most.
     */
    auth?: AuthContext;

    /**
     * Set by requireSession, and only there (D21). A SEPARATE field from
     * `auth`, not a widened version of it: an identity-authenticated request
     * has no company, no membership and no role, and giving the two pipelines
     * one field would let a route written for tenant authority read a
     * half-populated context and believe it had one.
     */
    identity?: IdentityContext;
  }
}

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

/**
 * F-19, resolved 2026-09-10. The declared-lifetime rule above proves
 * `0 < exp - iat <= 900`, which a token dated tomorrow satisfies perfectly —
 * and it is then honoured for the whole of tomorrow, because the verifier's
 * `exp > now` check is also satisfied. Only a bound on `iat` against the
 * SERVER clock closes that.
 *
 * 60 seconds is a clock-skew allowance between this product's own minter and
 * verifier, nothing more. Refusing genuine skew would log a driver out for a
 * clock difference nobody can see.
 *
 * This is a JWT security rule and is UNRELATED to D20, which governs the
 * driver's DECLARED start and finish times. Those may be any instant, past or
 * future, and are never rejected on temporal grounds. Do not let one rule
 * leak into the other.
 */
const TOKEN_MAX_FUTURE_IAT_SECONDS = 60;

/** AUTH.md's `"active" | "inactive"`, derived from CompanyMembership.active. */
type MembershipStatus = "active" | "inactive";

/**
 * The trusted identity a protected request carries. Exactly the six fields
 * AUTH.md freezes — no more. `role` is absent from the token on purpose and
 * comes from the membership row on every request, so a revoked or changed
 * role takes effect immediately instead of outliving its revocation.
 */
export interface AuthContext {
  readonly userId: string;
  readonly companyId: string;
  readonly membershipId: string;
  readonly sessionId: string;
  readonly role: MembershipRole;
  readonly membershipStatus: MembershipStatus;
}

/**
 * The trusted identity an IDENTITY-posture request carries (D21). Two fields,
 * and there is no third: an identity token names an account and a device
 * session, and nothing that could select a tenant.
 *
 * Deliberately NOT a subset type of AuthContext, and deliberately not
 * convertible into one. There is no function anywhere that turns an
 * IdentityContext into an AuthContext or a TenantContext, because the only
 * honest way to obtain tenant authority is to present a tenant token and have
 * its membership validated.
 */
export interface IdentityContext {
  readonly userId: string;
  readonly sessionId: string;
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
 * The identity token's claims (D21). Note what is absent and has no optional
 * slot: `companyId`, `membershipId`, `role`. A token carrying them is not
 * refused HERE — it never reaches here, because the audience check in the
 * verifier rejects it first. This schema simply cannot express them, so no
 * later edit can accidentally start reading one.
 */
const IdentityTokenClaims = z.object({
  sub:       z.string().min(1).max(64),
  sessionId: z.string().min(1).max(64),
  iat:       z.number().int().positive(),
  exp:       z.number().int().positive(),
});

/**
 * The temporal rules both token kinds share, expressed once.
 *
 * Returns false for: a non-positive declared lifetime (malformed), one longer
 * than the frozen 15 minutes (evidence of a broken or hostile minter, refused
 * outright rather than honoured for a window), and an `iat` further ahead
 * than the clock-skew allowance (F-19).
 *
 * Combined with the verifier's own `exp > now` check, the first two also
 * bound the token's AGE, since `now - iat < exp - iat <= 900`.
 */
function hasValidTiming(claims: { iat: number; exp: number }): boolean {
  const declaredLifetimeSeconds = claims.exp - claims.iat;
  if (declaredLifetimeSeconds <= 0) return false;
  if (declaredLifetimeSeconds > ACCESS_TOKEN_MAX_LIFETIME_SECONDS) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (claims.iat > nowSeconds + TOKEN_MAX_FUTURE_IAT_SECONDS) return false;

  return true;
}

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

  // The frozen 15-minute TTL and the F-19 future-`iat` bound, shared with the
  // identity pipeline so the two kinds cannot drift apart on timing.
  if (!hasValidTiming(claims)) throw unauthenticated();

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

/**
 * The ONE place an IDENTITY-posture request is authenticated (D21).
 *
 * The account pipeline, and deliberately a SHORTER one than `requireAuth`:
 *
 *   verify (signature, algorithm, issuer, IDENTITY audience, required claims)
 *     → timing (0 < exp - iat <= 900, iat <= now + 60s)
 *     → Session present, not revoked, not expired, userId === sub
 *     → STOP.
 *
 * What it does NOT do is the security property, and it is structural rather
 * than defensive: there is no membership read here, no `AuthContext`, no call
 * to `authorizeTenant`, and no `TenantContext`. It cannot grant tenant
 * authority because it has no code that could.
 *
 * The audience is what makes the separation load-bearing in BOTH directions.
 * `IDENTITY_VERIFY_OPTIONS` names `timesheets-identity`, so a tenant access
 * token presented to an identity route fails verification before a claim is
 * read — a more authoritative token is still the wrong KIND (D21), and one
 * token must never silently acquire a second meaning.
 *
 * Every failure path throws, and throws the SAME error `requireAuth` throws,
 * so the two postures are not distinguishable from outside by their
 * rejections either.
 */
export async function requireSession(request: FastifyRequest, store: AuthStore): Promise<void> {
  const token = bearerToken(request);
  if (token === null) throw unauthenticated();

  // The full option set, replacing the plugin's registered tenant defaults:
  // `@fastify/jwt` builds a fresh verifier from whatever is passed here, so a
  // partial object would silently drop `algorithms` or `requiredClaims`.
  let claims: z.infer<typeof IdentityTokenClaims>;
  try {
    const payload: unknown = request.server.jwt.verify(token, IDENTITY_VERIFY_OPTIONS);
    claims = IdentityTokenClaims.parse(payload);
  } catch {
    throw unauthenticated();
  }

  if (!hasValidTiming(claims)) throw unauthenticated();

  const session = await store.findSession(claims.sessionId);
  if (session === null) throw unauthenticated();
  if (session.revokedAt !== null) throw unauthenticated();
  if (session.expiresAt.getTime() <= Date.now()) throw unauthenticated();
  // The session id is a POINTER the token supplied, not proof of ownership.
  // Without this, any holder of a valid token could name any live session.
  if (session.userId !== claims.sub) throw unauthenticated();

  request.identity = {
    userId:    session.userId,
    sessionId: session.id,
  };
}
