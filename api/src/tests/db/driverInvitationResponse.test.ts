/**
 * D63, stage 3 — the driver's side of an invitation: list, accept, decline.
 *
 *   GET  /driver/invitations              identity — my open invitations
 *   POST /driver/invitations/:id/accept   identity — join that company
 *   POST /driver/invitations/:id/decline  identity — say no to it
 *
 * Identity posture: a driver with no company yet has no tenant token. What
 * this file proves, with real accounts against a real database:
 *
 *   - only a DRIVER account whose email is VERIFIED sees or answers
 *     invitations, and only those addressed to that email (D24, D63);
 *   - accepting creates the membership — or reactivates the driver's former
 *     one, the same row — in ONE transaction, safe against a concurrent
 *     second acceptance; the company then appears in the driver's companies;
 *   - declining creates nothing; the company sees Declined (owner decision);
 *   - an invitation that is not the driver's is indistinguishable from one
 *     that does not exist;
 *   - the DATABASE binds an accepted invitation to a membership of the SAME
 *     company.
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
  throw new Error("DATABASE_URL must be set to run the driver invitation response tests");
}

const ORIGIN = "https://allowed.example.com";
process.env.JWT_SECRET  = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV    = "test";
process.env.WEB_ORIGIN  = ORIGIN;
process.env.WEB_APP_URL = ORIGIN;

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `driver-invitation-response-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };
const DAY_MS = 24 * 60 * 60 * 1000;

let seq = 0;
function freshEmail(): string {
  seq += 1;
  return `${TAG}-${String(seq)}@example.com`;
}

const outbox: MailMessage[] = [];
const capturingMailer: Mailer = { send(message) { outbox.push(message); return Promise.resolve(null); } };

interface Injected { statusCode: number; body: unknown; raw: string }

async function inject(options: { url: string; method?: "GET" | "POST"; payload?: object; token?: string; web?: boolean }): Promise<Injected> {
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

/** A company and its administrator's tenant token, through the real website flow. */
async function companyAdmin(name: string): Promise<{ companyId: string; token: string; email: string }> {
  const email = freshEmail();
  const registered = await inject({
    url: "/auth/web/register", web: true,
    payload: { companyName: `${TAG}-${name}`, timeZone: "Europe/Vilnius", firstName: "Ada", lastName: "Admin", email, password: PASSWORD },
  });
  assert.equal(registered.statusCode, 201, `registration — got ${registered.raw}`);
  const token = /#token=([A-Za-z0-9_-]+)/.exec(outbox.filter(m => m.to === email).at(-1)?.text ?? "")?.[1];
  assert.ok(token !== undefined);
  assert.equal((await inject({ url: "/auth/email-verification/confirm", payload: { token } })).statusCode, 200);
  const login = await inject({ url: "/auth/web/login", web: true, payload: { email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, `company sign-in — got ${login.raw}`);
  const user = await prisma.user.findUniqueOrThrow({ where: { accountKind_email: { accountKind: "company", email } } });
  const membership = await prisma.companyMembership.findFirstOrThrow({ where: { userId: user.id } });
  outbox.length = 0;
  return { companyId: membership.companyId, token: stringField(login.body, "tenantToken"), email };
}

/** A phone-registered driver account; `verified` stamps the address as proven (the proof itself is emailVerification.test). */
async function driver(email: string, options: { verified?: boolean } = {}): Promise<{ userId: string; identityToken: string }> {
  const registered = await inject({ url: "/auth/register", payload: { firstName: "Dee", lastName: "River", email, password: PASSWORD } });
  assert.equal(registered.statusCode, 201, `driver registration — got ${registered.raw}`);
  const userId = stringField(field(registered.body, "user"), "id");
  if (options.verified !== false) await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  return { userId, identityToken: stringField(registered.body, "identityToken") };
}

async function invite(admin: { token: string }, email: string, over: object = {}): Promise<string> {
  const res = await inject({ url: "/company/driver-invitations", token: admin.token, payload: { firstName: "John", lastName: "Smith", email, payrollRef: "EMP-7", ...over } });
  assert.equal(res.statusCode, 201, `invitation — got ${res.raw}`);
  return stringField(field(res.body, "invitation"), "id");
}

const mine = (identityToken: string): Promise<Injected> => inject({ url: "/driver/invitations", method: "GET", token: identityToken });
const accept = (identityToken: string, id: string): Promise<Injected> => inject({ url: `/driver/invitations/${id}/accept`, token: identityToken });
const decline = (identityToken: string, id: string): Promise<Injected> => inject({ url: `/driver/invitations/${id}/decline`, token: identityToken });

async function companyView(admin: { token: string }, id: string): Promise<unknown> {
  const listed = await inject({ url: "/company/driver-invitations", method: "GET", token: admin.token });
  return list(listed.body, "invitations").find(row => field(row, "id") === id);
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "Company" WHERE name LIKE ${`${TAG}%`}`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(async () => { await cleanup(); outbox.length = 0; });
after(async () => { await cleanup(); await prisma.$disconnect(); });

// ═══════════════════════════════════════════════════════════════════════════
// Seeing my invitations
// ═══════════════════════════════════════════════════════════════════════════

test("DR1. a verified driver sees the OPEN invitations addressed to their email — from every company — with what each company typed", async () => {
  const northgate = await companyAdmin("Northgate");
  const seaway = await companyAdmin("Seaway");
  const email = freshEmail();
  const me = await driver(email);
  const fromNorthgate = await invite(northgate, email.toUpperCase());
  const fromSeaway = await invite(seaway, email, { firstName: "Johnny" });
  const cancelled = await invite(await companyAdmin("Cancelled"), email);
  await prisma.driverInvitation.update({ where: { id: cancelled }, data: { status: "cancelled" } });
  const lapsed = await invite(await companyAdmin("Lapsed"), email);
  await prisma.driverInvitation.update({ where: { id: lapsed }, data: { createdAt: new Date(Date.now() - 31 * DAY_MS), expiresAt: new Date(Date.now() - DAY_MS) } });
  await invite(northgate, freshEmail());

  const res = await mine(me.identityToken);

  assert.equal(res.statusCode, 200, `got ${res.raw}`);
  const rows = list(res.body, "invitations");
  assert.deepEqual(rows.map(row => field(row, "id")).sort(), [fromNorthgate, fromSeaway].sort(), "only open invitations to MY address");
  const seawayRow = rows.find(row => field(row, "id") === fromSeaway);
  assert.equal(field(seawayRow, "companyName"), `${TAG}-Seaway`);
  assert.equal(field(seawayRow, "firstName"), "Johnny");
  assert.equal(field(seawayRow, "lastName"), "Smith");
  assert.equal(typeof field(seawayRow, "expiresAt"), "string");
  assert.deepEqual(Object.keys(seawayRow as object).sort(), ["companyName", "expiresAt", "firstName", "id", "lastName"], "nothing of the company's internals — no payroll reference, no company id");
});

test("DR2. an UNVERIFIED driver sees none and can answer none; a company account sees none — whatever its email", async () => {
  const admin = await companyAdmin("Waiting");
  const email = freshEmail();
  const unverified = await driver(email, { verified: false });
  const id = await invite(admin, email);

  const listed = await mine(unverified.identityToken);
  assert.equal(listed.statusCode, 403, `got ${listed.raw}`);
  assert.equal(field(listed.body, "code"), "EMAIL_NOT_VERIFIED");
  const accepted = await accept(unverified.identityToken, id);
  assert.equal(accepted.statusCode, 403);
  assert.equal(field(accepted.body, "code"), "EMAIL_NOT_VERIFIED");
  assert.equal(await prisma.companyMembership.count({ where: { userId: unverified.userId } }), 0);

  // A COMPANY account using the invited address — a different account (D51).
  const other = await companyAdmin("Lookalike");
  const login = await inject({ url: "/auth/web/login", web: true, payload: { email: other.email, password: PASSWORD } });
  const asCompany = await inject({ url: "/driver/invitations", method: "GET", token: stringField(login.body, "identityToken") });
  assert.equal(asCompany.statusCode, 403, "a company account has no driver invitations");

  const anonymous = await inject({ url: "/driver/invitations", method: "GET" });
  assert.equal(anonymous.statusCode, 401);
  assert.deepEqual(anonymous.body, CANONICAL_401);
});

// ═══════════════════════════════════════════════════════════════════════════
// Accepting
// ═══════════════════════════════════════════════════════════════════════════

test("DR3. accepting joins the company: an active DRIVER membership with the company's payroll reference, the invitation accepted and bound to it — and the company appears in my companies", async () => {
  const admin = await companyAdmin("Joining");
  const email = freshEmail();
  const me = await driver(email);
  const id = await invite(admin, email);

  const res = await accept(me.identityToken, id);

  assert.equal(res.statusCode, 200, `got ${res.raw}`);
  const membership = field(res.body, "membership");
  assert.equal(field(membership, "companyId"), admin.companyId);
  assert.equal(field(membership, "companyName"), `${TAG}-Joining`);
  assert.equal(field(membership, "role"), "driver");
  const row = await prisma.companyMembership.findUniqueOrThrow({ where: { id: stringField(membership, "membershipId") } });
  assert.deepEqual({ userId: row.userId, companyId: row.companyId, role: row.role, active: row.active, payrollRef: row.payrollRef },
    { userId: me.userId, companyId: admin.companyId, role: "driver", active: true, payrollRef: "EMP-7" });
  const invitation = await prisma.driverInvitation.findUniqueOrThrow({ where: { id } });
  assert.equal(invitation.status, "accepted");
  assert.equal(invitation.membershipId, row.id);
  assert.ok(invitation.respondedAt !== null);

  const meNow = await inject({ url: "/auth/me", method: "GET", token: me.identityToken });
  assert.deepEqual(list(meNow.body, "memberships").map(m => field(m, "companyId")), [admin.companyId]);
  const switched = await inject({ url: "/auth/switch-company", token: me.identityToken, payload: { membershipId: row.id } });
  assert.equal(switched.statusCode, 200, "the driver can now act for the company");
  assert.equal(field(await companyView(admin, id), "status"), "accepted");
  assert.deepEqual(list((await mine(me.identityToken)).body, "invitations"), [], "an answered invitation is no longer open");
});

test("DR4. declining creates NO membership; the company sees Declined; the invitation is no longer open", async () => {
  const admin = await companyAdmin("Declined");
  const email = freshEmail();
  const me = await driver(email);
  const id = await invite(admin, email);

  const res = await decline(me.identityToken, id);

  assert.equal(res.statusCode, 204, `got ${res.raw}`);
  assert.equal(await prisma.companyMembership.count({ where: { userId: me.userId } }), 0);
  const invitation = await prisma.driverInvitation.findUniqueOrThrow({ where: { id } });
  assert.equal(invitation.status, "declined");
  assert.equal(invitation.membershipId, null);
  assert.ok(invitation.respondedAt !== null);
  assert.equal(field(await companyView(admin, id), "status"), "declined");
  assert.equal((await accept(me.identityToken, id)).statusCode, 409, "a declined invitation cannot then be accepted");
});

test("DR5. another driver — verified, different email — cannot see, accept or decline my invitation: answered exactly as for one that does not exist", async () => {
  const admin = await companyAdmin("Mine");
  const email = freshEmail();
  await driver(email);
  const id = await invite(admin, email);
  const stranger = await driver(freshEmail());
  const missing = "c" + "x".repeat(24);

  assert.deepEqual(list((await mine(stranger.identityToken)).body, "invitations"), []);
  for (const answer of [accept, decline]) {
    const theirs = await answer(stranger.identityToken, id);
    const nobodys = await answer(stranger.identityToken, missing);
    assert.equal(theirs.statusCode, 404);
    assert.equal(theirs.raw, nobodys.raw, "byte-identical");
  }
  assert.equal((await prisma.driverInvitation.findUniqueOrThrow({ where: { id } })).status, "pending");
  assert.equal(await prisma.companyMembership.count({ where: { companyId: admin.companyId, role: "driver" } }), 0);
});

test("DR6. a cancelled, expired or already-answered invitation cannot be accepted or declined — and nothing changes", async () => {
  const admin = await companyAdmin("Closed");
  const email = freshEmail();
  const me = await driver(email);

  const cancelled = await invite(admin, email);
  await inject({ url: `/company/driver-invitations/${cancelled}/cancel`, token: admin.token });
  const lapsed = await invite(admin, email);
  await prisma.driverInvitation.update({ where: { id: lapsed }, data: { createdAt: new Date(Date.now() - 31 * DAY_MS), expiresAt: new Date(Date.now() - DAY_MS) } });

  for (const id of [cancelled, lapsed]) {
    for (const answer of [accept, decline]) {
      const res = await answer(me.identityToken, id);
      assert.equal(res.statusCode, 409, `got ${res.raw}`);
      assert.equal(field(res.body, "code"), "INVITATION_NOT_PENDING");
    }
  }
  assert.equal(await prisma.companyMembership.count({ where: { userId: me.userId } }), 0);

  const open = await invite(admin, email);
  assert.equal((await accept(me.identityToken, open)).statusCode, 200);
  const again = await accept(me.identityToken, open);
  assert.equal(again.statusCode, 409, "accepting twice is refused");
  assert.equal(await prisma.companyMembership.count({ where: { userId: me.userId } }), 1);
});

test("DR7. two SIMULTANEOUS acceptances of one invitation: exactly one succeeds, exactly one membership exists", async () => {
  const admin = await companyAdmin("Race");
  const email = freshEmail();
  const me = await driver(email);
  const id = await invite(admin, email);

  const results = await Promise.all([accept(me.identityToken, id), accept(me.identityToken, id), accept(me.identityToken, id)]);

  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409, 409], results.map(r => r.raw).join(" | "));
  assert.equal(await prisma.companyMembership.count({ where: { userId: me.userId, companyId: admin.companyId } }), 1);
});

test("DR8. a REMOVED driver who rejoins gets their old membership back — the same row, active again, with the new payroll reference — never a second one", async () => {
  const admin = await companyAdmin("Rejoin");
  const email = freshEmail();
  const me = await driver(email);
  const first = await invite(admin, email);
  const joined = stringField(field((await accept(me.identityToken, first)).body, "membership"), "membershipId");
  await prisma.companyMembership.update({ where: { id: joined }, data: { active: false, removedAt: new Date() } });

  const second = await invite(admin, email, { payrollRef: "EMP-NEW" });
  const res = await accept(me.identityToken, second);

  assert.equal(res.statusCode, 200, `got ${res.raw}`);
  assert.equal(stringField(field(res.body, "membership"), "membershipId"), joined, "the same membership row");
  const row = await prisma.companyMembership.findUniqueOrThrow({ where: { id: joined } });
  assert.equal(row.active, true);
  assert.equal(row.removedAt, null, "back on the company's list (D65)");
  assert.equal(row.payrollRef, "EMP-NEW");
  assert.equal(await prisma.companyMembership.count({ where: { userId: me.userId } }), 1);
});

test("DR9. invitations follow the VERIFIED address: after the driver's email changes, an invitation to the old one is no longer theirs", async () => {
  const admin = await companyAdmin("Moved");
  const email = freshEmail();
  const me = await driver(email);
  const id = await invite(admin, email);
  await prisma.user.update({ where: { id: me.userId }, data: { email: freshEmail() } });

  assert.deepEqual(list((await mine(me.identityToken)).body, "invitations"), []);
  assert.equal((await accept(me.identityToken, id)).statusCode, 404);
});

test("DR10. accept and decline take no body — a company, membership or role sent by the client is refused", async () => {
  const admin = await companyAdmin("Strict");
  const email = freshEmail();
  const me = await driver(email);
  const id = await invite(admin, email);

  for (const payload of [{ companyId: "elsewhere" }, { role: "admin" }, { membershipId: "m1" }]) {
    const res = await inject({ url: `/driver/invitations/${id}/accept`, token: me.identityToken, payload });
    assert.equal(res.statusCode, 400, `got ${res.raw}`);
  }
  assert.equal((await prisma.driverInvitation.findUniqueOrThrow({ where: { id } })).status, "pending");
});

// ═══════════════════════════════════════════════════════════════════════════
// The database's own guarantees
// ═══════════════════════════════════════════════════════════════════════════

test("DR11. the DATABASE refuses an accepted invitation with no membership, a membership of ANOTHER company, and an answer with no time", async () => {
  const a = await companyAdmin("DbA");
  const b = await companyAdmin("DbB");
  const me = await driver(freshEmail());
  const memberOfB = await prisma.companyMembership.create({ data: { companyId: b.companyId, userId: me.userId, accountKind: "driver", role: "driver", active: true } });
  const base = { companyId: a.companyId, email: freshEmail(), firstName: "A", lastName: "B", expiresAt: new Date(Date.now() + DAY_MS) };

  await assert.rejects(prisma.driverInvitation.create({ data: { ...base, status: "accepted", respondedAt: new Date() } }), "accepted needs its membership");
  await assert.rejects(prisma.driverInvitation.create({ data: { ...base, status: "accepted", respondedAt: new Date(), membershipId: memberOfB.id } }), "a membership of another company");
  await assert.rejects(prisma.driverInvitation.create({ data: { ...base, status: "declined" } }), "an answer has a time");
  await assert.rejects(prisma.driverInvitation.create({ data: { ...base, status: "pending", membershipId: memberOfB.id } }), "only an accepted one is bound to a membership");
  await prisma.driverInvitation.create({ data: { ...base, status: "declined", respondedAt: new Date() } });
});
