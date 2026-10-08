/**
 * The endpoint-specific abuse limits (owner decision B6, 2026-10-01).
 *
 * Every limit here is keyed by the CALLER's IP, never by an account — so an
 * attacker exhausting a bucket stops only themselves, and nobody can lock a
 * named account out (no account lockout exists in this product).
 *
 * One limiter per POLICY, shared by every route the policy covers: the
 * phone's and the browser's login draw on ONE bucket, as do the two
 * registrations. (`@fastify/rate-limit` gives each route-level config its own
 * store, which would have let a caller double their allowance by alternating
 * transports.) A route carrying one of these is exempt from the global
 * 300/min limit, which these are all stricter than.
 *
 * The client IP is the socket's. `trustProxy` is deliberately NOT set: the
 * production proxy topology has not been established (F-15), and trusting a
 * forwarded header without it would let any caller choose their own bucket.
 * Behind a proxy, every client would share the proxy's bucket — which is why
 * F-15 blocks public deployment until `trustProxy` is decided on evidence.
 *
 * Password RESET is not here: its token is 256 random bits, so guessing is
 * not a strategy, a dead token is refused before any bcrypt work, and the
 * global limit already applies. Password CHANGE is here because it verifies a
 * password — the same guessing surface as login, so login's limit.
 */
import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from "fastify";

const AUTH_RATE_LIMITS = {
  login:              { max: 10, timeWindow: "1 minute" },
  registration:       { max: 5,  timeWindow: "1 hour" },
  passwordForgot:     { max: 5,  timeWindow: "1 hour" },
  verificationResend: { max: 5,  timeWindow: "1 hour" },
} as const;

/** B6: at most this many emails of one purpose per address per hour. */
export const EMAILS_PER_ADDRESS_PER_HOUR = 3;

export type AuthRateLimits = Record<keyof typeof AUTH_RATE_LIMITS, onRequestAsyncHookHandler>;

/**
 * Build one limiter hook per policy. Call once per app, after the plugin is
 * registered. Every policy counts per CLIENT, as `clientAddress` decides it
 * (lib/clientAddress.ts, F-15) — stated here rather than inherited, so no
 * policy can quietly key on the proxy instead.
 */
export function authRateLimits(app: FastifyInstance, clientAddress: (request: FastifyRequest) => string): AuthRateLimits {
  const keyGenerator = clientAddress;
  return {
    login:              app.rateLimit({ ...AUTH_RATE_LIMITS.login, keyGenerator }),
    registration:       app.rateLimit({ ...AUTH_RATE_LIMITS.registration, keyGenerator }),
    passwordForgot:     app.rateLimit({ ...AUTH_RATE_LIMITS.passwordForgot, keyGenerator }),
    verificationResend: app.rateLimit({ ...AUTH_RATE_LIMITS.verificationResend, keyGenerator }),
  };
}
