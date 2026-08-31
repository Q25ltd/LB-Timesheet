import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { env } from "./lib/env.js";
import { allowedOrigins } from "./lib/env.schema.js";
import { AppError, registerErrorHandling } from "./lib/errors.js";
import {
  requireAuth,
  ACCESS_TOKEN_ALGORITHM,
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
} from "./lib/auth.js";
import { authStore, type AuthQueryable } from "./lib/authStore.js";

/**
 * Only the surface the app actually uses today. Structural rather than a Pick of
 * PrismaClient, so a test can build the app without a database — and so widening
 * it later is a deliberate act. PrismaClient satisfies this.
 *
 * The two identity reads arrive through AuthQueryable, which names them
 * individually. They are handed to `authStore` here and never travel further:
 * requireAuth receives the narrow AuthStore, not this type.
 */
export interface AppDatabase extends AuthQueryable {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

export async function buildApp(prisma: AppDatabase): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV === "development" ? { transport: undefined, level: "info" } : true,
  });

  // An explicit, normalised allowlist — never `origin: true`, which reflects
  // whatever Origin the caller sent and lets any site read the response.
  // `credentials` stays false: authority travels in an Authorization header
  // (AUTH.md), not a cookie. Enabling it is an architectural change.
  await app.register(cors, { origin: allowedOrigins(env), credentials: false });

  // AUTH.md's access token. Only `verify` is configured: this boundary
  // verifies tokens, it does not mint them. `algorithms` is pinned so an
  // `alg: none` or algorithm-confusion token cannot verify, and iss/aud make a
  // LogisticBay TMS token structurally unusable here (D1). The secret is the
  // one already validated by env.schema.ts -- there is no second source.
  //
  // `requiredClaims` is not optional hardening: allowedIss/allowedAud are
  // VALUE validators that skip a claim which is absent, and expiry is only
  // checked when `exp` exists. Without this, a token simply omitting exp/iss/
  // aud verifies -- an unexpiring, cross-product-usable token. Presence of the
  // registered claims is enforced here; the identity claims (sub, companyId,
  // membershipId, sessionId) are enforced by the schema in lib/auth.ts, so
  // each claim is decided in exactly one place.
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    verify: {
      algorithms:     [ACCESS_TOKEN_ALGORITHM],
      allowedIss:     ACCESS_TOKEN_ISSUER,
      allowedAud:     ACCESS_TOKEN_AUDIENCE,
      requiredClaims: ["iat", "exp", "iss", "aud"],
    },
  });

  // Built once, from the two named delegates. This is the only object the
  // authentication boundary can read through.
  const identity = authStore(prisma);

  // F-10: every route is authenticated by default. A route becomes public
  // only through the explicit `config: { public: true }` marker below --
  // never by omission, and never by living outside some protected structure.
  // Registered on the root instance before any route, so Fastify's
  // encapsulation model applies it to every route added afterwards --
  // including ones later split into their own plugin files -- with no
  // registration path that skips it.
  //
  // Placed AFTER `cors` and BEFORE `rateLimit`: a CORS preflight carries no
  // Authorization header by design, and cors's own onRequest hook already
  // replies to OPTIONS and ends the hook chain before this one runs, so
  // preflight is never blocked here. Placed before rate-limiting so a
  // rejected request is denied as cheaply as possible, without spending a
  // rate-limit slot on a request that was never getting through.
  app.addHook("onRequest", async (request) => {
    if (request.is404) return; // no route matched -- let 404 handling run
    if (request.routeOptions.config.public === true) return;
    await requireAuth(request, identity);
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    // Route rate-limit rejections through the app's own envelope with a
    // fixed, safe message -- not the plugin's default body, and not the
    // generic 4xx-passthrough this replaces (F-05).
    errorResponseBuilder: () => new AppError(429, "Too many requests, try again shortly", "RATE_LIMITED"),
  });

  // Every error path — thrown, validation, unknown route, crash — leaves
  // through the one envelope. Without this, Fastify's defaults return their
  // own shape and a 500 echoes the exception message to the client.
  registerErrorHandling(app);

  app.get("/health", { config: { public: true } }, async () => {
    const dbOk = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
    return {
      status:  dbOk ? "ok" : "degraded",
      service: "lb-timesheet-api",
      db:      dbOk ? "up" : "down",
      time:    new Date().toISOString(),
    };
  });

  return app;
}
