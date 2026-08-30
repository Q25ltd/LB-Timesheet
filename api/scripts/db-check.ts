/**
 * db-check — provision a CLEAN database, apply real migrations, run the
 * database integrity tests. This is what `npm run test:db` now means.
 *
 * Why a script instead of a shell one-liner: the same file must behave
 * identically on a developer Mac (docker Postgres on 5544) and in CI (service
 * container on 5432), with no docker/psql binary dependency — only the `pg`
 * driver and the Prisma CLI, both already in node_modules.
 *
 * The developer's dev database is NEVER touched. The tests run against a
 * dedicated `lb_timesheet_check` database that is dropped and recreated from
 * migrations on every run — so the gate cannot be poisoned by local state, and
 * `prisma migrate deploy` (the production code path) is exercised every time.
 */
import { Client } from "pg";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(API_ROOT, ".env") });

const CHECK_DB = "lb_timesheet_check";

const base = process.env.DATABASE_URL;
if (base === undefined || base === "") {
  console.error("db-check: DATABASE_URL must be set (points at the Postgres server to use)");
  process.exit(1);
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function run(label: string, command: string, args: string[], databaseUrl: string): void {
  console.log(`\ndb-check: ${label}`);
  const result = spawnSync(command, args, {
    cwd: API_ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (result.status !== 0) {
    console.error(`db-check: ${label} FAILED (exit ${String(result.status)})`);
    process.exit(result.status ?? 1);
  }
}

// 1. Drop and recreate the check database. CREATE DATABASE cannot run inside a
//    transaction, so this needs a direct connection to the server's own db.
const admin = new Client({ connectionString: withDatabase(base, "postgres") });
try {
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${CHECK_DB}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${CHECK_DB}"`);
  console.log(`db-check: clean database "${CHECK_DB}" created`);
} catch (error) {
  console.error("db-check: could not provision the check database.");
  console.error("          Is Postgres running? Locally: docker compose up -d");
  console.error(error instanceof Error ? `          ${error.message}` : error);
  process.exit(1);
} finally {
  await admin.end().catch(() => {
    /* connection already gone — nothing to clean up */
  });
}

const checkUrl = withDatabase(base, CHECK_DB);

// 2. Real migrations — the production code path, never `db push`.
run("prisma migrate deploy", "npx", ["prisma", "migrate", "deploy"], checkUrl);

// 3. The integrity tests, against the database the migrations just built.
run("integrity tests", "npm", ["run", "test:db:run"], checkUrl);

console.log("\ndb-check: OK — migrations deployed cleanly and all integrity tests passed");
