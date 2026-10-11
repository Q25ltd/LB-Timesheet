/**
 * D66, stage S1 — a company's measurement units (D52).
 *
 *   POST /auth/web/register            a new registration MUST choose both
 *   GET  /company/settings/units       tenant (admin) — the company's units, or null
 *   PUT  /company/settings/units       tenant (admin) — choose or change them
 *   /auth/me, switch-company, login    each membership carries its company's units
 *
 * Units are never defaulted or guessed: a company that existed before them —
 * or a registration already waiting for its link — has none until an
 * administrator chooses. Real accounts, sessions and tokens against a real
 * database.
 *
 * WRITTEN RED. Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import type { MailMessage, Mailer } from "../../lib/mailer.js";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the company units tests");
}

const ORIGIN = "https://allowed.example.com";
process.env.JWT_SECRET  = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV    = "test";
process.env.WEB_ORIGIN  = ORIGIN;
process.env.WEB_APP_URL = ORIGIN;

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `company-units-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const UNITS = "/company/settings/units";

let seq = 0;
function freshEmail(): string {
  seq += 1;
  return `${TAG}-${String(seq)}@example.com`;
}

const outbox: MailMessage[] = [];
const capturingMailer: Mailer = { send(message) { outbox.push(message); return Promise.resolve(null); } };

interface Injected { statusCode: number; body: unknown; raw: string }

async function inject(options: { url: string; method?: "GET" | "POST" | "PUT"; payload?: object; token?: string; web?: boolean }): Promise<Injected> {
  const app = await buildApp(prisma, { mailer: capturingMailer });
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

function list(body: unknown, key: string): unknown[] {
  const value = field(body, key);
  assert.ok(Array.isArray(value), `the response must carry \`${key}\` as a list`);
  return value;
}

function registration(email: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    companyName: `${TAG}-Co`, timeZone: "Europe/Vilnius", distanceUnit: "kilometre", volumeUnit: "litre",
    firstName: "Ada", lastName: "Admin", email, password: PASSWORD, ...over,
  };
}

function register(email: string, over: Record<string, unknown> = {}): Promise<Injected> {
  return inject({ url: "/auth/web/register", web: true, payload: registration(email, over) });
}

async function confirmFor(email: string): Promise<void> {
  const token = /#token=([A-Za-z0-9_-]+)/.exec(outbox.filter(m => m.to === email).at(-1)?.text ?? "")?.[1];
  assert.ok(token !== undefined, "the registration sent its link");
  assert.equal((await inject({ url: "/auth/email-verification/confirm", payload: { token } })).statusCode, 200);
}

interface Admin { companyId: string; token: string }

async function signIn(email: string): Promise<Admin> {
  const login = await inject({ url: "/auth/web/login", web: true, payload: { email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, `login — got ${login.raw}`);
  const user = await prisma.user.findUniqueOrThrow({ where: { accountKind_email: { accountKind: "company", email } } });
  const membership = await prisma.companyMembership.findFirstOrThrow({ where: { userId: user.id } });
  return { companyId: membership.companyId, token: stringField(login.body, "tenantToken") };
}

async function companyAdmin(over: Record<string, unknown> = {}): Promise<Admin> {
  const email = freshEmail();
  const res = await register(email, { companyName: `${TAG}-${String(seq)}`, ...over });
  assert.equal(res.statusCode, 201, `registration — got ${res.raw}`);
  await confirmFor(email);
  return signIn(email);
}

interface Driver { userId: string; identityToken: string; email: string }

async function driverOf(admin: Admin): Promise<Driver & { membershipId: string }> {
  const email = freshEmail();
  const registered = await inject({ url: "/auth/register", payload: { firstName: "Dee", lastName: "River", email, password: PASSWORD } });
  assert.equal(registered.statusCode, 201);
  const userId = stringField(field(registered.body, "user"), "id");
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  const identityToken = stringField(registered.body, "identityToken");
  const invited = await inject({ url: "/company/driver-invitations", token: admin.token, payload: { firstName: "Dee", lastName: "River", email } });
  assert.equal(invited.statusCode, 201, `invitation — got ${invited.raw}`);
  const accepted = await inject({ url: `/driver/invitations/${stringField(field(invited.body, "invitation"), "id")}/accept`, token: identityToken });
  assert.equal(accepted.statusCode, 200, `acceptance — got ${accepted.raw}`);
  return { userId, identityToken, email, membershipId: stringField(field(accepted.body, "membership"), "membershipId") };
}

const getUnits = (admin: Admin): Promise<Injected> => inject({ url: UNITS, method: "GET", token: admin.token });
const putUnits = (admin: Admin, payload: object): Promise<Injected> => inject({ url: UNITS, method: "PUT", token: admin.token, payload });

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "Company" WHERE name LIKE ${`${TAG}%`}`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(async () => { await cleanup(); outbox.length = 0; });
after(async () => { await cleanup(); await prisma.$disconnect(); });

// ═══════════════════════════════════════════════════════════════════════════
// Registration
// ═══════════════════════════════════════════════════════════════════════════

test("UN1. a new registration MUST choose both units — missing or unknown is refused, nothing created", async () => {
  const cases: Record<string, unknown>[] = [
    { distanceUnit: undefined }, { volumeUnit: undefined },
    { distanceUnit: "furlong" }, { volumeUnit: "gallon" }, { distanceUnit: "KILOMETRE" }, { distanceUnit: null },
  ];
  for (const over of cases) {
    const email = freshEmail();
    const res = await register(email, over);
    assert.equal(res.statusCode, 400, `${JSON.stringify(over)} — got ${res.raw}`);
    assert.equal(await prisma.user.count({ where: { email } }), 0);
  }
});

test("UN2. the units chosen at registration wait on the registration and become the COMPANY's when its email is confirmed", async () => {
  const email = freshEmail();
  assert.equal((await register(email, { distanceUnit: "mile", volumeUnit: "us_gallon" })).statusCode, 201);
  const user = await prisma.user.findUniqueOrThrow({ where: { accountKind_email: { accountKind: "company", email } } });
  const pending = await prisma.pendingCompanyRegistration.findFirstOrThrow({ where: { userId: user.id } });
  assert.deepEqual({ d: pending.distanceUnit, v: pending.volumeUnit }, { d: "mile", v: "us_gallon" });

  await confirmFor(email);

  const membership = await prisma.companyMembership.findFirstOrThrow({ where: { userId: user.id }, include: { company: true } });
  assert.deepEqual({ d: membership.company.distanceUnit, v: membership.company.volumeUnit }, { d: "mile", v: "us_gallon" });
});

test("UN3. a registration made BEFORE units existed confirms into a company with NO units — never a guessed default; the company is then asked", async () => {
  const email = freshEmail();
  assert.equal((await register(email)).statusCode, 201);
  const user = await prisma.user.findUniqueOrThrow({ where: { accountKind_email: { accountKind: "company", email } } });
  await prisma.pendingCompanyRegistration.updateMany({ where: { userId: user.id }, data: { distanceUnit: null, volumeUnit: null } });

  await confirmFor(email);
  const admin = await signIn(email);

  const company = await prisma.company.findUniqueOrThrow({ where: { id: admin.companyId } });
  assert.deepEqual({ d: company.distanceUnit, v: company.volumeUnit }, { d: null, v: null });
  const res = await getUnits(admin);
  assert.equal(res.statusCode, 200, `got ${res.raw}`);
  assert.deepEqual(field(res.body, "units"), { distanceUnit: null, volumeUnit: null });
});

// ═══════════════════════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════════════════════

test("UN4. an administrator reads and changes the company's units — both at once, from the known values only", async () => {
  const admin = await companyAdmin();
  assert.deepEqual(field((await getUnits(admin)).body, "units"), { distanceUnit: "kilometre", volumeUnit: "litre" });

  const changed = await putUnits(admin, { distanceUnit: "mile", volumeUnit: "imperial_gallon" });

  assert.equal(changed.statusCode, 200, `got ${changed.raw}`);
  assert.deepEqual(field(changed.body, "units"), { distanceUnit: "mile", volumeUnit: "imperial_gallon" });
  assert.deepEqual(field((await getUnits(admin)).body, "units"), { distanceUnit: "mile", volumeUnit: "imperial_gallon" });
  for (const bad of [{ distanceUnit: "mile" }, { volumeUnit: "litre" }, { distanceUnit: "mile", volumeUnit: "pint" }, { distanceUnit: null, volumeUnit: "litre" }, {}]) {
    const res = await putUnits(admin, bad);
    assert.equal(res.statusCode, 400, `${JSON.stringify(bad)} — got ${res.raw}`);
  }
  assert.deepEqual(field((await getUnits(admin)).body, "units"), { distanceUnit: "mile", volumeUnit: "imperial_gallon" }, "a refused change changes nothing");
});

test("UN5. the body names no company: a companyId — or any other key — is refused, and only the token's company changes", async () => {
  const a = await companyAdmin();
  const b = await companyAdmin({ distanceUnit: "mile", volumeUnit: "us_gallon" });

  const smuggled = await putUnits(a, { distanceUnit: "kilometre", volumeUnit: "litre", companyId: b.companyId });
  assert.equal(smuggled.statusCode, 400, `got ${smuggled.raw}`);

  assert.equal((await putUnits(a, { distanceUnit: "mile", volumeUnit: "imperial_gallon" })).statusCode, 200);
  const companyB = await prisma.company.findUniqueOrThrow({ where: { id: b.companyId } });
  assert.deepEqual({ d: companyB.distanceUnit, v: companyB.volumeUnit }, { d: "mile", v: "us_gallon" }, "B untouched");
});

test("UN6. only the company's administrator: a driver's tenant token is refused (403), an identity token is not a tenant token (401)", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const switched = await inject({ url: "/auth/switch-company", token: me.identityToken, payload: { membershipId: me.membershipId } });
  const driverTenant = stringField(switched.body, "tenantToken");

  assert.equal((await inject({ url: UNITS, method: "GET", token: driverTenant })).statusCode, 403);
  assert.equal((await inject({ url: UNITS, method: "PUT", token: driverTenant, payload: { distanceUnit: "mile", volumeUnit: "litre" } })).statusCode, 403);
  assert.equal((await inject({ url: UNITS, method: "GET", token: me.identityToken })).statusCode, 401);
  assert.equal((await inject({ url: UNITS, method: "GET" })).statusCode, 401);
});

// ═══════════════════════════════════════════════════════════════════════════
// The driver's app learns its companies' units
// ═══════════════════════════════════════════════════════════════════════════

test("UN7. every membership the account is told about carries its company's units — /auth/me, switch-company — and null where the company has chosen none", async () => {
  const km = await companyAdmin();
  const me = await driverOf(km);
  const unset = await companyAdmin();
  await prisma.company.update({ where: { id: unset.companyId }, data: { distanceUnit: null, volumeUnit: null } });
  const invited = await inject({ url: "/company/driver-invitations", token: unset.token, payload: { firstName: "Dee", lastName: "River", email: me.email } });
  const second = await inject({ url: `/driver/invitations/${stringField(field(invited.body, "invitation"), "id")}/accept`, token: me.identityToken });
  const unsetMembership = stringField(field(second.body, "membership"), "membershipId");

  const account = await inject({ url: "/auth/me", method: "GET", token: me.identityToken });
  const memberships = list(account.body, "memberships");
  const unitsOf = (id: string) => {
    const m = memberships.find(row => field(row, "membershipId") === id);
    return { distanceUnit: field(m, "distanceUnit"), volumeUnit: field(m, "volumeUnit") };
  };
  assert.deepEqual(unitsOf(me.membershipId), { distanceUnit: "kilometre", volumeUnit: "litre" });
  assert.deepEqual(unitsOf(unsetMembership), { distanceUnit: null, volumeUnit: null });

  const switched = await inject({ url: "/auth/switch-company", token: me.identityToken, payload: { membershipId: me.membershipId } });
  assert.deepEqual(
    { distanceUnit: field(field(switched.body, "membership"), "distanceUnit"), volumeUnit: field(field(switched.body, "membership"), "volumeUnit") },
    { distanceUnit: "kilometre", volumeUnit: "litre" },
  );

  assert.equal((await putUnits(km, { distanceUnit: "mile", volumeUnit: "us_gallon" })).statusCode, 200);
  const reread = list((await inject({ url: "/auth/me", method: "GET", token: me.identityToken })).body, "memberships");
  assert.equal(field(reread.find(row => field(row, "membershipId") === me.membershipId), "distanceUnit"), "mile", "the next read says the change");
});
