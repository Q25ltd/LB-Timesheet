/**
 * The V1 COMPANY-WEB authorization contract (O11, owner decision 2026-10-04):
 *
 *   authenticated company account
 *   + a valid, ACTIVE CompanyMembership read from the database
 *   + role = admin (from that row, never from a token or a client)
 *   = an authorized company administrator — for THAT company only
 *
 * `authorizeCompanyAdmin` (lib/authorization.ts) is the one gate every
 * company-side operation — the future Drivers, Timesheets and Settings — must
 * use. No such route exists yet, so this file mounts a test-only probe behind
 * the default-deny tenant posture and drives it with REAL accounts, sessions,
 * memberships and tokens issued by the real endpoints.
 *
 * What is NOT re-proven here, because it already is:
 *   - the initial admin membership row (companyRegistration CV1)
 *   - driver ≠ admin and company ≠ driver at the database (accountBoundary)
 *   - another user's / an inactive membership refused at switch-company (companySwitch P2)
 *   - a forged companyId refused by requireAuth (authProtectedRequest, auth.test)
 *
 * WRITTEN RED. Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import type { MailMessage, Mailer } from "../../lib/mailer.js";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the company admin authorization tests");
}

const ORIGIN = "https://allowed.example.com";
process.env.JWT_SECRET  = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV    = "test";
process.env.WEB_ORIGIN  = ORIGIN;
process.env.WEB_APP_URL = ORIGIN;

const { buildApp } = await import("../../app.js");
// A namespace import, so a missing export fails each test under its own name.
const authorization = await import("../../lib/authorization.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const SECRET = process.env.JWT_SECRET;

const TAG = `company-admin-authz-test-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };
const CANONICAL_403 = { error: "Not allowed", code: "FORBIDDEN" };
const PROBE = "/test-only/company-admin";

let seq = 0;
function freshEmail(): string {
  seq += 1;
  return `${TAG}-${String(seq)}@example.com`;
}

const outbox: MailMessage[] = [];
const capturingMailer: Mailer = {
  send(message) {
    outbox.push(message);
    return Promise.resolve();
  },
};

interface Injected { statusCode: number; body: unknown; raw: string }

/**
 * One request against a fresh app that also carries the probe: a TENANT
 * route (no posture marker — default-deny) that asks the company-admin gate
 * and answers with the company it scoped to.
 */
async function inject(options: { url: string; method?: "GET" | "POST"; payload?: object; token?: string; web?: boolean }): Promise<Injected> {
  const app = await buildApp(prisma, { mailer: capturingMailer });
  app.get(PROBE, (request: FastifyRequest, reply: FastifyReply) => {
    if (request.auth === undefined) throw new Error("tenant route reached with no AuthContext");
    const ctx = authorization.authorizeCompanyAdmin(request.auth);
    return reply.send({ companyId: ctx.companyId, membershipId: ctx.membershipId });
  });
  try {
    const headers: Record<string, string> = {};
    if (options.web === true) headers["origin"] = ORIGIN;
    if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
    const res = await app.inject({
      method: options.method ?? "POST", url: options.url, headers,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });
    return { statusCode: res.statusCode, body: res.body === "" ? null : (JSON.parse(res.body) as unknown), raw: res.body };
  } finally {
    await app.close();
  }
}

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? (Reflect.get(body, key) as unknown) : undefined;
}

function stringField(body: unknown, key: string): string {
  const value = field(body, key);
  assert.equal(typeof value, "string", `the response must carry \`${key}\` as a string`);
  return value as string;
}

function probe(token: string): Promise<Injected> {
  return inject({ method: "GET", url: PROBE, token });
}

/** Register a company through the real website flow and open its emailed link: Company + its first admin. */
async function registeredCompany(email: string, companyName: string): Promise<{ userId: string; companyId: string; membershipId: string }> {
  const registered = await inject({
    url: "/auth/web/register", web: true,
    payload: { companyName, timeZone: "Asia/Tokyo", firstName: "Aiko", lastName: "Sato", email, password: PASSWORD },
  });
  assert.equal(registered.statusCode, 201, `registration — got ${registered.raw}`);
  const message = outbox.filter(m => m.to === email).at(-1);
  const token = message === undefined ? undefined : /#token=([A-Za-z0-9_-]+)/.exec(message.text)?.[1];
  assert.ok(token !== undefined, "the registration sent its verification link");
  const confirmed = await inject({ url: "/auth/email-verification/confirm", payload: { token } });
  assert.equal(confirmed.statusCode, 200, `confirmation — got ${confirmed.raw}`);
  const user = await prisma.user.findUniqueOrThrow({ where: { accountKind_email: { accountKind: "company", email } } });
  const membership = await prisma.companyMembership.findFirstOrThrow({ where: { userId: user.id } });
  return { userId: user.id, companyId: membership.companyId, membershipId: membership.id };
}

/** Company sign-in on the website: the identity token, and the tenant token when exactly one company. */
async function webLogin(email: string, password = PASSWORD): Promise<Injected> {
  return inject({ url: "/auth/web/login", web: true, payload: { email, password } });
}

