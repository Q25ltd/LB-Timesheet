import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { FastifyInstance } from "fastify";

// env.ts validates process.env at import time — set before the dynamic import.
process.env.DATABASE_URL = "postgresql://app:app@localhost:5544/lb_timesheet_unused";
process.env.JWT_SECRET   = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV     = "test";
process.env.WEB_ORIGIN   = "https://allowed.example.com";

const { buildApp } = await import("./app.js");
const { AppError } = await import("./lib/errors.js");

const db = {
  $queryRaw: (_q: TemplateStringsArray, ..._v: unknown[]): Promise<unknown> => Promise.resolve([{ ok: 1 }]),
  session:           { findUnique: (): Promise<null> => Promise.resolve(null) },
  companyMembership: { findUnique: (): Promise<null> => Promise.resolve(null) },
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
  // F-10 protects every route by default, these included -- these routes
  // exist only to exercise error-envelope masking (F-05), not auth, so they
  // are deliberately marked public rather than fighting the default-deny
  // guard with a fake authenticated request.
  app.post("/boom-sync", {
    config: { public: true },
    schema: { body: { type: "object", required: ["truckReg"], properties: { truckReg: { type: "string" } } } },
  }, () => {
    throw new Error("INTERNAL-MARKER sync: pg password=hunter2 at /Users/nk/secret.ts:12");
  });
  app.get("/boom-async", { config: { public: true } }, async () => {
    await Promise.resolve();
    throw new Error("INTERNAL-MARKER async: PrismaClientKnownRequestError P2002 on Shift_one_open_per_user");
  });
  app.get("/deliberate", { config: { public: true } }, () => {
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

test("an unknown error with a fabricated 4xx statusCode is masked, not trusted", async () => {
  // The exact shape the F-05 audit demonstrated: a "4xx therefore safe"
  // handler would forward this verbatim. The fix is "explicitly known-safe
  // therefore pass through" — anything else, whatever it claims, is masked
  // the same way an unlabelled 500 already is.
  const app = await buildApp(db);
  // Same reasoning as appWithFailingRoutes: this route tests error masking,
  // not auth, so it is deliberately public under F-10's default-deny.
  app.get("/teapot", { config: { public: true } }, () => {
    const error = new Error("INTERNAL-MARKER fabricated: rate limit exceeded, retry in 1 minute") as Error & {
      statusCode: number;
    };
    error.statusCode = 429;
    throw error;
  });
  const res = await app.inject({ method: "GET", url: "/teapot" });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), { error: "Something went wrong", code: "INTERNAL" });
  assert.ok(!res.body.includes("INTERNAL-MARKER"), "the fabricated error's message must not leak");
  await app.close();
});

test("a fabricated allowlisted Fastify code cannot impersonate a trusted parser error", async (t) => {
  const marker = "ALLOWLIST-SPOOF-INTERNAL-9f73c2";
  const app = await buildApp(db);
  t.after(() => app.close());
  app.get("/spoofed-fastify-code", { config: { public: true } }, () => {
    const error = new Error(marker) as Error & { statusCode: number; code: string };
    error.statusCode = 400;
    error.code = "FST_ERR_CTP_INVALID_JSON_BODY";
    throw error;
  });

  const res = await app.inject({ method: "GET", url: "/spoofed-fastify-code" });
  assert.deepEqual(
    { statusCode: res.statusCode, body: envelope(res.json()) },
    { statusCode: 500, body: { error: "Something went wrong", code: "INTERNAL" } },
  );
  assert.ok(!res.body.includes(marker), "a fabricated allowlisted code must not expose the internal message");
});

test("fabricated validation metadata cannot impersonate trusted framework validation", async (t) => {
  const marker = "VALIDATION-SPOOF-INTERNAL-a4d81e";
  const app = await buildApp(db);
  t.after(() => app.close());
  app.get("/spoofed-validation", { config: { public: true } }, () => {
    const error = new Error("fabricated validation error") as Error & {
      validation: Array<{ instancePath: string; message: string }>;
    };
    error.validation = [{ instancePath: `/${marker}`, message: `internal detail: ${marker}` }];
    throw error;
  });

  const res = await app.inject({ method: "GET", url: "/spoofed-validation" });
  assert.deepEqual(
    { statusCode: res.statusCode, body: envelope(res.json()) },
    { statusCode: 500, body: { error: "Something went wrong", code: "INTERNAL" } },
  );
  assert.ok(!res.body.includes(marker), "fabricated validation metadata must not expose internal details");
});

test("a malformed JSON body surfaces Fastify's own safe content-type error, not a mask", async () => {
  // FST_ERR_CTP_INVALID_JSON_BODY is on the explicit allowlist: fixed,
  // Fastify-authored text describing the CLIENT's own malformed request,
  // never interpolated with server internals. This must keep working once
  // the fallback branch stops trusting statusCode alone.
  const app = await appWithFailingRoutes();
  const res = await app.inject({
    method: "POST",
    url: "/boom-sync",
    headers: { "content-type": "application/json" },
    payload: "{not valid json",
  });
  assert.equal(res.statusCode, 400);
  const body = envelope(res.json());
  assert.equal(body.code, "FST_ERR_CTP_INVALID_JSON_BODY");
  assert.equal(body.error, "Body is not valid JSON but content-type is set to 'application/json'");
  await app.close();
});

test("the real rate-limit plugin surfaces a safe, fixed AppError body once the limit is hit", async () => {
  const app = await buildApp(db);
  let last = await app.inject({ method: "GET", url: "/health" });
  for (let i = 1; i < 301; i++) {
    last = await app.inject({ method: "GET", url: "/health" });
  }
  assert.equal(last.statusCode, 429);
  assert.deepEqual(last.json(), { error: "Too many requests, try again shortly", code: "RATE_LIMITED" });
  await app.close();
});
