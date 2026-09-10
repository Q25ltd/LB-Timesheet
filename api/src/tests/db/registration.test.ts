/**
 * Registration Increment 1 RED — against a REAL database built by the real
 * migrations.
 *
 * `src/routes/auth.test.ts` specifies what the boundary REFUSES, with
 * fixtures. This file proves the other half, and everything here is a claim
 * about PostgreSQL or about persisted state rather than about a schema:
 *
 *   - the User identity columns exist and `name` no longer competes with them (D22)
 *   - the DATABASE, not application code, refuses two accounts whose emails
 *     differ only in case (D22, D16)
 *   - a registration persists one User and exactly one Session, hashed
 *     credentials, zero memberships and zero shifts (D21)
 *   - the identity token it returns authenticates the account and is refused
 *     by a tenant route (D21)
 *
 * WRITTEN RED. Two independent absences produce the failures:
 *   (a) `POST /auth/register` and `GET /auth/me` do not exist — those cases
 *       fail on `404 !== <expected>`;
 *   (b) the User migration does not exist — those cases fail on an exact
 *       comparison of catalogue facts or of a SQLSTATE.
 * Both are assertion-level. Nothing here imports a module that is not built.
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compare as bcryptCompare } from "bcryptjs";
import { z } from "zod";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the registration database tests");
}

process.env.JWT_SECRET = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV   = "test";
process.env.WEB_ORIGIN = "https://allowed.example.com";

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `registration-test-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;

const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };
const IDENTITY_AUDIENCE = "timesheets-identity";

/** Distinct per case, so a leftover row can never make a later case pass. */
let seq = 0;
function freshEmail(local = "driver"): string {
  seq += 1;
  return `${TAG}-${String(seq)}-${local}@example.com`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Injection
// ─────────────────────────────────────────────────────────────────────────────

interface Injected {
  statusCode: number;
  body: unknown;
}

async function request(
  method: "GET" | "POST",
  url: string,
  options: { payload?: unknown; token?: string } = {},
): Promise<Injected> {
  const app = await buildApp(prisma);
  try {
    const res = await app.inject({
      method,
      url,
      ...(options.payload === undefined ? {} : { payload: options.payload as object }),
      headers: options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
    });
    return { statusCode: res.statusCode, body: res.body === "" ? null : (JSON.parse(res.body) as unknown) };
  } finally {
    await app.close();
  }
}

function register(body: Record<string, unknown>): Promise<Injected> {
  return request("POST", "/auth/register", { payload: body });
}

/**
 * The frozen success body (AUTH.md, "Registration"). `.strict()` throughout:
 * a field this contract does not name — a password hash, a refresh-token
 * hash, a companyId — fails here rather than shipping.
 */
const RegistrationResult = z.object({
  user: z.object({
    id:        z.string().max(64),
    firstName: z.string().max(200),
    lastName:  z.string().max(200),
    email:     z.string().max(320),
  }).strict(),
  identityToken: z.string().max(4000),
  refreshToken:  z.string().max(4000),
  memberships:   z.array(z.unknown()),
}).strict();

// ─────────────────────────────────────────────────────────────────────────────
// Catalogue and error helpers
// ─────────────────────────────────────────────────────────────────────────────

function stringField(row: unknown, key: string): string | null {
  if (typeof row !== "object" || row === null || !(key in row)) return null;
  const value: unknown = Reflect.get(row, key);
  return typeof value === "string" ? value : null;
}

/**
 * The SQLSTATE behind a Prisma failure, or null. Same nesting path the
 * companyTimezone and sessionPersistence suites established under the
 * PrismaPg driver adapter — observed, not assumed.
 */
function sqlStateOf(error: unknown): string | null {
  const path = ["meta", "driverAdapterError", "cause"];
  let current: unknown = error;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) return null;
    current = Reflect.get(current, key);
  }
  if (typeof current !== "object" || current === null) return null;
  for (const key of ["code", "originalCode"]) {
    if (!(key in current)) continue;
    const code: unknown = Reflect.get(current, key);
    if (typeof code === "string") return code;
  }
  return null;
}

