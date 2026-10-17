/**
 * D66, stage S4 — a driver submits a timesheet to a company (revision 1).
 *
 *   POST /driver/timesheets   identity posture — `authorizeTimesheetSubmission`
 *
 * One transaction writes the header, the immutable snapshot, the audit
 * events and — when accepted — the delivery job. Verified submissions are
 * accepted; an unverified one (withdrawn membership, no qualifying receipt)
 * waits for the company's review. Evidence is server time only. Real
 * accounts, memberships, receipts and tokens against a real database.
 *
 * WRITTEN RED. Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { canonicalJson } from "../../lib/timesheetSnapshot.js";
import { checklistKeys } from "../../lib/checklistKeys.js";
import { createHash } from "node:crypto";
import type { MailMessage, Mailer } from "../../lib/mailer.js";
import { renderTimesheetPdf } from "../../pdf/timesheetPdf.js";
import { readPdf } from "../pdfReader.js";
import { AppError } from "../../lib/errors.js";
import { submitTimesheet } from "../../services/timesheetSubmissions.js";
import { submissionMembershipLookup } from "../../repositories/startReceiptRepository.js";
import { authorizeTimesheetSubmission } from "../../lib/submissionAuthorization.js";
import { timesheetSubmissionRepository } from "../../repositories/timesheetSubmissionRepository.js";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the timesheet submission tests");
}

const ORIGIN = "https://allowed.example.com";
process.env.JWT_SECRET  = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV    = "test";
process.env.WEB_ORIGIN  = ORIGIN;
process.env.WEB_APP_URL = ORIGIN;

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `timesheet-submissions-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const RECEIPTS = "/driver/shift-receipts";
const SUBMIT = "/driver/timesheets";

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
  const companies = `${TAG}%`;
  // Submitted records are immutable (D66): only an explicit retention purge removes them.
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('lb.retention_purge', 'on', true)`;
    await tx.$executeRaw`DELETE FROM "Shift" WHERE "companyId" IN (SELECT id FROM "Company" WHERE name LIKE ${companies})`;
  });
  await prisma.$executeRaw`DELETE FROM "ShiftStartReceipt" WHERE "companyId" IN (SELECT id FROM "Company" WHERE name LIKE ${companies})`;
  await prisma.$executeRaw`DELETE FROM "Company" WHERE name LIKE ${companies}`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${companies}`;
}

before(cleanup);
beforeEach(async () => { await cleanup(); outbox.length = 0; });
after(async () => { await cleanup(); await prisma.$disconnect(); });

const act = (admin: Admin, membershipId: string, action: "deactivate" | "reactivate" | "remove") =>
  inject({ url: `/company/drivers/${membershipId}/${action}`, token: admin.token });

const START = "2026-10-11T04:00:00.000Z";
const END = "2026-10-11T14:00:00.000Z";

/** A whole, true day: a unit with fuel and a certified check with a defect, a fridge trailer with diesel. */
function snapshot(userId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    day: { startedAt: START, endedAt: END, nightOut: true, notes: "Waited two hours at the depot" },
    vehicles: [{
      useId: "a1111111-2222-4333-8444-555555555555", startedAt: START, endedAt: END, endedBy: "finish",
      vehicleClass: "class1", registration: "LY12 ABC", odometerStart: 120_000, odometerEnd: 120_350, odometerUnit: "kilometre",
      fills: [{ id: "f1111111-2222-4333-8444-555555555555", type: "fuel", recordedAt: "2026-10-11T09:00:00.000Z", quantity: 310.5, unit: "litre", unitSource: "recorded", note: null }],
      checks: [{
        id: "c1111111-2222-4333-8444-555555555555", checklist: "hgv-unit", checklistVersion: 1, status: "completed",
        startedAt: START, completedAt: "2026-10-11T04:10:00.000Z", completedBy: userId,
        // A whole certificate (R1): every row of hgv-unit v1, one defect described.
        items: (checklistKeys("hgv-unit", 1) ?? []).map(key => ({
          key, label: key === "wipers" ? "Windscreen wipers" : key, section: { id: "cab", title: "CAB / DRIVER VIEW" },
          result: key === "wipers" ? "fail" : "pass", note: key === "wipers" ? "Nearside blade split" : null,
        })),
        revisions: [],
      }],
    }],
    trailers: [{
      useId: "b1111111-2222-4333-8444-555555555555", startedAt: "2026-10-11T05:00:00.000Z", endedAt: END, endedBy: "finish",
      trailerType: "refrigerated", trailerNumber: "TR-23",
      fridgeDiesel: [{ id: "d1111111-2222-4333-8444-555555555555", recordedAt: "2026-10-11T11:00:00.000Z", quantity: null, unit: "litre", unitSource: "recorded", note: "Gauge broken" }],
      checks: [],
    }],
    declaration: { version: "v-abc123", declaredAt: END },
    ...over,
  };
}

