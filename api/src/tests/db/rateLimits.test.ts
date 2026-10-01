/**
 * Endpoint-specific abuse limits (owner decision B6, 2026-10-01) — against a
 * REAL database, on ONE app instance per test, because the limiter's buckets
 * live in that instance's memory.
 *
 *   login (phone + browser, one bucket)          10 / minute / IP
 *   registration (phone + browser, one bucket)    5 / hour   / IP
 *   forgot password                                5 / hour   / IP  + 3 emails / hour / address, silently
 *   verification resend                            5 / hour   / IP  + 3 emails / hour / address
 *   password change (verifies a password)         10 / minute / IP  — login's limit, for the same surface
 *
 * No lockout: every IP limit is keyed by the CALLER's address, never by the
 * account, so an attacker exhausting their own bucket cannot stop the owner
 * of an email signing in from anywhere else.
 *
 * The client IP is the socket's. `trustProxy` is NOT set (F-15 — the
 * production proxy is not established), so a forged `X-Forwarded-For` moves
 * nothing.
 *
 * WRITTEN RED.
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import type { MailMessage, Mailer } from "../../lib/mailer.js";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the rate-limit tests");
}

const ORIGIN = "https://allowed.example.com";
process.env.JWT_SECRET  = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV    = "test";
process.env.WEB_ORIGIN  = ORIGIN;
process.env.WEB_APP_URL = ORIGIN;

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `rate-limit-test-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const RATE_LIMITED = { error: "Too many requests, try again shortly", code: "RATE_LIMITED" };

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

async function call(app: FastifyInstance, options: {
  url: string; ip: string; payload?: object; token?: string; web?: boolean; headers?: Record<string, string>;
}): Promise<Injected> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.web === true) headers["origin"] = ORIGIN;
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
  const res = await app.inject({
    method: "POST", url: options.url, remoteAddress: options.ip, headers,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
  return { statusCode: res.statusCode, body: res.body === "" ? null : (JSON.parse(res.body) as unknown), raw: res.body };
}

function stringField(body: unknown, key: string): string {
  const value = typeof body === "object" && body !== null ? (Reflect.get(body, key) as unknown) : undefined;
  assert.equal(typeof value, "string", `the response must carry \`${key}\` as a string`);
  return value as string;
}

let app: FastifyInstance;

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(async () => {
  await cleanup();
  outbox.length = 0;
  app = await buildApp(prisma, { mailer: capturingMailer });
});
after(async () => { await cleanup(); await prisma.$disconnect(); });

async function closeApp(): Promise<void> {
  await app.close();   // settles background email work
}

async function registered(ip: string): Promise<{ email: string; identityToken: string }> {
  const email = freshEmail();
  const res = await call(app, { url: "/auth/register", ip, payload: { firstName: "Rate", lastName: "Limit", email, password: PASSWORD } });
  assert.equal(res.statusCode, 201, `setup registration must succeed — got ${res.raw}`);
  return { email, identityToken: stringField(res.body, "identityToken") };
}

test("RL1. login: 10 per minute per IP, ONE bucket for the phone and the browser, and no lockout of the account", async () => {
  const victim = await registered("10.0.1.1");
  const attacker = "10.0.1.2";
  const wrong = { email: victim.email, password: "not-the-password" };

  for (let i = 0; i < 5; i += 1) assert.equal((await call(app, { url: "/auth/login", ip: attacker, payload: wrong })).statusCode, 401);
  for (let i = 0; i < 5; i += 1) assert.equal((await call(app, { url: "/auth/web/login", ip: attacker, web: true, payload: wrong })).statusCode, 401);

  const eleventh = await call(app, { url: "/auth/login", ip: attacker, payload: wrong });
  assert.equal(eleventh.statusCode, 429, "the 11th attempt from one IP, across both transports, is limited");
  assert.deepEqual(eleventh.body, RATE_LIMITED);
  const viaWeb = await call(app, { url: "/auth/web/login", ip: attacker, web: true, payload: wrong });
  assert.equal(viaWeb.statusCode, 429, "the browser route shares the bucket");

  // The account owner, from their own address, is untouched.
  const owner = await call(app, { url: "/auth/login", ip: "10.0.1.3", payload: { email: victim.email, password: PASSWORD } });
  assert.equal(owner.statusCode, 200, "no account lockout: the limit is the attacker's, not the victim's");
  await closeApp();
});

test("RL2. a forged X-Forwarded-For does not move a caller into a fresh bucket (trustProxy is off)", async () => {
  const email = freshEmail();
  for (let i = 0; i < 10; i += 1) {
    await call(app, { url: "/auth/login", ip: "10.0.2.1", payload: { email, password: "nope-nope-nope" }, headers: { "x-forwarded-for": `198.51.100.${String(i)}` } });
  }
  const res = await call(app, { url: "/auth/login", ip: "10.0.2.1", payload: { email, password: "nope-nope-nope" }, headers: { "x-forwarded-for": "203.0.113.99" } });
  assert.equal(res.statusCode, 429, "the socket address decides, not a header the client wrote");
  await closeApp();
});

test("RL3. registration: 5 per hour per IP, one bucket for the phone and the browser", async () => {
  const ip = "10.0.3.1";
  const body = (): object => ({ firstName: "Reg", lastName: "Limit", email: freshEmail(), password: PASSWORD });
  for (let i = 0; i < 3; i += 1) assert.equal((await call(app, { url: "/auth/register", ip, payload: body() })).statusCode, 201);
  for (let i = 0; i < 2; i += 1) assert.equal((await call(app, { url: "/auth/web/register", ip, web: true, payload: body() })).statusCode, 201);

  const sixth = await call(app, { url: "/auth/web/register", ip, web: true, payload: body() });
  assert.equal(sixth.statusCode, 429);
  assert.deepEqual(sixth.body, RATE_LIMITED);
  assert.equal((await call(app, { url: "/auth/register", ip: "10.0.3.2", payload: body() })).statusCode, 201, "another IP is unaffected");
  await closeApp();
});

test("RL4. forgot password: 5 per hour per IP; at most 3 emails per hour per address — SILENTLY, identically for a known and an unknown address", async () => {
  // The website's recovery serves COMPANY accounts (D51), so the known
  // address is a company account registered on the website.
  const knownEmail = freshEmail();
  const reg = await call(app, { url: "/auth/web/register", ip: "10.0.4.0", web: true, payload: { firstName: "Re", lastName: "Set", email: knownEmail, password: PASSWORD } });
  assert.equal(reg.statusCode, 201);
  const known = { email: knownEmail };
  const unknown = freshEmail();

  for (let i = 0; i < 5; i += 1) {
    assert.equal((await call(app, { url: "/auth/password/forgot", ip: "10.0.4.1", payload: { email: unknown } })).statusCode, 204);
  }
  const sixth = await call(app, { url: "/auth/password/forgot", ip: "10.0.4.1", payload: { email: unknown } });
  assert.equal(sixth.statusCode, 429, "the per-IP limit");

  // Five different IPs ask for the KNOWN address: every answer is the same
  // 204, and only three emails go out.
  const answers: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const res = await call(app, { url: "/auth/password/forgot", ip: `10.0.4.${String(10 + i)}`, payload: { email: known.email } });
    assert.equal(res.statusCode, 204, "per-address throttling never changes the answer");
    answers.push(res.raw);
  }
  await closeApp();
  assert.equal(new Set(answers).size, 1);
  const resets = outbox.filter(m => m.to === known.email && m.subject.startsWith("Reset your password"));
  assert.equal(resets.length, 3, "3 reset emails per hour per address");
});

test("RL5. verification resend: at most 3 emails per hour per address — registration's email counts", async () => {
  const email = freshEmail();
  const reg = await call(app, { url: "/auth/web/register", ip: "10.0.5.0", web: true, payload: { firstName: "Re", lastName: "Send", email, password: PASSWORD } });
  assert.equal(reg.statusCode, 201);
  const token = stringField(reg.body, "identityToken");

  // Each from a DIFFERENT IP, so only the per-address throttle can refuse.
  assert.equal((await call(app, { url: "/auth/email-verification", ip: "10.0.5.1", token })).statusCode, 204);
  assert.equal((await call(app, { url: "/auth/email-verification", ip: "10.0.5.2", token })).statusCode, 204);
  const fourthEmail = await call(app, { url: "/auth/email-verification", ip: "10.0.5.3", token });
  assert.equal(fourthEmail.statusCode, 429, "the account owner is told: three emails this hour already");
  assert.deepEqual(fourthEmail.body, RATE_LIMITED);
  await closeApp();
  assert.equal(outbox.filter(m => m.to === email).length, 3);
});

test("RL5b. verification resend: 5 per hour per IP, whoever is asking", async () => {
  const ip = "10.0.5.9";
  for (let i = 0; i < 5; i += 1) {
    // Phone-registered accounts: no email at registration, so no address is near its throttle.
    const account = await registered(`10.0.5.${String(20 + i)}`);
    assert.equal((await call(app, { url: "/auth/email-verification", ip, token: account.identityToken })).statusCode, 204);
  }
  const another = await registered("10.0.5.30");
  const sixth = await call(app, { url: "/auth/email-verification", ip, token: another.identityToken });
  assert.equal(sixth.statusCode, 429, "the sixth request from one IP is limited");
  await closeApp();
});

test("RL6. password change verifies a password, so it carries login's 10 per minute per IP", async () => {
  const account = await registered("10.0.6.0");
  for (let i = 0; i < 10; i += 1) {
    const res = await call(app, { url: "/auth/password/change", ip: "10.0.6.1", token: account.identityToken, payload: { currentPassword: "wrong-guess-pass", newPassword: "a-new-passphrase" } });
    assert.equal(res.statusCode, 403);
  }
  const res = await call(app, { url: "/auth/password/change", ip: "10.0.6.1", token: account.identityToken, payload: { currentPassword: "wrong-guess-pass", newPassword: "a-new-passphrase" } });
  assert.equal(res.statusCode, 429);
  await closeApp();
});