async function companyTenantToken(email: string, membershipId?: string): Promise<string> {
  const login = await webLogin(email);
  assert.equal(login.statusCode, 200, `company sign-in — got ${login.raw}`);
  if (membershipId === undefined) return stringField(login.body, "tenantToken");
  const switched = await inject({ url: "/auth/switch-company", token: stringField(login.body, "identityToken"), payload: { membershipId } });
  assert.equal(switched.statusCode, 200, `switch-company — got ${switched.raw}`);
  return stringField(switched.body, "tenantToken");
}

/**
 * A DRIVER account (the phone's registration) with an active `driver`
 * membership in `companyId`, seeded directly: no driver onboarding exists yet,
 * and how a driver connects to a company is undesigned. Its own phone sign-in
 * yields its tenant token.
 */
async function driverOf(companyId: string, email: string, password = PASSWORD): Promise<{ userId: string; tenantToken: string }> {
  const registered = await inject({ url: "/auth/register", payload: { firstName: "Dee", lastName: "River", email, password } });
  assert.equal(registered.statusCode, 201, `driver registration — got ${registered.raw}`);
  const userId = stringField(field(registered.body, "user"), "id");
  await prisma.companyMembership.create({ data: { companyId, userId, accountKind: "driver", role: "driver", active: true } });
  const login = await inject({ url: "/auth/login", payload: { email, password } });
  assert.equal(login.statusCode, 200, `driver sign-in — got ${login.raw}`);
  return { userId, tenantToken: stringField(login.body, "tenantToken") };
}

function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1] ?? "";
  const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  assert.ok(typeof claims === "object" && claims !== null);
  return Object.fromEntries(Object.entries(claims));
}

