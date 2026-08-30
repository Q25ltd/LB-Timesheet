import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { env } from "./lib/env.js";
import { allowedOrigins } from "./lib/env.schema.js";
import { registerErrorHandling } from "./lib/errors.js";

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

  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  // Every error path — thrown, validation, unknown route, crash — leaves
  // through the one envelope. Without this, Fastify's defaults return their
  // own shape and a 500 echoes the exception message to the client.
  registerErrorHandling(app);

  app.get("/health", async () => {
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
