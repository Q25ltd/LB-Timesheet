/**
 * F-15 — who a request is from, for rate limiting, and what a limited
 * request costs.
 *
 *   x-real-ip  Railway's edge-set header, as ONE valid address — nothing
 *              else a client sends is believed (no X-Forwarded-For, no
 *              trustProxy), and an unusable header falls back to the socket
 *   socket     nothing a client sends is believed at all
 *   the global limit runs BEFORE authentication: over it, no Session is read
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

process.env.DATABASE_URL = "postgresql://app:app@localhost:5544/lb_timesheet_unused";
process.env.JWT_SECRET   = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV     = "test";
process.env.WEB_ORIGIN   = "https://allowed.example.com";

const { buildApp } = await import("./app.js");
const { clientAddressOf } = await import("./lib/clientAddress.js");
const { emptyDatabase } = await import("./tests/fakeDatabase.js");

const GLOBAL_LIMIT = 300;

function requestFrom(socketIp: string, headers: Record<string, string | string[]>) {
  return { ip: socketIp, headers };
}

test("x-real-ip: ONE valid address is the client; anything else falls back to the socket — never a client's choice", () => {
  const of = clientAddressOf("x-real-ip");
  assert.equal(of(requestFrom("10.0.0.1", { "x-real-ip": "203.0.113.7" })), "203.0.113.7");
  assert.equal(of(requestFrom("10.0.0.1", { "x-real-ip": " 2001:db8::1 " })), "2001:db8::1");
  for (const header of ["", "garbage", "203.0.113.7, 198.51.100.9", "203.0.113.7:443", "unknown"]) {
    assert.equal(of(requestFrom("10.0.0.1", { "x-real-ip": header })), "10.0.0.1", JSON.stringify(header));
  }
  assert.equal(of(requestFrom("10.0.0.1", { "x-real-ip": ["203.0.113.7", "198.51.100.9"] })), "10.0.0.1", "a repeated header is not one address");
  assert.equal(of(requestFrom("10.0.0.1", { "x-forwarded-for": "203.0.113.7" })), "10.0.0.1", "X-Forwarded-For is never read");
});

test("socket: no header is believed", () => {
  const of = clientAddressOf("socket");
  assert.equal(of(requestFrom("10.0.0.1", { "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.9" })), "10.0.0.1");
});

async function exhaust(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>): Promise<number> {
  let last = 0;
  for (let i = 0; i <= GLOBAL_LIMIT; i += 1) {
    last = (await app.inject({ method: "GET", url: "/health/live", headers })).statusCode;
  }
  return last;
}

test("behind Railway (x-real-ip), each client has its OWN bucket — and X-Forwarded-For cannot buy a new one", async () => {
  const { db } = emptyDatabase();
  const app = await buildApp(db, { clientIpSource: "x-real-ip" });
  try {
    assert.equal(await exhaust(app, { "x-real-ip": "203.0.113.7" }), 429, "client A over its limit");
    const otherClient = await app.inject({ method: "GET", url: "/health/live", headers: { "x-real-ip": "198.51.100.9" } });
    assert.equal(otherClient.statusCode, 200, "client B is not punished for A — the bug a proxy-keyed limit has");
    const spoofed = await app.inject({ method: "GET", url: "/health/live", headers: { "x-real-ip": "203.0.113.7", "x-forwarded-for": "192.0.2.55" } });
    assert.equal(spoofed.statusCode, 429, "a forged X-Forwarded-For changes nothing");
  } finally {
    await app.close();
  }
});

test("every answer carries the client's own remaining allowance — the observable used to verify the live edge", async () => {
  const { db } = emptyDatabase();
  const app = await buildApp(db, { clientIpSource: "x-real-ip" });
  try {
    const remaining = async (ip: string) =>
      (await app.inject({ method: "GET", url: "/health/live", headers: { "x-real-ip": ip } })).headers["x-ratelimit-remaining"];
    assert.equal(await remaining("203.0.113.7"), "299");
    assert.equal(await remaining("203.0.113.7"), "298", "the same client counts down");
    assert.equal(await remaining("198.51.100.9"), "299", "another client has its own count");
  } finally {
    await app.close();
  }
});

test("with socket, a client cannot escape its limit by sending any header", async () => {
  const { db } = emptyDatabase();
  const app = await buildApp(db, { clientIpSource: "socket" });
  try {
    assert.equal(await exhaust(app, {}), 429);
    for (const headers of [{ "x-real-ip": "198.51.100.9" }, { "x-forwarded-for": "198.51.100.9" }]) {
      assert.equal((await app.inject({ method: "GET", url: "/health/live", headers })).statusCode, 429, JSON.stringify(headers));
    }
  } finally {
    await app.close();
  }
});

test("the endpoint limits count per CLIENT too: one client's resets do not exhaust another's", async () => {
  const { db } = emptyDatabase();
  const app = await buildApp(db, { clientIpSource: "x-real-ip" });
  try {
    const forgot = (ip: string) => app.inject({ method: "POST", url: "/auth/password/forgot", headers: { "x-real-ip": ip }, payload: { email: "a@example.com" } });
    let status = 0;
    for (let i = 0; i < 6; i += 1) status = (await forgot("203.0.113.7")).statusCode;
    assert.equal(status, 429, "5 per hour per client (D50)");
    assert.equal((await forgot("198.51.100.9")).statusCode, 204, "another client is unaffected");
  } finally {
    await app.close();
  }
});

/** A correctly SIGNED tenant token — so authentication would read the Session. */
function tenantToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = encode({ alg: "HS256", typ: "JWT" });
  const body = encode({
    sub: "user-1", companyId: "company-1", membershipId: "membership-1", sessionId: "session-1",
    iat: now, exp: now + 600, iss: "logisticbay-timesheets", aud: "timesheets-api",
  });
  const signature = createHmac("sha256", process.env.JWT_SECRET ?? "").update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${signature}`;
}

test("F-15: a request over the limit is refused BEFORE authentication — it reads no Session", async () => {
  const { db, counters } = emptyDatabase();
  const app = await buildApp(db, { clientIpSource: "socket" });
  const authorization = `Bearer ${tenantToken()}`;
  try {
    for (let i = 0; i < GLOBAL_LIMIT; i += 1) {
      assert.equal((await app.inject({ method: "GET", url: "/shifts/current", headers: { authorization } })).statusCode, 401);
    }
    assert.equal(counters.sessionReads, GLOBAL_LIMIT, "each request within the limit was authenticated");
    for (let i = 0; i < 25; i += 1) {
      assert.equal((await app.inject({ method: "GET", url: "/shifts/current", headers: { authorization } })).statusCode, 429);
    }
    assert.equal(counters.sessionReads, GLOBAL_LIMIT, "a flood over the limit costs the database nothing");
  } finally {
    await app.close();
  }
});
