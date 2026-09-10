/**
 * Start Shift Foundation — the INPUT CONTRACT, proven at the HTTP boundary
 * without a database.
 *
 * Scope is deliberately narrow: what the route accepts and refuses before any
 * business state exists. Everything that needs a persisted row — the created
 * shift, idempotency, the open-shift conflict, concurrency, cross-company
 * isolation and the company-local date against a real Company row — lives in
 * src/tests/db/startShift.test.ts, because those are claims about the
 * database, not about a schema.
 *
 * WRITTEN RED. `POST /shifts/start` does not exist, so every case below fails
 * on `404 !== <expected status>`. The identity fixtures are real enough to
 * authenticate (the same injection pattern as src/lib/auth.test.ts), so a RED
 * failure here names the missing route and not a missing session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { MembershipRole } from "../generated/enums.js";

// env.ts validates process.env at import time and exits on failure, so these
// must be set BEFORE app.js is loaded — the pattern app.test.ts established.
process.env.DATABASE_URL = "postgresql://app:app@localhost:5544/lb_timesheet_unused";
process.env.JWT_SECRET   = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV     = "test";
process.env.WEB_ORIGIN   = "https://allowed.example.com";

const { buildApp } = await import("../app.js");

const SECRET        = process.env.JWT_SECRET;
const USER_ID       = "user_cmth00000000000000000001";
const COMPANY_ID    = "comp_cmth00000000000000000001";
const MEMBERSHIP_ID = "memb_cmth00000000000000000001";
const SESSION_ID    = "sess_cmth00000000000000000001";
const DRIVER_FIRST_NAME = "Fixture";
const DRIVER_LAST_NAME  = "Driver";
const TIMEZONE      = "Europe/London";

/** A syntactically valid client event id — one logical Start Shift. */
const EVENT_ID = "3f8e1a52-6c4d-4b7a-9f21-0d5e8c7a1b34";

const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };
const CANONICAL_403 = { error: "Not allowed",       code: "FORBIDDEN" };

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function token(): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = {
    sub:          USER_ID,
    companyId:    COMPANY_ID,
    membershipId: MEMBERSHIP_ID,
    sessionId:    SESSION_ID,
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

/**
 * The reads the app performs, supplied as fixtures. `shift.create` REJECTS:
 * every case below must be refused before persistence is attempted, so a call
 * reaching it is itself the failure.
 */
function fixtures(options: { active?: boolean } = {}) {
  const role: MembershipRole = "driver";
  return {
    $queryRaw: () => Promise.resolve([{ ok: 1 }]),
    session: {
      findUnique: () => Promise.resolve({
        id: SESSION_ID, userId: USER_ID,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), revokedAt: null,
      }),
      create: () => Promise.reject(new Error("session.create must not be reached by a refused request")),
    },
    companyMembership: {
      findUnique: () => Promise.resolve({
        id: MEMBERSHIP_ID, userId: USER_ID, companyId: COMPANY_ID,
        role, active: options.active ?? true,
      }),
      findMany: () => Promise.resolve([]),
    },
    company: { findUnique: () => Promise.resolve({ timezone: TIMEZONE }) },
    // D22: the two canonical halves. `startContext` derives the snapshot name
    // from them, so DRIVER_NAME below is the DERIVED value, not a column.
    user: {
      findUnique: () => Promise.resolve({
        id: USER_ID, email: "fixture-driver@example.com",
        firstName: DRIVER_FIRST_NAME, lastName: DRIVER_LAST_NAME,
      }),
      create:     () => Promise.reject(new Error("user.create must not be reached by a refused request")),
    },
    shift: {
      create:    () => Promise.reject(new Error("shift.create must not be reached by a refused request")),
      findFirst: () => Promise.resolve(null),
    },
    $transaction: () => Promise.reject(new Error("$transaction must not be reached by a refused request")),
  };
}

const ErrorBody = z.object({
  error:   z.string().max(200),
  code:    z.string().max(64).optional(),
  details: z.unknown().optional(),
}).strict();

async function post(payload: Record<string, unknown>, options: { auth?: boolean; active?: boolean } = {}) {
  const app = await buildApp(fixtures({ active: options.active }));
  try {
    return await app.inject({
      method:  "POST",
      url:     "/shifts/start",
      headers: (options.auth ?? true) ? { authorization: `Bearer ${token()}` } : {},
      payload,
    });
  } finally {
    await app.close();
  }
}

