/**
 * Local development: the verification link the development outbox received,
 * handed to the signed-in account that it was sent to — so a developer can
 * finish a company registration without opening `api/.mail-outbox/`.
 *
 *   GET /dev/email-verification-link   identity — DEVELOPMENT OUTBOX ONLY
 *     → 200 { link } — the EXACT link the message in the outbox contains, and
 *       only if its token is THIS account's live verification token
 *     → 404 when the outbox holds no such message (or none is live)
 *
 * It creates nothing and verifies nothing: the link is the real one, and
 * opening it goes through the normal `confirm` and its normal transaction.
 *
 * The route exists only where messages go to the development outbox
 * (`NODE_ENV=development`, no provider key). Where they do not, it is not
 * registered at all — see `devEmailLinkAbsent.test.ts`.
 *
 * This file runs as DEVELOPMENT with its own temporary outbox directory.
 *
 * WRITTEN RED.
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the development email link tests");
}

const ORIGIN = "http://localhost:5173";
process.env.JWT_SECRET       = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV         = "development";
process.env.WEB_ORIGIN       = ORIGIN;
process.env.WEB_APP_URL      = ORIGIN;
process.env.SENDGRID_API_KEY = "";

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `dev-email-link-test-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
let outbox = "";

let seq = 0;
function freshEmail(): string {
  seq += 1;
  return `${TAG}-${String(seq)}@example.com`;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface Injected { statusCode: number; body: unknown; raw: string }

async function inject(options: { url: string; method?: "GET" | "POST"; payload?: object; token?: string; web?: boolean }): Promise<Injected> {
  const app = await buildApp(prisma, { outboxDirectory: outbox });
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
    await app.close();   // settles the background email write
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

async function registerCompany(email: string): Promise<string> {
  const res = await inject({
    url: "/auth/web/register", web: true,
    payload: { companyName: `${TAG}-co`, timeZone: "Asia/Tokyo", firstName: "Dev", lastName: "Owner", email, password: PASSWORD },
  });
  assert.equal(res.statusCode, 201, `registration — got ${res.raw}`);
  return stringField(res.body, "identityToken");
}

/** Every verification link the outbox holds for `to`, oldest first — read the way a developer would. */
async function linksInOutbox(to: string): Promise<string[]> {
  const links: string[] = [];
  for (const name of (await readdir(outbox)).sort()) {
    const message: unknown = JSON.parse(await readFile(join(outbox, name), "utf8"));
    if (field(message, "to") !== to) continue;
    const match = /(http:\/\/localhost:5173\/verify-email#token=[A-Za-z0-9_-]+)/.exec(String(field(message, "text")));
    if (match?.[1] !== undefined) links.push(match[1]);
  }
  return links;
}

function devLink(identityToken: string): Promise<Injected> {
  return inject({ method: "GET", url: "/dev/email-verification-link", token: identityToken });
}

function tokenOf(link: string): string {
  return link.slice(link.indexOf("#token=") + "#token=".length);
}

function confirm(link: string): Promise<Injected> {
  return inject({ url: "/auth/email-verification/confirm", payload: { token: tokenOf(link) } });
}

async function account(email: string) {
  return prisma.user.findUniqueOrThrow({ where: { accountKind_email: { accountKind: "company", email } } });
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "Company" WHERE name LIKE ${`${TAG}%`}`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(async () => { outbox = await mkdtemp(join(tmpdir(), "lbts-outbox-")); await cleanup(); });
beforeEach(cleanup);
after(async () => { await cleanup(); await prisma.$disconnect(); await rm(outbox, { recursive: true, force: true }); });

test("DL1. after registering, the account is handed the EXACT link its verification email contains — the real token — and nothing is created yet", async () => {
  const email = freshEmail();
  const identityToken = await registerCompany(email);

  const res = await devLink(identityToken);
  assert.equal(res.statusCode, 200, `the development link is available — got ${res.raw}`);
  const link = stringField(res.body, "link");
  assert.deepEqual(await linksInOutbox(email), [link], "the very link the outbox message carries");

  const row = await prisma.accountToken.findFirstOrThrow({ where: { userId: (await account(email)).id, purpose: "email_verification" } });
  assert.equal(digest(tokenOf(link)), row.tokenHash, "the real, stored verification token — not a second mechanism");
  assert.equal(await prisma.companyMembership.count({ where: { userId: (await account(email)).id } }), 0, "no membership before the link is opened");
  assert.equal(await prisma.company.count({ where: { name: `${TAG}-co` } }), 0, "no Company before the link is opened");
});

test("DL2. opening it goes through the normal confirmation: verified, Company, initial admin, pending row gone — and then there is no link to hand out", async () => {
  const email = freshEmail();
  const identityToken = await registerCompany(email);
  const link = stringField((await devLink(identityToken)).body, "link");

  const confirmed = await confirm(link);
  assert.equal(confirmed.statusCode, 200);
  assert.deepEqual(confirmed.body, { companyRegistered: true });
  const user = await account(email);
  assert.notEqual(user.emailVerifiedAt, null);
  const memberships = await prisma.companyMembership.findMany({ where: { userId: user.id }, include: { company: true } });
  assert.deepEqual(memberships.map(m => [m.role, m.company.name, m.company.timezone]), [["admin", `${TAG}-co`, "Asia/Tokyo"]]);
  assert.equal(await prisma.pendingCompanyRegistration.count({ where: { userId: user.id } }), 0);

  assert.equal((await devLink(identityToken)).statusCode, 404, "a spent link is not handed out again");
});

test("DL3. after a resend the account is handed the NEW link; the old one is refused, the new one works", async () => {
  const email = freshEmail();
  const identityToken = await registerCompany(email);
  const first = stringField((await devLink(identityToken)).body, "link");

  assert.equal((await inject({ url: "/auth/email-verification", token: identityToken })).statusCode, 204);
  const second = stringField((await devLink(identityToken)).body, "link");
  assert.notEqual(second, first, "never the superseded link");

  assert.equal((await confirm(first)).statusCode, 400, "the superseded link is refused");
  assert.equal((await confirm(second)).statusCode, 200, "the new one completes the registration");
});

test("DL4. each account is handed ONLY its own link — never another company's, never the same-email driver's", async () => {
  const email = freshEmail();
  // A driver account with the SAME address, which also gets a verification
  // message into the outbox.
  const driver = await inject({ url: "/auth/register", payload: { firstName: "Dee", lastName: "River", email, password: PASSWORD } });
  const driverToken = stringField(driver.body, "identityToken");
  assert.equal((await inject({ url: "/auth/email-verification", token: driverToken })).statusCode, 204);
  const companyToken = await registerCompany(email);
  const otherToken = await registerCompany(freshEmail());

  const companyLink = stringField((await devLink(companyToken)).body, "link");
  const driverLink = stringField((await devLink(driverToken)).body, "link");
  const otherLink = stringField((await devLink(otherToken)).body, "link");
  assert.equal((await linksInOutbox(email)).length, 2, "two messages to one address");
  assert.notEqual(companyLink, driverLink, "the company is never handed the driver's link");
  assert.notEqual(companyLink, otherLink);

  const companyRow = await prisma.accountToken.findFirstOrThrow({ where: { userId: (await account(email)).id } });
  assert.equal(digest(tokenOf(companyLink)), companyRow.tokenHash);
});

test("DL5. no account, a tenant token, or nothing in the outbox: nothing is handed out", async () => {
  const anonymous = await inject({ method: "GET", url: "/dev/email-verification-link" });
  assert.equal(anonymous.statusCode, 401);

  const email = freshEmail();
  const identityToken = await registerCompany(email);
  for (const name of await readdir(outbox)) await rm(join(outbox, name));
  const empty = await devLink(identityToken);
  assert.equal(empty.statusCode, 404, "the token is live, but no message holding it is in the outbox");
  assert.equal(field(empty.body, "link"), undefined);
});
