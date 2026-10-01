/**
 * The CSRF baseline for every endpoint that acts on, or sets, the browser's
 * refresh cookie (D45): strict server-side validation of the request's
 * `Origin` against the explicitly authorised Timesheets web origin(s).
 *
 * A cookie is attached by the browser automatically, whoever started the
 * request, so these endpoints must know WHO started it. Browsers send
 * `Origin` on every cross-origin request and on same-origin POSTs, and a page
 * cannot forge it. `SameSite` is not relied on: the TMS and the umbrella site
 * share this product's registrable domain, so to `SameSite` they are the same
 * site (D3, D45).
 *
 * Exact match against the normalised allowlist, and nothing cleverer:
 *
 *   absent            → refused (a browser always sends one here; a request
 *                       without one is not from the web app)
 *   "null"            → refused (an opaque origin: sandboxed frame, file:)
 *   unlisted          → refused
 *   sibling subdomain → refused (no suffix matching, ever)
 *   different scheme or port, trailing slash, other casing → refused (not
 *                       the exact serialised origin a browser sends)
 *
 * The refusal is D17's generic 403: it says nothing about why.
 */
import { AppError } from "./errors.js";

export function requireTrustedOrigin(origin: string | string[] | undefined, allowed: readonly string[]): void {
  if (typeof origin !== "string" || !allowed.includes(origin)) {
    throw new AppError(403, "Not allowed", "FORBIDDEN");
  }
}
