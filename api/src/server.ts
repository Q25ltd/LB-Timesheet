import "dotenv/config";
import { PrismaClient } from "./generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { buildApp } from "./app.js";
import { env, mailDisabled } from "./lib/env.js";

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
const prisma  = new PrismaClient({ adapter });
const app     = await buildApp(prisma);

async function shutdown() {
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}
// Wrapped rather than passed directly: process.on expects a void-returning
// listener, so handing it an async function means a rejection during
// shutdown is swallowed with no trace. Found by eslint no-misused-promises.
process.on("SIGINT",  () => { shutdown().catch(() => process.exit(1)); });
process.on("SIGTERM", () => { shutdown().catch(() => process.exit(1)); });

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  app.log.info(`LogisticBay Timesheets API on http://localhost:${env.PORT}`);
  if (mailDisabled) app.log.warn("SENDGRID_API_KEY is empty — email sending is disabled");
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