/** Re-sign `token`'s claims with `changes` applied — a forged token the server's own key signs. */
function resigned(token: string, changes: Record<string, unknown>): string {
  const [header] = token.split(".");
  const payload = Buffer.from(JSON.stringify({ ...decodeClaims(token), ...changes })).toString("base64url");
  const signature = createHmac("sha256", SECRET).update(`${header ?? ""}.${payload}`).digest("base64url");
  return `${header ?? ""}.${payload}.${signature}`;
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "Company" WHERE id IN (
    SELECT m."companyId" FROM "CompanyMembership" m JOIN "User" u ON u.id = m."userId" WHERE u.email LIKE ${`${TAG}%`})`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(async () => { await cleanup(); outbox.length = 0; });
after(async () => { await cleanup(); await prisma.$disconnect(); });

test("CA1. a registered company's FIRST administrator — role admin, from the real flow — is authorized for its own company, and only it", async () => {
  const email = freshEmail();
  const company = await registeredCompany(email, `${TAG}-Tokyo`);
  const row = await prisma.companyMembership.findUniqueOrThrow({ where: { id: company.membershipId } });
  assert.equal(row.role, "admin");
  assert.equal(row.active, true);

  const res = await probe(await companyTenantToken(email));
  assert.equal(res.statusCode, 200, `the initial admin passes the company-admin gate — got ${res.raw}`);
  assert.deepEqual(res.body, { companyId: company.companyId, membershipId: company.membershipId });
});

test("CA2. a DRIVER's tenant token — an ACTIVE driver membership of the SAME company — is refused company-admin authority", async () => {
  const adminEmail = freshEmail();
  const company = await registeredCompany(adminEmail, `${TAG}-Haulage`);
  const driver = await driverOf(company.companyId, freshEmail());

  // Positive control first: the gate is not refusing everything.
  assert.equal((await probe(await companyTenantToken(adminEmail))).statusCode, 200);

  const res = await probe(driver.tenantToken);
  assert.equal(res.statusCode, 403, `a driver relationship confers no company-web authority — got ${res.raw}`);
  assert.deepEqual(res.body, CANONICAL_403, "the generic 403 — nothing about roles");
});

test("CA3. a company account with NO company has no tenant authority to present", async () => {
  // A company account whose registration is still pending: no Company, no membership.
  const email = freshEmail();
  const registered = await inject({
    url: "/auth/web/register", web: true,
    payload: { companyName: `${TAG}-Pending`, timeZone: "Asia/Tokyo", firstName: "Aiko", lastName: "Sato", email, password: PASSWORD },
  });
  const identityToken = stringField(registered.body, "identityToken");
  const login = await webLogin(email);
  assert.equal(field(login.body, "tenantToken"), undefined, "no company → no tenant token");

  const res = await probe(identityToken);
  assert.equal(res.statusCode, 401, "an identity token is the wrong KIND for a company route");
  assert.deepEqual(res.body, CANONICAL_401);
});

test("CA4. authority follows the CURRENT membership row: deactivated → 403, deleted → 401, on the very next request", async () => {
  const email = freshEmail();
  const company = await registeredCompany(email, `${TAG}-Revoked`);
  const token = await companyTenantToken(email);
  assert.equal((await probe(token)).statusCode, 200, "positive control");

  await prisma.companyMembership.update({ where: { id: company.membershipId }, data: { active: false } });
  const deactivated = await probe(token);
  assert.equal(deactivated.statusCode, 403, "the same unexpired token, a deactivated membership");
  assert.deepEqual(deactivated.body, CANONICAL_403);

  await prisma.companyMembership.delete({ where: { id: company.membershipId } });
  const deleted = await probe(token);
  assert.equal(deleted.statusCode, 401, "the membership the token names no longer exists");
  assert.deepEqual(deleted.body, CANONICAL_401);
});

test("CA5. the role comes from the ROW: a forged role claim neither grants nor removes authority", async () => {
  const adminEmail = freshEmail();
  const company = await registeredCompany(adminEmail, `${TAG}-Forged`);
  const driver = await driverOf(company.companyId, freshEmail());
  assert.equal(decodeClaims(driver.tenantToken)["role"], undefined, "tenant tokens carry no role at all");

  // The driver's genuine token, re-signed with the server's own key, claiming admin.
  const claimedAdmin = await probe(resigned(driver.tenantToken, { role: "admin" }));
  assert.equal(claimedAdmin.statusCode, 403, `a role claim is never authority — got ${claimedAdmin.raw}`);

  // And the reverse: an admin's token claiming `driver` is still the admin.
  const adminToken = await companyTenantToken(adminEmail);
  assert.equal((await probe(resigned(adminToken, { role: "driver" }))).statusCode, 200);
});

test("CA6. an admin of company A has no authority over company B — by switching, or by a forged claim", async () => {
  const emailA = freshEmail();
  const emailB = freshEmail();
  const a = await registeredCompany(emailA, `${TAG}-A`);
  const b = await registeredCompany(emailB, `${TAG}-B`);

  // A asks to switch to B's administrator membership.
  const login = await webLogin(emailA);
  const switched = await inject({ url: "/auth/switch-company", token: stringField(login.body, "identityToken"), payload: { membershipId: b.membershipId } });
  assert.equal(switched.statusCode, 403);
  assert.deepEqual(switched.body, CANONICAL_403);

  // A's genuine tenant token, re-signed to claim company B or B's membership.
  const tokenA = await companyTenantToken(emailA);
  for (const forged of [{ companyId: b.companyId }, { membershipId: b.membershipId }, { companyId: b.companyId, membershipId: b.membershipId }]) {
    const res = await probe(resigned(tokenA, forged));
    assert.equal(res.statusCode, 401, `forged ${JSON.stringify(Object.keys(forged))} — got ${res.raw}`);
    assert.ok(!res.raw.includes(b.companyId), "nothing of company B is disclosed");
  }
  assert.deepEqual((await probe(tokenA)).body, { companyId: a.companyId, membershipId: a.membershipId }, "A still reaches A");
});

test("CA7. a company account and a DRIVER account with the SAME email are two identities: neither reaches the other's authority", async () => {
  const email = freshEmail();
  const company = await registeredCompany(email, `${TAG}-SameEmail`);
  const driver = await driverOf(company.companyId, email, "the-drivers-own-password");
  assert.notEqual(driver.userId, company.userId, "two accounts, never linked");

  assert.equal((await probe(driver.tenantToken)).statusCode, 403, "the same-email driver is not the administrator");
  assert.equal((await probe(await companyTenantToken(email))).statusCode, 200, "and the administrator is unaffected");

  // The driver's password does not open the company account on the website.
  const asDriver = await webLogin(email, "the-drivers-own-password");
  assert.equal(asDriver.statusCode, 401);
  assert.deepEqual(asDriver.body, CANONICAL_401);
});

test("CA8. a company may have TWO administrators — both authorized for it, neither for another company", async () => {
  const emailA = freshEmail();
  const emailB = freshEmail();
  const emailC = freshEmail();
  const x = await registeredCompany(emailA, `${TAG}-X`);
  const y = await registeredCompany(emailC, `${TAG}-Y`);
  // A second company account administers X too: structurally allowed (no API
  // or UI for adding administrators exists — seeded, as a later feature would).
  const second = await registeredCompany(emailB, `${TAG}-B-own`);
  const secondInX = await prisma.companyMembership.create({
    data: { companyId: x.companyId, userId: second.userId, accountKind: "company", role: "admin", active: true },
  });
  assert.equal(await prisma.companyMembership.count({ where: { companyId: x.companyId, role: "admin", active: true } }), 2, "two admins of one company");

  const firstAdmin = await probe(await companyTenantToken(emailA));
  const secondAdmin = await probe(await companyTenantToken(emailB, secondInX.id));
  assert.deepEqual(firstAdmin.body, { companyId: x.companyId, membershipId: x.membershipId });
  assert.deepEqual(secondAdmin.body, { companyId: x.companyId, membershipId: secondInX.id });

  // Being X's second admin opens nothing of Y.
  const login = await webLogin(emailB);
  const toY = await inject({ url: "/auth/switch-company", token: stringField(login.body, "identityToken"), payload: { membershipId: y.membershipId } });
  assert.equal(toY.statusCode, 403);
  assert.equal(await prisma.companyMembership.count({ where: { userId: second.userId, companyId: y.companyId } }), 0);
});
