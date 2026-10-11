/**
 * D65 — a company deactivates, reactivates and removes its drivers.
 *
 *   GET  /company/drivers                          tenant (admin) — the company's drivers
 *   POST /company/drivers/:membershipId/deactivate tenant (admin)
 *   POST /company/drivers/:membershipId/reactivate tenant (admin)
 *   POST /company/drivers/:membershipId/remove     tenant (admin)
 *
 * On the existing membership: `active` stays the one access switch, removal
 * is soft (`removedAt`), every transition is one conditional write and is
 * recorded in `MembershipEvent`. Real accounts, sessions, memberships (joined
 * through D63's real invitation flow) and tokens, against a real database.
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
  throw new Error("DATABASE_URL must be set to run the company driver management tests");
}

const ORIGIN = "https://allowed.example.com";
process.env.JWT_SECRET  = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV    = "test";
process.env.WEB_ORIGIN  = ORIGIN;
process.env.WEB_APP_URL = ORIGIN;

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `company-driver-mgmt-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const DRIVERS = "/company/drivers";

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

interface Admin { companyId: string; token: string; userId: string }

async function companyAdmin(name: string): Promise<Admin> {
  const email = freshEmail();
  const registered = await inject({
    url: "/auth/web/register", web: true,
    payload: { companyName: `${TAG}-${name}`, timeZone: "Europe/Vilnius", distanceUnit: "kilometre", volumeUnit: "litre", firstName: "Ada", lastName: "Admin", email, password: PASSWORD },
  });
  assert.equal(registered.statusCode, 201, `registration — got ${registered.raw}`);
  const token = /#token=([A-Za-z0-9_-]+)/.exec(outbox.filter(m => m.to === email).at(-1)?.text ?? "")?.[1];
  assert.ok(token !== undefined);
  assert.equal((await inject({ url: "/auth/email-verification/confirm", payload: { token } })).statusCode, 200);
  const login = await inject({ url: "/auth/web/login", web: true, payload: { email, password: PASSWORD } });
  assert.equal(login.statusCode, 200);
  const user = await prisma.user.findUniqueOrThrow({ where: { accountKind_email: { accountKind: "company", email } } });
  const membership = await prisma.companyMembership.findFirstOrThrow({ where: { userId: user.id } });
  outbox.length = 0;
  return { companyId: membership.companyId, token: stringField(login.body, "tenantToken"), userId: user.id };
}

interface Driver { userId: string; identityToken: string; email: string }

async function driver(email = freshEmail()): Promise<Driver> {
  const registered = await inject({ url: "/auth/register", payload: { firstName: "Dee", lastName: "River", email, password: PASSWORD } });
  assert.equal(registered.statusCode, 201);
  const userId = stringField(field(registered.body, "user"), "id");
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  return { userId, identityToken: stringField(registered.body, "identityToken"), email };
}

function invite(admin: Admin, email: string, over: object = {}): Promise<Injected> {
  return inject({ url: "/company/driver-invitations", token: admin.token, payload: { firstName: "Dee", lastName: "River", email, payrollRef: "EMP-1", ...over } });
}

/** Through D63's real flow: invite, then the driver accepts. Answers the membership id. */
async function joined(admin: Admin, me: Driver, over: object = {}): Promise<string> {
  const invited = await invite(admin, me.email, over);
  assert.equal(invited.statusCode, 201, `invitation — got ${invited.raw}`);
  const accepted = await inject({ url: `/driver/invitations/${stringField(field(invited.body, "invitation"), "id")}/accept`, token: me.identityToken });
  assert.equal(accepted.statusCode, 200, `acceptance — got ${accepted.raw}`);
  return stringField(field(accepted.body, "membership"), "membershipId");
}

const act = (admin: Admin, membershipId: string, action: "deactivate" | "reactivate" | "remove", payload?: object): Promise<Injected> =>
  inject({ url: `${DRIVERS}/${membershipId}/${action}`, token: admin.token, ...(payload === undefined ? {} : { payload }) });

