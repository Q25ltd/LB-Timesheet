import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { env } from "./lib/env.js";
import { allowedOrigins } from "./lib/env.schema.js";
import { AppError, registerErrorHandling } from "./lib/errors.js";
import { requireAuth } from "./lib/auth.js";

/**
 * Only the surface the app actually uses today. Structural rather than a Pick of
 * PrismaClient, so a test can build the app without a database — and so widening
 * it later is a deliberate act. PrismaClient satisfies this.
 */
export interface AppDatabase {
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

  // F-04: every route is authenticated by default. A route becomes public
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
    await requireAuth(request);
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