function submit(me: { identityToken: string }, body: Record<string, unknown>): Promise<Injected> {
  return inject({ url: SUBMIT, token: me.identityToken, payload: body });
}

function bodyFor(me: { userId: string; membershipId: string }, over: Record<string, unknown> = {}, snap: Record<string, unknown> = snapshot(me.userId)): Record<string, unknown> {
  return { membershipId: me.membershipId, clientEventId: randomUUID(), revision: 1, snapshot: snap, ...over };
}

const view = (res: Injected) => field(res.body, "timesheet");

async function recordsOf(membershipId: string) {
  const shifts = await prisma.shift.findMany({ where: { membershipId } });
  const shiftIds = shifts.map(s => s.id);
  return {
    shifts,
    submissions: await prisma.timesheetSubmission.findMany({ where: { shiftId: { in: shiftIds } } }),
    events: (await prisma.timesheetEvent.findMany({ where: { shiftId: { in: shiftIds } }, orderBy: { occurredAt: "asc" } })).map(e => e.kind),
    deliveries: await prisma.timesheetDelivery.findMany({ where: { shiftId: { in: shiftIds } } }),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// An active membership
// ═══════════════════════════════════════════════════════════════════════════

test("TS1. an ACTIVE membership's timesheet is accepted, verified by the membership: one transaction wrote the header, the immutable snapshot, its hash, the events and the delivery job", async () => {
  const admin = await companyAdmin({ timeZone: "Asia/Tokyo" });
  const me = await driverOf(admin);
  await prisma.companyMembership.update({ where: { id: me.membershipId }, data: { payrollRef: "PAY-77" } });
  const body = bodyFor(me);

  const res = await submit(me, body);

  assert.equal(res.statusCode, 201, `got ${res.raw}`);
  assert.match(stringField(view(res), "reference"), /^TS-[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.deepEqual({ revision: field(view(res), "revision"), standing: field(view(res), "standing"), verification: field(view(res), "verification") },
    { revision: 1, standing: "accepted", verification: "membership_active" });
  const { shifts, submissions, events, deliveries } = await recordsOf(me.membershipId);
  assert.equal(shifts.length, 1);
  const shift = shifts[0];
  assert.ok(shift !== undefined);
  assert.equal(shift.companyId, admin.companyId);
  assert.equal(shift.status, "submitted");
  assert.equal(shift.driverName, "Dee River");
  assert.equal(shift.payrollRef, "PAY-77");
  assert.equal(submissions[0]?.filedInTimezone, "Asia/Tokyo", "the zone it was filed in, with the revision — never on the header (D18)");
  assert.equal(shift.shiftDate.toISOString().slice(0, 10), "2026-10-11", "04:00Z is 13:00 in Tokyo, 11 Oct");
  assert.equal(shift.nightOut, true);
  assert.equal(shift.notes, "Waited two hours at the depot");
  assert.equal(shift.clientEventId, body["clientEventId"]);
  assert.deepEqual({ current: shift.currentRevision, authoritative: shift.authoritativeRevision }, { current: 1, authoritative: 1 });
  assert.equal(submissions.length, 1);
  assert.deepEqual(submissions[0]?.payload, body["snapshot"], "stored exactly as validated");
  assert.equal(submissions[0]?.payloadSha256, createHash("sha256").update(canonicalJson(body["snapshot"])).digest("hex"));
  assert.equal(submissions[0]?.declaredBy, me.userId);
  assert.deepEqual(events, ["submitted", "accepted_automatically", "delivery_queued"]);
  assert.deepEqual(deliveries.map(d => ({ revision: d.revision, status: d.status })), [{ revision: 1, status: "waiting_for_address" }], "no confirmed report address yet");
});

test("TS2. with a CONFIRMED report address the delivery is queued to go", async () => {
  const admin = await companyAdmin();
  await prisma.company.update({ where: { id: admin.companyId }, data: { reportEmail: freshEmail(), reportEmailVerifiedAt: new Date() } });
  const me = await driverOf(admin);

  assert.equal((await submit(me, bodyFor(me))).statusCode, 201);

  assert.deepEqual((await recordsOf(me.membershipId)).deliveries.map(d => d.status), ["queued"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Idempotency
// ═══════════════════════════════════════════════════════════════════════════

test("TS3. the same submission again is the SAME answer — one header, one revision, one delivery, the events unchanged", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const body = bodyFor(me);
  const first = await submit(me, body);

  const again = await submit(me, body);

  assert.equal(again.statusCode, 200, `got ${again.raw}`);
  assert.deepEqual(view(again), view(first));
  const { shifts, submissions, events, deliveries } = await recordsOf(me.membershipId);
  assert.deepEqual([shifts.length, submissions.length, deliveries.length, events.length], [1, 1, 1, 3]);
});

test("TS4. the same day id with DIFFERENT content is refused — 409 SUBMISSION_MISMATCH — and nothing changes", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const body = bodyFor(me);
  await submit(me, body);
  const unchanged = await recordsOf(me.membershipId);

  const changed = await submit(me, { ...body, snapshot: snapshot(me.userId, { day: { startedAt: START, endedAt: END, nightOut: false, notes: null } }) });

  assert.equal(changed.statusCode, 409);
  assert.equal(field(changed.body, "code"), "SUBMISSION_MISMATCH");
  assert.deepEqual(await recordsOf(me.membershipId), unchanged);
});

test("TS5. FIVE identical submissions at once make ONE timesheet: one 201, the rest answered with it", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const body = bodyFor(me);

  const results = await Promise.all(Array.from({ length: 5 }, () => submit(me, body)));

  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 200, 200, 200, 201], results.map(r => r.raw).join(" | "));
  assert.equal(new Set(results.map(r => stringField(view(r), "reference"))).size, 1);
  const { shifts, submissions, deliveries } = await recordsOf(me.membershipId);
  assert.deepEqual([shifts.length, submissions.length, deliveries.length], [1, 1, 1]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Withdrawn memberships (D65 Option A)
// ═══════════════════════════════════════════════════════════════════════════

test("TS6. DEACTIVATED, with a start receipt the server received while active: accepted, verified by the receipt", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const body = bodyFor(me);
  assert.equal((await receipt(me.identityToken, { membershipId: me.membershipId, clientEventId: body["clientEventId"], startedAt: START })).statusCode, 201);
  await act(admin, me.membershipId, "deactivate");

  const res = await submit(me, body);

  assert.equal(res.statusCode, 201, `got ${res.raw}`);
  assert.deepEqual({ standing: field(view(res), "standing"), verification: field(view(res), "verification") }, { standing: "accepted", verification: "start_receipt" });
  const shift = (await recordsOf(me.membershipId)).shifts[0];
  const stored = await prisma.shiftStartReceipt.findFirstOrThrow({ where: { membershipId: me.membershipId } });
  assert.equal(shift?.receiptId, stored.id);
});

test("TS7. DEACTIVATED with no receipt: stored — never discarded — but PENDING COMPANY REVIEW: unverified, not authoritative, no report queued", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  await act(admin, me.membershipId, "deactivate");

  const res = await submit(me, bodyFor(me));

  assert.equal(res.statusCode, 201, `got ${res.raw}`);
  assert.deepEqual({ standing: field(view(res), "standing"), verification: field(view(res), "verification") }, { standing: "pending_review", verification: "unverified" });
  const { shifts, submissions, events, deliveries } = await recordsOf(me.membershipId);
  assert.equal(shifts[0]?.authoritativeRevision, null, "not company-approved");
  assert.equal(submissions.length, 1, "the driver's submission is kept");
  assert.deepEqual(events, ["submitted", "review_requested"]);
  assert.deepEqual(deliveries, [], "a pending timesheet is never sent as a report");
});

test("TS8. REMOVED: a receipt from before the removal verifies it; without one it waits for review — the membership row, never deleted, carries it", async () => {
  const admin = await companyAdmin();
  const withReceipt = await driverOf(admin);
  const without = await driverOf(admin);
  const verified = bodyFor(withReceipt);
  await receipt(withReceipt.identityToken, { membershipId: withReceipt.membershipId, clientEventId: verified["clientEventId"], startedAt: START });
  await act(admin, withReceipt.membershipId, "remove");
  await act(admin, without.membershipId, "remove");

  assert.equal(field(view(await submit(withReceipt, verified)), "verification"), "start_receipt");
  assert.equal(field(view(await submit(without, bodyFor(without))), "standing"), "pending_review");
});

test("TS9. a device timestamp is never evidence: a day DECLARED to start a week before the deactivation still waits for review", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  await act(admin, me.membershipId, "deactivate");
  const early = snapshot(me.userId, {
    day: { startedAt: "2020-01-01T04:00:00.000Z", endedAt: "2020-01-01T14:00:00.000Z", nightOut: false, notes: null },
    vehicles: [], trailers: [], declaration: { version: "v1", declaredAt: "2020-01-01T14:00:00.000Z" },
  });

  const res = await submit(me, bodyFor(me, {}, early));

  assert.equal(field(view(res), "standing"), "pending_review");
  // The shift's date is its DECLARED start's, never the day it arrived (D66).
  assert.equal((await recordsOf(me.membershipId)).shifts[0]?.shiftDate.toISOString().slice(0, 10), "2020-01-01");
});

test("TS10. a receipt for ANOTHER day does not verify this one", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  await receipt(me.identityToken, { membershipId: me.membershipId, clientEventId: randomUUID(), startedAt: START });
  await act(admin, me.membershipId, "deactivate");

  assert.equal(field(view(await submit(me, bodyFor(me))), "verification"), "unverified");
});

// ═══════════════════════════════════════════════════════════════════════════
// Isolation and authority
// ═══════════════════════════════════════════════════════════════════════════

test("TS11. only the driver's OWN driver membership: another driver's, an administrator's or none is one byte-identical 404, storing nothing", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const other = await driverOf(admin);
  const adminMembership = await prisma.companyMembership.findFirstOrThrow({ where: { companyId: admin.companyId, role: "admin" } });

  const theirs = await submit(me, bodyFor(me, { membershipId: other.membershipId }));
  const nobodys = await submit(me, bodyFor(me, { membershipId: "c" + "x".repeat(24) }));
  const admins = await submit(me, bodyFor(me, { membershipId: adminMembership.id }));

  assert.equal(theirs.statusCode, 404);
  assert.equal(theirs.raw, nobodys.raw);
  assert.equal(admins.raw, nobodys.raw);
  assert.equal(await prisma.shift.count({ where: { companyId: admin.companyId } }), 0);
});

test("TS12. a driver of two companies: the day goes to the company it names and NO other — and the other learns nothing", async () => {
  const a = await companyAdmin();
  const b = await companyAdmin();
  const me = await driverOf(a);
  const invited = await inject({ url: "/company/driver-invitations", token: b.token, payload: { firstName: "Dee", lastName: "River", email: me.email } });
  const joined = await inject({ url: `/driver/invitations/${stringField(field(invited.body, "invitation"), "id")}/accept`, token: me.identityToken });
  const inB = stringField(field(joined.body, "membership"), "membershipId");

  assert.equal((await submit(me, bodyFor({ ...me, membershipId: inB }))).statusCode, 201);

  assert.equal(await prisma.shift.count({ where: { companyId: b.companyId } }), 1);
  assert.equal(await prisma.shift.count({ where: { companyId: a.companyId } }), 0);
});

test("TS13. the identity token only: a tenant token is the wrong kind (401); no token 401", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const tenant = stringField((await inject({ url: "/auth/switch-company", token: me.identityToken, payload: { membershipId: me.membershipId } })).body, "tenantToken");

  assert.equal((await inject({ url: SUBMIT, token: tenant, payload: bodyFor(me) })).statusCode, 401);
  assert.equal((await inject({ url: SUBMIT, payload: bodyFor(me) })).statusCode, 401);
});

