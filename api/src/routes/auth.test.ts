/**
 * Registration Increment 1 RED — the INPUT CONTRACT and the IDENTITY POSTURE,
 * proven at the HTTP boundary without a database.
 *
 * Scope is deliberately narrow, following the split `shifts.test.ts`
 * established: what the boundary REFUSES before any row is written, plus the
 * behaviour of the new identity posture, whose whole pipeline is two Session
 * reads and can therefore be specified with fixtures. Everything that needs a
 * persisted row — a successful registration, email normalisation, bcrypt,
 * the Session, the 409, concurrency — lives in
 * `src/tests/db/registration.test.ts`, because those are claims about the
 * database, not about a schema.
 *
 * Consequently there is **no "not 400" or "not 401" assertion in this file**.
 * Against a route that does not exist yet, a negative-only assertion is
 * vacuously green (404 is not 401 either), so every case asserts the exact
 * status the contract requires. Positive controls that need persistence live
 * in the DB suite and are named where they are relied on.
 *
 * WRITTEN RED. `POST /auth/register` and `GET /auth/me` do not exist, so every
 * case fails on `404 !== <expected>` — an assertion-level failure naming the
 * missing behaviour, never a missing import. The identity fixtures are real
 * enough to authenticate, so a RED failure here cannot be a missing session.
 *
 * Frozen by AUTH.md (2026-09-10 amendment) and DECISIONS D21–D24.
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
const OTHER_USER    = "user_cmth00000000000000000002";
const COMPANY_ID    = "comp_cmth00000000000000000001";
const MEMBERSHIP_ID = "memb_cmth00000000000000000001";
const SESSION_ID    = "sess_cmth00000000000000000001";

const ISSUER            = "logisticbay-timesheets";
const TENANT_AUDIENCE   = "timesheets-api";
/** D21: the whole separation rests on this being a DIFFERENT audience. */
const IDENTITY_AUDIENCE = "timesheets-identity";

const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };

const MINUTE = 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Token minting
// ─────────────────────────────────────────────────────────────────────────────
// Constructed independently of production, so RED specifies the frozen token
// contract rather than depending on the minter this increment will build.

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function signToken(claims: Record<string, string | number>, secret = SECRET): string {
  const header    = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload   = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * AUTH.md's identity token (D21). Note what is NOT here: companyId,
 * membershipId, role. Their absence is the design — this token names an
 * account and a device session, and nothing that could select a tenant.
 */
function identityClaims(overrides: Record<string, string | number> = {}): Record<string, string | number> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    sub:       USER_ID,
    sessionId: SESSION_ID,
    iat:       nowSeconds,
    exp:       nowSeconds + 15 * 60,
    iss:       ISSUER,
    aud:       IDENTITY_AUDIENCE,
    ...overrides,
  };
}

/** The unchanged tenant access token, for the cross-posture cases. */
function tenantClaims(overrides: Record<string, string | number> = {}): Record<string, string | number> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    sub:          USER_ID,
    companyId:    COMPANY_ID,
    membershipId: MEMBERSHIP_ID,
    sessionId:    SESSION_ID,
    iat:          nowSeconds,
    exp:          nowSeconds + 15 * 60,
    iss:          ISSUER,
    aud:          TENANT_AUDIENCE,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity fixtures
// ─────────────────────────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

interface MembershipRow {
  id: string;
  userId: string;
  companyId: string;
  role: MembershipRole;
  active: boolean;
}

/** The driver's own row as the identity posture reads it back (D22). */
interface UserRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

function driverRow(): UserRow {
  return {
    id:        USER_ID,
    firstName: "Nerijus",
    lastName:  "Kuizinas",
    email:     "driver@example.com",
  };
}

