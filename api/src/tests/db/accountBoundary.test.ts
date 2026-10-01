/**
 * The driver/company boundary (D51) — against a REAL database.
 *
 *   phone   (/auth/register, /auth/login, /auth/refresh)   DRIVER accounts only
 *   website (/auth/web/*, /auth/password/forgot)           COMPANY accounts only
 *
 * Guaranteed in the DATABASE, not only in the routes (D16):
 *   - a Session's kind agrees with its account's kind: driver ↔ mobile,
 *     company ↔ browser (a composite foreign key carries the account kind
 *     onto the Session, and a CHECK pairs it with the client kind);
 *   - a membership's role agrees with its account's kind: a driver account
 *     holds `driver` memberships only; a company account never holds a
 *     `driver` membership. Deliberately NOT "a company has one admin" —
 *     additional company users are a later feature (D51).
 *
 * And in the services: the wrong kind fails exactly like a wrong password;
 * only a `driver` membership starts a shift; only a company account creates a
 * company.
 *
 * WRITTEN RED.
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the account boundary tests");
}

const ORIGIN = "https://allowed.example.com";
process.env.JWT_SECRET  = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV    = "test";
process.env.WEB_ORIGIN  = ORIGIN;
process.env.WEB_APP_URL = ORIGIN;

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `account-boundary-test-${Date.now()}`;
const DRIVER_PASSWORD = "driver-password-one";
const COMPANY_PASSWORD = "company-password-two";
const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };
const CANONICAL_403 = { error: "Not allowed", code: "FORBIDDEN" };
const CHECK_VIOLATION = "23514";
const FK_VIOLATION = "23503";

let seq = 0;
function freshEmail(): string {
  seq += 1;
  return `${TAG}-${String(seq)}@example.com`;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sqlStateOf(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error);
  return /Code: `(\w{5})`/.exec(text)?.[1] ?? null;
}

interface Injected { statusCode: number; body: unknown; raw: string; setCookie: string | null }

async function inject(options: { url: string; method?: "GET" | "POST"; payload?: object; token?: string; web?: boolean }): Promise<Injected> {
  const app = await buildApp(prisma, { mailer: { send: () => Promise.resolve() } });
  try {
    const headers: Record<string, string> = {};
    if (options.web === true) headers["origin"] = ORIGIN;
    if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
    const res = await app.inject({
      method: options.method ?? "POST", url: options.url, headers,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });
    const cookie = res.headers["set-cookie"];
    return {
      statusCode: res.statusCode,
      body: res.body === "" ? null : (JSON.parse(res.body) as unknown),
      raw: res.body,
      setCookie: typeof cookie === "string" ? cookie : null,
    };
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

async function kindOfUser(id: string): Promise<string | undefined> {
  const rows = await prisma.$queryRaw<{ kind: string }[]>`SELECT "accountKind"::text AS kind FROM "User" WHERE id = ${id}`;
  return rows[0]?.kind;
}

async function registerDriver(email: string): Promise<{ userId: string; identityToken: string }> {
  const res = await inject({ url: "/auth/register", payload: { firstName: "Dee", lastName: "River", email, password: DRIVER_PASSWORD } });
  assert.equal(res.statusCode, 201, `driver registration — got ${res.raw}`);
  return { userId: stringField(field(res.body, "user"), "id"), identityToken: stringField(res.body, "identityToken") };
}

async function registerCompanyAccount(email: string): Promise<{ userId: string; identityToken: string; cookie: string }> {
  const res = await inject({ url: "/auth/web/register", web: true, payload: { firstName: "Co", lastName: "Admin", email, password: COMPANY_PASSWORD } });
  assert.equal(res.statusCode, 201, `company account registration — got ${res.raw}`);
  return { userId: stringField(field(res.body, "user"), "id"), identityToken: stringField(res.body, "identityToken"), cookie: res.setCookie ?? "" };
}

async function rawSession(userId: string, accountKind: string, clientKind: string): Promise<unknown> {
  try {
    await prisma.$executeRaw`
      INSERT INTO "Session" ("id", "userId", "accountKind", "clientKind", "expiresAt", "refreshTokenHash", "updatedAt")
      VALUES (${randomUUID()}, ${userId}, ${accountKind}::"AccountKind", ${clientKind}::"SessionClientKind",
              now() + interval '1 day', ${digest(randomUUID())}, now())`;
    return null;
  } catch (error) {
    return error;
  }
}

async function rawMembership(userId: string, accountKind: string, role: string, companyId: string): Promise<unknown> {
  try {
    await prisma.$executeRaw`
      INSERT INTO "CompanyMembership" ("id", "companyId", "userId", "accountKind", "role", "updatedAt")
      VALUES (${randomUUID()}, ${companyId}, ${userId}, ${accountKind}::"AccountKind", ${role}::"MembershipRole", now())`;
    return null;
  } catch (error) {
    return error;
  }
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "CompanyMembership" WHERE "companyId" IN (SELECT id FROM "Company" WHERE name LIKE ${`${TAG}%`})`;
  await prisma.$executeRaw`DELETE FROM "Company" WHERE name LIKE ${`${TAG}%`}`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(cleanup);
after(async () => { await cleanup(); await prisma.$disconnect(); });

// ═════════════════════════════════════════════════════════════════════════════
// The database guarantees
// ═════════════════════════════════════════════════════════════════════════════

test("AB1. a Session's kind must agree with its account: driver ↔ mobile, company ↔ browser — refused by the database", async () => {
  const driver = await registerDriver(freshEmail());
  const company = await registerCompanyAccount(freshEmail());

  assert.equal(sqlStateOf(await rawSession(driver.userId, "driver", "browser")), CHECK_VIOLATION, "a driver account cannot hold a browser session");
  assert.equal(sqlStateOf(await rawSession(company.userId, "company", "mobile")), CHECK_VIOLATION, "a company account cannot hold a mobile session");
  assert.equal(sqlStateOf(await rawSession(driver.userId, "company", "browser")), FK_VIOLATION, "a session cannot claim a kind its account does not have");

  assert.equal(await rawSession(driver.userId, "driver", "mobile"), null, "positive control");
  assert.equal(await rawSession(company.userId, "company", "browser"), null, "positive control");
});

test("AB2. a membership's role must agree with its account: drivers hold driver memberships; company accounts never do", async () => {
  const driver = await registerDriver(freshEmail());
  const company = await registerCompanyAccount(freshEmail());
  const { id: companyId } = await prisma.company.create({ data: { name: `${TAG}-co` } });
  const second = await registerCompanyAccount(freshEmail());

  assert.equal(sqlStateOf(await rawMembership(driver.userId, "driver", "admin", companyId)), CHECK_VIOLATION, "a driver account can never be an administrator");
  assert.equal(sqlStateOf(await rawMembership(company.userId, "company", "driver", companyId)), CHECK_VIOLATION, "a company account can never be a driver");
  // A pairing the CHECK accepts (company + admin), on a DRIVER account: only
  // the composite foreign key can refuse it, so this isolates that guarantee.
  assert.equal(sqlStateOf(await rawMembership(driver.userId, "company", "admin", companyId)), FK_VIOLATION, "a membership cannot claim a kind its account does not have");

  assert.equal(await rawMembership(driver.userId, "driver", "driver", companyId), null, "positive control");
  assert.equal(await rawMembership(company.userId, "company", "admin", companyId), null, "positive control");
  // NOT one administrator per company: a second company-side user is allowed by the schema (D51).
  assert.equal(await rawMembership(second.userId, "company", "admin", companyId), null, "a company may later have more than one company-side user");
});

// ═════════════════════════════════════════════════════════════════════════════
// Each surface accepts only its own kind
// ═════════════════════════════════════════════════════════════════════════════

test("AB3. the phone registers DRIVER accounts and the website COMPANY accounts — the same email may do both", async () => {
  const email = freshEmail();
  const driver = await registerDriver(email);
  const company = await registerCompanyAccount(email);

  assert.notEqual(driver.userId, company.userId, "two separate accounts");
  assert.equal(await kindOfUser(driver.userId), "driver");
  assert.equal(await kindOfUser(company.userId), "company");

  const secondCompany = await inject({ url: "/auth/web/register", web: true, payload: { firstName: "X", lastName: "Y", email: email.toUpperCase(), password: COMPANY_PASSWORD } });
  assert.equal(secondCompany.statusCode, 409, "one company account per email");
});

test("AB4. each surface signs in ONLY its own kind; the other kind's correct password fails exactly like a wrong one", async () => {
  const email = freshEmail();
  await registerDriver(email);
  await registerCompanyAccount(email);
  const onlyDriver = freshEmail();
  await registerDriver(onlyDriver);
  const onlyCompany = freshEmail();
  await registerCompanyAccount(onlyCompany);

  // Each surface, its own account: in.
  assert.equal((await inject({ url: "/auth/login", payload: { email, password: DRIVER_PASSWORD } })).statusCode, 200);
  assert.equal((await inject({ url: "/auth/web/login", web: true, payload: { email, password: COMPANY_PASSWORD } })).statusCode, 200);

  // The other kind's password on a surface: refused, byte-identically to a wrong password and an unknown email.
  const refusals = [
    await inject({ url: "/auth/login", payload: { email, password: COMPANY_PASSWORD } }),
    await inject({ url: "/auth/web/login", web: true, payload: { email, password: DRIVER_PASSWORD } }),
    await inject({ url: "/auth/login", payload: { email: onlyCompany, password: COMPANY_PASSWORD } }),
    await inject({ url: "/auth/web/login", web: true, payload: { email: onlyDriver, password: DRIVER_PASSWORD } }),
    await inject({ url: "/auth/login", payload: { email: freshEmail(), password: DRIVER_PASSWORD } }),
    await inject({ url: "/auth/web/login", web: true, payload: { email: freshEmail(), password: COMPANY_PASSWORD } }),
  ];
  for (const res of refusals) {
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, CANONICAL_401);
    assert.equal(res.setCookie, null, "no cookie for a refused sign-in");
  }
});

test("AB5. the sessions each surface creates are of its own kind", async () => {
  const email = freshEmail();
  const driver = await registerDriver(email);
  const company = await registerCompanyAccount(email);
  const kinds = await prisma.$queryRaw<{ userId: string; accountKind: string; clientKind: string }[]>`
    SELECT "userId", "accountKind"::text AS "accountKind", "clientKind"::text AS "clientKind" FROM "Session"
    WHERE "userId" IN (${driver.userId}, ${company.userId}) ORDER BY "clientKind"`;
  assert.deepEqual(kinds.map(k => [k.userId === driver.userId ? "driver" : "company", k.accountKind, k.clientKind]), [
    ["company", "company", "browser"],
    ["driver", "driver", "mobile"],
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// Company accounts administer; drivers drive
// ═════════════════════════════════════════════════════════════════════════════

test("AB6. a company account cannot start a shift, even with valid tenant authority", async () => {
  const company = await registerCompanyAccount(freshEmail());
  await prisma.user.update({ where: { id: company.userId }, data: { emailVerifiedAt: new Date() } });
  const created = await inject({ url: "/companies", token: company.identityToken, payload: { name: `${TAG}-co` } });
  assert.equal(created.statusCode, 201, `setup — got ${created.raw}`);
  const switched = await inject({ url: "/auth/switch-company", token: company.identityToken, payload: { membershipId: stringField(field(created.body, "membership"), "membershipId") } });
  const tenantToken = stringField(switched.body, "tenantToken");

  const start = await inject({ url: "/shifts/start", token: tenantToken, payload: { clientEventId: randomUUID(), startedAt: new Date().toISOString() } });
  assert.equal(start.statusCode, 403, `a company account is not a driver — got ${start.raw}`);
  assert.deepEqual(start.body, CANONICAL_403);
  assert.equal(await prisma.shift.count({ where: { userId: company.userId } }), 0);
});

test("AB7. a driver account cannot create a company", async () => {
  const driver = await registerDriver(freshEmail());
  await prisma.user.update({ where: { id: driver.userId }, data: { emailVerifiedAt: new Date() } });
  const res = await inject({ url: "/companies", token: driver.identityToken, payload: { name: `${TAG}-driver-co` } });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, CANONICAL_403);
  assert.equal(await prisma.company.count({ where: { name: `${TAG}-driver-co` } }), 0);
});

test("AB8. web password reset reaches the COMPANY account, never the driver account sharing its email", async () => {
  const email = freshEmail();
  const driver = await registerDriver(email);
  const company = await registerCompanyAccount(email);
  const sent: { to: string; text: string }[] = [];
  const app = await buildApp(prisma, { mailer: { send: message => { sent.push(message); return Promise.resolve(); } } });
  try {
    const res = await app.inject({ method: "POST", url: "/auth/password/forgot", payload: { email } });
    assert.equal(res.statusCode, 204);
  } finally {
    await app.close();
  }
  const issued = await prisma.$queryRaw<{ userId: string }[]>`SELECT "userId" FROM "AccountToken" WHERE purpose = 'password_reset' AND "userId" IN (${driver.userId}, ${company.userId})`;
  assert.deepEqual(issued.map(r => r.userId), [company.userId], "the reset token belongs to the company account only");
  assert.equal(sent.length, 1);

  // And a driver-only email gets no reset from the website.
  const onlyDriver = freshEmail();
  const lone = await registerDriver(onlyDriver);
  const app2 = await buildApp(prisma, { mailer: { send: () => Promise.resolve() } });
  try {
    const res = await app2.inject({ method: "POST", url: "/auth/password/forgot", payload: { email: onlyDriver } });
    assert.equal(res.statusCode, 204, "the same answer as for any address");
  } finally {
    await app2.close();
  }
  assert.equal(await prisma.accountToken.count({ where: { userId: lone.userId } }), 0, "no token for a driver account");
});