// ═══════════════════════════════════════════════════════════════════════════
// The server's own validation
// ═══════════════════════════════════════════════════════════════════════════

test("TS14. every snapshot is validated by the server — shape and meaning — and a refusal stores NOTHING", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const base = snapshot(me.userId);
  const vehicle = (base["vehicles"] as Record<string, unknown>[])[0] ?? {};
  const trailer = (base["trailers"] as Record<string, unknown>[])[0] ?? {};
  const check = (vehicle["checks"] as Record<string, unknown>[])[0] ?? {};
  const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["a company in the envelope", { companyId: admin.companyId }, base],
    ["revision 2 before amendments exist", { revision: 2 }, base],
    ["an unknown key in the snapshot", {}, { ...base, extra: true }],
    // No uses: the finish-before-start rule alone refuses it.
    ["the finish before the start", {}, { ...base, vehicles: [], trailers: [], day: { startedAt: END, endedAt: START, nightOut: false, notes: null } }],
    ["a use outside the shift", {}, { ...base, vehicles: [{ ...vehicle, endedAt: "2026-10-11T15:00:00.000Z" }] }],
    ["two vehicles at once", {}, { ...base, vehicles: [vehicle, { ...vehicle, useId: randomUUID(), startedAt: "2026-10-11T06:00:00.000Z" }] }],
    ["an end reading below the start", {}, { ...base, vehicles: [{ ...vehicle, odometerEnd: 119_000 }] }],
    ["a registration longer than 16", {}, { ...base, vehicles: [{ ...vehicle, registration: "X".repeat(17) }] }],
    ["a quantity of 0", {}, { ...base, vehicles: [{ ...vehicle, fills: [{ ...(vehicle["fills"] as object[])[0], quantity: 0 }] }] }],
    ["an unknown unit", {}, { ...base, vehicles: [{ ...vehicle, odometerUnit: "furlong" }] }],
    ["fridge diesel on a standard trailer", {}, { ...base, trailers: [{ ...trailer, trailerType: "standard" }] }],
    ["the wrong checklist for the class", {}, { ...base, vehicles: [{ ...vehicle, checks: [{ ...check, checklist: "van" }] }] }],
    ["an item the checklist does not have", {}, { ...base, vehicles: [{ ...vehicle, checks: [{ ...check, items: [{ key: "invented", label: "Invented", section: null, result: "pass", note: null }] }] }] }],
    ["a check certified by someone else", {}, { ...base, vehicles: [{ ...vehicle, checks: [{ ...check, completedBy: "someone-else" }] }] }],
    ["a draft said to be certified", {}, { ...base, vehicles: [{ ...vehicle, checks: [{ ...check, status: "draft" }] }] }],
    ["a description on an item that passed", {}, { ...base, vehicles: [{ ...vehicle, checks: [{ ...check, items: [{ key: "front-view", label: "Front view", section: null, result: "pass", note: "x" }] }] }] }],
  ];
  for (const [why, envelope, snap] of cases) {
    const res = await submit(me, bodyFor(me, envelope, snap));
    assert.equal(res.statusCode, 400, `${why} — got ${res.statusCode}: ${res.raw.slice(0, 160)}`);
    // The envelope is the route's (VALIDATION, before anything is looked up); a snapshot of a new day is TIMESHEET_REJECTED.
    assert.equal(field(res.body, "code"), Object.keys(envelope).length > 0 ? "VALIDATION" : "TIMESHEET_REJECTED", why);
  }
  assert.equal(await prisma.shift.count({ where: { membershipId: me.membershipId } }), 0);
});

