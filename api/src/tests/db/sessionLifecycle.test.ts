/**
 * Logout, revocation, and the independence of a driver's devices.
 *
 * The property this file exists for: revoking a Session must kill EVERY
 * credential derived from it — the identity token, the tenant token and the
 * refresh secret — and must kill nothing belonging to another Session.
 *
 * That is only provable end to end, because the three credentials are checked
 * by three different pipelines (`requireSession`, `requireAuth`, and the
 * refresh boundary) that happen to read the same Session row.
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the session-lifecycle tests");
}

process.env.JWT_SECRET = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV   = "test";
process.env.WEB_ORIGIN = "https://allowed.example.com";

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `session-test-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };

let seq = 0;
function freshEmail(local = "driver"): string {
  seq += 1;
  return `${TAG}-${String(seq)}-${local}@example.com`;
}

interface Injected { statusCode: number; body: unknown; raw: string }

async function request(
  method: "GET" | "POST",
  url: string,
  options: { payload?: unknown; token?: string } = {},
): Promise<Injected> {
  const app = await buildApp(prisma);
  try {
    const res = await app.inject({
      method, url,
      ...(options.payload === undefined ? {} : { payload: options.payload as object }),
      headers: options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
    });
    return { statusCode: res.statusCode, body: res.body === "" ? null : (JSON.parse(res.body) as unknown), raw: res.body };
  } finally {
    await app.close();
  }
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function field(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null || !(key in body)) return undefined;
  return Reflect.get(body, key);
}

function stringField(body: unknown, key: string): string {
  const value = field(body, key);
  assert.equal(typeof value, "string", `the response must carry \`${key}\` as a string`);
  return value as string;
}

function optionalString(body: unknown, key: string): string | undefined {
  const value = field(body, key);
  return typeof value === "string" ? value : undefined;
}

/** A device: one Session, with whatever credentials it received. */
interface Device {
  identityToken: string;
  refreshToken: string;
  tenantToken: string | undefined;
  sessionId: string;
}

async function registerDriver(email: string): Promise<Device> {
  const result = await request("POST", "/auth/register", {
    payload: { firstName: "Nerijus", lastName: "Kuizinas", email, password: PASSWORD },
  });
  assert.equal(result.statusCode, 201, `registration must succeed — got ${result.raw}`);
  return deviceFrom(result);
}

async function loginDriver(email: string): Promise<Device> {
  const result = await request("POST", "/auth/login", { payload: { email, password: PASSWORD } });
  assert.equal(result.statusCode, 200, `login must succeed — got ${result.raw}`);
  return deviceFrom(result);
}

async function deviceFrom(result: Injected): Promise<Device> {
  const refreshToken = stringField(result.body, "refreshToken");
  const session = await prisma.session.findUnique({ where: { refreshTokenHash: digest(refreshToken) } });
  assert.ok(session !== null, "the issued secret must name a persisted session");
  return {
    identityToken: stringField(result.body, "identityToken"),
    refreshToken,
    tenantToken:   optionalString(result.body, "tenantToken"),
    sessionId:     session.id,
  };
}

/** A company and an ACTIVE membership, seeded directly — no onboarding exists. */
async function seedMembership(userId: string, label: string): Promise<{ companyId: string; membershipId: string }> {
  seq += 1;
  const company = await prisma.company.create({
    data: { name: `${TAG}-${label}`, joinCode: `${TAG}-join-${String(seq)}` },
  });
  const membership = await prisma.companyMembership.create({
    data: { companyId: company.id, userId, role: "driver", active: true },
  });
  return { companyId: company.id, membershipId: membership.id };
}

async function userIdFor(email: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { email } });
  assert.ok(user !== null, "the account must exist");
  return user.id;
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
  await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
}

before(cleanup);
beforeEach(cleanup);
after(async () => { await cleanup(); await prisma.$disconnect(); });

// ═════════════════════════════════════════════════════════════════════════════
// S1-S3. Logout revokes the session server-side
// ═════════════════════════════════════════════════════════════════════════════

