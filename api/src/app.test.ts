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

/** Minimal stand-in — no database needed. The identity lookups find nothing:
 *  these tests carry no authenticated session, which is why every protected
 *  route below is expected to be refused. */
const db = {
  $queryRaw: (_query: TemplateStringsArray, ..._values: unknown[]): Promise<unknown> =>
    Promise.resolve([{ ok: 1 }]),
  session: {
    findUnique: (): Promise<null> => Promise.resolve(null),
    create:     () => Promise.reject(new Error("session.create is not part of this test")),
  },
  companyMembership: {
    findUnique: (): Promise<null> => Promise.resolve(null),
    findMany:   () => Promise.resolve([]),
  },
  // Start Shift's reads. Not exercised here — these tests never authenticate,
  // and /health is public — but AppDatabase now names them, so the stand-in
  // has to be honest about what the app is able to ask for.
  shift: {
    create:    () => Promise.reject(new Error("shift.create is not part of this test")),
    findFirst: () => Promise.resolve(null),
  },
  company: { findUnique: () => Promise.resolve(null) },
  user: {
    findUnique: () => Promise.resolve(null),
    // The account boundary's write (D21). It REJECTS: no case in this file
    // registers an account, so reaching it would mean the app did something
    // the test never asked for.
    create: () => Promise.reject(new Error("user.create is not part of this test")),
  },
  $transaction: () => Promise.reject(new Error("$transaction is not part of this test")),
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
  // Same stand-in as `db`, with only the health probe changed — spread so the
  // two cannot drift as AppDatabase grows.
  const failing = {
    ...db,
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

// ── F-10 (+ D21): default-deny routing across THREE postures ────────────────
// The invariant, unchanged in polarity and widened in range: every route is
// TENANT-authenticated by default. A route becomes public or identity-scoped
// only by an exact `config: { authPosture: "public" | "identity" }` marker —
// not by omission, not by a typo, not by living outside some protected
// structure. Adding a third posture must not add a way to become public. Registered
// here, after buildApp() returns, exactly the way any future feature route
// would be added: no config, no preHandler wired by hand. That is the whole
// point — this must be denied WITHOUT the route author doing anything extra.
test("a newly registered route with no auth marker is protected by default (F-10)", async () => {
  const app = await buildApp(db);
  app.get("/test-only/unmarked", () => ({ ok: true }));
  const res = await app.inject({ method: "GET", url: "/test-only/unmarked" });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), { error: "Not authenticated", code: "UNAUTHENTICATED" });
  await app.close();
});

test("a route with a config object that omits authPosture stays protected (F-10)", async () => {
  const app = await buildApp(db);
  // `config` present but empty -- distinct from the no-config case above.
  // Anything short of an exact `"public"` / `"identity"` must fail closed.
  app.get("/test-only/empty-config", { config: {} }, () => ({ ok: true }));
  const res = await app.inject({ method: "GET", url: "/test-only/empty-config" });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), { error: "Not authenticated", code: "UNAUTHENTICATED" });
  await app.close();
});

test('a route explicitly marked authPosture: "tenant" stays protected (F-10)', async () => {
  const app = await buildApp(db);
  app.get("/test-only/explicitly-private", { config: { authPosture: "tenant" } }, () => ({ ok: true }));
  const res = await app.inject({ method: "GET", url: "/test-only/explicitly-private" });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), { error: "Not authenticated", code: "UNAUTHENTICATED" });
  await app.close();
});

test('a route explicitly marked authPosture: "public" is let through (F-10)', async () => {
  const app = await buildApp(db);
  app.get("/test-only/public", { config: { authPosture: "public" } }, () => ({ ok: true }));
  const res = await app.inject({ method: "GET", url: "/test-only/public" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  await app.close();
});

// The failure mode a STRING posture marker introduces that a boolean could
// not: a value that looks deliberate and is not one of the three. A `switch`
// with a permissive default, or an `!== "tenant"` comparison, would let these
// through as public. The hook compares for exact matches instead, so an
// unrecognised posture lands in the strictest branch.
test("a misspelled or unknown posture value fails CLOSED, never open (D21)", async () => {
  const app = await buildApp(db);
  const unknownPostures = ["Public", "PUBLIC", "publik", "identity ", "none", "", "true"];

  // Every route registered BEFORE the first inject: injecting starts the
  // instance, after which Fastify refuses further registrations.
  //
  // The cast is the point of the test: TypeScript would reject each of these
  // at a real call site, so the only way this mistake reaches production is
  // through code the compiler never checked -- generated config, JSON, or a
  // plugin. The runtime must not depend on tsc.
  const urls = unknownPostures.map((posture, index) => {
    const url = `/test-only/unknown-posture-${String(index)}`;
    app.get(url, { config: { authPosture: posture as "tenant" } }, () => ({ ok: true }));
    return url;
  });

  for (const [index, url] of urls.entries()) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 401, `posture "${unknownPostures[index] ?? ""}" must not be treated as public`);
    assert.deepEqual(res.json(), { error: "Not authenticated", code: "UNAUTHENTICATED" });
  }
  await app.close();
});

// An identity route is NOT public. It has its own pipeline, and with no
// token it refuses exactly as a tenant route does -- the two postures are
// indistinguishable from outside by their rejections.
test('a route marked authPosture: "identity" still requires a token (D21)', async () => {
  const app = await buildApp(db);
  app.get("/test-only/identity", { config: { authPosture: "identity" } }, () => ({ ok: true }));
  const res = await app.inject({ method: "GET", url: "/test-only/identity" });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), { error: "Not authenticated", code: "UNAUTHENTICATED" });
  await app.close();
});

test("a route registered inside a child plugin is still denied by default -- no registration path skips the guard (F-10)", async () => {
  const app = await buildApp(db);
  // Registered the way a real feature would eventually split routes into
  // their own plugin file: app.register(subPlugin). The guard hook was
  // added on the root instance before this registration, so Fastify's
  // encapsulation model must still apply it here -- proving the "cannot
  // bypass by registering directly" guarantee is structural, not incidental.
  await app.register((child) => {
    child.get("/test-only/child-plugin-route", () => ({ ok: true }));
  });
  const res = await app.inject({ method: "GET", url: "/test-only/child-plugin-route" });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), { error: "Not authenticated", code: "UNAUTHENTICATED" });
  await app.close();
});
