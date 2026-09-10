/**
 * Start Shift Foundation — the primary invariant, against a REAL database
 * built by the real migrations.
 *
 * The invariant under test:
 *
 *   An authenticated active driver can start exactly one open Shift for their
 *   trusted company membership, using the driver's own declared start instant,
 *   with shiftDate derived once from that instant in the authoritative
 *   Company IANA timezone — and that Shift is valid with ZERO asset segments.
 *
 * Everything here is asserted at the HTTP boundary first and then against the
 * persisted rows, because a status code alone proves nothing about what was
 * written. Cross-tenant and cross-driver cases follow the Company A/B pattern
 * already used by repositoryTenantBoundary.test.ts.
 *
 * WRITTEN RED: `POST /shifts/start` and `GET /shifts/current` do not exist, so
 * every case fails on its FIRST assertion (`404 !== 201`, `404 !== 409`, …)
 * rather than on a missing import or a schema error.
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the Start Shift database tests");
}

process.env.JWT_SECRET = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV   = "test";
process.env.WEB_ORIGIN = "https://allowed.example.com";

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const SECRET = process.env.JWT_SECRET;
const TAG    = `start-shift-test-${Date.now()}`;
const DAY    = 24 * 60 * 60 * 1000;

const CANONICAL_401  = { error: "Not authenticated", code: "UNAUTHENTICATED" };
const CANONICAL_403  = { error: "Not allowed",       code: "FORBIDDEN" };

/** The frozen opaque conflict — it must never grow an id, a date or a company. */
const ALREADY_OPEN_CODE = "SHIFT_ALREADY_OPEN";
const MISMATCH_CODE     = "CLIENT_EVENT_MISMATCH";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Companies deliberately on different zones: one UK default, one not. */
const LONDON = "Europe/London";
const SYDNEY = "Australia/Sydney";

let companyA = "";
let companyB = "";

