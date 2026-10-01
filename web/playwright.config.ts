import { defineConfig, devices } from "@playwright/test";

/**
 * Real-browser tests of the account flows (owner decision B8).
 *
 * Playwright starts BOTH tiers itself and stops them afterwards:
 *
 *   API  `npm run e2e:server --prefix ../api` — a fresh `lb_timesheet_e2e`
 *        database built by the real migrations, on :3100, emails written to
 *        `api/.mail-outbox/` (no provider)
 *   web  the Vite dev server on :4175, pointed at that API
 *
 * Only a local Postgres is needed — the same one `npm run check` uses — so
 * this suite depends on no external service. It is NOT part of
 * `npm run check`; it runs as `npm run test:e2e` and as its own CI job.
 */
const API = "http://localhost:3100";
const WEB = "http://localhost:4175";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: WEB,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm run e2e:server --prefix ../api",
      url: `${API}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "npx vite --port 4175 --strictPort",
      url: WEB,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_API_URL: API },
    },
  ],
});