interface AuthReads {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  session: {
    findUnique(args: { where: { id: string } }): Promise<SessionRow | null>;
    create(): Promise<never>;
  };
  companyMembership: {
    findUnique(args: { where: { id: string } }): Promise<MembershipRow | null>;
    findMany(): Promise<never[]>;
  };
  // Keyed by id OR email, because the account boundary looks up both.
  user: {
    findUnique(args: { where: { id?: string; email?: string } }): Promise<UserRow | null>;
    create(): Promise<never>;
  };
  // Start Shift's reads. `findFirst` returns null so `GET /shifts/current`
  // answers "no open shift" for the cross-posture cases.
  shift: {
    create(): Promise<never>;
    findFirst(): Promise<null>;
  };
  company: { findUnique(): Promise<{ timezone: string } | null> };
  // Every WRITE rejects: no case in this file may reach persistence, so a
  // call landing here is itself the failure rather than a setup gap.
  $transaction(): Promise<never>;
}

/** Matches on id, so "the token names a session that is not there" stays expressible. */
function reads(session: SessionRow | null, membership: MembershipRow | null, user: UserRow | null = driverRow()): AuthReads {
  return {
    $queryRaw: () => Promise.resolve([{ ok: 1 }]),
    session: {
      findUnique: ({ where }) =>
        Promise.resolve(session !== null && session.id === where.id ? session : null),
      create: () => Promise.reject(new Error("no case in routes/auth.test.ts may reach session persistence")),
    },
    companyMembership: {
      findUnique: ({ where }) =>
        Promise.resolve(membership !== null && membership.id === where.id ? membership : null),
      findMany: () => Promise.resolve([]),
    },
    user: {
      findUnique: ({ where }) =>
        Promise.resolve(
          user !== null && (where.id === user.id || where.email === user.email) ? user : null,
        ),
      create: () => Promise.reject(new Error("no case in routes/auth.test.ts may reach user persistence")),
    },
    shift: {
      create:    () => Promise.reject(new Error("no case in routes/auth.test.ts may reach shift persistence")),
      findFirst: () => Promise.resolve(null),
    },
    company: { findUnique: () => Promise.resolve({ timezone: "Europe/London" }) },
    $transaction: () => Promise.reject(new Error("no case in routes/auth.test.ts may reach persistence")),
  };
}

function liveSession(): SessionRow {
  return { id: SESSION_ID, userId: USER_ID, expiresAt: new Date(Date.now() + 90 * 24 * 60 * MINUTE), revokedAt: null };
}

function activeMembership(): MembershipRow {
  return { id: MEMBERSHIP_ID, userId: USER_ID, companyId: COMPANY_ID, role: "driver", active: true };
}