/** Yesterday — comfortably in the past, whenever the suite runs. */
function pastInstant(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function validBody(): Record<string, unknown> {
  return { startedAt: pastInstant(), clientEventId: EVENT_ID };
}

// ─────────────────────────────────────────────────────────────────────────────
// The two authority answers, at this route (thin — the auth suite is not
// duplicated here; this only proves THIS route sits behind that boundary).
// ─────────────────────────────────────────────────────────────────────────────

test("Start Shift is refused without authentication, with the canonical 401", async () => {
  const res = await post(validBody(), { auth: false });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), CANONICAL_401);
});

test("Start Shift is refused for an inactive membership, with the canonical 403", async () => {
  const res = await post(validBody(), { active: false });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), CANONICAL_403);
});

// ─────────────────────────────────────────────────────────────────────────────
// The body contract
// ─────────────────────────────────────────────────────────────────────────────

test("a body missing startedAt is refused as a validation failure", async () => {
  const res = await post({ clientEventId: EVENT_ID });
  assert.equal(res.statusCode, 400);
  assert.equal(ErrorBody.parse(res.json()).code, "VALIDATION");
});

test("a body missing clientEventId is refused as a validation failure", async () => {
  const res = await post({ startedAt: pastInstant() });
  assert.equal(res.statusCode, 400);
  assert.equal(ErrorBody.parse(res.json()).code, "VALIDATION");
});

test("startedAt must be a real instant with an explicit offset — nothing else parses", async () => {
  // The backend places no limit on WHEN a declared start may be (that is the
  // driver's official timesheet time). It is strict about WHAT one is: an
  // unambiguous instant. A bare wall-clock value would force the server to
  // guess a zone, which D18 forbids.
  const invalid = [
    "2026-09-08T05:43:00",       // no offset — which 05:43?
    "2026-09-08",                // a date, not an instant
    "08/09/2026 05:43",          // not ISO 8601 at all
    "2026-13-45T05:43:00Z",      // impossible calendar values
    "not-a-date",
    "",
  ];
  for (const startedAt of invalid) {
    const res = await post({ startedAt, clientEventId: EVENT_ID });
    assert.equal(res.statusCode, 400, `${JSON.stringify(startedAt)} must be refused`);
    assert.equal(ErrorBody.parse(res.json()).code, "VALIDATION");
  }
});

test("a malformed or empty clientEventId is refused", async () => {
  for (const clientEventId of ["", "not-a-uuid", "00000000-0000-0000-0000-000000000000"]) {
    const res = await post({ startedAt: pastInstant(), clientEventId });
    assert.equal(res.statusCode, 400, `clientEventId ${JSON.stringify(clientEventId)} must be refused`);
    assert.equal(ErrorBody.parse(res.json()).code, "VALIDATION");
  }
});

test("no vehicle, trailer, mileage or check field is required to start a shift", async () => {
  // The positive control for every negative above: the ONLY fields Start Shift
  // Foundation accepts are these two, and they are sufficient on their own.
  const res = await post(validBody());
  assert.notEqual(res.statusCode, 400, "a valid no-vehicle Start Shift must not be a validation failure");
  assert.notEqual(res.statusCode, 404, "POST /shifts/start must exist");
});

// ─────────────────────────────────────────────────────────────────────────────
// Hostile authority input
// ─────────────────────────────────────────────────────────────────────────────

test("a client-supplied authority field is REFUSED, not silently ignored", async () => {
  const hostile: Record<string, unknown> = {
    companyId:    "comp_attacker",
    userId:       "user_attacker",
    membershipId: "memb_attacker",
    shiftDate:    "2026-01-01",
    timezone:     "Pacific/Kiritimati",
    driverName:   "Someone Else",
    status:       "submitted",
  };

  for (const [field, value] of Object.entries(hostile)) {
    const res = await post({ ...validBody(), [field]: value });
    assert.equal(res.statusCode, 400, `${field} must be refused by strict validation`);
    assert.equal(ErrorBody.parse(res.json()).code, "VALIDATION", `${field} must fail through the canonical envelope`);
  }
});

test("a vehicle field is refused too — the asset flow is not part of Start Shift", async () => {
  const res = await post({ ...validBody(), truckReg: "AB24 XYZ" });
  assert.equal(res.statusCode, 400);
  assert.equal(ErrorBody.parse(res.json()).code, "VALIDATION");
});
