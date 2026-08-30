import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { PrismaClient } from "./generated/client.js";
import { env } from "./lib/env.js";

export async function buildApp(prisma: PrismaClient): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV === "development" ? { transport: undefined, level: "info" } : true,
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  // Health — the only public route for now.
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