test("TS15. a legacy day is accepted as it is: readings with NO unit, a fill under the old LITRES label", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const base = snapshot(me.userId);
  const vehicle = (base["vehicles"] as Record<string, unknown>[])[0] ?? {};
  const legacy = { ...base, vehicles: [{ ...vehicle, odometerUnit: null, fills: [{ id: randomUUID(), type: "fuel", recordedAt: "2026-10-11T09:00:00.000Z", quantity: 300, unit: "litre", unitSource: "legacy-litres-label", note: null }] }] };

  assert.equal((await submit(me, bodyFor(me, {}, legacy))).statusCode, 201);
});

// ═══════════════════════════════════════════════════════════════════════════
// The database's own guarantees
// ═══════════════════════════════════════════════════════════════════════════

/** The database's immutability trigger said no — not some other failure. */
function refusedAsImmutable(error: unknown): boolean {
  const said = `${String(error)} ${JSON.stringify(error)}`;
  assert.match(said, /immutable|restrict_violation|23001/, `refused for another reason: ${said.slice(0, 400)}`);
  return true;
}

test("TS16. a submitted revision, its events and the header's company cannot be rewritten: the database refuses an update or a deletion", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  await submit(me, bodyFor(me));
  const { shifts, submissions } = await recordsOf(me.membershipId);
  const submission = submissions[0];
  const shift = shifts[0];
  assert.ok(submission !== undefined && shift !== undefined);

  await assert.rejects(prisma.timesheetSubmission.update({ where: { id: submission.id }, data: { payloadSha256: "0".repeat(64) } }), refusedAsImmutable);
  await assert.rejects(prisma.timesheetSubmission.delete({ where: { id: submission.id } }), refusedAsImmutable);
  await assert.rejects(prisma.timesheetEvent.updateMany({ where: { shiftId: shift.id }, data: { actorUserId: null } }), refusedAsImmutable);
  await assert.rejects(prisma.shift.delete({ where: { id: shift.id } }), "a header with a submission cannot be deleted from under it");
  await assert.rejects(prisma.timesheetSubmission.create({ data: { ...submission, id: undefined, revision: 1, payload: {}, companyId: (await companyAdmin()).companyId } as never }), "a revision belongs to its header's company");
});

