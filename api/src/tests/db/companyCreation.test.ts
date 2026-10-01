/**
 * Company creation by a verified identity (owner decision B3, 2026-10-01) —
 * against a REAL database built by the real migrations.
 *
 *   POST /companies   identity posture   { name }
 *
 * The flow B3 fixes: the person authenticates as THEMSELVES, has proved
 * their email (D47), and asks for a company. One transaction creates the
 * Company and the creator's `admin` CompanyMembership. Tenant authority then
 * comes from the existing exchange — `POST /auth/switch-company` — and from
 * nowhere new.
 *
 * What it is NOT: a way to attach anybody else. The request names no email,
 * no user and no membership; the only account it can touch is the caller's.
 * And `admin` here is a role VALUE, not a capability: O11 stays open, and
 * nothing new is authorised by it.
 *
 * WRITTEN RED.
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the company creation tests");
}

process.env.JWT_SECRET = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV   = "test";
process.env.WEB_ORIGIN = "https://allowed.example.com";

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `company-create-test-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };
const CANONICAL_403 = { error: "Not allowed", code: "FORBIDDEN" };

let seq = 0;
function fresh(label: string): string {
  seq += 1;
  return `${TAG}-${String(seq)}-${label}`;
}

interface Injected { statusCode: number; body: unknown; raw: string }

async function inject(options: { url: string; method?: "GET" | "POST"; payload?: object; token?: string }): Promise<Injected> {
  const app = await buildApp(prisma);
  try {
    const res = await app.inject({
      method: options.method ?? "POST", url: options.url,
      headers: options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
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

interface Account { email: string; userId: string; identityToken: string }

/** A phone-registered account; verified directly unless told otherwise. */
async function account(options: { verified?: boolean } = {}): Promise<Account> {
  const email = `${fresh("user")}@example.com`;
  const res = await inject({ url: "/auth/register", payload: { firstName: "Comp", lastName: "Any", email, password: PASSWORD } });
  assert.equal(res.statusCode, 201, `registration must succeed — got ${res.raw}`);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  if (options.verified !== false) {
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  }
  return { email, userId: user.id, identityToken: stringField(res.body, "identityToken") };
}

