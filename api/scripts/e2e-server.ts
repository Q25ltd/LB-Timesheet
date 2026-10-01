/**
 * e2e-server — the API the browser tests run against (owner decision B8).
 *
 * Provisions a CLEAN `lb_timesheet_e2e` database through the real migrations
 * (`prisma migrate deploy`, never `db push`), then starts the ordinary server
 * on it. The developer's own database is never touched, and nothing here is
 * reachable outside this machine:
 *
 *   - it refuses any DATABASE_URL whose host is not local;
 *   - it runs the API as NODE_ENV=development, so account emails are written
 *     to `api/.mail-outbox/` (lib/mailer.ts) where the tests read them —
 *     no email provider is involved;
 *   - its signing secret is a fixed, test-only value that the production
 *     schema would refuse (too short for production).
 *
 * Started and stopped by Playwright's `webServer` (web/playwright.config.ts).
 */
import { Client } from "pg";
import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(API_ROOT, ".env"), quiet: true });

const E2E_DB = "lb_timesheet_e2e";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const base = process.env.DATABASE_URL;
if (base === undefined || base === "") {
  console.error("e2e-server: DATABASE_URL must be set (the local Postgres server to use)");
  process.exit(1);
}
if (!LOCAL_HOSTS.has(new URL(base).hostname)) {
  console.error("e2e-server: refusing a non-local database server");
  process.exit(1);
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const admin = new Client({ connectionString: withDatabase(base, "postgres") });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS "${E2E_DB}" WITH (FORCE)`);
await admin.query(`CREATE DATABASE "${E2E_DB}"`);
await admin.end();

const databaseUrl = withDatabase(base, E2E_DB);
const migrated = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  cwd: API_ROOT,
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: databaseUrl },
});
if (migrated.status !== 0) process.exit(migrated.status ?? 1);

const webOrigin = process.env.E2E_WEB_ORIGIN ?? "http://localhost:4175";
const server = spawn("npx", ["tsx", "src/server.ts"], {
  cwd: API_ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL:     databaseUrl,
    NODE_ENV:         "development",
    PORT:             process.env.E2E_API_PORT ?? "3100",
    WEB_ORIGIN:       webOrigin,
    WEB_APP_URL:      webOrigin,
    SENDGRID_API_KEY: "",
    JWT_SECRET:       "e2e-only-7c1f9a3b5d2e8046b1c7a9f3e5d20b84",
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { server.kill(signal); });
}
server.on("exit", code => { process.exit(code ?? 0); });