interface Driver {
  userId: string;
  membershipId: string;
  sessionId: string;
  companyId: string;
  name: string;
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

/** The frozen access token (AUTH.md). Minted here so the test depends on the
 *  token CONTRACT, not on a token-issuing implementation that does not exist. */
function tokenFor(driver: Driver): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = {
    sub:          driver.userId,
    companyId:    driver.companyId,
    membershipId: driver.membershipId,
    sessionId:    driver.sessionId,
    iat:          nowSeconds,
    exp:          nowSeconds + 15 * 60,
    iss:          "logisticbay-timesheets",
    aud:          "timesheets-api",
  };
  const header    = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload   = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

let seq = 0;

/** A fresh person with one membership — one open shift per USER, so scenarios
 *  that must not collide get their own driver rather than a cleanup step. */
async function newDriver(
  label: string,
  companyId: string,
  options: { role?: "driver" | "admin"; active?: boolean } = {},
): Promise<Driver> {
  seq += 1;
  // Two canonical halves (D22), and the display name DERIVED from them — the
  // same derivation `startContext` performs. `driver.name` below therefore
  // still means "what should be snapshotted onto the Shift", so the
  // driverName assertion proves the derivation rather than merely echoing a
  // stored column.
  const firstName = TAG;
  const lastName  = label;
  const name      = `${firstName} ${lastName}`;
  const user = await prisma.user.create({
    data: { email: `${TAG}-${String(seq)}-${label}@example.com`, firstName, lastName, passwordHash: "not-a-real-hash" },
  });
  const membership = await prisma.companyMembership.create({
    data: { companyId, userId: user.id, role: options.role ?? "driver", active: options.active ?? true },
  });
  const session = await prisma.session.create({
    data: {
      userId:           user.id,
      expiresAt:        new Date(Date.now() + 90 * DAY),
      refreshTokenHash: createHmac("sha256", TAG).update(`refresh-${String(seq)}`).digest("hex"),
    },
  });
  return { userId: user.id, membershipId: membership.id, sessionId: session.id, companyId, name };
}

/** A second membership for a driver who works for two companies (D12). */
async function addMembership(driver: Driver, companyId: string): Promise<Driver> {
  const membership = await prisma.companyMembership.create({
    data: { companyId, userId: driver.userId, role: "driver", active: true },
  });
  return { ...driver, companyId, membershipId: membership.id };
}

async function cleanup(): Promise<void> {
  const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
  const ids = users.map(user => user.id);
  // Shifts first: Shift → CompanyMembership is Restrict, so a membership
  // carrying history cannot be cascaded away by deleting the user.
  if (ids.length > 0) await prisma.shift.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
}

before(async () => {
  await cleanup();
  const a = await prisma.company.create({ data: { name: `${TAG}-A`, joinCode: `${TAG}-A`, timezone: LONDON } });
  const b = await prisma.company.create({ data: { name: `${TAG}-B`, joinCode: `${TAG}-B`, timezone: SYDNEY } });
  companyA = a.id;
  companyB = b.id;
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// Request helpers
// ─────────────────────────────────────────────────────────────────────────────

const ShiftView = z.object({
  id:        z.string().max(64),
  status:    z.string().max(32),
  startedAt: z.string().max(64),
  shiftDate: z.string().max(32),
}).strict();

const StartResponse  = z.object({ shift: ShiftView }).strict();
const CurrentResponse = z.object({ shift: ShiftView.nullable() }).strict();
const ErrorBody = z.object({
  error:   z.string().max(200),
  code:    z.string().max(64).optional(),
  details: z.unknown().optional(),
}).strict();

async function startShift(driver: Driver | null, payload: Record<string, unknown>) {
  const app = await buildApp(prisma);
  try {
    return await app.inject({
      method:  "POST",
      url:     "/shifts/start",
      headers: driver === null ? {} : { authorization: `Bearer ${tokenFor(driver)}` },
      payload,
    });
  } finally {
    await app.close();
  }
}

async function currentShift(driver: Driver | null) {
  const app = await buildApp(prisma);
  try {
    return await app.inject({
      method:  "GET",
      url:     "/shifts/current",
      headers: driver === null ? {} : { authorization: `Bearer ${tokenFor(driver)}` },
    });
  } finally {
    await app.close();
  }
}

function body(startedAt: string, clientEventId: string = randomUUID()): Record<string, unknown> {
  return { startedAt, clientEventId };
}

/** The company-local calendar date, computed independently of the production
 *  helper — so a test asserting shiftDate is not just repeating its logic. */
function companyLocalDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant);
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** Yesterday morning — a real past instant whenever this suite runs. */
function yesterdayMorning(): string {
  return new Date(Date.now() - DAY).toISOString();
}

async function shiftsOf(driver: Driver) {
  return prisma.shift.findMany({ where: { userId: driver.userId }, orderBy: { createdAt: "asc" } });
}

// ─────────────────────────────────────────────────────────────────────────────
// A — the primary invariant
// ─────────────────────────────────────────────────────────────────────────────

test("an active driver starts one ACTIVE shift with ZERO segments, owned by the trusted identity", async () => {
  const driver = await newDriver("primary", companyA);
  const startedAt = "2026-09-08T05:43:00.000Z";
  const clientEventId = randomUUID();

  const res = await startShift(driver, body(startedAt, clientEventId));
  assert.equal(res.statusCode, 201, "a valid no-vehicle Start Shift must be created");

  const view = StartResponse.parse(res.json()).shift;
  assert.equal(view.status, "active");
  assert.equal(new Date(view.startedAt).getTime(), new Date(startedAt).getTime());
  assert.equal(view.shiftDate, "2026-09-08");

  const rows = await shiftsOf(driver);
  assert.equal(rows.length, 1, "exactly one Shift row");
  const [shift] = rows;
  assert.ok(shift !== undefined);
  assert.equal(shift.id, view.id);
  assert.equal(shift.companyId, companyA,           "company comes from the token's membership");
  assert.equal(shift.userId, driver.userId,         "user comes from the token's membership");
  assert.equal(shift.membershipId, driver.membershipId, "membership comes from the token");
  assert.equal(shift.driverName, driver.name,       "driverName is a server-side snapshot derived from User.firstName + User.lastName");
  assert.equal(shift.clientEventId, clientEventId);
  assert.equal(shift.status, "active");
  assert.equal(shift.startedAt.getTime(), new Date(startedAt).getTime());
  assert.equal(shift.shiftDate.toISOString(), "2026-09-08T00:00:00.000Z");
  assert.equal(shift.endedAt, null);
  assert.equal(shift.submittedAt, null);

  const segments = await prisma.shiftSegment.count({ where: { shiftId: shift.id } });
  assert.equal(segments, 0, "a driver waiting for a vehicle has NO asset segment — not a placeholder one");
});

// ─────────────────────────────────────────────────────────────────────────────
// B — role
// ─────────────────────────────────────────────────────────────────────────────

test("an active ADMIN membership may start its OWN shift, bound to its own identity", async () => {
  const admin = await newDriver("admin", companyA, { role: "admin" });

  const res = await startShift(admin, body(yesterdayMorning()));
  assert.equal(res.statusCode, 201, "admin is not a role gate for starting your own shift");

  const rows = await shiftsOf(admin);
  assert.equal(rows.length, 1);
  const [shift] = rows;
  assert.ok(shift !== undefined);
  assert.equal(shift.userId, admin.userId,             "an admin's shift is still their own");
  assert.equal(shift.membershipId, admin.membershipId, "admin confers no authority over another membership");
});

// ─────────────────────────────────────────────────────────────────────────────
// C / D — the driver's declared start instant
// ─────────────────────────────────────────────────────────────────────────────

test("an explicitly entered earlier startedAt is stored EXACTLY — never the request receipt time", async () => {
  const driver = await newDriver("manual-time", companyA);
  // 06:00, hours before the driver got signal to submit it.
  const startedAt = new Date(Date.now() - 9 * 60 * 60 * 1000);
  startedAt.setUTCSeconds(0, 0);

  const res = await startShift(driver, body(startedAt.toISOString()));
  assert.equal(res.statusCode, 201);

  const [shift] = await shiftsOf(driver);
  assert.ok(shift !== undefined);
  assert.equal(shift.startedAt.getTime(), startedAt.getTime(), "the declared instant, not now");
  assert.ok(
    Date.now() - shift.startedAt.getTime() > 8 * 60 * 60 * 1000,
    "receipt time was not substituted for the driver's declared start",
  );
});

test("the backend accepts ANY valid declared instant — past, rounded-up, or materially future — and stores it exactly", async () => {
  // startedAt is the driver's OFFICIAL timesheet time, not a measurement of
  // when the app was opened. A driver who forgot to book on enters 06:00 at
  // 08:00; a company that rounds to the quarter hour enters 15:45 at 15:40.
  // Both are correct data, and the backend is not the place that second-
  // guesses them: there is no backdating limit and no future limit in V1.
  //
  // The mobile app will WARN (not block) when a manually entered time is more
  // than 15 minutes from the device clock, and a confirmed value is preserved
  // exactly — which only works if the backend accepts it. That is what this
  // case pins down.
  const offsets: readonly { label: string; ms: number }[] = [
    { label: "a day earlier",          ms: -24 * 60 * 60 * 1000 },
    { label: "nine hours earlier",     ms:  -9 * 60 * 60 * 1000 },
    { label: "two hours earlier",      ms:  -2 * 60 * 60 * 1000 },
    { label: "five minutes ahead",     ms:   5 * 60 * 1000 },
    { label: "thirty minutes ahead",   ms:  30 * 60 * 1000 },
    { label: "two hours ahead",        ms:   2 * 60 * 60 * 1000 },
  ];

  for (const [index, offset] of offsets.entries()) {
    const driver = await newDriver(`declared-${String(index)}`, companyA);
    const declared = new Date(Date.now() + offset.ms);
    declared.setUTCMilliseconds(0);

    const res = await startShift(driver, body(declared.toISOString()));
    assert.equal(res.statusCode, 201, `${offset.label} must be accepted`);

    const view = StartResponse.parse(res.json()).shift;
    assert.equal(new Date(view.startedAt).getTime(), declared.getTime(), `${offset.label}: response`);

    const [shift] = await shiftsOf(driver);
    assert.ok(shift !== undefined);
    assert.equal(
      shift.startedAt.getTime(), declared.getTime(),
      `${offset.label}: the declared instant is persisted verbatim, never clamped to server time`,
    );
    assert.equal(
      view.shiftDate, companyLocalDate(declared, LONDON),
      `${offset.label}: shiftDate follows the DECLARED instant in the company zone, not server time`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// E — the company timezone is the authority for shiftDate (D18)
// ─────────────────────────────────────────────────────────────────────────────

test("shiftDate follows the COMPANY timezone, not the UTC date", async () => {
  const driver = await newDriver("sydney", companyB);
  // 2026-06-30 22:00 UTC is 2026-07-01 08:00 in Australia/Sydney: the UTC
  // calendar date and the company-local one are different days.
  const startedAt = "2026-06-30T22:00:00.000Z";

  const res = await startShift(driver, body(startedAt));
  assert.equal(res.statusCode, 201);

  const view = StartResponse.parse(res.json()).shift;
  assert.equal(view.shiftDate, "2026-07-01", "filed under the company-local date");
  assert.notEqual(view.shiftDate, "2026-06-30", "the UTC date is NOT the filing date");

  const [shift] = await shiftsOf(driver);
  assert.ok(shift !== undefined);
  assert.equal(shift.shiftDate.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(shift.startedAt.toISOString(), startedAt, "the instant itself stays UTC");
});

// ─────────────────────────────────────────────────────────────────────────────
// F — hostile authority input
// ─────────────────────────────────────────────────────────────────────────────

test("client-supplied authority fields are refused and cannot influence what is persisted", async () => {
  const attacker = await newDriver("hostile", companyA);
  const victim   = await newDriver("hostile-victim", companyB);

  const hostile: Record<string, unknown> = {
    companyId:    victim.companyId,
    userId:       victim.userId,
    membershipId: victim.membershipId,
    shiftDate:    "2020-01-01",
    timezone:     "Pacific/Kiritimati",
    driverName:   "Someone Else",
    status:       "submitted",
  };

  for (const [field, value] of Object.entries(hostile)) {
    const res = await startShift(attacker, { ...body(yesterdayMorning()), [field]: value });
    assert.equal(res.statusCode, 400, `${field} must be refused`);
    assert.equal(ErrorBody.parse(res.json()).code, "VALIDATION");
  }

  assert.equal((await shiftsOf(attacker)).length, 0, "no shift from any hostile attempt");
  assert.equal((await shiftsOf(victim)).length, 0,   "and nothing under the named victim");
});

// ─────────────────────────────────────────────────────────────────────────────
// G / H / I — offline retry identity
// ─────────────────────────────────────────────────────────────────────────────

test("the SAME clientEventId with the same startedAt is an idempotent retry — one row, 200, same id", async () => {
  const driver = await newDriver("retry", companyA);
  const startedAt = "2026-09-08T05:43:00.000Z";
  const clientEventId = randomUUID();

  const first = await startShift(driver, body(startedAt, clientEventId));
  assert.equal(first.statusCode, 201);
  const created = StartResponse.parse(first.json()).shift;

  const retry = await startShift(driver, body(startedAt, clientEventId));
  assert.equal(retry.statusCode, 200, "a replayed offline event is not a new creation");
  assert.deepEqual(StartResponse.parse(retry.json()).shift, created, "the same shift comes back");

  assert.equal((await shiftsOf(driver)).length, 1, "a retry must never create a second shift");
});

test("the SAME clientEventId with a DIFFERENT startedAt is a conflict — nothing is mutated, nothing is created", async () => {
  const driver = await newDriver("mismatch", companyA);
  const startedAt = "2026-09-08T05:43:00.000Z";
  const clientEventId = randomUUID();

  assert.equal((await startShift(driver, body(startedAt, clientEventId))).statusCode, 201);

  const res = await startShift(driver, body("2026-09-08T09:15:00.000Z", clientEventId));
  assert.equal(res.statusCode, 409);
  assert.equal(ErrorBody.parse(res.json()).code, MISMATCH_CODE);

  const rows = await shiftsOf(driver);
  assert.equal(rows.length, 1, "no second shift");
  const [shift] = rows;
  assert.ok(shift !== undefined);
  assert.equal(shift.startedAt.toISOString(), startedAt, "the original start instant is untouched");
});

test("a genuinely NEW Start Shift while one is open is refused with an opaque 409", async () => {
  const driver = await newDriver("second-start", companyA);
  assert.equal((await startShift(driver, body(yesterdayMorning()))).statusCode, 201);

  const res = await startShift(driver, body(yesterdayMorning()));
  assert.equal(res.statusCode, 409);

  const failure = ErrorBody.parse(res.json());
  assert.equal(failure.code, ALREADY_OPEN_CODE);
  assert.equal(failure.details, undefined, "the conflict must carry no payload");

  const rows = await shiftsOf(driver);
  assert.equal(rows.length, 1, "the database is the authority: still one shift");
  const [shift] = rows;
  assert.ok(shift !== undefined);
  const serialised = JSON.stringify(failure);
  for (const secret of [shift.id, shift.companyId, shift.membershipId, "2026-", companyA]) {
    assert.ok(!serialised.includes(secret), `the conflict must not disclose ${secret}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// J — concurrency: the database, not the pre-read, is the authority
// ─────────────────────────────────────────────────────────────────────────────

test("concurrent DIFFERENT Start Shift requests produce exactly one open shift, and no 500", async () => {
  const driver = await newDriver("race", companyA);
  const app = await buildApp(prisma);
  try {
    const attempts = await Promise.all(
      [0, 1, 2, 3].map(() => app.inject({
        method:  "POST",
        url:     "/shifts/start",
        headers: { authorization: `Bearer ${tokenFor(driver)}` },
        payload: body(yesterdayMorning()),
      })),
    );

    const created  = attempts.filter(res => res.statusCode === 201);
    const refused  = attempts.filter(res => res.statusCode === 409);
    assert.equal(created.length, 1, "exactly one request may win the race");
    assert.equal(refused.length, 3, "the losers get the approved conflict");
    for (const res of refused) assert.equal(ErrorBody.parse(res.json()).code, ALREADY_OPEN_CODE);
    assert.equal(attempts.filter(res => res.statusCode >= 500).length, 0, "no raw database failure escapes");
  } finally {
    await app.close();
  }

  assert.equal((await shiftsOf(driver)).length, 1, "never two open rows");
});

test("concurrent replays of the SAME clientEventId converge on one shift", async () => {
  const driver = await newDriver("race-retry", companyA);
  const payload = body("2026-09-08T05:43:00.000Z", randomUUID());
  const app = await buildApp(prisma);
  try {
    const attempts = await Promise.all(
      [0, 1, 2, 3].map(() => app.inject({
        method:  "POST",
        url:     "/shifts/start",
        headers: { authorization: `Bearer ${tokenFor(driver)}` },
        payload,
      })),
    );

    const ids = new Set<string>();
    for (const res of attempts) {
      assert.ok(res.statusCode === 200 || res.statusCode === 201, `unexpected ${String(res.statusCode)}`);
      ids.add(StartResponse.parse(res.json()).shift.id);
    }
    assert.equal(ids.size, 1, "every replay resolves to the same shift");
  } finally {
    await app.close();
  }

  assert.equal((await shiftsOf(driver)).length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// K — cross-company
// ─────────────────────────────────────────────────────────────────────────────

test("a driver with an open shift in company A cannot start one in company B, and B learns nothing about A", async () => {
  const inA = await newDriver("multi", companyA);
  const inB = await addMembership(inA, companyB);

  assert.equal((await startShift(inA, body(yesterdayMorning()))).statusCode, 201);

  const res = await startShift(inB, body(yesterdayMorning()));
  assert.equal(res.statusCode, 409);
  const failure = ErrorBody.parse(res.json());
  assert.equal(failure.code, ALREADY_OPEN_CODE, "the same opaque conflict as a same-company clash");

  const serialised = JSON.stringify(failure);
  for (const secret of [companyA, inA.membershipId, `${TAG}-A`]) {
    assert.ok(!serialised.includes(secret), `company B must not learn ${secret}`);
  }

  const rows = await shiftsOf(inA);
  assert.equal(rows.length, 1);
  const [shift] = rows;
  assert.ok(shift !== undefined);
  assert.equal(shift.companyId, companyA, "no shift was created under company B");
});

test("company A's driver cannot cause a shift under company B", async () => {
  const driverA = await newDriver("tenant-a", companyA);
  assert.equal((await startShift(driverA, body(yesterdayMorning()))).statusCode, 201);

  const rows = await prisma.shift.findMany({ where: { companyId: companyB, userId: driverA.userId } });
  assert.equal(rows.length, 0, "an A-scoped token can only ever write into A");
});

// ─────────────────────────────────────────────────────────────────────────────
// L — restart / recovery
// ─────────────────────────────────────────────────────────────────────────────

test("GET /shifts/current returns null when the driver has no open shift", async () => {
  const driver = await newDriver("current-none", companyA);
  const res = await currentShift(driver);
  assert.equal(res.statusCode, 200);
  assert.equal(CurrentResponse.parse(res.json()).shift, null);
});

test("GET /shifts/current returns the driver's OWN open shift, and never a colleague's", async () => {
  const driver    = await newDriver("current-own", companyA);
  const colleague = await newDriver("current-colleague", companyA);

  const created = StartResponse.parse((await startShift(driver, body("2026-09-08T05:43:00.000Z"))).json()).shift;
  assert.equal((await startShift(colleague, body(yesterdayMorning()))).statusCode, 201);

  const own = await currentShift(driver);
  assert.equal(own.statusCode, 200);
  assert.deepEqual(CurrentResponse.parse(own.json()).shift, created, "the driver recovers their own shift");

  const colleagueView = CurrentResponse.parse((await currentShift(colleague)).json()).shift;
  assert.ok(colleagueView !== null);
  assert.notEqual(colleagueView.id, created.id, "a same-company colleague sees their own shift, not this one");
});

test("GET /shifts/current under company B does not expose an open shift in company A", async () => {
  const inA = await newDriver("current-multi", companyA);
  const inB = await addMembership(inA, companyB);
  assert.equal((await startShift(inA, body(yesterdayMorning()))).statusCode, 201);

  const res = await currentShift(inB);
  assert.equal(res.statusCode, 200);
  assert.equal(CurrentResponse.parse(res.json()).shift, null, "company B's scope reveals nothing about company A");
});

// ─────────────────────────────────────────────────────────────────────────────
// M — the route sits behind the existing auth boundary (thin, not a duplicate
// of the auth suite)
// ─────────────────────────────────────────────────────────────────────────────

test("both Start Shift routes are refused without authentication", async () => {
  assert.deepEqual((await startShift(null, body(yesterdayMorning()))).json(), CANONICAL_401);
  assert.equal((await startShift(null, body(yesterdayMorning()))).statusCode, 401);
  assert.equal((await currentShift(null)).statusCode, 401);
});

test("an inactive membership may not start a shift, and gets the generic 403", async () => {
  const driver = await newDriver("inactive", companyA, { active: false });

  const res = await startShift(driver, body(yesterdayMorning()));
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), CANONICAL_403);
  assert.equal((await shiftsOf(driver)).length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// The idempotency constraint itself — PostgreSQL, not the service, is what
// makes a replayed Start Shift unable to become a second row.
// ─────────────────────────────────────────────────────────────────────────────

const UNIQUE_VIOLATION = { name: "PrismaClientKnownRequestError", code: "P2002" };

/** A CLOSED shift, so the one-open-shift index can never be the constraint
 *  under test — these cases must be about (membershipId, clientEventId) alone. */
function closedShift(driver: Driver, clientEventId: string | null) {
  return {
    membershipId: driver.membershipId,
    companyId:    driver.companyId,
    userId:       driver.userId,
    driverName:   driver.name,
    shiftDate:    new Date("2026-09-08T00:00:00.000Z"),
    startedAt:    new Date("2026-09-08T05:43:00.000Z"),
    status:       "voided" as const,
    clientEventId,
  };
}

test("PostgreSQL REJECTS a second Shift with the same clientEventId for the same membership", async () => {
  const driver = await newDriver("dup-event", companyA);
  const clientEventId = randomUUID();

  await prisma.shift.create({ data: closedShift(driver, clientEventId) });
  await assert.rejects(
    prisma.shift.create({ data: closedShift(driver, clientEventId) }),
    UNIQUE_VIOLATION,
  );
});

test("the same clientEventId under a DIFFERENT membership is accepted — one driver's ids cannot collide with another's", async () => {
  const one = await newDriver("event-scope-one", companyA);
  const two = await newDriver("event-scope-two", companyA);
  const clientEventId = randomUUID();

  await prisma.shift.create({ data: closedShift(one, clientEventId) });
  const other = await prisma.shift.create({ data: closedShift(two, clientEventId) });
  assert.equal(other.clientEventId, clientEventId);
});

test("Shift rows predating the offline identity carry no clientEventId, and several coexist", async () => {
  const driver = await newDriver("legacy-events", companyA);

  const first  = await prisma.shift.create({ data: closedShift(driver, null) });
  const second = await prisma.shift.create({ data: closedShift(driver, null) });
  assert.equal(first.clientEventId, null);
  assert.equal(second.clientEventId, null);
  assert.notEqual(first.id, second.id, "NULLs are distinct under the unique index — no backfill is needed");
});
