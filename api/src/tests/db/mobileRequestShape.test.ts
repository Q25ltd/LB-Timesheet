/**
 * F-38 — the phone's bodyless requests, through REAL Fastify request parsing.
 *
 * The app's HTTP client sent `Content-Type: application/json` on every
 * request, with or without a body. Fastify refuses that header with an empty
 * body — `400 FST_ERR_CTP_EMPTY_JSON_BODY` — so every bodyless POST from the
 * phone was refused: sign-out's server revocation (since September, unseen:
 * the app does not act on its outcome), D63's email confirmation, and
 * accepting and declining an invitation. Mocked responses in the app's tests
 * could not see it.
 *
 * This file sends both shapes over a real socket to the real app (not
 * `inject`), against a real database:
 *
 *   OLD — `content-type: application/json`, no body: still REFUSED, and
 *         nothing changes. The API's strict parsing is kept, on purpose.
 *   NEW — no content-type, no body (what the app now sends): accepted, and
 *         the server does what was asked — the session is revoked, the
 *         token issued, the membership created, the invitation declined.
 *
 * The NEW headers below are exactly what `mobile/src/api/client.ts` sends for
 * a bodyless request (`mobile/src/__tests__/bodylessRequests.test.ts`).
 *
 * WRITTEN RED for the app's side; this file is the server's contract.
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
  throw new Error("DATABASE_URL must be set to run the mobile request shape tests");
}

const ORIGIN = "https://allowed.example.com";
process.env.JWT_SECRET  = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV    = "test";
process.env.WEB_ORIGIN  = ORIGIN;
process.env.WEB_APP_URL = ORIGIN;

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `mobile-request-shape-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const EMPTY_JSON_BODY = "FST_ERR_CTP_EMPTY_JSON_BODY";

let seq = 0;
function freshEmail(): string {
  seq += 1;
  return `${TAG}-${String(seq)}@example.com`;
}

const outbox: MailMessage[] = [];
const capturingMailer: Mailer = { send(message) { outbox.push(message); return Promise.resolve(null); } };

let app: FastifyInstance;
let base = "";

/** The app's two shapes for a bodyless request. */
function headers(shape: "old" | "new", token: string): Record<string, string> {
  return shape === "old"
    ? { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` }
    : { accept: "application/json", authorization: `Bearer ${token}` };
}

/** A real HTTP request over a socket — Fastify's real content-type parsing, not `inject`. */
async function bodyless(shape: "old" | "new", path: string, token: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: headers(shape, token) });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text) as unknown };
}

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? (Reflect.get(body, key) as unknown) : undefined;
}

function stringField(body: unknown, key: string): string {
  const value = field(body, key);
  assert.equal(typeof value, "string", `the response must carry \`${key}\` as a string`);
  return value as string;
}

/**
 * One live server serves the whole file, so its rate limits are shared: each
 * set-up call names its own client (the app is built with
 * `clientIpSource: "x-real-ip"`), as Railway's edge would. The bodyless
 * requests under test name none.
 */
let client = 0;
function nextClient(): string {
  client += 1;
  return `198.51.100.${String(client)}`;
}

async function json(path: string, payload: object, extra: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": nextClient(), ...extra }, body: JSON.stringify(payload) });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text) as unknown };
}

async function driver(email: string, options: { verified?: boolean } = {}): Promise<{ userId: string; identityToken: string; sessionId: string }> {
  const registered = await json("/auth/register", { firstName: "Dee", lastName: "River", email, password: PASSWORD });
  assert.equal(registered.status, 201);
  const userId = stringField(field(registered.body, "user"), "id");
  if (options.verified === true) await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  const session = await prisma.session.findFirstOrThrow({ where: { userId } });
  return { userId, identityToken: stringField(registered.body, "identityToken"), sessionId: session.id };
}