async function columnNames(table: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<unknown[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
  `;
  return rows.map(row => stringField(row, "column_name")).filter((n): n is string => n !== null);
}

async function columnIsNullable(table: string, column: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<unknown[]>`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
  `;
  const row = rows[0];
  return row === undefined ? null : stringField(row, "is_nullable");
}

/** The underlying type name — `text` or `citext` — as PostgreSQL reports it. */
async function columnUdtName(table: string, column: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<unknown[]>`
    SELECT udt_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
  `;
  const row = rows[0];
  return row === undefined ? null : stringField(row, "udt_name");
}

async function userIndexDefinitions(): Promise<string[]> {
  const rows = await prisma.$queryRaw<unknown[]>`
    SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'User'
  `;
  return rows.map(row => stringField(row, "indexdef")).filter((d): d is string => d !== null);
}

/** The user row, read raw so this file never depends on the generated client
 *  carrying columns the migration has not created yet. */
async function readUserRaw(email: string): Promise<Record<string, unknown> | null> {
  const rows = await prisma.$queryRaw<unknown[]>`
    SELECT * FROM "User" WHERE email = ${email}
  `;
  const row = rows[0];
  return typeof row === "object" && row !== null ? (row as Record<string, unknown>) : null;
}

function claimsOf(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  assert.ok(payload !== undefined && payload !== "", "a JWT must have a payload segment");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

async function cleanup(): Promise<void> {
  // Sessions and memberships cascade from User (proven in sessionPersistence).
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
  await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
}

before(cleanup);
beforeEach(cleanup);
after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

// ═════════════════════════════════════════════════════════════════════════════
// D1-D3. The schema the identity model requires (D22)
// ═════════════════════════════════════════════════════════════════════════════

test("D1. User carries firstName and lastName, both NOT NULL, and `name` no longer exists as a competing authority", async () => {
  const columns = await columnNames("User");

  assert.ok(columns.includes("firstName"), `User.firstName must exist — columns are: ${columns.join(", ")}`);
  assert.ok(columns.includes("lastName"),  `User.lastName must exist — columns are: ${columns.join(", ")}`);
  assert.equal(await columnIsNullable("User", "firstName"), "NO", "firstName is identity, not optional detail");
  assert.equal(await columnIsNullable("User", "lastName"),  "NO", "lastName is identity, not optional detail");

  // D22 and CLAUDE.md's "one concept, one name": a surviving `name` column is
  // a second authority for the driver's name, and the two will disagree.
  assert.ok(!columns.includes("name"), "User.name must be GONE, not kept alongside firstName/lastName");
});

test("D2. exactly one unique constraint governs User.email, and it is case-insensitive by construction", async () => {
  // Deliberately MECHANISM-AGNOSTIC. Two implementations satisfy D22 — a
  // functional `UNIQUE (lower(email))` index over a text column, or a plain
  // unique index over a `citext` column — and which to use is an open
  // mechanic, not something RED gets to freeze by accident. What is NOT
  // negotiable is the property: one constraint, and case cannot split an
  // identity. D3 proves the behaviour; this case proves there is exactly one
  // place it comes from, so a second, case-SENSITIVE index cannot survive
  // alongside and mislead the next reader.
  const definitions = await userIndexDefinitions();
  const emailUnique = definitions.filter(d => /unique/i.test(d) && /email/i.test(d));

  assert.equal(
    emailUnique.length, 1,
    `exactly one UNIQUE index may govern User.email — found:\n  ${definitions.join("\n  ")}`,
  );

  const definition = emailUnique[0] ?? "";
  const functional = /lower\s*\(\s*\(?\s*email/i.test(definition);
  const citext     = await columnUdtName("User", "email") === "citext";

  assert.ok(
    functional || citext,
    `the sole email index must be case-insensitive — either over lower(email) or over a citext column. ` +
    `Index: ${definition}; column type: ${String(await columnUdtName("User", "email"))}`,
  );
});

/**
 * Insert a User straight into PostgreSQL, bypassing every application code
 * path, and report the outcome as a SQLSTATE (or null on success).
 *
 * Returning the state rather than throwing is what keeps D3 an ASSERTION: a
 * missing migration surfaces as `'42703' !== null` on a named line, not as an
 * unhandled rejection that says only that the test crashed.
 */
async function insertUserRaw(id: string, email: string, firstName: string, lastName: string): Promise<string | { unmapped: string } | null> {
  try {
    await prisma.$executeRaw`
      INSERT INTO "User" ("id", "email", "firstName", "lastName", "passwordHash", "updatedAt")
      VALUES (${id}, ${email}, ${firstName}, ${lastName}, 'not-a-real-hash', now())
    `;
    return null;
  } catch (error) {
    return sqlStateOf(error) ?? { unmapped: String(error) };
  }
}

test("D3. the database itself refuses two accounts whose emails differ only in case", async () => {
  const lower = freshEmail("case");
  const upper = lower.toUpperCase();
  assert.notEqual(lower, upper, "fixture sanity: the two spellings differ as strings");

  // Raw SQL on purpose: this must prove the CONSTRAINT, not a service that
  // happens to lowercase before writing. Application normalisation is not the
  // guarantee (D22, D16).
  const first = await insertUserRaw(`${TAG}-ci-1`, lower, "Case", "One");
  assert.equal(first, null, `the first insert must succeed — instead PostgreSQL reported: ${JSON.stringify(first)}`);

  const second = await insertUserRaw(`${TAG}-ci-2`, upper, "Case", "Two");
  assert.equal(
    second, "23505",
    `a case variant of an existing email must violate a unique constraint (SQLSTATE 23505), got: ${JSON.stringify(second)}`,
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// D4-D8. A successful registration (D21, D22, D23)
// ═════════════════════════════════════════════════════════════════════════════

test("D4. registration normalises the email to trimmed lowercase and returns the canonical form", async () => {
  const canonical = freshEmail("normalise");
  const asTyped   = `  ${canonical.toUpperCase()}  `;

  const result = await register({ firstName: "  Nerijus  ", lastName: "  Kuizinas  ", email: asTyped, password: "correct-horse-battery" });

  assert.equal(result.statusCode, 201, "a valid registration creates an account");
  const body = RegistrationResult.parse(result.body);

  assert.equal(body.user.email, canonical, "the response carries the canonical identity, not what the driver typed");
  assert.equal(body.user.firstName, "Nerijus", "names are trimmed (CLAUDE.md), so no account is created with padded whitespace");
  assert.equal(body.user.lastName,  "Kuizinas");

  const row = await readUserRaw(canonical);
  assert.ok(row !== null, "the canonical email is what is PERSISTED — a lookup by it must find the row");
  assert.equal(row["firstName"], "Nerijus");
  assert.equal(row["lastName"],  "Kuizinas");
});

test("D5. the password is bcrypt-hashed, never stored or returned in plaintext, and verifies", async () => {
  const email    = freshEmail("hash");
  const password = "correct-horse-battery";

  const result = await register({ firstName: "Hash", lastName: "Driver", email, password });
  assert.equal(result.statusCode, 201);

  const row = await readUserRaw(email);
  assert.ok(row !== null, "the user must be persisted");
  const hash = row["passwordHash"];
  assert.equal(typeof hash, "string", "passwordHash must be a string");
  assert.ok(typeof hash === "string" && hash !== password, "the plaintext password must never be the stored value");
  assert.ok(typeof hash === "string" && /^\$2[aby]\$/.test(hash), `the stored value must be a bcrypt hash, got: ${String(hash)}`);
  assert.ok(typeof hash === "string" && await bcryptCompare(password, hash), "the stored hash must verify against the password the driver chose");
  assert.equal(await bcryptCompare(`${password}x`, typeof hash === "string" ? hash : ""), false, "and must not verify against a different password");

  // The response is the other place a credential can escape.
  const serialised = JSON.stringify(result.body);
  assert.ok(!serialised.includes(password),                    "the response must not echo the plaintext password");
  assert.ok(!serialised.includes(typeof hash === "string" ? hash : " "), "the response must not disclose the password hash");
});

test("D6. registration creates exactly one Session, owned by the new user, with the frozen 90-day absolute lifetime", async () => {
  const email  = freshEmail("session");
  const result = await register({ firstName: "Session", lastName: "Driver", email, password: "correct-horse-battery" });
  assert.equal(result.statusCode, 201);

  const body = RegistrationResult.parse(result.body);
  const sessions = await prisma.session.findMany({ where: { userId: body.user.id } });

  assert.equal(sessions.length, 1, "one registration is one device session — not zero, and not two");
  const session = sessions[0];
  assert.ok(session !== undefined);
  assert.equal(session.userId, body.user.id, "the Session belongs to the user it authenticated");
  assert.equal(session.revokedAt, null,      "a brand-new session is not revoked");

  // AUTH.md: ABSOLUTE, 90 days from login. A minute of tolerance for the
  // round trip; anything else (a sliding window, a 30-day default) fails.
  const lifetimeMs = session.expiresAt.getTime() - Date.now();
  assert.ok(
    Math.abs(lifetimeMs - 90 * DAY) < 60_000,
    `the session lifetime must be the frozen 90 days, got ${String(Math.round(lifetimeMs / DAY))} days`,
  );

  // D11 of the gate: registration mints the initial refresh secret the Session
  // model requires, and NOTHING has rotated yet. Both halves of the previous
  // token are one fact, and both must still be absent.
  assert.equal(session.previousRefreshTokenHash, null,       "nothing has rotated, so there is no previous token");
  assert.equal(session.previousRefreshTokenGraceUntil, null, "and no grace deadline");
});

test("D7. the refresh secret is returned once and stored only as a SHA-256 digest", async () => {
  const email  = freshEmail("refresh");
  const result = await register({ firstName: "Refresh", lastName: "Driver", email, password: "correct-horse-battery" });
  assert.equal(result.statusCode, 201);

  const body    = RegistrationResult.parse(result.body);
  const session = await prisma.session.findFirstOrThrow({ where: { userId: body.user.id } });

  assert.notEqual(session.refreshTokenHash, body.refreshToken, "the token itself must never be the stored value");
  assert.equal(
    session.refreshTokenHash,
    createHash("sha256").update(body.refreshToken).digest("hex"),
    "AUTH.md: the Session stores a SHA-256 digest of the refresh token — deterministic, so refresh can look it up, and never the token",
  );

  const serialised = JSON.stringify(result.body);
  assert.ok(!serialised.includes(session.refreshTokenHash), "the stored digest must not travel to the client");
});

test("D8. a registered driver has ZERO memberships and ZERO shifts — no tenant is invented", async () => {
  const email  = freshEmail("zero");
  const result = await register({ firstName: "Zero", lastName: "Company", email, password: "correct-horse-battery" });
  assert.equal(result.statusCode, 201);

  const body = RegistrationResult.parse(result.body);

  assert.deepEqual(body.memberships, [], "zero memberships is the successful answer, expressed explicitly");
  assert.equal(await prisma.companyMembership.count({ where: { userId: body.user.id } }), 0, "no CompanyMembership may be fabricated for a driver with no employer (D21)");
  assert.equal(await prisma.shift.count({ where: { userId: body.user.id } }), 0, "registration creates no shift");

  // The fake-tenant failure mode this forbids: a Company created to hang a
  // "personal" membership off. Nothing registered may have created one.
  assert.equal(
    await prisma.company.count({ where: { OR: [{ name: { contains: email } }, { joinCode: { contains: email } }] } }),
    0,
    "no Company may be created by a driver registration",
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// D9-D11. Duplicate identity (D24) and concurrency
// ═════════════════════════════════════════════════════════════════════════════

test("D9. a second registration of the same email — in any casing — is 409 EMAIL_IN_USE and discloses nothing else", async () => {
  const email = freshEmail("duplicate");

  const first = await register({ firstName: "First", lastName: "Driver", email, password: "correct-horse-battery" });
  assert.equal(first.statusCode, 201, "positive control: the first registration must succeed");
  const firstBody = RegistrationResult.parse(first.body);

  const second = await register({ firstName: "Second", lastName: "Driver", email: email.toUpperCase(), password: "different-password-x" });

  assert.equal(second.statusCode, 409, "a case variant is the same identity (D22), so it collides");
  assert.deepEqual(
    second.body, { error: "Email already registered", code: "EMAIL_IN_USE" },
    "the frozen envelope — and NOTHING else: no user id, no name, no account status, no membership or company information (D24)",
  );

  const serialised = JSON.stringify(second.body);
  for (const leak of [firstBody.user.id, "First", firstBody.user.email]) {
    assert.ok(!serialised.includes(leak), `the conflict response must not disclose ${leak}`);
  }

  const rows = await prisma.$queryRaw<unknown[]>`SELECT id FROM "User" WHERE lower(email) = ${email.toLowerCase()}`;
  assert.equal(rows.length, 1, "the refused registration must not have created a second row");
});

test("D10. a multibyte password within 72 BYTES is accepted and verifies — the control for the route suite's rejection case", async () => {
  const email = freshEmail("multibyte");
  // 30 accented characters: 30 UTF-16 code units, 60 UTF-8 bytes. Over the
  // 10-character minimum, under the 72-byte maximum. A byte-based check that
  // was accidentally written against `.length` would still pass this — the
  // rejection half (routes/auth.test.ts R9) is what catches that.
  const password = "é".repeat(30);
  assert.equal(Buffer.byteLength(password, "utf8"), 60, "fixture sanity: 60 UTF-8 bytes");

  const result = await register({ firstName: "Multi", lastName: "Byte", email, password });
  assert.equal(result.statusCode, 201, "a 60-byte multibyte password is within policy and must be accepted");

  const row = await readUserRaw(email);
  const hash = row === null ? null : row["passwordHash"];
  assert.ok(typeof hash === "string" && await bcryptCompare(password, hash), "and must verify — bcrypt must have received the whole password");
});

test("D11. concurrent registrations of the same normalised email create at most one User", async () => {
  const email = freshEmail("race");
  // Four spellings of one identity, posted at once. A read-then-write has a
  // window between the two; only the database can close it.
  const spellings = [email, email.toUpperCase(), `  ${email}  `, email.replace("driver", "DRIVER")];

  const results = await Promise.all(
    spellings.map((spelling, index) =>
      register({ firstName: "Race", lastName: `Driver${String(index)}`, email: spelling, password: "correct-horse-battery" }),
    ),
  );

  const created  = results.filter(r => r.statusCode === 201);
  const conflict = results.filter(r => r.statusCode === 409);

  assert.equal(created.length, 1,  `exactly one concurrent registration may succeed, got statuses: ${results.map(r => String(r.statusCode)).join(", ")}`);
  assert.equal(conflict.length, 3, "the losers must be answered 409, never 500 — a race is not an internal error");

  const rows = await prisma.$queryRaw<unknown[]>`SELECT id FROM "User" WHERE lower(email) = ${email.toLowerCase()}`;
  assert.equal(rows.length, 1, "exactly one row, whatever the interleaving");
});

// ═════════════════════════════════════════════════════════════════════════════
// D12-D14. The identity token this registration issued, end to end (D21)
// ═════════════════════════════════════════════════════════════════════════════

test("D12. the identity token registration returns carries no tenant claims and the identity audience", async () => {
  const email  = freshEmail("token");
  const result = await register({ firstName: "Token", lastName: "Driver", email, password: "correct-horse-battery" });
  assert.equal(result.statusCode, 201);

  const body   = RegistrationResult.parse(result.body);
  const claims = claimsOf(body.identityToken);

  assert.equal(claims["aud"], IDENTITY_AUDIENCE, "the audience is what makes this token structurally unusable against tenant routes");
  assert.equal(claims["iss"], "logisticbay-timesheets");
  assert.equal(claims["sub"], body.user.id, "the token names the account it was issued for");
  assert.equal(typeof claims["sessionId"], "string");

  for (const forbidden of ["companyId", "membershipId", "role"]) {
    assert.ok(!(forbidden in claims), `an identity token must not carry ${forbidden} — D21`);
  }

  // The same lifetime rules as the tenant token.
  const iat = claims["iat"];
  const exp = claims["exp"];
  assert.equal(typeof iat, "number");
  assert.equal(typeof exp, "number");
  assert.ok(typeof iat === "number" && typeof exp === "number" && exp - iat > 0 && exp - iat <= 900, "the declared lifetime must be within the frozen 15 minutes");
  assert.ok(typeof iat === "number" && iat <= Math.floor(Date.now() / 1000) + 60, "and must not be future-dated beyond the 60-second allowance (F-19)");
});

test("D13. the identity token authenticates the account against the REAL persisted Session", async () => {
  const email  = freshEmail("me");
  const result = await register({ firstName: "Real", lastName: "Session", email, password: "correct-horse-battery" });
  assert.equal(result.statusCode, 201);
  const body = RegistrationResult.parse(result.body);

  const me = await request("GET", "/auth/me", { token: body.identityToken });
  assert.equal(me.statusCode, 200, "the token just issued must authenticate against the row just written");
  assert.deepEqual(
    me.body,
    { user: { id: body.user.id, firstName: "Real", lastName: "Session", email }, memberships: [] },
    "and describe the zero-membership account exactly",
  );

  // Revoking the persisted session must end it immediately, not at token expiry.
  await prisma.session.updateMany({ where: { userId: body.user.id }, data: { revokedAt: new Date() } });
  const afterRevoke = await request("GET", "/auth/me", { token: body.identityToken });
  assert.equal(afterRevoke.statusCode, 401, "a revoked session must be refused on the very next request");
  assert.deepEqual(afterRevoke.body, CANONICAL_401);
});

test("D14. the identity token registration issued cannot reach Start Shift's tenant authority", async () => {
  const email  = freshEmail("crossing");
  const result = await register({ firstName: "Cross", lastName: "Driver", email, password: "correct-horse-battery" });
  assert.equal(result.statusCode, 201, "positive control: registration must succeed and issue a usable identity token");
  const body = RegistrationResult.parse(result.body);

  const control = await request("GET", "/auth/me", { token: body.identityToken });
  assert.equal(control.statusCode, 200, "positive control: the token authenticates at its own posture");

  // The invariant the whole two-token design exists for. A real token, a real
  // live session, a real user — and no membership anywhere. It must not reach
  // tenant data, and it must fail as an authentication failure, not as a
  // partially-processed request.
  const crossed = await request("GET", "/shifts/current", { token: body.identityToken });
  assert.equal(crossed.statusCode, 401, "no token may reach tenant data without naming and validating a real membership (D21)");
  assert.deepEqual(crossed.body, CANONICAL_401);

  const started = await request("POST", "/shifts/start", {
    token:   body.identityToken,
    payload: { clientEventId: "3f8e1a52-6c4d-4b7a-9f21-0d5e8c7a1b34", startedAt: new Date().toISOString() },
  });
  assert.equal(started.statusCode, 401, "and Start Shift must be equally unreachable");
  assert.deepEqual(started.body, CANONICAL_401);
  assert.equal(await prisma.shift.count({ where: { userId: body.user.id } }), 0, "no shift row may exist for an account with no membership");
});