test("TS17. at most 50 NEW submissions per membership a day — a replay of one already stored is never counted or refused", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const kept = bodyFor(me);
  assert.equal((await submit(me, kept)).statusCode, 201);
  await prisma.$executeRaw`
    INSERT INTO "Shift" (id, "membershipId", "companyId", "userId", "driverName", "clientEventId", "shiftDate", "startedAt", "endedAt", status, "submittedAt", reference, "currentRevision", verification, standing, "companyName", "updatedAt")
    SELECT 'cap-' || g || '-' || ${me.membershipId}, ${me.membershipId}, ${admin.companyId}, ${me.userId}, 'Dee River', gen_random_uuid()::text, '2026-10-11', now(), now(), 'submitted', now(), 'TS-CAP' || lpad(g::text, 5, '0') || substr(${me.membershipId}, 1, 4), 1, 'membership_active', 'pending_review', 'x', now()
    FROM generate_series(1, 49) AS g`;

  const fiftyFirst = await submit(me, bodyFor(me));
  assert.equal(fiftyFirst.statusCode, 429, `got ${fiftyFirst.raw}`);
  assert.equal((await submit(me, kept)).statusCode, 200, "the replay still answers");
});

test("TS18. (S5) the PDF is drawn from the STORED revision: the JSON column's payload still hashes to what was stored, is attached exactly, and draws the same bytes twice", async () => {
  const admin = await companyAdmin({ timeZone: "Asia/Tokyo" });
  const me = await driverOf(admin);
  const snap = snapshot(me.userId, { day: { startedAt: START, endedAt: END, nightOut: true, notes: "Wartezeit — שלום (נמל) — مرحبا ١٢٣ — नमस्ते — 東京 — 🚚" } });
  assert.equal((await submit(me, bodyFor(me, {}, snap))).statusCode, 201);

  const shift = await prisma.shift.findFirstOrThrow({ where: { membershipId: me.membershipId } });
  const submission = await prisma.timesheetSubmission.findUniqueOrThrow({ where: { shiftId_revision: { shiftId: shift.id, revision: 1 } } });
  const decision = await prisma.timesheetReviewDecision.findUnique({ where: { shiftId_revision: { shiftId: shift.id, revision: 1 } } });
  assert.ok(shift.reference !== null && shift.companyName !== null);
  const source = {
    reference: shift.reference, driverName: shift.driverName, payrollRef: shift.payrollRef, companyName: shift.companyName,
    submission: {
      revision: submission.revision, schemaVersion: submission.schemaVersion, payload: submission.payload,
      payloadSha256: submission.payloadSha256, declaredBy: submission.declaredBy, receivedAt: submission.receivedAt,
      verification: submission.verification, filedInTimezone: submission.filedInTimezone,
    },
    decision,
  };

  const first = await renderTimesheetPdf(source);
  const second = await renderTimesheetPdf(source);
  assert.ok(first.pdf.equals(second.pdf));
  assert.equal(first.missingGlyphs, true, "the emoji is marked, not dropped");
  const attached = readPdf(first.pdf).attachments.get(`${shift.reference}-revision-1.json`);
  assert.ok(attached !== undefined);
  assert.equal(createHash("sha256").update(attached).digest("hex"), submission.payloadSha256);
  assert.deepEqual(JSON.parse(attached.toString("utf8")), snap);
});

