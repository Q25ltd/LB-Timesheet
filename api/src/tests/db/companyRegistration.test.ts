/**
 * Company registration, end to end on the server (D51, D53) — against a REAL
 * database built by the real migrations.
 *
 *   POST /auth/web/register                 public (Origin-guarded, browser)
 *     { companyName, timeZone, firstName, lastName, email, password }
 *     → ONE transaction: the COMPANY account, its PendingCompanyRegistration
 *       (name + timezone exactly as accepted) and a browser Session; then a
 *       single-use, digest-only email-verification token and its message
 *       through the Mailer. NO Company, NO membership.
 *
 *   POST /auth/email-verification/confirm   public — the token is the credential
 *     → for a company account holding a pending registration, ONE
 *       transaction: consume the token, verify the email, create the Company
 *       (the pending name and timezone), create the initial `admin`
 *       membership, DELETE the pending row. All or nothing; single use.
 *
 * The same email may also be a DRIVER account: it is never found, linked,
 * changed or disclosed by any of this.
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
import type { MailMessage, Mailer } from "../../lib/mailer.js";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the company registration tests");
}

const ORIGIN = "https://allowed.example.com";
process.env.JWT_SECRET  = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV    = "test";
process.env.WEB_ORIGIN  = ORIGIN;
process.env.WEB_APP_URL = ORIGIN;

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `company-registration-test-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const CANONICAL_403 = { error: "Not allowed", code: "FORBIDDEN" };
const TOKEN_INVALID = { error: "This link is invalid or has expired", code: "TOKEN_INVALID" };

let seq = 0;
function freshEmail(): string {
  seq += 1;
  return `${TAG}-${String(seq)}@example.com`;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const outbox: MailMessage[] = [];
const capturingMailer: Mailer = {
  send(message) {
    outbox.push(message);
    return Promise.resolve();
  },
};

interface Injected { statusCode: number; body: unknown; raw: string; setCookie: string | null }

/**
 * One request against a fresh app. `db` lets a test hand the app a client
 * that fails part-way, to prove the confirmation is all or nothing.
 */