/** The identity a zero-membership driver has: a real session, no membership. */
function zeroMembershipReads(session = liveSession()): AuthReads {
  return reads(session, null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Injection helpers
// ─────────────────────────────────────────────────────────────────────────────

interface Injected {
  statusCode: number;
  body: unknown;
}

async function post(url: string, payload: unknown, identity: AuthReads = zeroMembershipReads(), token?: string): Promise<Injected> {
  const app = await buildApp(identity);
  try {
    const res = await app.inject({
      method:  "POST",
      url,
      payload: payload as object,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
    return { statusCode: res.statusCode, body: res.body === "" ? null : (JSON.parse(res.body) as unknown) };
  } finally {
    await app.close();
  }
}

async function get(url: string, identity: AuthReads, token?: string): Promise<Injected> {
  const app = await buildApp(identity);
  try {
    const res = await app.inject({
      method:  "GET",
      url,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
    return { statusCode: res.statusCode, body: res.body === "" ? null : (JSON.parse(res.body) as unknown) };
  } finally {
    await app.close();
  }
}

/** The four fields registration accepts, and nothing else (D21). */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    firstName: "Nerijus",
    lastName:  "Kuizinas",
    email:     "driver@example.com",
    password:  "correct-horse-battery",
    ...overrides,
  };
}

/** The one envelope a rejected DTO produces — the shape `invalidRequest` builds. */
function assertValidationFailure(result: Injected, why: string): void {
  assert.equal(result.statusCode, 400, why);
  const body = z.object({
    error:   z.literal("Invalid request"),
    code:    z.literal("VALIDATION"),
    details: z.unknown(),
  }).parse(result.body);
  assert.equal(body.code, "VALIDATION");
}

// ═════════════════════════════════════════════════════════════════════════════
// R1. The registration route is PUBLIC
// ═════════════════════════════════════════════════════════════════════════════
// Proven by what happens with NO Authorization header: the request must reach
// the route's own validation and be answered on its merits. A malformed body
// is used deliberately — it needs no persistence, so this case can assert an
// EXACT status rather than the vacuous "not 401" (404 is not 401 either).

test("R1. POST /auth/register is public: with no Authorization header the request reaches validation, not the auth boundary", async () => {
  const result = await post("/auth/register", {});

  assertValidationFailure(result, "an unauthenticated malformed registration must be answered 400 by the route, not 401 by the default-deny hook");
  assert.notDeepEqual(result.body, CANONICAL_401, "a public route must not produce the authentication envelope");
});

// ═════════════════════════════════════════════════════════════════════════════
// R2-R4. The DTO is EXACTLY four fields
// ═════════════════════════════════════════════════════════════════════════════

test("R2. every one of the four fields is required", async () => {
  for (const field of ["firstName", "lastName", "email", "password"]) {
    const body = validBody();
    delete body[field];
    assertValidationFailure(await post("/auth/register", body), `a registration missing ${field} must be refused`);
  }
});

test("R3. an authority field in the body is REFUSED, never ignored", async () => {
  // Each of these is a client attempting to name identity the server owns.
  // Silently dropping them would make the attempt invisible; the DTO is
  // `.strict()` so the attempt is an error.
  const smuggled: Record<string, unknown> = {
    companyId:    COMPANY_ID,
    membershipId: MEMBERSHIP_ID,
    userId:       USER_ID,
    id:           USER_ID,
    role:         "admin",
    passwordHash: "$2a$12$forged",
    memberships:  [{ companyId: COMPANY_ID }],
  };

  for (const [field, value] of Object.entries(smuggled)) {
    const result = await post("/auth/register", validBody({ [field]: value }));
    assertValidationFailure(result, `a registration carrying ${field} must be refused, not accepted with the field ignored`);
  }
});

test("R4. an unrecognised field is refused even when it is harmless", async () => {
  // Not about this field. A DTO that tolerates one unknown key tolerates all
  // of them, which is how the fields in R3 get through a later refactor.
  assertValidationFailure(
    await post("/auth/register", validBody({ marketingOptIn: true })),
    "an unknown field must be refused — strictness is the mechanism R3 depends on",
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// R5-R6. Bounds (CLAUDE.md: names 200, emails 320)
// ═════════════════════════════════════════════════════════════════════════════

test("R5. names are bounded at 200 and must be non-empty after trimming", async () => {
  const tooLong = "a".repeat(201);
  assertValidationFailure(await post("/auth/register", validBody({ firstName: tooLong })), "firstName over 200 must be refused");
  assertValidationFailure(await post("/auth/register", validBody({ lastName:  tooLong })), "lastName over 200 must be refused");

  // Whitespace is not a name. Trimming to empty must fail, not persist "".
  assertValidationFailure(await post("/auth/register", validBody({ firstName: "   " })), "a whitespace-only firstName must be refused");
  assertValidationFailure(await post("/auth/register", validBody({ lastName:  "   " })), "a whitespace-only lastName must be refused");
});

test("R6. the email is bounded at 320 and must be an email address", async () => {
  const longLocal = `${"a".repeat(311)}@example.com`; // 323 characters
  assert.ok(longLocal.length > 320, "fixture sanity: the probe must actually exceed the cap");
  assertValidationFailure(await post("/auth/register", validBody({ email: longLocal })), "an email over 320 must be refused");

  for (const malformed of ["not-an-email", "driver@", "@example.com", "driver@example", "driver example@x.com"]) {
    assertValidationFailure(await post("/auth/register", validBody({ email: malformed })), `"${malformed}" is not an address and must be refused`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// R7-R9. Password policy (D23): min 10 characters, max 72 UTF-8 BYTES
// ═════════════════════════════════════════════════════════════════════════════

test("R7. a password shorter than 10 characters is refused", async () => {
  assertValidationFailure(await post("/auth/register", validBody({ password: "123456789" })), "9 characters is below the frozen minimum of 10");
  assertValidationFailure(await post("/auth/register", validBody({ password: "" })),          "an empty password is refused");
});

test("R8. a password longer than 72 bytes is refused rather than silently truncated by bcrypt", async () => {
  const ascii73 = "a".repeat(73);
  assert.equal(Buffer.byteLength(ascii73, "utf8"), 73, "fixture sanity: 73 ASCII characters are 73 bytes");
  assertValidationFailure(
    await post("/auth/register", validBody({ password: ascii73 })),
    "73 bytes exceeds bcrypt's 72-byte input; accepting it would silently ignore the tail",
  );
});

test("R9. the 72-byte cap is measured in UTF-8 BYTES, not JavaScript characters", async () => {
  // The case the whole rule exists for. 25 lorries are 50 UTF-16 code units —
  // comfortably under any character cap of 72 — and 100 UTF-8 bytes, so bcrypt
  // would read 72 of them and discard the rest. A `.length` check passes this
  // password. A byte check must not.
  const lorries = "🚚".repeat(25);
  assert.equal(lorries.length, 50,                              "fixture sanity: 50 UTF-16 code units");
  assert.equal(Buffer.byteLength(lorries, "utf8"), 100,         "fixture sanity: 100 UTF-8 bytes");
  assert.ok(lorries.length <= 72,                               "fixture sanity: a character-count cap of 72 would ACCEPT this");

  assertValidationFailure(
    await post("/auth/register", validBody({ password: lorries })),
    "a password under 72 characters but over 72 bytes must be refused — this is the case a .length check gets wrong",
  );

  // The positive control — 30 accented characters, 60 bytes, accepted and
  // verifiable through bcrypt — needs persistence and lives in the DB suite
  // (src/tests/db/registration.test.ts, case D10). Asserting "not 400" here
  // would be vacuously green against a 404.
});

// ═════════════════════════════════════════════════════════════════════════════
// R10-R12. The identity posture exists and authenticates an account
// ═════════════════════════════════════════════════════════════════════════════

/** The exact body an identity-authenticated account read returns. `.strict()`
 *  is what proves "exactly": a leaked field fails here rather than passing. */
const MeSnapshot = z.object({
  user: z.object({
    id:        z.string().max(64),
    firstName: z.string().max(200),
    lastName:  z.string().max(200),
    email:     z.string().max(320),
  }).strict(),
  memberships: z.array(z.unknown()),
}).strict();

test("R10. GET /auth/me with no token is refused with the canonical envelope", async () => {
  const result = await get("/auth/me", zeroMembershipReads());

  assert.equal(result.statusCode, 401, "an identity route is not public");
  assert.deepEqual(result.body, CANONICAL_401, "and fails identically to every other authentication failure");
});

test("R11. a valid identity token and live session authenticate an account that has NO memberships", async () => {
  const result = await get("/auth/me", zeroMembershipReads(), signToken(identityClaims()));

  assert.equal(result.statusCode, 200, "a zero-membership driver must be able to authenticate — D21, the whole point");
  const me = MeSnapshot.parse(result.body);
  assert.deepEqual(me.user, {
    id:        USER_ID,
    firstName: "Nerijus",
    lastName:  "Kuizinas",
    email:     "driver@example.com",
  });
  assert.deepEqual(me.memberships, [], "zero memberships is a legitimate authenticated state, expressed as an empty list");
});

test("R12. the identity response never carries tenant identity", async () => {
  const result = await get("/auth/me", zeroMembershipReads(), signToken(identityClaims()));
  assert.equal(result.statusCode, 200, "positive control: the identity token must authenticate");

  // Asserted on the serialised body so a nested leak cannot hide from a
  // shallow key check. MeSnapshot's .strict() already forbids extra keys; this
  // states the forbidden VALUES too, which survives a future shape change.
  const serialised = JSON.stringify(result.body);
  for (const forbidden of ["companyId", "membershipId", "role", COMPANY_ID, MEMBERSHIP_ID]) {
    assert.ok(!serialised.includes(forbidden), `an identity response must not disclose ${forbidden}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// R13-R14. The two token kinds do not cross (D21) — the central invariant
// ═════════════════════════════════════════════════════════════════════════════

test("R13. an identity token cannot reach a tenant route, even with a live session and an active membership present", async () => {
  const identity = reads(liveSession(), activeMembership());

  // Positive control: the tenant token against the same fixtures succeeds, so
  // the refusal below is attributable to the TOKEN KIND and nothing else.
  const control = await get("/shifts/current", identity, signToken(tenantClaims()));
  assert.equal(control.statusCode, 200, "positive control: a tenant token must reach the tenant route");

  const crossed = await get("/shifts/current", identity, signToken(identityClaims()));
  assert.equal(crossed.statusCode, 401, "an identity token must NEVER reach Start Shift tenant authority");
  assert.deepEqual(crossed.body, CANONICAL_401, "and must fail generically, disclosing nothing about why");
});

test("R14. an identity token carrying forged tenant claims still cannot reach a tenant route", async () => {
  // The adversarial form of R13: a well-formed identity token with companyId,
  // membershipId and role bolted on. The audience is what must refuse it, so
  // the extra claims are never even read. If this ever passed, the identity
  // audience would be decoration.
  const identity = reads(liveSession(), activeMembership());
  const forged   = signToken(identityClaims({ companyId: COMPANY_ID, membershipId: MEMBERSHIP_ID, role: "admin" }));

  const result = await get("/shifts/current", identity, forged);
  assert.equal(result.statusCode, 401, "tenant claims in an identity-audience token confer nothing");
  assert.deepEqual(result.body, CANONICAL_401);
});

test("R15. a tenant token does not silently become an identity token", async () => {
  const identity = reads(liveSession(), activeMembership());

  // Positive control: the identity token works on this route.
  const control = await get("/auth/me", identity, signToken(identityClaims()));
  assert.equal(control.statusCode, 200, "positive control: the identity token must authenticate at the identity route");

  // A more authoritative token is still the WRONG KIND. One token must never
  // acquire a second meaning merely because both are JWTs (D21).
  const crossed = await get("/auth/me", identity, signToken(tenantClaims()));
  assert.equal(crossed.statusCode, 401, "a tenant token must not be accepted at an identity route");
  assert.deepEqual(crossed.body, CANONICAL_401);
});

// ═════════════════════════════════════════════════════════════════════════════
// R16-R19. The identity pipeline's own negative matrix
// ═════════════════════════════════════════════════════════════════════════════
// Each case leaves every OTHER check satisfied, so the rejection is
// attributable to the one binding under test. Each is paired with a positive
// control asserted FIRST, so a boundary that refuses everything cannot pass
// these vacuously.

test("R16. an identity token whose session belongs to a different user is refused", async () => {
  const token = signToken(identityClaims());

  const control = await get("/auth/me", zeroMembershipReads(), token);
  assert.equal(control.statusCode, 200, "positive control: the session belonging to the token subject must authenticate");

  // Present, unrevoked, unexpired, named exactly by the token — and someone
  // else's. `session.userId === sub` is the only check this identity fails.
  const othersSession: SessionRow = { ...liveSession(), userId: OTHER_USER };
  const result = await get("/auth/me", zeroMembershipReads(othersSession), token);

  assert.equal(result.statusCode, 401, "a session belonging to another user must not authenticate the token's subject");
  assert.deepEqual(result.body, CANONICAL_401);
});

test("R17. a revoked, expired or absent session refuses the identity token generically", async () => {
  const token = signToken(identityClaims());

  const control = await get("/auth/me", zeroMembershipReads(), token);
  assert.equal(control.statusCode, 200, "positive control: the live session must authenticate");

  const revoked: SessionRow = { ...liveSession(), revokedAt: new Date(Date.now() - MINUTE) };
  const expired: SessionRow = { ...liveSession(), expiresAt: new Date(Date.now() - MINUTE) };

  for (const [label, identity] of [
    ["revoked", zeroMembershipReads(revoked)],
    ["expired", zeroMembershipReads(expired)],
    ["absent",  reads(null, null)],
  ] as const) {
    const result = await get("/auth/me", identity, token);
    assert.equal(result.statusCode, 401, `a ${label} session must not authenticate`);
    assert.deepEqual(result.body, CANONICAL_401, `and a ${label} session must be indistinguishable from the others in the response`);
  }
});

test("R18. a forged, unsigned, foreign-issuer or expired identity token is refused", async () => {
  const control = await get("/auth/me", zeroMembershipReads(), signToken(identityClaims()));
  assert.equal(control.statusCode, 200, "positive control: the correctly signed token must authenticate");

  const nowSeconds = Math.floor(Date.now() / 1000);
  const unsigned   = `${base64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${base64url(JSON.stringify(identityClaims()))}.`;

  const cases: [string, string][] = [
    ["a different signing secret", signToken(identityClaims(), "9c2e7a41b8d05f36e1a94c7b2d8f60e35a1c9b4d7e2f80a6")],
    ["alg:none",                   unsigned],
    ["a foreign issuer",           signToken(identityClaims({ iss: "logisticbay-tms" }))],
    ["an expired token",           signToken(identityClaims({ iat: nowSeconds - 3600, exp: nowSeconds - 60 }))],
    ["a declared lifetime over 15 minutes", signToken(identityClaims({ iat: nowSeconds, exp: nowSeconds + 86400 }))],
    ["no sessionId",               signToken({ sub: USER_ID, iat: nowSeconds, exp: nowSeconds + 900, iss: ISSUER, aud: IDENTITY_AUDIENCE })],
    ["garbage",                    "not.a.jwt"],
  ];

  for (const [label, token] of cases) {
    const result = await get("/auth/me", zeroMembershipReads(), token);
    assert.equal(result.statusCode, 401, `${label} must not authenticate`);
    assert.deepEqual(result.body, CANONICAL_401, `${label} must fail with the canonical envelope, disclosing nothing`);
  }
});

test("R19. F-19: an identity token issued more than 60 seconds in the future is refused", async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);

  const control = await get("/auth/me", zeroMembershipReads(), signToken(identityClaims()));
  assert.equal(control.statusCode, 200, "positive control: a present-dated token must authenticate");

  // Inside the allowance: a minter 30 seconds ahead of this verifier is
  // ordinary clock skew, not an attack, and must still work.
  const skewed = await get("/auth/me", zeroMembershipReads(), signToken(identityClaims({ iat: nowSeconds + 30, exp: nowSeconds + 30 + 900 })));
  assert.equal(skewed.statusCode, 200, "30 seconds of clock skew is within the frozen 60-second allowance");

  // Outside it: `0 < exp - iat <= 900` is satisfied, so only the future-iat
  // bound can catch this. Without it the token is honoured for a day.
  const future = await get("/auth/me", zeroMembershipReads(), signToken(identityClaims({ iat: nowSeconds + 86400, exp: nowSeconds + 86400 + 900 })));
  assert.equal(future.statusCode, 401, "a token dated 24 hours ahead must be refused");
  assert.deepEqual(future.body, CANONICAL_401, "and must not disclose that the reason was temporal");
});

// ═════════════════════════════════════════════════════════════════════════════
// R20. Posture by omission still fails closed (F-10 polarity, extended)
// ═════════════════════════════════════════════════════════════════════════════

test("R20. a route that declares no posture is TENANT-protected, so an identity token cannot reach it", async () => {
  const app = await buildApp(reads(liveSession(), activeMembership()));
  // Registered with NO config, exactly as a careless feature route would be.
  app.get("/test-only/undeclared", () => ({ reached: true }));
  try {
    for (const [label, token] of [
      ["no token",         undefined],
      ["an identity token", signToken(identityClaims())],
    ] as const) {
      const res = await app.inject({
        method:  "GET",
        url:     "/test-only/undeclared",
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      });
      assert.equal(res.statusCode, 401, `an undeclared route must not be reachable with ${label}`);
      assert.deepEqual(res.json(), CANONICAL_401);
    }

    // And the control: the default posture is TENANT, so a tenant token works.
    const allowed = await app.inject({
      method:  "GET",
      url:     "/test-only/undeclared",
      headers: { authorization: `Bearer ${signToken(tenantClaims())}` },
    });
    assert.equal(allowed.statusCode, 200, "positive control: the default posture is tenant, and a tenant token satisfies it");
  } finally {
    await app.close();
  }
});
