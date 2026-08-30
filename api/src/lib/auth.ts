import type { FastifyRequest } from "fastify";
import { AppError } from "./errors.js";

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
}

/**
 * The ONE place that decides who gets through a protected route.
 *
 * This is a deliberate Phase 1 stub, not a placeholder pretending to work.
 * AUTH.md's JWT verification, Session lookup and AuthContext construction do
 * not exist yet, so the honest behavior right now is to reject every
 * protected request — not to guess, and not to leave the route open while
 * auth is unimplemented. When Phase 1 lands, only this function's body
 * changes; the onRequest hook, the public marker and this call site do not.
 */
export async function requireAuth(_request: FastifyRequest): Promise<void> {
  // Phase 1 replaces this body with real async work (session lookup, JWT
  // verification) -- this await keeps the function honestly asynchronous in
  // the meantime, matching the app.ts call site's `await requireAuth(...)`,
  // rather than faking async with a synchronous throw. Same idiom as the
  // deliberate-failure routes in errorHandling.test.ts.
  await Promise.resolve();
  throw new AppError(401, "Not authenticated", "UNAUTHENTICATED");
}