async function inject(options: {
  url: string; method?: "GET" | "POST"; payload?: object; token?: string; web?: boolean; db?: PrismaClient;
}): Promise<Injected> {
  const app = await buildApp(options.db ?? prisma, { mailer: capturingMailer });
  try {
    const headers: Record<string, string> = {};
    if (options.web === true) headers["origin"] = ORIGIN;
    if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
    const res = await app.inject({
      method: options.method ?? "POST", url: options.url, headers,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });
    const setCookie = res.headers["set-cookie"];
    return {
      statusCode: res.statusCode,
      body: res.body === "" ? null : (JSON.parse(res.body) as unknown),
      raw: res.body,
      setCookie: typeof setCookie === "string" ? setCookie : null,
    };
  } finally {
    await app.close();   // settles the background email
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

function registration(email: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    companyName: "Tokyo Freight KK", timeZone: "Asia/Tokyo",
    firstName: "Aiko", lastName: "Sato", email, password: PASSWORD, ...overrides,
  };
}

function registerCompany(email: string, overrides: Record<string, unknown> = {}): Promise<Injected> {
  return inject({ url: "/auth/web/register", web: true, payload: registration(email, overrides) });
}

/** The verification token in the newest message to `to`. */
function verificationTokenSentTo(to: string): string {
  const message = outbox.filter(m => m.to === to).at(-1);
  assert.ok(message !== undefined, `expected a verification message to ${to}`);
  const match = /\/verify-email#token=([A-Za-z0-9_-]+)/.exec(message.text);
  assert.ok(match?.[1] !== undefined, "the message must carry a verification link");
  assert.ok(message.html.includes(`#token=${match[1]}`));
  return match[1];
}

function confirm(token: string, db?: PrismaClient): Promise<Injected> {
  return inject({ url: "/auth/email-verification/confirm", payload: { token }, ...(db === undefined ? {} : { db }) });
}

async function companyAccount(email: string) {
  return prisma.user.findUniqueOrThrow({ where: { accountKind_email: { accountKind: "company", email } } });
}

async function pendingOf(userId: string) {
  return prisma.pendingCompanyRegistration.findMany({ where: { userId } });
}

async function membershipsOf(userId: string) {
  return prisma.companyMembership.findMany({ where: { userId }, include: { company: true } });
}

async function registerDriver(email: string): Promise<{ userId: string; refreshToken: string }> {
  const res = await inject({ url: "/auth/register", payload: { firstName: "Dee", lastName: "River", email, password: PASSWORD } });
  assert.equal(res.statusCode, 201, `the same email may be a driver account — got ${res.raw}`);
  return { userId: stringField(field(res.body, "user"), "id"), refreshToken: stringField(res.body, "refreshToken") };
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "Company" WHERE id IN (
    SELECT m."companyId" FROM "CompanyMembership" m JOIN "User" u ON u.id = m."userId" WHERE u.email LIKE ${`${TAG}%`})`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(async () => { await cleanup(); outbox.length = 0; });
after(async () => { await cleanup(); await prisma.$disconnect(); });

// ═════════════════════════════════════════════════════════════════════════════
// Registration
// ═════════════════════════════════════════════════════════════════════════════

test("CR1. registering a company creates the COMPANY account, its pending registration and a browser session — and NO Company or membership", async () => {
  const email = freshEmail();
  const res = await registerCompany(email, { companyName: "  Tokyo  Freight KK  " });

  assert.equal(res.statusCode, 201, `registration succeeds — got ${res.raw}`);
  assert.ok(res.setCookie?.startsWith("lbts_refresh="), "signed in on this browser: the refresh cookie is set");
  assert.equal(typeof field(res.body, "identityToken"), "string");
  assert.equal(field(res.body, "refreshToken"), undefined, "the refresh secret travels only in the cookie");
  assert.equal(field(res.body, "tenantToken"), undefined, "no company, so no tenant authority");

  const account = await companyAccount(email);
  assert.equal(account.accountKind, "company");
  assert.deepEqual([account.firstName, account.lastName], ["Aiko", "Sato"]);
  assert.equal(account.emailVerifiedAt, null, "unverified until the link is opened");

  const pending = await pendingOf(account.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.companyName, "Tokyo  Freight KK", "trimmed; inner spacing is the owner's");
  assert.equal(pending[0]?.timezone, "Asia/Tokyo", "the chosen timezone, exactly");

  assert.deepEqual(await membershipsOf(account.id), [], "no membership before verification");
  assert.equal(await prisma.company.count({ where: { name: "Tokyo  Freight KK" } }), 0, "no Company before verification");

  const sessions = await prisma.session.findMany({ where: { userId: account.id } });
  assert.deepEqual(sessions.map(s => [s.clientKind, s.accountKind]), [["browser", "company"]]);
});

test("CR2. a single-use verification token is issued, stored only as its digest, and sent through the Mailer", async () => {
  const email = freshEmail();
  assert.equal((await registerCompany(email)).statusCode, 201);
  const account = await companyAccount(email);

  const token = verificationTokenSentTo(email);
  const rows = await prisma.accountToken.findMany({ where: { userId: account.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.purpose, "email_verification");
  assert.equal(rows[0]?.tokenHash, digest(token));
  assert.ok(!JSON.stringify(rows).includes(token), "the plaintext is in no column");
  assert.ok((rows[0]?.expiresAt.getTime() ?? 0) - (rows[0]?.issuedAt.getTime() ?? 0) <= 24 * 60 * 60 * 1000, "B4's 24 hours");
});

test("CR3. a DRIVER account with the same email neither blocks, joins nor changes the company registration", async () => {
  const email = freshEmail();
  const driver = await registerDriver(email);
  const driverBefore = await prisma.user.findUniqueOrThrow({ where: { id: driver.userId } });

  const res = await registerCompany(email);
  assert.equal(res.statusCode, 201, `the driver account is irrelevant — got ${res.raw}`);

  const company = await companyAccount(email);
  assert.notEqual(company.id, driver.userId, "a separate account");
  assert.deepEqual(await prisma.user.findUniqueOrThrow({ where: { id: driver.userId } }), driverBefore, "the driver account is untouched");
  assert.deepEqual(await pendingOf(driver.userId), []);
  assert.equal(await prisma.accountToken.count({ where: { userId: driver.userId } }), 0, "nothing was issued to the driver");
  assert.ok(stringField(field(res.body, "user"), "id") === company.id);
});

test("CR4. a second registration of the same COMPANY email is the deliberate 409 (D24) — no second account, pending row or token", async () => {
  const email = freshEmail();
  assert.equal((await registerCompany(email)).statusCode, 201);
  const again = await registerCompany(email.toUpperCase(), { companyName: "Another Name Ltd", timeZone: "Europe/Vilnius" });

  assert.equal(again.statusCode, 409);
  assert.equal(field(again.body, "code"), "EMAIL_IN_USE");
  const account = await companyAccount(email);
  assert.equal(await prisma.user.count({ where: { accountKind: "company", email } }), 1);
  const pending = await pendingOf(account.id);
  assert.deepEqual(pending.map(p => [p.companyName, p.timezone]), [["Tokyo Freight KK", "Asia/Tokyo"]], "the first registration is kept as it was");
});

test("CR5. simultaneous registrations of one company email create ONE account and ONE pending registration", async () => {
  const email = freshEmail();
  const results = await Promise.all([1, 2, 3].map(n => registerCompany(email, { companyName: `Race ${String(n)} Ltd` })));
  assert.deepEqual(results.map(r => r.statusCode).sort(), [201, 409, 409]);
  const account = await companyAccount(email);
  assert.equal((await pendingOf(account.id)).length, 1);
});

test("CR6. the registration DTO is strict: company name and timezone are required and held to D51/D53", async () => {
  const cases: [string, Record<string, unknown>][] = [
    ["no company name", { companyName: undefined }],
    ["a blank company name", { companyName: "   " }],
    ["a 201-character company name", { companyName: "x".repeat(201) }],
    ["no timezone", { timeZone: undefined }],
    ["UTC", { timeZone: "UTC" }],
    ["a fixed offset", { timeZone: "+01:00" }],
    ["an Etc/ zone", { timeZone: "Etc/GMT+5" }],
    ["an abbreviation", { timeZone: "BST" }],
    ["junk", { timeZone: "Mars/Olympus" }],
    ["a short password", { password: "short" }],
    ["a password over 72 bytes", { password: "é".repeat(37) }],
    ["a companyId", { companyId: "c" }],
    ["a userId", { userId: "u" }],
    ["a repeat-password field", { repeatPassword: PASSWORD }],
  ];
  for (const [what, override] of cases) {
    const email = freshEmail();
    const payload = registration(email, override);
    for (const key of Object.keys(override)) if (override[key] === undefined) Reflect.deleteProperty(payload, key);
    const res = await inject({ url: "/auth/web/register", web: true, payload });
    assert.equal(res.statusCode, 400, `refused: ${what} — got ${res.raw}`);
    assert.equal(await prisma.user.count({ where: { email } }), 0, `nothing created for ${what}`);
  }
  // The old person-first body is refused, not quietly accepted.
  const oldShape = await inject({ url: "/auth/web/register", web: true, payload: { firstName: "A", lastName: "B", email: freshEmail(), password: PASSWORD } });
  assert.equal(oldShape.statusCode, 400);
});

test("CR7. the account view of a pending registration shows its company name and timezone — and nothing of any driver account", async () => {
  const email = freshEmail();
  await registerDriver(email);
  const reg = await registerCompany(email);
  const me = await inject({ method: "GET", url: "/auth/me", token: stringField(reg.body, "identityToken") });

  assert.equal(me.statusCode, 200);
  assert.equal(field(me.body, "emailVerified"), false);
  assert.deepEqual(field(me.body, "memberships"), []);
  assert.deepEqual(field(me.body, "pendingCompanyRegistration"), { companyName: "Tokyo Freight KK", timezone: "Asia/Tokyo" });
  assert.ok(!me.raw.includes("driver"), "nothing about the same-email driver account");
});

test("CR8. the phone's driver registration is unchanged — four fields, a mobile session, no pending registration", async () => {
  const email = freshEmail();
  const driver = await registerDriver(email);
  assert.deepEqual(await pendingOf(driver.userId), []);
  const sessions = await prisma.session.findMany({ where: { userId: driver.userId } });
  assert.deepEqual(sessions.map(s => [s.clientKind, s.accountKind]), [["mobile", "driver"]]);
});

// ═════════════════════════════════════════════════════════════════════════════
// Verification completes the registration
// ═════════════════════════════════════════════════════════════════════════════

test("CV1. the link completes the registration in one act: email verified, Company with the pending name and timezone, ONE admin membership, pending row gone, token spent", async () => {
  const email = freshEmail();
  await registerCompany(email, { companyName: "Chicago Freight LLC", timeZone: "America/Chicago" });
  const account = await companyAccount(email);
  const token = verificationTokenSentTo(email);

  const res = await confirm(token);
  assert.equal(res.statusCode, 200, `the link completes it — got ${res.raw}`);
  assert.deepEqual(res.body, { companyRegistered: true });

  assert.notEqual((await companyAccount(email)).emailVerifiedAt, null);
  const memberships = await membershipsOf(account.id);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0]?.role, "admin");
  assert.equal(memberships[0]?.active, true);
  assert.equal(memberships[0]?.accountKind, "company");
  assert.equal(memberships[0]?.company.name, "Chicago Freight LLC");
  assert.equal(memberships[0]?.company.timezone, "America/Chicago", "the pending timezone, exactly — never the Europe/London default");
  assert.deepEqual(await pendingOf(account.id), [], "the pending registration is deleted");
  const row = await prisma.accountToken.findFirstOrThrow({ where: { userId: account.id, purpose: "email_verification" } });
  assert.notEqual(row.consumedAt, null, "the token is spent");
});

test("CV2. a replayed link is the one generic refusal and changes NOTHING", async () => {
  const email = freshEmail();
  await registerCompany(email);
  const token = verificationTokenSentTo(email);
  assert.equal((await confirm(token)).statusCode, 200);
  const account = await companyAccount(email);
  const completed = JSON.stringify(await membershipsOf(account.id));

  const replay = await confirm(token);
  assert.equal(replay.statusCode, 400);
  assert.deepEqual(replay.body, TOKEN_INVALID);
  assert.equal(JSON.stringify(await membershipsOf(account.id)), completed);
  assert.equal(await prisma.companyMembership.count({ where: { userId: account.id } }), 1);
});

test("CV3. simultaneous confirmations with one link create ONE Company and ONE membership", async () => {
  const email = freshEmail();
  await registerCompany(email, { companyName: `${TAG}-race-co` });
  const token = verificationTokenSentTo(email);

  const results = await Promise.all([1, 2, 3, 4, 5].map(() => confirm(token)));
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 400, 400, 400, 400]);
  const account = await companyAccount(email);
  assert.equal(await prisma.company.count({ where: { name: `${TAG}-race-co` } }), 1);
  assert.equal(await prisma.companyMembership.count({ where: { userId: account.id } }), 1);
  assert.deepEqual(await pendingOf(account.id), []);
});

/**
 * A client whose transactions fail at one named step — after the token has
 * been consumed and the account verified — to prove the confirmation is all
 * or nothing. Everything outside `$transaction` is the real client.
 */
function failingAt(model: "company" | "companyMembership" | "pendingCompanyRegistration"): PrismaClient {
  return new Proxy(prisma, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property !== "$transaction" || typeof value !== "function") return value;
      return (fn: (tx: unknown) => Promise<unknown>) => target.$transaction(async tx => fn(new Proxy(tx, {
        get(inner, name, innerReceiver) {
          const delegate: unknown = Reflect.get(inner, name, innerReceiver);
          if (name !== model) return delegate;
          return new Proxy(delegate as object, {
            get(d, method, dReceiver) {
              const fnValue: unknown = Reflect.get(d, method, dReceiver);
              if (typeof fnValue !== "function") return fnValue;
              return () => Promise.reject(new Error(`simulated failure in ${model}`));
            },
          });
        },
      })));
    },
  });
}

test("CV4. a confirmation that fails part-way leaves NOTHING behind: token unspent, email unverified, no Company, no membership, pending row intact — and the link still works", async () => {
  for (const step of ["company", "companyMembership", "pendingCompanyRegistration"] as const) {
    const email = freshEmail();
    await registerCompany(email, { companyName: `${TAG}-rollback-${step}` });
    const account = await companyAccount(email);
    const token = verificationTokenSentTo(email);

    const failed = await confirm(token, failingAt(step));
    assert.ok(failed.statusCode >= 500, `${step}: a fault is not a refusal — got ${String(failed.statusCode)}`);

    assert.equal((await companyAccount(email)).emailVerifiedAt, null, `${step}: still unverified`);
    assert.equal(await prisma.company.count({ where: { name: `${TAG}-rollback-${step}` } }), 0, `${step}: no Company`);
    assert.equal(await prisma.companyMembership.count({ where: { userId: account.id } }), 0, `${step}: no membership`);
    assert.equal((await pendingOf(account.id)).length, 1, `${step}: the pending registration is intact`);
    const row = await prisma.accountToken.findFirstOrThrow({ where: { userId: account.id } });
    assert.equal(row.consumedAt, null, `${step}: the token is unspent`);

    assert.equal((await confirm(token)).statusCode, 200, `${step}: the same link completes it once the fault has passed`);
    assert.equal(await prisma.companyMembership.count({ where: { userId: account.id } }), 1);
  }
});

test("CV5. an expired link is refused and creates nothing", async () => {
  const email = freshEmail();
  await registerCompany(email, { companyName: `${TAG}-expired-co` });
  const account = await companyAccount(email);
  const token = verificationTokenSentTo(email);
  await prisma.$executeRaw`UPDATE "AccountToken" SET "issuedAt" = now() - interval '2 days', "expiresAt" = now() - interval '1 day' WHERE "userId" = ${account.id}`;

  const res = await confirm(token);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, TOKEN_INVALID);
  assert.equal(await prisma.company.count({ where: { name: `${TAG}-expired-co` } }), 0);
  assert.equal((await pendingOf(account.id)).length, 1);
});

test("CV6. a resent link supersedes the first; the first is refused; the resend creates no second pending row; the new link completes it", async () => {
  const email = freshEmail();
  const reg = await registerCompany(email);
  const account = await companyAccount(email);
  const first = verificationTokenSentTo(email);

  const resend = await inject({ url: "/auth/email-verification", token: stringField(reg.body, "identityToken") });
  assert.equal(resend.statusCode, 204);
  const second = verificationTokenSentTo(email);
  assert.notEqual(second, first);
  assert.equal((await pendingOf(account.id)).length, 1, "a resend never touches the pending registration");
  assert.equal(await prisma.companyMembership.count({ where: { userId: account.id } }), 0, "a resend creates no company");

  assert.deepEqual((await confirm(first)).body, TOKEN_INVALID);
  assert.equal((await confirm(second)).statusCode, 200);
  assert.equal(await prisma.companyMembership.count({ where: { userId: account.id } }), 1);
});

test("CV7. a DRIVER account's verification link confirms its email and creates NO company", async () => {
  const email = freshEmail();
  const driver = await registerDriver(email);
  const login = await inject({ url: "/auth/login", payload: { email, password: PASSWORD } });
  assert.equal((await inject({ url: "/auth/email-verification", token: stringField(login.body, "identityToken") })).statusCode, 204);

  const res = await confirm(verificationTokenSentTo(email));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { companyRegistered: false });
  assert.notEqual((await prisma.user.findUniqueOrThrow({ where: { id: driver.userId } })).emailVerifiedAt, null);
  assert.equal(await prisma.companyMembership.count({ where: { userId: driver.userId } }), 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// After verification: the company signs in; the boundaries hold
// ═════════════════════════════════════════════════════════════════════════════

async function completedCompany(email: string, overrides: Record<string, unknown> = {}): Promise<string> {
  assert.equal((await registerCompany(email, overrides)).statusCode, 201);
  assert.equal((await confirm(verificationTokenSentTo(email))).statusCode, 200);
  return (await companyAccount(email)).id;
}

test("CB1. after verification the company signs in on the website and gets its one company's tenant authority", async () => {
  const email = freshEmail();
  await completedCompany(email, { companyName: "Signed In Ltd" });

  const login = await inject({ url: "/auth/web/login", web: true, payload: { email, password: PASSWORD } });
  assert.equal(login.statusCode, 200);
  const memberships = field(login.body, "memberships");
  assert.ok(Array.isArray(memberships) && memberships.length === 1);
  assert.equal(field(memberships[0], "companyName"), "Signed In Ltd");
  assert.equal(field(memberships[0], "role"), "admin");
  assert.equal(typeof field(login.body, "tenantToken"), "string", "exactly one company: selected for it (D13)");
});

test("CB2. the same-email DRIVER cannot sign in on the website, and the company account cannot sign in on the phone", async () => {
  const email = freshEmail();
  await registerDriver(email);
  await completedCompany(email);
  const wrongForWeb = await inject({ url: "/auth/web/login", web: true, payload: { email, password: "the-drivers-own-pass" } });
  assert.equal(wrongForWeb.statusCode, 401);
  // The phone finds the DRIVER account — never the company one — so the
  // company's identity cannot reach the phone.
  const phone = await inject({ url: "/auth/login", payload: { email, password: PASSWORD } });
  assert.equal(phone.statusCode, 200);
  assert.deepEqual(field(phone.body, "memberships"), [], "the driver account gained no company");
});

test("CB3. the company account cannot start a driver shift", async () => {
  const email = freshEmail();
  await completedCompany(email);
  const login = await inject({ url: "/auth/web/login", web: true, payload: { email, password: PASSWORD } });
  const start = await inject({ url: "/shifts/start", token: stringField(login.body, "tenantToken"), payload: { clientEventId: randomUUID(), startedAt: new Date().toISOString() } });
  assert.equal(start.statusCode, 403);
  assert.deepEqual(start.body, CANONICAL_403);
});

test("CB4. the obsolete person-first company set-up route is GONE — no way to create a Company on the Europe/London default", async () => {
  const email = freshEmail();
  const reg = await registerCompany(email);
  await prisma.user.update({ where: { id: (await companyAccount(email)).id }, data: { emailVerifiedAt: new Date() } });
  const res = await inject({ url: "/companies", token: stringField(reg.body, "identityToken"), payload: { name: `${TAG}-old-path` } });
  assert.equal(res.statusCode, 404);
  assert.equal(await prisma.company.count({ where: { name: `${TAG}-old-path` } }), 0);
});

test("CB5. a company's view of itself names only its own company — nothing of other companies or same-email accounts", async () => {
  const email = freshEmail();
  await registerDriver(email);
  await completedCompany(email, { companyName: "Mine Ltd" });
  await completedCompany(freshEmail(), { companyName: "Someone Else Ltd" });

  const login = await inject({ url: "/auth/web/login", web: true, payload: { email, password: PASSWORD } });
  const me = await inject({ method: "GET", url: "/auth/me", token: stringField(login.body, "identityToken") });
  assert.equal(me.statusCode, 200);
  const memberships = field(me.body, "memberships");
  assert.ok(Array.isArray(memberships));
  assert.deepEqual(memberships.map(m => field(m, "companyName")), ["Mine Ltd"]);
  assert.equal(field(me.body, "pendingCompanyRegistration"), null, "completed: nothing pending");
  assert.ok(!me.raw.includes("Someone Else Ltd"));
});
