// The Prisma CLI does not load .env itself, and it may be invoked from the repo
// root (knip does exactly this), where a bare `dotenv/config` would look in the
// wrong directory. Resolve .env relative to THIS file so it works from anywhere.
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "prisma/config";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), ".env") });

// `prisma generate` needs no database, and a build machine may have none: so
// an absent DATABASE_URL is not an error HERE. Every command that does reach
// a database (migrate, db, studio) still fails — on an empty URL — rather
// than guessing one.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["DATABASE_URL"] ?? "" },
});
