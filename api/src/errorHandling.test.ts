import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { FastifyInstance } from "fastify";

// env.ts validates process.env at import time — set before the dynamic import.
process.env.DATABASE_URL = "postgresql://app:app@localhost:5544/lb_timesheet_unused";
process.env.JWT_SECRET   = "x".repeat(40);
process.env.NODE_ENV     = "test";
process.env.WEB_ORIGIN   = "https://allowed.example.com";

const { buildApp } = await import("./app.js");
const { AppError } = await import("./lib/errors.js");

const db = {
  $queryRaw: (_q: TemplateStringsArray, ..._v: unknown[]): Promise<unknown> => Promise.resolve([{ ok: 1 }]),
};

/** The envelope, and NOTHING else: no Fastify `message`/`statusCode` keys. */
const Envelope = z.strictObject({
  error:   z.string().max(500),
  code:    z.string().max(64).optional(),
  details: z.unknown().optional(),
});

function envelope(payload: unknown): z.infer<typeof Envelope> {
  return Envelope.parse(payload);
}

/**
 * Routes that misbehave on purpose. Added here, in the test, so production
 * code carries no test-only endpoints — buildApp is unchanged.
 */
async function appWithFailingRoutes(): Promise<FastifyInstance> {
  const app = await buildApp(db);
  app.post("/boom-sync", {
    schema: { body: { type: "object", required: ["truckReg"], properties: { truckReg: { type: "string" } } } },
  }, () => {
    throw new Error("INTERNAL-MARKER sync: pg password=hunter2 at /Users/nk/secret.ts:12");
  });
  app.get("/boom-async", async () => {
    await Promise.resolve();
    throw new Error("INTERNAL-MARKER async: PrismaClientKnownRequestError P2002 on Shift_one_open_per_user");
  });
  app.get("/deliberate", () => {
    throw new AppError(409, "Shift already submitted", "SHIFT_ALREADY_SUBMITTED", { shiftId: "abc" });
  });
  return app;
}

test("unknown route returns the envelope, not Fastify's default shape", async () => {
  const app = await buildApp(db);
  const res = await app.inject({ method: "GET", url: "/no-such-route" });
  assert.equal(res.statusCode, 404);
  const body = envelope(res.json());
  assert.equal(body.error, "Not found");
  assert.equal(body.code, "NOT_FOUND");
  await app.close();
});

test("validation failure returns 400 in the envelope with the validation list", async () => {
  const app = await appWithFailingRoutes();
  const res = await app.inject({ method: "POST", url: "/boom-sync", payload: { wrong: true } });
  assert.equal(res.statusCode, 400);
  const body = envelope(res.json());
  assert.equal(body.error, "Invalid request");
  assert.equal(body.code, "VALIDATION");
  assert.ok(Array.isArray(body.details), "validation details should be the validation list");
  await app.close();
});

test("a synchronous throw is masked to the fixed 500 body", async () => {
  const app = await appWithFailingRoutes();
  const res = await app.inject({ method: "POST", url: "/boom-sync", payload: { truckReg: "AB24 XYZ" } });
  assert.equal(res.statusCode, 500);
  const body = envelope(res.json());
  assert.equal(body.error, "Something went wrong");
  assert.equal(body.code, "INTERNAL");
  await app.close();
});

test("an asynchronous throw is masked identically", async () => {
  const app = await appWithFailingRoutes();
  const res = await app.inject({ method: "GET", url: "/boom-async" });
  assert.equal(res.statusCode, 500);
  assert.equal(envelope(res.json()).code, "INTERNAL");
  await app.close();
});

test("nothing internal leaks through a 500 — message, Prisma, paths, stack", async () => {
  const app = await appWithFailingRoutes();
  for (const probe of [
    { method: "POST" as const, url: "/boom-sync", payload: { truckReg: "x" } },
    { method: "GET" as const, url: "/boom-async" },
  ]) {
    const res = await app.inject(probe);
    const raw = res.body;
    for (const secret of ["INTERNAL-MARKER", "hunter2", "Prisma", "P2002", "/Users/", "secret.ts", "at "]) {
      assert.ok(!raw.includes(secret), `response leaked ${JSON.stringify(secret)}: ${raw}`);
    }
  }
  await app.close();
});

test("a deliberate AppError keeps its status, message, code and details exactly", async () => {
  const app = await appWithFailingRoutes();
  const res = await app.inject({ method: "GET", url: "/deliberate" });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), {
    error: "Shift already submitted",
    code: "SHIFT_ALREADY_SUBMITTED",
    details: { shiftId: "abc" },
  });
  await app.close();
});

test("rate-limit style Fastify 4xx errors keep their status and pass through the envelope", async () => {
  const app = await buildApp(db);
  // Same shape @fastify/rate-limit and friends produce: statusCode + message.
  app.get("/teapot", () => {
    const error = new Error("Rate limit exceeded, retry in 1 minute") as Error & { statusCode: number };
    error.statusCode = 429;
    throw error;
  });
  const res = await app.inject({ method: "GET", url: "/teapot" });
  assert.equal(res.statusCode, 429);
  const body = envelope(res.json());
  assert.equal(body.error, "Rate limit exceeded, retry in 1 minute");
  await app.close();
});