// ═══════════════════════════════════════════════════════════════════════════
// Security review remediation (2026-10-17): R2, R4
// ═══════════════════════════════════════════════════════════════════════════

async function seedSubmissions(admin: Admin, me: { userId: string; membershipId: string }, count: number): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "Shift" (id, "membershipId", "companyId", "userId", "driverName", "clientEventId", "shiftDate", "startedAt", "endedAt", status, "submittedAt", reference, "currentRevision", verification, standing, "companyName", "updatedAt")
    SELECT 'seed-' || g || '-' || ${me.membershipId}, ${me.membershipId}, ${admin.companyId}, ${me.userId}, 'Dee River', gen_random_uuid()::text, '2026-10-11', now(), now(), 'submitted', now(), 'TS-SEED' || lpad(g::text, 4, '0') || substr(md5(${me.membershipId}), 1, 4), 1, 'membership_active', 'pending_review', 'x', now()
    FROM generate_series(1, ${count}::int) AS g`;
}

/** Holds every caller of `method` until `parties` have arrived (or a short wait): "all counted before any wrote". */
function barrierOn<T extends object>(repository: T, method: string, parties: number): T {
  let arrived = 0;
  let release: () => void = () => undefined;
  const all = new Promise<void>(resolve => { release = resolve; });
  return new Proxy(repository, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (key !== method || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(value, target, args);
        arrived += 1;
        if (arrived >= parties) release();
        await Promise.race([all, new Promise(resolve => setTimeout(resolve, 500))]);
        return result;
      };
    },
  });
}

test("TS19. (R2) the reviewer's scenario, forced: 49 submitted, five NEW days that all pass the pre-check before any writes → 50, never 54; replays at the cap still answer", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  await seedSubmissions(admin, me, 48);
  const kept = bodyFor(me);
  assert.equal((await submit(me, kept)).statusCode, 201);
  const submissions = barrierOn(timesheetSubmissionRepository(prisma), "existing", 5);

  const outcomes = await Promise.all(Array.from({ length: 5 }, () => submitTimesheet(
    { userId: me.userId, sessionId: "test" },
    { membershipId: me.membershipId, clientEventId: randomUUID(), revision: 1, snapshot: snapshot(me.userId) },
    submissionMembershipLookup(prisma), submissions,
  ).then(() => 201, (error: unknown) => (error instanceof AppError ? error.statusCode : 500))));

  assert.equal(await prisma.shift.count({ where: { membershipId: me.membershipId } }), 50, "count-then-insert let the cap through");
  assert.deepEqual(outcomes.sort(), [201, 429, 429, 429, 429]);
  const replays = await Promise.all([submit(me, kept), submit(me, kept)]);
  assert.deepEqual(replays.map(res => res.statusCode), [200, 200], "a replay is never counted or refused");
});

test("TS19b. (R2) two copies of the SAME new day at the cap's edge: one is kept (the 50th), the other is its replay — never counted, never refused", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  await seedSubmissions(admin, me, 49);
  const submissions = barrierOn(timesheetSubmissionRepository(prisma), "existing", 2);
  const input = { membershipId: me.membershipId, clientEventId: randomUUID(), revision: 1 as const, snapshot: snapshot(me.userId) };

  const outcomes = await Promise.all([0, 1].map(() => submitTimesheet({ userId: me.userId, sessionId: "test" }, input, submissionMembershipLookup(prisma), submissions)
    .then(result => (result.created ? 201 : 200), (error: unknown) => (error instanceof AppError ? error.statusCode : 500))));

  assert.deepEqual(outcomes.sort(), [200, 201]);
  assert.equal(await prisma.shift.count({ where: { membershipId: me.membershipId } }), 50);
});

test("TS20. (R4) an UPPERCASE day id is the same day: it finds the lowercase receipt, is stored canonical, and either case replays the same timesheet", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const id = randomUUID();
  assert.equal((await receipt(me.identityToken, { membershipId: me.membershipId, clientEventId: id, startedAt: START })).statusCode, 201);
  await act(admin, me.membershipId, "deactivate");

  const upper = await submit(me, bodyFor(me, { clientEventId: id.toUpperCase() }));
  assert.equal(upper.statusCode, 201, `got ${upper.raw}`);
  assert.equal(field(view(upper), "verification"), "start_receipt", "the uppercase id did not find the day's receipt");
  const lower = await submit(me, bodyFor(me, { clientEventId: id }));
  assert.equal(lower.statusCode, 200, `got ${lower.raw}`);
  assert.equal(field(view(lower), "reference"), field(view(upper), "reference"));
  const shifts = await prisma.shift.findMany({ where: { membershipId: me.membershipId } });
  assert.deepEqual(shifts.map(shift => shift.clientEventId), [id]);
});

// ── R1 at the API, with the reviewer's own inputs ───────────────────────────

/** The day's unit check, replaced by `check`. */
function withUnitCheck(userId: string, check: Record<string, unknown>): Record<string, unknown> {
  const base = snapshot(userId);
  const vehicles = Array.isArray(base.vehicles) ? base.vehicles : [];
  const unit: unknown = vehicles[0];
  return { ...base, vehicles: [{ ...(typeof unit === "object" && unit !== null ? unit : {}), checks: [check] }] };
}

function unitCheck(userId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "c1111111-2222-4333-8444-555555555555", checklist: "hgv-unit", checklistVersion: 1, status: "completed",
    startedAt: START, completedAt: "2026-10-11T04:10:00.000Z", completedBy: userId,
    items: hgvRows(), revisions: [], ...over,
  };
}

function hgvRows(over: Record<string, Record<string, unknown>> = {}): Record<string, unknown>[] {
  return (checklistKeys("hgv-unit", 1) ?? []).map(key => ({ key, label: key, section: null, result: "pass", note: null, ...over[key] }));
}

test("TS21. (R1) an incomplete or undescribed CERTIFICATE is refused with nothing stored — the reviewer's one-row check, partial correction and null description", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const wipersDefect = { wipers: { result: "fail", note: "Nearside blade split" } };
  const cases: [string, Record<string, unknown>][] = [
    ["one answered row certified", unitCheck(me.userId, { items: [{ key: "front-view", label: "Front view", section: null, result: "pass", note: null }] })],
    ["a certified defect with no description", unitCheck(me.userId, { items: hgvRows({ wipers: { result: "fail", note: null } }) })],
    ["a correction holding only a passing row, dropping the defect", unitCheck(me.userId, {
      items: hgvRows(wipersDefect),
      revisions: [{ id: randomUUID(), revisedAt: END, revisedBy: me.userId, items: [{ key: "front-view", label: "front-view", section: null, result: "pass", note: null }] }],
    })],
    ["a whole correction with an undescribed defect", unitCheck(me.userId, {
      items: hgvRows(wipersDefect),
      revisions: [{ id: randomUUID(), revisedAt: END, revisedBy: me.userId, items: hgvRows({ wipers: { result: "fail", note: null } }) }],
    })],
  ];
  for (const [name, check] of cases) {
    const res = await submit(me, bodyFor(me, {}, withUnitCheck(me.userId, check)));
    assert.equal(res.statusCode, 400, `${name}: got ${res.raw}`);
    assert.equal(field(res.body, "code"), "TIMESHEET_REJECTED", name);
  }
  const stored = await recordsOf(me.membershipId);
  assert.deepEqual([stored.shifts.length, stored.submissions.length, stored.events.length, stored.deliveries.length], [0, 0, 0, 0], "a refused certificate left records");
});

test("TS22. (R1) what is TRUE still goes through: a whole certificate, a whole correction that clears a defect, and a partial draft with a defect not yet described", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const valid: [string, Record<string, unknown>][] = [
    ["a whole certificate with a described defect", unitCheck(me.userId, { items: hgvRows({ wipers: { result: "fail", note: "Nearside blade split" } }) })],
    ["a whole correction clearing the defect", unitCheck(me.userId, {
      items: hgvRows({ wipers: { result: "fail", note: "Nearside blade split" } }),
      revisions: [{ id: randomUUID(), revisedAt: END, revisedBy: me.userId, items: hgvRows() }],
    })],
    ["a partial draft", unitCheck(me.userId, { status: "draft", completedAt: null, completedBy: null, items: hgvRows({ wipers: { result: "fail", note: null } }).slice(0, 4) })],
  ];
  for (const [name, check] of valid) {
    const res = await submit(me, bodyFor(me, {}, withUnitCheck(me.userId, check)));
    assert.equal(res.statusCode, 201, `${name}: got ${res.raw}`);
  }
});

// ── Replay before validation (S6 remediation, 2026-10-17) ───────────────────

/** A snapshot today's rules refuse — a certified check of two rows — as an older, looser server could have accepted it. */
function acceptedUnderOlderRules(userId: string): Record<string, unknown> {
  return withUnitCheck(userId, unitCheck(userId, { items: [
    { key: "front-view", label: "Front view", section: null, result: "pass", note: null },
    { key: "wipers", label: "Windscreen wipers", section: null, result: "fail", note: "Nearside blade split" },
  ] }));
}

/**
 * Store `snap` as revision 1 of a day exactly as an OLDER server with looser
 * rules would have: through the S4 repository, which stores what it is given
 * — today's validation lives in the service, above it.
 */
async function storedAsAccepted(me: { membershipId: string; userId: string; identityToken: string }, snap: Record<string, unknown>): Promise<{ clientEventId: string; reference: unknown }> {
  const clientEventId = randomUUID();
  const ctx = await authorizeTimesheetSubmission({ userId: me.userId, sessionId: "test" }, me.membershipId, submissionMembershipLookup(prisma));
  const repository = timesheetSubmissionRepository(prisma);
  const facts = await repository.facts(ctx);
  const now = new Date();
  const created = await repository.createRevisionOne(ctx, {
    clientEventId, shiftDate: new Date("2026-10-11"), startedAt: new Date(START), endedAt: new Date(END), nightOut: true, notes: null,
    declaredAt: new Date(END), declaredVersion: "v-older", schemaVersion: 1, payload: snap,
    payloadSha256: createHash("sha256").update(canonicalJson(snap)).digest("hex"),
    verification: "membership_active", receiptId: null, standing: "accepted", facts, now,
  }, { max: 50, since: new Date(now.getTime() - 86_400_000) });
  assert.equal(created.kind, "created");
  return { clientEventId, reference: created.kind === "created" ? created.timesheet.reference : null };
}

test("TS23. accepted under OLDER rules, the answer lost, the rules tightened since: the IDENTICAL replay is answered with what was kept — never re-validated, never a 400", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const older = acceptedUnderOlderRules(me.userId);
  const kept = await storedAsAccepted(me, older);
  // Today's rules refuse it as a new submission...
  const fresh = await submit(me, bodyFor(me, {}, older));
  assert.equal(fresh.statusCode, 400, `got ${fresh.raw}`);

  // ...but the day already kept is replayed, as it is.
  const replay = await submit(me, bodyFor(me, { clientEventId: kept.clientEventId }, older));

  assert.equal(replay.statusCode, 200, `got ${replay.raw}`);
  assert.equal(field(view(replay), "reference"), kept.reference);
  const { shifts, submissions } = await recordsOf(me.membershipId);
  assert.deepEqual([shifts.length, submissions.length], [1, 1]);
});

test("TS24. a day already kept, sent again with DIFFERENT content — valid or not by today's rules — is a conflict (409), never a 400 and never a change", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const kept = await storedAsAccepted(me, acceptedUnderOlderRules(me.userId));
  const unchanged = await recordsOf(me.membershipId);

  const invalidDifferent = await submit(me, bodyFor(me, { clientEventId: kept.clientEventId }, { ...acceptedUnderOlderRules(me.userId), extra: true }));
  const validDifferent = await submit(me, bodyFor(me, { clientEventId: kept.clientEventId }));

  for (const res of [invalidDifferent, validDifferent]) {
    assert.equal(res.statusCode, 409, `got ${res.raw}`);
    assert.equal(field(res.body, "code"), "SUBMISSION_MISMATCH");
  }
  assert.deepEqual(await recordsOf(me.membershipId), unchanged);
});

test("TS25. a replay is never an ORACLE or a key: another driver — same day id, same bytes — gets the same 404 as for nobody's membership, and learns and changes nothing", async () => {
  const admin = await companyAdmin();
  const me = await driverOf(admin);
  const other = await driverOf(admin);
  const kept = await storedAsAccepted(me, acceptedUnderOlderRules(me.userId));
  const unchanged = await recordsOf(me.membershipId);

  const theirs = await submit(other, bodyFor(other, { membershipId: me.membershipId, clientEventId: kept.clientEventId }, acceptedUnderOlderRules(me.userId)));
  const nobodys = await submit(other, bodyFor(other, { membershipId: "c" + "x".repeat(24), clientEventId: kept.clientEventId }, acceptedUnderOlderRules(me.userId)));

  assert.equal(theirs.statusCode, 404);
  assert.equal(theirs.raw, nobodys.raw);
  // Their OWN membership, the same day id: a different day — nothing of mine.
  const own = await submit(other, bodyFor(other, { clientEventId: kept.clientEventId }, acceptedUnderOlderRules(me.userId)));
  assert.equal(own.statusCode, 400, `got ${own.raw}`);
  assert.deepEqual(await recordsOf(me.membershipId), unchanged);
});