async function companyInviting(name: string, email: string): Promise<string> {
  const admin = freshEmail();
  const registered = await json("/auth/web/register", { companyName: `${TAG}-${name}`, timeZone: "Europe/Vilnius", firstName: "Ada", lastName: "Admin", email: admin, password: PASSWORD }, { origin: ORIGIN });
  assert.equal(registered.status, 201);
  // A live server sends the link after its answer (background work): wait for it.
  let token: string | undefined;
  for (let tries = 0; token === undefined && tries < 100; tries += 1) {
    token = /#token=([A-Za-z0-9_-]+)/.exec(outbox.filter(m => m.to === admin).at(-1)?.text ?? "")?.[1];
    if (token === undefined) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(token !== undefined, "the registration sent its verification link");
  assert.equal((await json("/auth/email-verification/confirm", { token })).status, 200);
  const login = await json("/auth/web/login", { email: admin, password: PASSWORD }, { origin: ORIGIN });
  const invited = await json("/company/driver-invitations", { firstName: "Dee", lastName: "River", email }, { authorization: `Bearer ${stringField(login.body, "tenantToken")}` });
  assert.equal(invited.status, 201);
  return stringField(field(invited.body, "invitation"), "id");
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "Company" WHERE name LIKE ${`${TAG}%`}`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(async () => {
  await cleanup();
  app = await buildApp(prisma, { mailer: capturingMailer, clientIpSource: "x-real-ip" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address !== null && typeof address === "object");
  base = `http://127.0.0.1:${String(address.port)}`;
});
beforeEach(async () => { await cleanup(); outbox.length = 0; });
after(async () => { await app.close(); await cleanup(); await prisma.$disconnect(); });

test("MR1. sign-out: the OLD shape is refused and the session stays live; the NEW shape revokes it", async () => {
  const me = await driver(freshEmail());

  const old = await bodyless("old", "/auth/logout", me.identityToken);
  assert.equal(old.status, 400);
  assert.equal(field(old.body, "code"), EMPTY_JSON_BODY, "the API's strict parsing is kept");
  assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: me.sessionId } })).revokedAt, null, "refused — and so NOT revoked: F-38");

  const fixed = await bodyless("new", "/auth/logout", me.identityToken);
  assert.equal(fixed.status, 204);
  assert.notEqual((await prisma.session.findUniqueOrThrow({ where: { id: me.sessionId } })).revokedAt, null, "the session is revoked server-side");
});

test("MR2. asking for the confirmation email: OLD refused, no token, no email; NEW sends it", async () => {
  const email = freshEmail();
  const me = await driver(email);

  const old = await bodyless("old", "/auth/email-verification", me.identityToken);
  assert.equal(old.status, 400);
  assert.equal(field(old.body, "code"), EMPTY_JSON_BODY);
  assert.equal(await prisma.accountToken.count({ where: { userId: me.userId } }), 0);
  assert.equal(outbox.filter(m => m.to === email).length, 0);

  const fixed = await bodyless("new", "/auth/email-verification", me.identityToken);
  assert.equal(fixed.status, 204);
  assert.equal(await prisma.accountToken.count({ where: { userId: me.userId, purpose: "email_verification" } }), 1);
  assert.equal(outbox.filter(m => m.to === email).length, 1);
});

test("MR3. accepting an invitation: OLD refused and nothing joined; NEW creates the membership", async () => {
  const email = freshEmail();
  const me = await driver(email, { verified: true });
  const id = await companyInviting("Accept", email);

  const old = await bodyless("old", `/driver/invitations/${id}/accept`, me.identityToken);
  assert.equal(old.status, 400);
  assert.equal(field(old.body, "code"), EMPTY_JSON_BODY);
  assert.equal(await prisma.companyMembership.count({ where: { userId: me.userId } }), 0);
  assert.equal((await prisma.driverInvitation.findUniqueOrThrow({ where: { id } })).status, "pending");

  const fixed = await bodyless("new", `/driver/invitations/${id}/accept`, me.identityToken);
  assert.equal(fixed.status, 200);
  assert.equal(await prisma.companyMembership.count({ where: { userId: me.userId, active: true } }), 1);
  assert.equal((await prisma.driverInvitation.findUniqueOrThrow({ where: { id } })).status, "accepted");
});

test("MR4. declining an invitation: OLD refused and still open; NEW declines it", async () => {
  const email = freshEmail();
  const me = await driver(email, { verified: true });
  const id = await companyInviting("Decline", email);

  const old = await bodyless("old", `/driver/invitations/${id}/decline`, me.identityToken);
  assert.equal(old.status, 400);
  assert.equal(field(old.body, "code"), EMPTY_JSON_BODY);
  assert.equal((await prisma.driverInvitation.findUniqueOrThrow({ where: { id } })).status, "pending");

  const fixed = await bodyless("new", `/driver/invitations/${id}/decline`, me.identityToken);
  assert.equal(fixed.status, 204);
  assert.equal((await prisma.driverInvitation.findUniqueOrThrow({ where: { id } })).status, "declined");
  assert.equal(await prisma.companyMembership.count({ where: { userId: me.userId } }), 0);
});
