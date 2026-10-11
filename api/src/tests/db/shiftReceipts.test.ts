/**
 * D66, stage S3 — start receipts: server evidence that a company's day
 * existed while the driver's membership was active.
 *
 *   POST /driver/shift-receipts   identity posture — `authorizeTimesheetSubmission`
 *
 * The phone queues one when a company's day starts (or a day is made a
 * company's) and sends it when it can; it never blocks working offline. The
 * server keeps ITS OWN `receivedAt` — the only time that counts as evidence —
 * and refuses a receipt for a membership that is not active. Receipts are
 * not company-visible. Real accounts, memberships and tokens.
 *
 * WRITTEN RED. Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import type { MailMessage, Mailer } from "../../lib/mailer.js";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the shift receipt tests");
}

const ORIGIN = "https://allowed.example.com";
process.env.JWT_SECRET  = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV    = "test";
process.env.WEB_ORIGIN  = ORIGIN;
process.env.WEB_APP_URL = ORIGIN;

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `shift-receipts-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const RECEIPTS = "/driver/shift-receipts";

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

function receipt(identityToken: string, payload: object): Promise<Injected> {
  return inject({ url: RECEIPTS, token: identityToken, payload });
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "ShiftStartReceipt" WHERE "companyId" IN (SELECT id FROM "Company" WHERE name LIKE ${`${TAG}%`})`;
  await prisma.$executeRaw`DELETE FROM "Company" WHERE name LIKE ${`${TAG}%`}`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(async () => { await cleanup(); outbox.length = 0; });
after(async () => { await cleanup(); await prisma.$disconnect(); });

const act = (admin: Admin, membershipId: string, action: "deactivate" | "remove") =>
  inject({ url: `/company/drivers/${membershipId}/${action}`, token: admin.token });

test("SR1. an ACTIVE membership's receipt is kept with the SERVER's receivedAt, and the day's date as the company files it — from the DECLARED start", async () => {
  const admin = await companyAdmin({ timeZone: "Asia/Tokyo" });
  const me = await driverOf(admin);
  const clientEventId = randomUUID();
  const sentAt = Date.now();

  // 15:30Z on 10 Oct is 00:30 on 11 Oct in Tokyo: the company's date.
  const res = await receipt(me.identityToken, { membershipId: me.membershipId, clientEventId, startedAt: "2026-10-10T15:30:00.000Z" });

  assert.equal(res.statusCode, 201, `got ${res.raw}`);
  const receivedAt = Date.parse(stringField(field(res.body, "receipt"), "receivedAt"));
  assert.ok(receivedAt >= sentAt - 1000 && receivedAt <= Date.now() + 1000, "the server's clock, not the phone's");
  const row = await prisma.shiftStartReceipt.findFirstOrThrow({ where: { membershipId: me.membershipId, clientEventId } });
  assert.equal(row.companyId, admin.companyId);
  assert.equal(row.userId, me.userId);
  assert.equal(row.declaredStartedAt.toISOString(), "2026-10-10T15:30:00.000Z");
  assert.equal(row.shiftDate.toISOString().slice(0, 10), "2026-10-11");
  assert.equal(row.companyTimezone, "Asia/Tokyo");
});

test("SR2. the same receipt sent again is the SAME receipt — its first receivedAt, one row; a different start under the same id is refused", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const body = { membershipId: me.membershipId, clientEventId: randomUUID(), startedAt: "2026-10-11T05:00:00+03:00" };
  const first = await receipt(me.identityToken, body);

  const again = await receipt(me.identityToken, body);

  assert.equal(again.statusCode, 200, `got ${again.raw}`);
  assert.deepEqual(field(again.body, "receipt"), field(first.body, "receipt"));
  assert.equal(await prisma.shiftStartReceipt.count({ where: { membershipId: me.membershipId } }), 1);
  const changed = await receipt(me.identityToken, { ...body, startedAt: "2026-10-11T06:00:00+03:00" });
  assert.equal(changed.statusCode, 409);
  assert.equal(field(changed.body, "code"), "RECEIPT_MISMATCH");
});

test("SR3. a DEACTIVATED or REMOVED membership gets no receipt — the generic 403 — so a withdrawn driver can never make a verified start", async () => {
  for (const action of ["deactivate", "remove"] as const) {
    const admin = await companyAdmin();
    const me = await driverOf(admin);
    assert.equal((await act(admin, me.membershipId, action)).statusCode, 200);

    const res = await receipt(me.identityToken, { membershipId: me.membershipId, clientEventId: randomUUID(), startedAt: new Date().toISOString() });

    assert.equal(res.statusCode, 403, `${action}: got ${res.raw}`);
    assert.deepEqual(res.body, { error: "Not allowed", code: "FORBIDDEN" });
    assert.equal(await prisma.shiftStartReceipt.count({ where: { membershipId: me.membershipId } }), 0);
  }
});

test("SR4. a membership that is not the signed-in driver's — another driver's, an administrator's, or none — is the same 404", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const other = await driverOf(admin);
  const adminMembership = await prisma.companyMembership.findFirstOrThrow({ where: { companyId: admin.companyId, role: "admin" } });
  const body = (membershipId: string) => ({ membershipId, clientEventId: randomUUID(), startedAt: new Date().toISOString() });

  const theirs = await receipt(me.identityToken, body(other.membershipId));
  const nobodys = await receipt(me.identityToken, body("c" + "x".repeat(24)));
  const admins = await receipt(me.identityToken, body(adminMembership.id));

  assert.equal(theirs.statusCode, 404);
  assert.equal(theirs.raw, nobodys.raw, "byte-identical");
  assert.equal(admins.raw, nobodys.raw);
  assert.equal(await prisma.shiftStartReceipt.count({ where: { companyId: admin.companyId } }), 0);
});

test("SR5. the identity token only: a tenant token is the wrong kind (401), no token 401", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const tenant = stringField((await inject({ url: "/auth/switch-company", token: me.identityToken, payload: { membershipId: me.membershipId } })).body, "tenantToken");
  const body = { membershipId: me.membershipId, clientEventId: randomUUID(), startedAt: new Date().toISOString() };

  assert.equal((await receipt(tenant, body)).statusCode, 401);
  assert.equal((await inject({ url: RECEIPTS, payload: body })).statusCode, 401);
});

test("SR6. strict: a company, a user or a date from the client is refused; an id must be a UUID; a start must carry its offset", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const ok = { membershipId: me.membershipId, clientEventId: randomUUID(), startedAt: "2026-10-11T05:00:00+03:00" };
  for (const payload of [
    { ...ok, companyId: admin.companyId }, { ...ok, userId: me.userId }, { ...ok, shiftDate: "2026-10-11" },
    { ...ok, clientEventId: "not-a-uuid" }, { ...ok, startedAt: "2026-10-11T05:00:00" }, { ...ok, membershipId: "" },
  ]) {
    const res = await receipt(me.identityToken, payload);
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload).slice(0, 80)} — got ${res.raw}`);
  }
  assert.equal(await prisma.shiftStartReceipt.count({ where: { membershipId: me.membershipId } }), 0);
});

test("SR7. at most 50 NEW receipts per membership a day — a replay of one already kept is never counted or refused", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const kept = { membershipId: me.membershipId, clientEventId: randomUUID(), startedAt: new Date().toISOString() };
  assert.equal((await receipt(me.identityToken, kept)).statusCode, 201);
  await prisma.shiftStartReceipt.createMany({
    data: Array.from({ length: 49 }, () => ({
      companyId: admin.companyId, membershipId: me.membershipId, userId: me.userId, clientEventId: randomUUID(),
      declaredStartedAt: new Date(), shiftDate: new Date("2026-10-11"), companyTimezone: "Europe/Vilnius",
    })),
  });

  const fiftyFirst = await receipt(me.identityToken, { ...kept, clientEventId: randomUUID() });
  assert.equal(fiftyFirst.statusCode, 429, `got ${fiftyFirst.raw}`);
  assert.equal((await receipt(me.identityToken, kept)).statusCode, 200, "the replay still answers");
});

test("SR8. the DATABASE binds a receipt to its membership's own company and user, and keeps one per membership and id", async () => {
  const a = await companyAdmin();
  const b = await companyAdmin();
  const me = await driverOf(a);
  const row = { membershipId: me.membershipId, userId: me.userId, clientEventId: randomUUID(), declaredStartedAt: new Date(), shiftDate: new Date("2026-10-11"), companyTimezone: "Europe/Vilnius" };

  await assert.rejects(prisma.shiftStartReceipt.create({ data: { ...row, companyId: b.companyId } }), "another company");
  await prisma.shiftStartReceipt.create({ data: { ...row, companyId: a.companyId } });
  await assert.rejects(prisma.shiftStartReceipt.create({ data: { ...row, companyId: a.companyId } }), "one per membership and id");
});