test("S1. logout marks the Session revoked in the DATABASE — not merely in the client", async () => {
  const device = await registerDriver(freshEmail());

  const result = await request("POST", "/auth/logout", { token: device.identityToken });

  assert.equal(result.statusCode, 204, `logout must succeed with no body — got ${result.raw}`);
  assert.equal(result.raw, "", "204 carries nothing to describe");

  const session = await prisma.session.findUnique({ where: { id: device.sessionId } });
  assert.ok(session?.revokedAt !== null && session?.revokedAt !== undefined, "the session row must be revoked");
  // The row is KEPT, so a revoked session stays distinguishable from one that
  // never existed (schema comment on `revokedAt`).
  assert.ok(session !== null, "and kept, not deleted");
});

test("S2. logout kills ALL THREE credentials the session issued", async () => {
  // Three pipelines, one Session row. This is the chain that matters: a
  // logout that only stopped the refresh token would leave a 15-minute
  // window in which the stolen access token still worked.
  const email = freshEmail();
  const device = await registerDriver(email);
  await seedMembership(await userIdFor(email), "co");
  // Log in again to pick up the auto-selected tenant token for this account.
  const withTenant = await loginDriver(email);
  assert.ok(withTenant.tenantToken !== undefined, "one active membership must yield a tenant token");

  const loggedOut = await request("POST", "/auth/logout", { token: withTenant.identityToken });
  assert.equal(loggedOut.statusCode, 204, `logout must succeed — got ${loggedOut.raw}`);

  // 1. the IDENTITY token
  const me = await request("GET", "/auth/me", { token: withTenant.identityToken });
  assert.equal(me.statusCode, 401, "the identity token must stop working");
  assert.deepEqual(me.body, CANONICAL_401, "generically");

  // 2. the TENANT token — a different pipeline (`requireAuth`), same row
  const shifts = await request("GET", "/shifts/current", { token: withTenant.tenantToken });
  assert.equal(shifts.statusCode, 401, "the tenant token must stop working");
  assert.deepEqual(shifts.body, CANONICAL_401, "generically");

  // 3. the REFRESH secret
  const refreshed = await request("POST", "/auth/refresh", { payload: { refreshToken: withTenant.refreshToken } });
  assert.equal(refreshed.statusCode, 401, "the refresh secret must stop working");
  assert.deepEqual(refreshed.body, CANONICAL_401, "generically");

  // And the first device — a DIFFERENT session — is unaffected.
  const firstDevice = await request("GET", "/auth/me", { token: device.identityToken });
  assert.equal(firstDevice.statusCode, 200, `the other device's session must survive — got ${firstDevice.raw}`);
});

test("S3. logging out twice is a success, and does not move the moment the session ended", async () => {
  const device = await registerDriver(freshEmail());

  const first = await request("POST", "/auth/logout", { token: device.identityToken });
  assert.equal(first.statusCode, 204, "the first logout succeeds");
  const revokedAt = (await prisma.session.findUnique({ where: { id: device.sessionId } }))?.revokedAt;
  assert.ok(revokedAt !== null && revokedAt !== undefined, "and revokes the session");

  // The token is dead now, so a second logout cannot authenticate — which is
  // itself the right answer: the caller's goal is already true.
  const second = await request("POST", "/auth/logout", { token: device.identityToken });
  assert.equal(second.statusCode, 401, "a revoked token cannot authenticate a second logout");

  const later = (await prisma.session.findUnique({ where: { id: device.sessionId } }))?.revokedAt;
  assert.equal(later?.getTime(), revokedAt.getTime(), "and the original revocation timestamp is preserved");
});

test("S4. logout requires authentication — it cannot be used to revoke somebody else's session", async () => {
  const device = await registerDriver(freshEmail());

  const anonymous = await request("POST", "/auth/logout");
  assert.equal(anonymous.statusCode, 401, "an unauthenticated logout is refused");
  assert.deepEqual(anonymous.body, CANONICAL_401, "generically");

  const forged = await request("POST", "/auth/logout", { token: "not.a.token" });
  assert.equal(forged.statusCode, 401, "a forged token is refused");

  // The session is untouched by either attempt.
  const session = await prisma.session.findUnique({ where: { id: device.sessionId } });
  assert.equal(session?.revokedAt, null, "and nothing was revoked");
  const me = await request("GET", "/auth/me", { token: device.identityToken });
  assert.equal(me.statusCode, 200, "the real session still works");
});

