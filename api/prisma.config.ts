// The Prisma CLI does not load .env itself, and it may be invoked from the repo
// root (knip does exactly this), where a bare `dotenv/config` would look in the
// wrong directory. Resolve .env relative to THIS file so it works from anywhere.
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig, env } from "prisma/config";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), ".env") });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