function createCompany(token: string | undefined, payload: object): Promise<Injected> {
  return inject({ url: "/companies", payload, ...(token === undefined ? {} : { token }) });
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "CompanyMembership" WHERE "companyId" IN (SELECT id FROM "Company" WHERE name LIKE ${`${TAG}%`})`;
  await prisma.$executeRaw`DELETE FROM "Company" WHERE name LIKE ${`${TAG}%`}`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(cleanup);
after(async () => { await cleanup(); await prisma.$disconnect(); });

test("CC1. a VERIFIED identity creates a Company and its own admin membership, and reaches tenant authority only through switch-company", async () => {
  const me = await account();
  const name = fresh("Haulier");

  const res = await createCompany(me.identityToken, { name });

  assert.equal(res.statusCode, 201, `a verified account may create a company — got ${res.raw}`);
  const membership = field(res.body, "membership");
  assert.equal(field(membership, "companyName"), name);
  assert.equal(field(membership, "role"), "admin");
  assert.equal(field(res.body, "tenantToken"), undefined, "creation mints no tenant authority of its own");

  const company = await prisma.company.findFirstOrThrow({ where: { name } });
  const rows = await prisma.companyMembership.findMany({ where: { companyId: company.id } });
  assert.equal(rows.length, 1, "exactly one membership: the creator's");
  assert.equal(rows[0]?.userId, me.userId);
  assert.equal(rows[0]?.role, "admin");
  assert.equal(rows[0]?.active, true);
  assert.equal(company.timezone, "Europe/London", "the V1 default (D18)");

  const switched = await inject({ url: "/auth/switch-company", token: me.identityToken, payload: { membershipId: stringField(membership, "membershipId") } });
  assert.equal(switched.statusCode, 200, `the creator can select the new company — got ${switched.raw}`);
  const tenant = stringField(switched.body, "tenantToken");
  const claims = JSON.parse(Buffer.from(tenant.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  assert.equal(claims["companyId"], company.id);
  assert.equal("role" in claims, false, "admin is never a token claim");
  assert.notEqual((await inject({ method: "GET", url: "/shifts/current", token: tenant })).statusCode, 401);
});

test("CC2. an UNVERIFIED identity is refused with the generic 403, and nothing is created", async () => {
  const me = await account({ verified: false });
  const name = fresh("Unverified");

  const res = await createCompany(me.identityToken, { name });

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, CANONICAL_403);
  assert.equal(await prisma.company.count({ where: { name } }), 0);
  assert.equal(await prisma.companyMembership.count({ where: { userId: me.userId } }), 0);
});

test("CC3. no token, or a TENANT token, cannot create a company", async () => {
  const anonymous = await createCompany(undefined, { name: fresh("Anon") });
  assert.equal(anonymous.statusCode, 401);
  assert.deepEqual(anonymous.body, CANONICAL_401);

  const me = await account();
  const first = await createCompany(me.identityToken, { name: fresh("First") });
  const switched = await inject({ url: "/auth/switch-company", token: me.identityToken, payload: { membershipId: stringField(field(first.body, "membership"), "membershipId") } });
  const tenantToken = stringField(switched.body, "tenantToken");
  const withTenant = await createCompany(tenantToken, { name: fresh("ViaTenant") });
  assert.equal(withTenant.statusCode, 401, "company creation is an ACCOUNT act; a tenant token is the wrong kind");
});

test("CC4. the body is exactly { name } — no email, user, membership, company or role can be named", async () => {
  const me = await account();
  for (const extra of [
    { email: "someone.else@example.com" }, { userId: randomUUID() }, { membershipId: randomUUID() },
    { companyId: randomUUID() }, { role: "driver" }, { timezone: "Asia/Dubai" },
  ]) {
    const res = await createCompany(me.identityToken, { name: fresh("Extra"), ...extra });
    assert.equal(res.statusCode, 400, `refused, not ignored: ${JSON.stringify(extra)}`);
  }
  for (const name of ["", "   ", "x".repeat(201)]) {
    assert.equal((await createCompany(me.identityToken, { name })).statusCode, 400, `name ${JSON.stringify(name.slice(0, 10))}`);
  }
  assert.equal(await prisma.companyMembership.count({ where: { userId: me.userId } }), 0, "nothing was created by any refusal");

  const trimmed = fresh("Trimmed");
  const padded = await createCompany(me.identityToken, { name: `  ${trimmed}  ` });
  assert.equal(padded.statusCode, 201);
  assert.equal(field(field(padded.body, "membership"), "companyName"), trimmed, "the name is stored trimmed");
});

test("CC5. creation is ATOMIC: a membership that cannot be written leaves no Company behind", async () => {
  const { companyRepository } = await import("../../repositories/companyRepository.js");
  const companies = companyRepository(prisma);
  const name = fresh("Orphan");

  // A user id that does not exist: the Company insert succeeds inside the
  // transaction, the membership insert then violates its foreign key.
  await assert.rejects(companies.createWithAdminMembership({ userId: `missing-${randomUUID()}`, name }));

  assert.equal(await prisma.company.count({ where: { name } }), 0, "the transaction rolled the Company back");
});

test("CC6. Company A and Company B: neither creator learns of the other", async () => {
  const alice = await account();
  const bob = await account();
  const companyA = fresh("CompanyA");
  const companyB = fresh("CompanyB");
  const a = await createCompany(alice.identityToken, { name: companyA });
  const b = await createCompany(bob.identityToken, { name: companyB });
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 201);

  for (const [who, own, other] of [[alice, companyA, companyB], [bob, companyB, companyA]] as const) {
    const me = await inject({ method: "GET", url: "/auth/me", token: who.identityToken });
    const listed = JSON.stringify(field(me.body, "memberships"));
    assert.ok(listed.includes(own), "a creator sees their own company");
    assert.ok(!listed.includes(other), "and never the other's");

    const login = await inject({ url: "/auth/login", payload: { email: who.email, password: PASSWORD } });
    assert.ok(!login.raw.includes(other), "login lists only the caller's own memberships");
  }

  const bobsMembership = stringField(field(b.body, "membership"), "membershipId");
  const steal = await inject({ url: "/auth/switch-company", token: alice.identityToken, payload: { membershipId: bobsMembership } });
  assert.equal(steal.statusCode, 403, "Alice cannot select Bob's membership");
  assert.deepEqual(steal.body, CANONICAL_403);
  assert.ok(!steal.raw.includes(companyB), "and the refusal names nothing of B");

  assert.equal(await prisma.companyMembership.count({ where: { userId: alice.userId } }), 1, "creating B touched no membership of Alice's");
});

test("CC7. a second company makes the creator a 2+ member: login lists both and selects neither", async () => {
  const me = await account();
  assert.equal((await createCompany(me.identityToken, { name: fresh("One") })).statusCode, 201);
  assert.equal((await createCompany(me.identityToken, { name: fresh("Two") })).statusCode, 201);

  const login = await inject({ url: "/auth/login", payload: { email: me.email, password: PASSWORD } });
  assert.equal(login.statusCode, 200);
  assert.equal((field(login.body, "memberships") as unknown[]).length, 2);
  assert.equal(field(login.body, "tenantToken"), undefined, "two companies are a choice, made through switch-company");
});
