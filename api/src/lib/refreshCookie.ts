/**
 * The browser refresh cookie (D45, D46) — the ONE place it is named, read and
 * written.
 *
 * What the cookie must be, and how each property is achieved:
 *
 *   HttpOnly     always — JavaScript can never read the refresh credential.
 *   host-only    NO `Domain` attribute, ever, so it belongs to the API host
 *                alone and never to `.logisticbay.com` (D3's trap). In
 *                production the name carries the `__Host-` prefix, which makes
 *                the BROWSER enforce that too: a `__Host-` cookie is refused
 *                unless it is Secure, has `Path=/` and has no `Domain` — so a
 *                sibling host on the shared registrable domain cannot plant
 *                one under this name ("cookie tossing").
 *   Secure       in production. Not in development/test, where the API runs
 *                on plain `http://localhost`.
 *   SameSite     Strict. The Timesheets web origin and the API are the same
 *                SITE, so Strict still travels on the app's own requests —
 *                but it is defence in depth only: the CSRF guarantee is the
 *                server's Origin check (D45), not this attribute.
 *   Path         `/`. The `__Host-` prefix requires it; restricting the path
 *                instead would give up the browser-enforced host-only
 *                guarantee, which is the stronger property. Only the
 *                `/auth/web/*` routes ever read it.
 *   Max-Age      the Session's REMAINING absolute lifetime, recomputed on
 *                every set — never longer (owner decision B1).
 *
 * No cookie library: the API reads exactly one cookie whose value is
 * base64url, and writes it with a fixed attribute set. The parser is strict on
 * purpose — an ambiguous header (our name twice) yields NO credential rather
 * than a guess, because a second copy is exactly what a tossed cookie looks
 * like.
 */
import type { NodeEnv } from "./env.schema.js";

export interface RefreshCookiePolicy {
  name: string;
  secure: boolean;
}

/** The development/test name, and the production one with its browser-enforced prefix. */
const COOKIE_BASE_NAME = "lbts_refresh";

/** A refresh secret: 32 random bytes, base64url — 43 characters. Bounded at 64 like the body DTO. */
const REFRESH_SECRET_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Production unless explicitly development or test — the same fail-closed
 * reading `env.schema.ts` applies, so a deploy that forgets NODE_ENV gets the
 * Secure, `__Host-` cookie and never the lenient one.
 */
export function refreshCookiePolicy(nodeEnv: NodeEnv | undefined): RefreshCookiePolicy {
  const devLike = nodeEnv === "development" || nodeEnv === "test";
  return devLike
    ? { name: COOKIE_BASE_NAME, secure: false }
    : { name: `__Host-${COOKIE_BASE_NAME}`, secure: true };
}

/**
 * The refresh secret the request's `Cookie` header carries, or null.
 *
 * Null for: no header, no cookie of our name, MORE THAN ONE cookie of our
 * name, or a value that is not a refresh secret's shape. The caller answers
 * every one of those with the same 401 it gives an unknown credential.
 */
export function readRefreshCookie(header: string | undefined, policy: RefreshCookiePolicy): string | null {
  if (header === undefined || header === "") return null;

  const values: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === policy.name) values.push(part.slice(eq + 1).trim());
  }

  if (values.length !== 1) return null;
  const [value] = values;
  return value !== undefined && REFRESH_SECRET_SHAPE.test(value) ? value : null;
}

function serialise(policy: RefreshCookiePolicy, value: string, maxAgeSeconds: number): string {
  const attributes = [
    `${policy.name}=${value}`,
    "Path=/",
    `Max-Age=${String(maxAgeSeconds)}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (policy.secure) attributes.push("Secure");
  return attributes.join("; ");
}

/**
 * The `Set-Cookie` value carrying a freshly issued refresh secret.
 *
 * Max-Age is the whole seconds left until the Session's absolute expiry,
 * rounded DOWN, so the browser can never keep the cookie past the moment the
 * server stops honouring it.
 */
export function refreshCookie(policy: RefreshCookiePolicy, secret: string, sessionExpiresAt: Date, now: Date): string {
  const remainingSeconds = Math.max(0, Math.floor((sessionExpiresAt.getTime() - now.getTime()) / 1000));
  return serialise(policy, secret, remainingSeconds);
}

/** The `Set-Cookie` value that tells the browser to drop the refresh cookie now. */
export function clearedRefreshCookie(policy: RefreshCookiePolicy): string {
  return serialise(policy, "", 0);
}
