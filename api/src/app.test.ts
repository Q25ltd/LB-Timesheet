import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

// env.ts validates process.env at import time and exits on failure, so these
// must be set BEFORE app.js is loaded. Hence the dynamic import below.
process.env.DATABASE_URL = "postgresql://app:app@localhost:5544/lb_timesheet_unused";
process.env.JWT_SECRET   = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV     = "test";
process.env.WEB_ORIGIN   = "https://allowed.example.com";

const { buildApp } = await import("./app.js");

/** Minimal stand-in — /health only calls $queryRaw. No database needed. */
const db = {
  $queryRaw: (_query: TemplateStringsArray, ..._values: unknown[]): Promise<unknown> =>
    Promise.resolve([{ ok: 1 }]),
};

/** /health's response shape — parsed rather than reached into, since
 *  res.json() is `any` and unchecked member access on it is banned. */
const HealthBody = z.object({
  status:  z.enum(["ok", "degraded"]),
  service: z.string().max(64),
  db:      z.enum(["up", "down"]),
  time:    z.string().max(64),
});

function health(payload: unknown): z.infer<typeof HealthBody> {
  return HealthBody.parse(payload);
}

const ALLOWED = "https://allowed.example.com";
const FOREIGN = "https://evil.example.com";

test("an allowed origin receives Access-Control-Allow-Origin", async () => {
  const app = await buildApp(db);
  const res = await app.inject({ method: "GET", url: "/health", headers: { origin: ALLOWED } });
  assert.equal(res.headers["access-control-allow-origin"], ALLOWED);
  await app.close();
});

test("a FOREIGN origin receives NO Access-Control-Allow-Origin", async () => {
  const app = await buildApp(db);
  const res = await app.inject({ method: "GET", url: "/health", headers: { origin: FOREIGN } });
  assert.equal(
    res.headers["access-control-allow-origin"],
    undefined,
    "a foreign origin must never be reflected",
  );
  await app.close();
});

test("a foreign preflight is not granted", async () => {
  const app = await buildApp(db);
  const res = await app.inject({
    method: "OPTIONS",
    url: "/health",
    headers: {
      origin: FOREIGN,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  await app.close();
});

test("credentials are never allowed — authority travels in a header, not a cookie", async () => {
  const app = await buildApp(db);
  const res = await app.inject({ method: "GET", url: "/health", headers: { origin: ALLOWED } });
  assert.equal(res.headers["access-control-allow-credentials"], undefined);
  await app.close();
});

test("a request with no Origin header still works and gets no CORS headers", async () => {
  const app = await buildApp(db);
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
  await app.close();
});

test("/health reports db up when the query succeeds", async () => {
  const app = await buildApp(db);
  const res = await app.inject({ method: "GET", url: "/health" });
  const body: unknown = res.json();
  assert.equal(health(body).db, "up");
  await app.close();
});

test("/health reports degraded when the query fails", async () => {
  const failing = {
    $queryRaw: (): Promise<unknown> => Promise.reject(new Error("no database")),
  };
  const app = await buildApp(failing);
  const res = await app.inject({ method: "GET", url: "/health" });
  const body: unknown = res.json();
  const parsed = health(body);
  assert.equal(parsed.status, "degraded");
  assert.equal(parsed.db, "down");
  await app.close();
});