async function drivers(admin: Admin): Promise<unknown[]> {
  const res = await inject({ url: DRIVERS, method: "GET", token: admin.token });
  assert.equal(res.statusCode, 200, `list — got ${res.raw}`);
  return list(res.body, "drivers");
}

/** The driver's tenant token for one company — what Start Shift's server route needs. */
async function tenantFor(me: Driver, membershipId: string): Promise<Injected> {
  return inject({ url: "/auth/switch-company", token: me.identityToken, payload: { membershipId } });
}

function startShift(tenantToken: string): Promise<Injected> {
  return inject({ url: "/shifts/start", token: tenantToken, payload: { startedAt: new Date().toISOString(), clientEventId: randomUUID() } });
}

async function events(membershipId: string): Promise<string[]> {
  return (await prisma.membershipEvent.findMany({ where: { membershipId }, orderBy: { occurredAt: "asc" } })).map(e => e.kind);
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "Shift" WHERE "companyId" IN (SELECT id FROM "Company" WHERE name LIKE ${`${TAG}%`})`;
  await prisma.$executeRaw`DELETE FROM "Company" WHERE name LIKE ${`${TAG}%`}`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(async () => { await cleanup(); outbox.length = 0; });
after(async () => { await cleanup(); await prisma.$disconnect(); });

// ═══════════════════════════════════════════════════════════════════════════
// The list
// ═══════════════════════════════════════════════════════════════════════════

test("CM1. the company's drivers: active and inactive, each with the account's name and email and the company's payroll reference — removed ones and administrators not listed", async () => {
  const admin = await companyAdmin("List");
  const active = await driver();
  const inactive = await driver();
  const removed = await driver();
  const activeId = await joined(admin, active, { payrollRef: "P-A" });
  const inactiveId = await joined(admin, inactive);
  const removedId = await joined(admin, removed);
  assert.equal((await act(admin, inactiveId, "deactivate")).statusCode, 200);
  assert.equal((await act(admin, removedId, "remove")).statusCode, 200);

  const rows = await drivers(admin);

  assert.deepEqual(rows.map(r => field(r, "membershipId")).sort(), [activeId, inactiveId].sort());
  const a = rows.find(r => field(r, "membershipId") === activeId);
  assert.deepEqual(
    { firstName: field(a, "firstName"), lastName: field(a, "lastName"), email: field(a, "email"), payrollRef: field(a, "payrollRef"), status: field(a, "status") },
    { firstName: "Dee", lastName: "River", email: active.email, payrollRef: "P-A", status: "active" },
  );
  assert.equal(field(rows.find(r => field(r, "membershipId") === inactiveId), "status"), "inactive");
  assert.deepEqual(Object.keys(a as object).sort(), ["email", "firstName", "joinedAt", "lastName", "membershipId", "payrollRef", "status"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Deactivate → Reactivate
// ═══════════════════════════════════════════════════════════════════════════

test("CM2. Deactivate: no new shifts and no company authority — at once, even with a token issued before; the membership and its history stay; recorded", async () => {
  const admin = await companyAdmin("Deactivate");
  const me = await driver();
  const membershipId = await joined(admin, me);
  const issued = await tenantFor(me, membershipId);
  assert.equal(issued.statusCode, 200);
  const staleTenant = stringField(issued.body, "tenantToken");
  const started = await startShift(staleTenant);
  assert.equal(started.statusCode, 201, `a shift while active — got ${started.raw}`);

  const res = await act(admin, membershipId, "deactivate");

  assert.equal(res.statusCode, 200, `got ${res.raw}`);
  assert.equal(field(field(res.body, "driver"), "status"), "inactive");
  const row = await prisma.companyMembership.findUniqueOrThrow({ where: { id: membershipId } });
  assert.equal(row.active, false);
  assert.equal(row.removedAt, null);
  assert.equal(await prisma.shift.count({ where: { membershipId } }), 1, "the shift started before stays");
  assert.ok((await startShift(staleTenant)).statusCode >= 401, "a token issued BEFORE deactivation starts nothing now");
  assert.equal((await tenantFor(me, membershipId)).statusCode, 403, "no new company authority");
  const meNow = await inject({ url: "/auth/me", method: "GET", token: me.identityToken });
  assert.deepEqual(list(meNow.body, "memberships"), [], "Start Shift will not offer it");
  assert.deepEqual(await events(membershipId), ["joined", "deactivated"]);
  const event = await prisma.membershipEvent.findFirstOrThrow({ where: { membershipId, kind: "deactivated" } });
  assert.equal(event.actorUserId, admin.userId, "who did it is recorded");
});

test("CM3. Reactivate restores it: listed active, offered at Start Shift, new shifts allowed; recorded", async () => {
  const admin = await companyAdmin("Reactivate");
  const me = await driver();
  const membershipId = await joined(admin, me);
  await act(admin, membershipId, "deactivate");

  const res = await act(admin, membershipId, "reactivate");

  assert.equal(res.statusCode, 200, `got ${res.raw}`);
  assert.equal(field(field(res.body, "driver"), "status"), "active");
  const tenant = await tenantFor(me, membershipId);
  assert.equal(tenant.statusCode, 200);
  assert.equal((await startShift(stringField(tenant.body, "tenantToken"))).statusCode, 201);
  assert.deepEqual(await events(membershipId), ["joined", "deactivated", "reactivated"]);
});

test("CM4. only the transition that makes sense: reactivating an active driver or deactivating an inactive one is refused, changing nothing", async () => {
  const admin = await companyAdmin("States");
  const me = await driver();
  const membershipId = await joined(admin, me);

  const reactivateActive = await act(admin, membershipId, "reactivate");
  assert.equal(reactivateActive.statusCode, 409);
  assert.equal(field(reactivateActive.body, "code"), "MEMBERSHIP_STATE");
  await act(admin, membershipId, "deactivate");
  const deactivateInactive = await act(admin, membershipId, "deactivate");
  assert.equal(deactivateInactive.statusCode, 409);
  assert.equal(field(deactivateInactive.body, "code"), "MEMBERSHIP_STATE");
  assert.deepEqual(await events(membershipId), ["joined", "deactivated"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Remove → Reinvite → Accept
// ═══════════════════════════════════════════════════════════════════════════

test("CM5. Remove: no company access, hidden from the list — the membership row, the driver's account and the shifts all stay", async () => {
  const admin = await companyAdmin("Remove");
  const me = await driver();
  const membershipId = await joined(admin, me);
  const tenant = stringField((await tenantFor(me, membershipId)).body, "tenantToken");
  assert.equal((await startShift(tenant)).statusCode, 201);

  const res = await act(admin, membershipId, "remove");

  assert.equal(res.statusCode, 200, `got ${res.raw}`);
  const row = await prisma.companyMembership.findUniqueOrThrow({ where: { id: membershipId } });
  assert.equal(row.active, false);
  assert.notEqual(row.removedAt, null);
  assert.ok(await prisma.user.findUnique({ where: { id: me.userId } }) !== null, "the global driver account stays");
  assert.equal(await prisma.shift.count({ where: { membershipId } }), 1, "history stays");
  assert.deepEqual(await drivers(admin), []);
  assert.ok((await startShift(tenant)).statusCode >= 401);
  for (const action of ["deactivate", "reactivate", "remove"] as const) {
    assert.equal((await act(admin, membershipId, action)).statusCode, 404, `a removed driver cannot be ${action}d — only invited again`);
  }
  assert.deepEqual(await events(membershipId), ["joined", "removed"]);
});

test("CM6. Remove → invite again → accept: the SAME membership row returns, active, with the new payroll reference; recorded as rejoined", async () => {
  const admin = await companyAdmin("Rejoin");
  const me = await driver();
  const membershipId = await joined(admin, me);
  await act(admin, membershipId, "remove");

  const back = await joined(admin, me, { payrollRef: "EMP-NEW" });

  assert.equal(back, membershipId, "never a second membership");
  const row = await prisma.companyMembership.findUniqueOrThrow({ where: { id: membershipId } });
  assert.deepEqual({ active: row.active, removedAt: row.removedAt, payrollRef: row.payrollRef }, { active: true, removedAt: null, payrollRef: "EMP-NEW" });
  assert.equal(await prisma.companyMembership.count({ where: { userId: me.userId } }), 1);
  assert.deepEqual(await events(membershipId), ["joined", "removed", "rejoined"]);
  assert.equal(field((await drivers(admin))[0], "status"), "active");
});

test("CM7. a DEACTIVATED driver cannot be invited — the company reactivates them instead (D65); an invitation never undoes a deactivation", async () => {
  const admin = await companyAdmin("NoReinvite");
  const me = await driver();
  const membershipId = await joined(admin, me);
  await act(admin, membershipId, "deactivate");

  const res = await invite(admin, me.email);

  assert.equal(res.statusCode, 409, `got ${res.raw}`);
  assert.equal(field(res.body, "code"), "DRIVER_INACTIVE");
  assert.equal((await prisma.companyMembership.findUniqueOrThrow({ where: { id: membershipId } })).active, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// Isolation
// ═══════════════════════════════════════════════════════════════════════════

test("CM8. Company B cannot see or change Company A's drivers — the same 404 as one that does not exist — and A's change never touches the driver's membership of B", async () => {
  const a = await companyAdmin("A");
  const b = await companyAdmin("B");
  const me = await driver();
  const inA = await joined(a, me);
  const inB = await joined(b, me);
  const missing = "c" + "x".repeat(24);

  assert.deepEqual((await drivers(b)).map(r => field(r, "membershipId")), [inB], "B sees only its own");
  for (const action of ["deactivate", "reactivate", "remove"] as const) {
    const theirs = await act(b, inA, action);
    const nobodys = await act(b, missing, action);
    assert.equal(theirs.statusCode, 404);
    assert.equal(theirs.raw, nobodys.raw, "byte-identical");
  }
  assert.equal((await prisma.companyMembership.findUniqueOrThrow({ where: { id: inA } })).active, true);

  await act(a, inA, "remove");
  const rowB = await prisma.companyMembership.findUniqueOrThrow({ where: { id: inB } });
  assert.deepEqual({ active: rowB.active, removedAt: rowB.removedAt }, { active: true, removedAt: null });
  assert.equal((await tenantFor(me, inB)).statusCode, 200, "still works for B");
});

test("CM9. only DRIVER memberships: an administrator's own membership is not a driver — 404; a driver's tenant token is refused the company routes", async () => {
  const admin = await companyAdmin("Admins");
  const adminMembership = await prisma.companyMembership.findFirstOrThrow({ where: { companyId: admin.companyId, role: "admin" } });
  const me = await driver();
  const membershipId = await joined(admin, me);

  assert.equal((await act(admin, adminMembership.id, "deactivate")).statusCode, 404);
  assert.equal((await prisma.companyMembership.findUniqueOrThrow({ where: { id: adminMembership.id } })).active, true);

  const driverTenant = stringField((await tenantFor(me, membershipId)).body, "tenantToken");
  assert.equal((await inject({ url: DRIVERS, method: "GET", token: driverTenant })).statusCode, 403);
  assert.equal((await inject({ url: `${DRIVERS}/${membershipId}/deactivate`, token: driverTenant })).statusCode, 403);
});

test("CM10. the actions take no body: a company, a membership or a state sent by the client is refused", async () => {
  const admin = await companyAdmin("Strict");
  const me = await driver();
  const membershipId = await joined(admin, me);
  for (const payload of [{ companyId: "elsewhere" }, { active: true }, { removedAt: null }]) {
    const res = await act(admin, membershipId, "deactivate", payload);
    assert.equal(res.statusCode, 400, `got ${res.raw}`);
  }
  assert.equal((await prisma.companyMembership.findUniqueOrThrow({ where: { id: membershipId } })).active, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// Concurrency and the database's own guarantees
// ═══════════════════════════════════════════════════════════════════════════

test("CM11. three SIMULTANEOUS deactivations: exactly one succeeds, exactly one event", async () => {
  const admin = await companyAdmin("Race");
  const me = await driver();
  const membershipId = await joined(admin, me);

  const results = await Promise.all([act(admin, membershipId, "deactivate"), act(admin, membershipId, "deactivate"), act(admin, membershipId, "deactivate")]);

  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409, 409], results.map(r => r.raw).join(" | "));
  assert.deepEqual(await events(membershipId), ["joined", "deactivated"]);
});

test("CM12. the DATABASE refuses a removed membership that is active, and an event on a membership of another company", async () => {
  const a = await companyAdmin("DbA");
  const b = await companyAdmin("DbB");
  const me = await driver();
  const membershipId = await joined(a, me);

  await assert.rejects(prisma.companyMembership.update({ where: { id: membershipId }, data: { removedAt: new Date(), active: true } }), "removed implies inactive");
  await assert.rejects(prisma.membershipEvent.create({ data: { companyId: b.companyId, membershipId, kind: "deactivated" } }), "an event belongs to its membership's company");
});

test("CM13. D63 is unaffected: a driver who never joined is invited, verifies and accepts as before — recorded as joined", async () => {
  const admin = await companyAdmin("D63");
  const me = await driver();

  const membershipId = await joined(admin, me);

  assert.equal((await prisma.companyMembership.findUniqueOrThrow({ where: { id: membershipId } })).active, true);
  assert.deepEqual(await events(membershipId), ["joined"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Option A — withdrawal never touches work already started
// ═══════════════════════════════════════════════════════════════════════════

test("CM14. withdrawal DURING an open shift: the shift keeps its company, membership, status and times — deactivated or removed — and only NEW shifts are refused", async () => {
  for (const action of ["deactivate", "remove"] as const) {
    const admin = await companyAdmin(`Open-${action}`);
    const me = await driver();
    const membershipId = await joined(admin, me);
    const tenant = stringField((await tenantFor(me, membershipId)).body, "tenantToken");
    const started = await startShift(tenant);
    assert.equal(started.statusCode, 201);
    const open = await prisma.shift.findFirstOrThrow({ where: { membershipId } });

    assert.equal((await act(admin, membershipId, action)).statusCode, 200);

    const now = await prisma.shift.findUniqueOrThrow({ where: { id: open.id } });
    assert.deepEqual(now, open, `${action}: the open shift is exactly as it was — never closed, moved or discarded`);
    assert.ok((await startShift(tenant)).statusCode >= 401, `${action}: no new shift`);
  }
});

test("CM15. two SIMULTANEOUS removals: one succeeds, the other finds no driver — one event", async () => {
  const admin = await companyAdmin("RaceRemove");
  const me = await driver();
  const membershipId = await joined(admin, me);

  const results = await Promise.all([act(admin, membershipId, "remove"), act(admin, membershipId, "remove")]);

  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 404], results.map(r => r.raw).join(" | "));
  assert.deepEqual(await events(membershipId), ["joined", "removed"]);
});

test("CM16. an invitation still open from BEFORE a deactivation cannot be accepted — 409 DRIVER_INACTIVE, the invitation and the membership unchanged", async () => {
  const admin = await companyAdmin("StaleInvite");
  const me = await driver();
  const membershipId = await joined(admin, me);
  await act(admin, membershipId, "deactivate");
  // Not reachable through the API (an invitation needs a driver who is not
  // one): a row older than D65's refusal, written directly.
  const stale = await prisma.driverInvitation.create({
    data: { companyId: admin.companyId, email: me.email, firstName: "Dee", lastName: "River", expiresAt: new Date(Date.now() + 86_400_000) },
  });

  const res = await inject({ url: `/driver/invitations/${stale.id}/accept`, token: me.identityToken });

  assert.equal(res.statusCode, 409, `got ${res.raw}`);
  assert.equal(field(res.body, "code"), "DRIVER_INACTIVE");
  assert.equal((await prisma.driverInvitation.findUniqueOrThrow({ where: { id: stale.id } })).status, "pending");
  assert.equal((await prisma.companyMembership.findUniqueOrThrow({ where: { id: membershipId } })).active, false);
  assert.deepEqual(await events(membershipId), ["joined", "deactivated"]);
});
