/**
 * Where the Fastify API lives — the ONE authority for authentication,
 * sessions and tenant context (D44). The web app is only its client.
 *
 * `VITE_API_URL` overrides it. Without one, development uses the local API
 * and a production build uses the API host D3 assigns to this product. The
 * production host is also named in `vercel.json`'s Content-Security-Policy
 * (`connect-src`); a test keeps the two in step.
 */
export const PRODUCTION_API = "https://api.timesheets.logisticbay.com";
const DEVELOPMENT_API = "http://localhost:3000";

function configured(): string | null {
  const value: unknown = import.meta.env["VITE_API_URL"];
  return typeof value === "string" && value.trim() !== "" ? value.trim().replace(/\/$/, "") : null;
}

export const API_BASE = configured() ?? (import.meta.env.DEV ? DEVELOPMENT_API : PRODUCTION_API);