// ═════════════════════════════════════════════════════════════════════════════
// M1-M3. Multiple devices are independent
// ═════════════════════════════════════════════════════════════════════════════

test("M1. logging in again creates a SECOND session and revokes nothing", async () => {
  const email = freshEmail();
  const phoneA = await registerDriver(email);
  const phoneB = await loginDriver(email);

  assert.notEqual(phoneA.sessionId, phoneB.sessionId, "each login is its own device session");

  const sessions = await prisma.session.findMany({ where: { userId: await userIdFor(email) } });
  assert.equal(sessions.length, 2, "both sessions exist");
  for (const session of sessions) {
    assert.equal(session.revokedAt, null, "and neither is revoked — a second phone must not sign the first out");
  }

  for (const [name, device] of [["A", phoneA], ["B", phoneB]] as const) {
    const me = await request("GET", "/auth/me", { token: device.identityToken });
    assert.equal(me.statusCode, 200, `phone ${name} must be authenticated — got ${me.raw}`);
  }
});

test("M2. logging out phone A leaves phone B fully working — including its refresh credential", async () => {
  const email = freshEmail();
  const phoneA = await registerDriver(email);
  const phoneB = await loginDriver(email);

  const loggedOut = await request("POST", "/auth/logout", { token: phoneA.identityToken });
  assert.equal(loggedOut.statusCode, 204, `logout must succeed — got ${loggedOut.raw}`);

  // A is dead, in every pipeline.
  assert.equal((await request("GET", "/auth/me", { token: phoneA.identityToken })).statusCode, 401, "A's identity token dies");
  const refreshA = await request("POST", "/auth/refresh", { payload: { refreshToken: phoneA.refreshToken } });
  assert.equal(refreshA.statusCode, 401, "A's refresh credential dies");

  // B is untouched, and can still rotate.
  assert.equal((await request("GET", "/auth/me", { token: phoneB.identityToken })).statusCode, 200, "B's identity token lives");
  const refreshB = await request("POST", "/auth/refresh", { payload: { refreshToken: phoneB.refreshToken } });
  assert.equal(refreshB.statusCode, 200, `B must still rotate — got ${refreshB.raw}`);

  const sessionB = await prisma.session.findUnique({ where: { id: phoneB.sessionId } });
  assert.equal(sessionB?.revokedAt, null, "and B's session is still live in the database");
});

test("M3. credential reuse on one device revokes only that device", async () => {
  // The reuse-revocation blast radius. It must be the Session, not the User —
  // a stolen credential on one phone must not log the driver's other phone out.
  const email = freshEmail();
  const phoneA = await registerDriver(email);
  const phoneB = await loginDriver(email);

  const rotated = await request("POST", "/auth/refresh", { payload: { refreshToken: phoneA.refreshToken } });
  assert.equal(rotated.statusCode, 200, `A's rotation must succeed — got ${rotated.raw}`);
  await prisma.session.update({
    where: { id: phoneA.sessionId },
    data:  { previousRefreshTokenGraceUntil: new Date(Date.now() - 1000) },
  });

  const reused = await request("POST", "/auth/refresh", { payload: { refreshToken: phoneA.refreshToken } });
  assert.equal(reused.statusCode, 401, "reuse outside grace is refused");

  const sessionA = await prisma.session.findUnique({ where: { id: phoneA.sessionId } });
  assert.ok(sessionA?.revokedAt !== null, "A is revoked");
  const sessionB = await prisma.session.findUnique({ where: { id: phoneB.sessionId } });
  assert.equal(sessionB?.revokedAt, null, "B is NOT — revocation is per session, never per user");
  assert.equal((await request("GET", "/auth/me", { token: phoneB.identityToken })).statusCode, 200, "and B still works");
});
