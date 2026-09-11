/**
 * Login RED — against a REAL database built by the real migrations.
 *
 * `src/routes/authLogin.test.ts` specifies what the login boundary REFUSES,
 * with fixtures. This file proves the other half, and every case here is a
 * claim about persisted state or about the answer a real account produces:
 *
 *   - a registered driver authenticates with their credentials (AUTH.md,
 *     "Login flow"; contract tests 1 and 4)
 *   - a wrong password and an unknown email are INDISTINGUISHABLE from
 *     outside (AUTH.md contract test 4, D17)
 *   - a zero-membership driver is a successful login (D21, superseding
 *     D13's "0 memberships → denied")
 *   - the token issued is an IDENTITY token and carries no tenant authority
 *     of any kind (D21)
 *   - an INACTIVE membership is not offered and grants nothing (AUTH.md
 *     contract test 5)
 *   - login creates no Company, no CompanyMembership and no Shift (D21:
 *     a "personal" tenant is never invented)
 *   - no credential material appears in the response (AUTH.md contract 31)
 *
 * The accounts are created through the REAL, shipped `POST /auth/register`,
 * so a RED failure here is never a hand-built fixture that does not match
 * what registration actually writes.
 *
 * WRITTEN RED. `POST /auth/login` does not exist, so every case fails on
 * `404 !== <expected>`, or on an exact comparison of persisted counts — an
 * assertion-level failure naming the missing behaviour. Nothing here imports
 * a module that is not built.
 *
 * L1-L20 were written BEFORE the owner resolved the remaining contracts;
 * L21-L25 were added with those decisions (2026-09-11) and prove them:
 * a NEW Session per login, no revocation of an earlier one, an unreadable
 * stored hash answering 401 rather than 500, an existing short credential
 * still authenticating, and the unknown-email path spending real bcrypt work.
 *
 * WHAT THIS FILE STILL DOES NOT TEST, because it is not reachable:
 *
 *   - the 1-membership auto-selection and 2+ membership list. AUTH.md freezes
 *     both, but nothing in this product can create a CompanyMembership, so no
 *     login can produce a non-empty list and there is no tenant-token minter
 *     to assert against. They belong to the company-onboarding increment.
 *   - anything about `/auth/refresh`, rotation, or session restore — blocked
 *     by F-21, whose direction is decided but whose implementation is not.
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hash as bcryptHash } from "bcryptjs";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the login database tests");
}

process.env.JWT_SECRET = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV   = "test";
process.env.WEB_ORIGIN = "https://allowed.example.com";

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `login-test-${Date.now()}`;

const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };
const IDENTITY_AUDIENCE = "timesheets-identity";
const TENANT_AUDIENCE   = "timesheets-api";

/** Long enough for D23's 10-character minimum, and not trimmed anywhere. */
const PASSWORD = "correct-horse-battery-staple";

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
  raw: string;
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
    return {
      statusCode: res.statusCode,
      body:       res.body === "" ? null : (JSON.parse(res.body) as unknown),
      raw:        res.body,
    };
  } finally {
    await app.close();
  }
}

function login(email: unknown, password: unknown): Promise<Injected> {
  return request("POST", "/auth/login", { payload: { email, password } });
}

/**
 * A registered driver, created through the REAL registration route. Returns
 * the canonical email the account was stored under.
 */
async function registerDriver(email: string, password = PASSWORD): Promise<string> {
  const result = await request("POST", "/auth/register", {
    payload: { firstName: "Nerijus", lastName: "Kuizinas", email, password },
  });
  assert.equal(result.statusCode, 201, `the shipped registration route must create the account this case logs in as — got ${result.raw}`);
  return email.trim().toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the answer
// ─────────────────────────────────────────────────────────────────────────────

function field(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null || !(key in body)) return undefined;
  return Reflect.get(body, key);
}

function stringField(body: unknown, key: string): string {
  const value = field(body, key);
  assert.equal(typeof value, "string", `the login response must carry \`${key}\` as a string`);
  return value as string;
}

function claimsOf(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  assert.ok(payload !== undefined && payload !== "", "a JWT must have a payload segment");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

/**
 * Every JWT anywhere in the response, with its audience — found by SHAPE, not
 * by field name.
 *
 * Deliberately name-agnostic: the property under test is "no token in this
 * answer carries tenant authority", and a test that only inspected a field it
 * knew the name of would be satisfied by a tenant token smuggled under any
 * other name. A refresh secret is 32 random bytes of base64url and has no
 * dots, so it is never mistaken for one of these.
 */
function jwtsIn(body: unknown): { value: string; audience: unknown }[] {
  const found: { value: string; audience: unknown }[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(node)) {
        try {
          found.push({ value: node, audience: claimsOf(node)["aud"] });
        } catch {
          // Three dot-separated segments that do not decode are not a JWT,
          // and are therefore not a token this assertion is about.
          found.push({ value: node, audience: undefined });
        }
      }
      return;
    }
    if (Array.isArray(node)) { (node as unknown[]).forEach(visit); return; }
    if (typeof node === "object" && node !== null) {
      for (const key of Object.keys(node)) visit(Reflect.get(node, key));
    }
  };
  visit(body);
  return found;
}

function memberships(body: unknown): unknown[] {
  const value = field(body, "memberships");
  assert.ok(Array.isArray(value), "the login response must carry `memberships` — an EMPTY array is the answer for a driver with no company (D21)");
  return value;
}

/**
 * The one Session a returned refresh secret names.
 *
 * Asserts uniqueness on the way through, so every caller below inherits the
 * "exactly one row" guarantee L17 states rather than restating it.
 */
async function sessionFor(refreshToken: string): Promise<{ id: string; userId: string; revokedAt: Date | null; expiresAt: Date }> {
  const digest = createHash("sha256").update(refreshToken).digest("hex");
  const rows = await prisma.session.findMany({ where: { refreshTokenHash: digest } });
  assert.equal(rows.length, 1, "a refresh secret must name exactly one session");
  const row = rows[0];
  assert.ok(row !== undefined, "a refresh secret must name exactly one session");
  return { id: row.id, userId: row.userId, revokedAt: row.revokedAt, expiresAt: row.expiresAt };
}

/**
 * The floor that separates "bcrypt ran" from "the call returned early".
 * Measured on Node 22.13: cost-12 verification ~230 ms, no verification ~0 ms.
 */
const BCRYPT_WORK_FLOOR_MS = 25;

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
// L7. Valid credentials authenticate, and a ZERO-MEMBERSHIP driver is IN
// ═════════════════════════════════════════════════════════════════════════════
// D21, superseding D13's "0 memberships → denied". Registration creates
// exactly this account — one User, one Session, no company — so this is the
// ONLY kind of account that exists today, and it must be able to get back in.

test("L7. a registered driver with NO memberships authenticates, and receives identity material", async () => {
  const email = await registerDriver(freshEmail());

  const result = await login(email, PASSWORD);

  assert.equal(result.statusCode, 200, `valid credentials must authenticate — got ${result.raw}`);
  // The two AUTH.md's login flow names: "issue IDENTITY token + refresh
  // (always — the account exists regardless)". The names are registration's,
  // already frozen and already consumed by the mobile client (one concept,
  // one name).
  assert.ok(stringField(result.body, "identityToken").length > 0, "login must issue an identity token");
  assert.ok(stringField(result.body, "refreshToken").length > 0, "login must issue a refresh token");
  assert.deepEqual(memberships(result.body), [], "a driver with no company has an EMPTY membership list, not an error");
});

test("L8. the identity token login returns actually authenticates an identity route", async () => {
  // Not a claim about the token's shape — a claim that the thing handed to
  // the phone works. Without this, login could return a well-formed token
  // that no route accepts and every other case here would still pass.
  const email = await registerDriver(freshEmail());
  const result = await login(email, PASSWORD);
  assert.equal(result.statusCode, 200, `valid credentials must authenticate — got ${result.raw}`);

  const me = await request("GET", "/auth/me", { token: stringField(result.body, "identityToken") });
  assert.equal(me.statusCode, 200, `the token login issued must authenticate GET /auth/me — got ${me.raw}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// L9. Email canonicalisation is Registration's, exactly
// ═════════════════════════════════════════════════════════════════════════════
// D22: `Driver@Example.com` and `driver@example.com` are the same account.
// Mechanism-agnostic on purpose — trim+lowercase in the service and `citext`
// in the database both satisfy this, and which one answers is not this test's
// business. What IS frozen is that the driver who typed their address with a
// capital letter or a trailing space on a phone keyboard gets in.

test("L9. the email is canonicalised exactly as registration canonicalises it — case and surrounding whitespace do not split an identity", async () => {
  const email = freshEmail();
  await registerDriver(email);

  for (const variant of [email.toUpperCase(), `  ${email}  `, `\t${email.toUpperCase()}\n`]) {
    const result = await login(variant, PASSWORD);
    assert.equal(result.statusCode, 200, `"${variant}" is the same identity as "${email}" (D22) — got ${result.raw}`);
  }
});

test("L10. the password is NOT canonicalised — whitespace is part of the credential", async () => {
  // D23's counterpart to L9, and the reason `PasswordPolicy` is the one
  // user-visible string in this codebase that is deliberately not `.trim()`ed.
  // Trimming at login would let a password the driver never chose sign them
  // in, and would break a password that legitimately ends in a space.
  const email = await registerDriver(freshEmail(), ` ${PASSWORD} `);

  const exact = await login(email, ` ${PASSWORD} `);
  assert.equal(exact.statusCode, 200, `the password as chosen must authenticate — got ${exact.raw}`);

  const trimmed = await login(email, PASSWORD);
  assert.deepEqual(
    { status: trimmed.statusCode, body: trimmed.body },
    { status: 401, body: CANONICAL_401 },
    "a trimmed password is a DIFFERENT credential and must not authenticate",
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// L11-L13. Failure discloses nothing — and discloses the SAME nothing
// ═════════════════════════════════════════════════════════════════════════════
// D17's table: invalid authentication is 401 / UNAUTHENTICATED / "Not
// authenticated", and it does not explain itself. AUTH.md contract test 4:
// wrong password answers identically to unknown email. Registration's
// deliberate `409 EMAIL_IN_USE` enumeration trade-off (D24) is scoped to
// registration and does NOT license login to confirm that an account exists.

test("L11. a wrong password is refused with the canonical authentication failure", async () => {
  const email = await registerDriver(freshEmail());

  const result = await login(email, "not-the-right-password");

  assert.equal(result.statusCode, 401, `a wrong password must be 401 — got ${result.raw}`);
  assert.deepEqual(result.body, CANONICAL_401, "the failure is the project's one authentication envelope (D17)");
});

test("L12. an unknown email is refused with the canonical authentication failure", async () => {
  const result = await login(freshEmail("nobody"), PASSWORD);

  assert.equal(result.statusCode, 401, `an unknown email must be 401 — got ${result.raw}`);
  assert.deepEqual(result.body, CANONICAL_401, "the failure is the project's one authentication envelope (D17)");
});

test("L13. an unknown email and a wrong password are INDISTINGUISHABLE from outside", async () => {
  // The property, stated as a comparison rather than as two separate
  // expectations: even if the canonical body changed, these two must not
  // diverge. A response that differs in status, code, message, field order or
  // length is an account-existence oracle.
  const email = await registerDriver(freshEmail());

  const wrongPassword = await login(email, "not-the-right-password");
  const unknownEmail  = await login(freshEmail("nobody"), PASSWORD);

  // Anchored to the EXACT status first. Without this the case is vacuously
  // green against a route that does not exist — two identical 404s are
  // indistinguishable too, and would prove nothing about login.
  assert.equal(wrongPassword.statusCode, 401, `a wrong password must be 401 — got ${wrongPassword.raw}`);
  assert.equal(unknownEmail.statusCode, 401, `an unknown email must be 401 — got ${unknownEmail.raw}`);

  assert.equal(wrongPassword.statusCode, unknownEmail.statusCode, "the two failures must share a status code");
  assert.deepEqual(wrongPassword.body, unknownEmail.body, "the two failures must share a body");
  assert.equal(
    wrongPassword.raw, unknownEmail.raw,
    "the two failures must be byte-identical — a difference in serialisation is still an oracle",
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// L14. No credential material leaves in the response
// ═════════════════════════════════════════════════════════════════════════════
// AUTH.md contract test 31, applied to login.

test("L14. no plaintext password, stored hash or refresh-token digest appears in the login response", async () => {
  const email = await registerDriver(freshEmail());
  const stored = await prisma.user.findUnique({ where: { email } });
  assert.ok(stored !== null, "registration must have persisted the account");

  const result = await login(email, PASSWORD);
  assert.equal(result.statusCode, 200, `valid credentials must authenticate — got ${result.raw}`);

  assert.ok(!result.raw.includes(PASSWORD), "the plaintext password must never be echoed");
  assert.ok(!result.raw.includes(stored.passwordHash), "the stored bcrypt hash must never be returned");
  assert.ok(!/\$2[aby]\$/.test(result.raw), "nothing bcrypt-shaped belongs in an authentication response");

  // The refresh SECRET is returned by design; its stored DIGEST is what must
  // not be, because a digest in a response is a lookup key for every session.
  const digest = createHash("sha256").update(stringField(result.body, "refreshToken")).digest("hex");
  assert.ok(!result.raw.includes(digest), "the refresh token's stored hash must never be returned");
});

// ═════════════════════════════════════════════════════════════════════════════
// L15-L16. The token login issues is an IDENTITY token, and nothing more
// ═════════════════════════════════════════════════════════════════════════════
// D21: the separation between the two kinds is the JWT AUDIENCE, not a claim
// the code has to remember to read. A login that has selected no company must
// not be able to produce a tenant-audience token by any route.

test("L15. the token carries the IDENTITY audience and no companyId, membershipId or role", async () => {
  const email = await registerDriver(freshEmail());
  const result = await login(email, PASSWORD);
  assert.equal(result.statusCode, 200, `valid credentials must authenticate — got ${result.raw}`);

  const claims = claimsOf(stringField(result.body, "identityToken"));

  assert.equal(claims["aud"], IDENTITY_AUDIENCE, "an account-level token carries the identity audience (D21)");
  assert.equal(claims["iss"], "logisticbay-timesheets", "the issuer is what keeps a TMS token out of this product (D1)");
  assert.equal(typeof claims["sub"], "string", "an identity token names the account");
  assert.equal(typeof claims["sessionId"], "string", "an identity token names the device session");

  for (const forbidden of ["companyId", "membershipId", "role"]) {
    assert.ok(
      !(forbidden in claims),
      `an identity token must not carry \`${forbidden}\` — its absence is the design, not an omission (D21). Claims were: ${Object.keys(claims).join(", ")}`,
    );
  }
});

test("L16. no token anywhere in the login response carries the TENANT audience", async () => {
  // Found by shape, not by field name: the property is about the ANSWER, not
  // about one field of it. A driver who has selected no company holds no
  // tenant authority, and none may be smuggled under another name.
  const email = await registerDriver(freshEmail());
  const result = await login(email, PASSWORD);
  assert.equal(result.statusCode, 200, `valid credentials must authenticate — got ${result.raw}`);

  const audiences = jwtsIn(result.body).map(token => token.audience);
  assert.ok(audiences.length > 0, "login must return at least one token");
  assert.deepEqual(
    audiences.filter(aud => aud === TENANT_AUDIENCE), [],
    `no tenant-audience token may be issued by login to a driver with no company — audiences were: ${audiences.join(", ")}`,
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// L17. The refresh secret resolves to exactly ONE live Session for this user
// ═════════════════════════════════════════════════════════════════════════════
// Deliberately does NOT decide whether login creates a new Session, reuses a
// device Session or replaces one — that is an open owner decision. This is
// the invariant that holds under all three, and the one a future
// `/auth/refresh` will depend on.

test("L17. the returned refresh secret resolves to exactly one live Session owned by the authenticated user", async () => {
  const email = await registerDriver(freshEmail());
  const account = await prisma.user.findUnique({ where: { email } });
  assert.ok(account !== null, "registration must have persisted the account");

  const result = await login(email, PASSWORD);
  assert.equal(result.statusCode, 200, `valid credentials must authenticate — got ${result.raw}`);

  const digest = createHash("sha256").update(stringField(result.body, "refreshToken")).digest("hex");
  const sessions = await prisma.session.findMany({ where: { refreshTokenHash: digest } });

  assert.equal(sessions.length, 1, "the secret handed to the phone must name exactly one session");
  const session = sessions[0];
  assert.ok(session !== undefined, "the secret handed to the phone must name exactly one session");
  assert.equal(session.userId, account.id, "the session must belong to the driver who authenticated");
  assert.equal(session.revokedAt, null, "login must not hand back a revoked session");
  assert.ok(session.expiresAt.getTime() > Date.now(), "login must not hand back an expired session");
});

// ═════════════════════════════════════════════════════════════════════════════
// L18-L20. Login creates NO tenant of any kind
// ═════════════════════════════════════════════════════════════════════════════
// D21: no fake Company, no fake CompanyMembership, no fake tenant — ever.
// Counts are scoped to THIS driver rather than global, because the database
// suites run in parallel and a global count is a flake, not a proof.

test("L18. authenticating creates no Company, no CompanyMembership and no Shift for the driver", async () => {
  const email = await registerDriver(freshEmail());
  const account = await prisma.user.findUnique({ where: { email } });
  assert.ok(account !== null, "registration must have persisted the account");
  const userId = account.id;

  const result = await login(email, PASSWORD);
  assert.equal(result.statusCode, 200, `valid credentials must authenticate — got ${result.raw}`);

  assert.equal(
    await prisma.companyMembership.count({ where: { userId } }), 0,
    "login must not invent a membership to make the response shape uniform (D21)",
  );
  assert.equal(
    await prisma.company.count({ where: { memberships: { some: { userId } } } }), 0,
    "login must not invent a personal Company (D21)",
  );
  assert.equal(
    await prisma.shift.count({ where: { userId } }), 0,
    "authenticating is not starting work — login must create no Shift",
  );
});

test("L19. a FAILED login creates nothing and leaves the account untouched", async () => {
  const email = await registerDriver(freshEmail());
  const priorAccount = await prisma.user.findUnique({ where: { email } });
  assert.ok(priorAccount !== null, "registration must have persisted the account");
  const sessionsBefore = await prisma.session.count({ where: { userId: priorAccount.id } });

  const result = await login(email, "not-the-right-password");
  assert.equal(result.statusCode, 401, `a wrong password must be 401 — got ${result.raw}`);

  const laterAccount = await prisma.user.findUnique({ where: { email } });
  assert.ok(laterAccount !== null, "a failed login must not delete the account");
  assert.equal(laterAccount.passwordHash, priorAccount.passwordHash, "a failed login must not rewrite the stored credential");
  assert.equal(
    await prisma.session.count({ where: { userId: priorAccount.id } }), sessionsBefore,
    "a failed login must not create a session",
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// L20. An INACTIVE membership is not authority and is not offered
// ═════════════════════════════════════════════════════════════════════════════
// AUTH.md contract test 5, and D12: active/inactive lives on the membership.
// A driver Company A has deactivated still has an account and still logs in —
// with identity only. This is the case that would silently regress if a
// future implementation counted memberships without filtering on `active`.

test("L20. a driver whose ONLY membership is inactive authenticates with identity alone — no tenant token, and the membership is not offered", async () => {
  const email = await registerDriver(freshEmail());
  const account = await prisma.user.findUnique({ where: { email } });
  assert.ok(account !== null, "registration must have persisted the account");

  const company = await prisma.company.create({
    data: { name: `${TAG}-inactive-co`, joinCode: `${TAG}-join-${String(seq)}` },
  });
  await prisma.companyMembership.create({
    data: { companyId: company.id, userId: account.id, role: "driver", active: false },
  });

  const result = await login(email, PASSWORD);

  assert.equal(result.statusCode, 200, `a deactivated membership does not remove the ACCOUNT — got ${result.raw}`);
  assert.deepEqual(
    memberships(result.body), [],
    "an inactive membership must not be offered in the list (AUTH.md contract test 5)",
  );

  const audiences = jwtsIn(result.body).map(token => token.audience);
  assert.deepEqual(
    audiences.filter(aud => aud === TENANT_AUDIENCE), [],
    `an inactive membership is not a company to auto-select — no tenant token may be minted. Audiences were: ${audiences.join(", ")}`,
  );
  assert.equal(
    claimsOf(stringField(result.body, "identityToken"))["companyId"], undefined,
    "and no companyId may appear on the identity token either",
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// L21-L22. Every successful login creates a NEW Session, and revokes nothing
// ═════════════════════════════════════════════════════════════════════════════
// Owner decision, 2026-09-11. Device-session reuse is not expressible: the
// Session row carries no device identity, and inventing one was refused. The
// consequence that must hold is that a driver signing in on a second phone
// does not sign the first one out.

test("L21. two sequential logins create two DISTINCT Sessions", async () => {
  const email = await registerDriver(freshEmail());
  const account = await prisma.user.findUnique({ where: { email } });
  assert.ok(account !== null, "registration must have persisted the account");

  const first  = await login(email, PASSWORD);
  const second = await login(email, PASSWORD);
  assert.equal(first.statusCode, 200, `the first login must succeed — got ${first.raw}`);
  assert.equal(second.statusCode, 200, `the second login must succeed — got ${second.raw}`);

  const firstSecret  = stringField(first.body, "refreshToken");
  const secondSecret = stringField(second.body, "refreshToken");
  assert.notEqual(firstSecret, secondSecret, "each login mints its own refresh secret");

  const firstSession  = await sessionFor(firstSecret);
  const secondSession = await sessionFor(secondSecret);
  assert.notEqual(firstSession.id, secondSession.id, "each login creates its OWN Session row, not a reused one");
  assert.equal(firstSession.userId, account.id, "both belong to the driver who authenticated");
  assert.equal(secondSession.userId, account.id, "both belong to the driver who authenticated");

  // Registration's session plus two logins. Stated as an exact count so a
  // future implementation that quietly replaced a row would fail here.
  assert.equal(
    await prisma.session.count({ where: { userId: account.id } }), 3,
    "registration's session and both logins' sessions must all exist",
  );
});

test("L22. a second login does NOT revoke or expire the first — a driver's other phone stays signed in", async () => {
  const email = await registerDriver(freshEmail());

  const first = await login(email, PASSWORD);
  assert.equal(first.statusCode, 200, `the first login must succeed — got ${first.raw}`);
  const firstToken = stringField(first.body, "identityToken");

  const second = await login(email, PASSWORD);
  assert.equal(second.statusCode, 200, `the second login must succeed — got ${second.raw}`);

  const firstSession = await sessionFor(stringField(first.body, "refreshToken"));
  assert.equal(firstSession.revokedAt, null, "the earlier session must not be revoked by a later login");
  assert.ok(firstSession.expiresAt.getTime() > Date.now(), "nor expired");

  // The behavioural half: the first device's token still authenticates.
  const me = await request("GET", "/auth/me", { token: firstToken });
  assert.equal(me.statusCode, 200, `the first device's identity token must still work — got ${me.raw}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// L23. An unreadable stored hash answers 401, never 500
// ═════════════════════════════════════════════════════════════════════════════
// Seeded directly, because no production path can create such a row —
// registration always writes a valid cost-12 hash. The row models a corrupted
// or migrated credential. A 500 here would be an oracle: every other account
// answers 401, so the one that answers 500 is identifiable.

test("L23. a stored hash this build cannot read is refused as a credential failure, not as a server error", async () => {
  const unreadable = [
    `$2z$99$${"x".repeat(53)}`,          // throws inside bcryptjs: "Invalid salt revision"
    "not-a-bcrypt-hash-at-all",
    "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$aGFzaA",
  ];

  for (const passwordHash of unreadable) {
    const email = freshEmail("legacy");
    await prisma.user.create({
      data: { email, firstName: "Legacy", lastName: "Driver", passwordHash },
    });

    const result = await login(email, PASSWORD);

    assert.equal(
      result.statusCode, 401,
      `an unreadable stored hash must answer 401, not leak as a 500 — ${JSON.stringify(passwordHash)} produced ${result.raw}`,
    );
    assert.deepEqual(result.body, CANONICAL_401, "and with the identical canonical body every other failure returns");
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// L24. Registration's password POLICY does not govern an existing credential
// ═════════════════════════════════════════════════════════════════════════════
// Owner decision, 2026-09-11. Seeded directly because registration refuses to
// create a credential this short — which is exactly the point: the account
// exists, the policy has since tightened, and the driver must still get in.

test("L24. an account whose password is shorter than Registration's minimum can still log in", async () => {
  const shortPassword = "short1";
  assert.ok(shortPassword.length < 10, "the fixture must be under D23's minimum for this case to mean anything");

  const email = freshEmail("legacy-short");
  await prisma.user.create({
    data: {
      email,
      firstName:    "Legacy",
      lastName:     "Driver",
      passwordHash: await bcryptHash(shortPassword, 12),
    },
  });

  const refused = await request("POST", "/auth/register", {
    payload: { firstName: "Legacy", lastName: "Driver", email: freshEmail("policy"), password: shortPassword },
  });
  assert.equal(refused.statusCode, 400, "registration must still refuse this as a NEW credential (D23)");

  const result = await login(email, shortPassword);
  assert.equal(
    result.statusCode, 200,
    `an existing short credential must authenticate — a policy governs new passwords, not old accounts. Got ${result.raw}`,
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// L25. Unknown email and wrong password both spend the bcrypt work
// ═════════════════════════════════════════════════════════════════════════════
// The response bodies are already proven byte-identical (L13). This is the
// other half of the same property: without a dummy verification the unknown
// path returns in ~0 ms and the identical body hides nothing.
//
// A generous floor, not a constant-time claim — bcrypt is not constant time.
// Cost 12 is 4096 rounds; no plausible CPU finishes that in under 25 ms,
// while the early return this guards against is ~0 ms.

test("L25. an unknown email costs the same order of work as a wrong password", async () => {
  const email = await registerDriver(freshEmail());

  const wrongStarted = Date.now();
  const wrongPassword = await login(email, "not-the-right-password");
  const wrongTook = Date.now() - wrongStarted;

  const unknownStarted = Date.now();
  const unknownEmail = await login(freshEmail("nobody"), PASSWORD);
  const unknownTook = Date.now() - unknownStarted;

  assert.equal(wrongPassword.statusCode, 401, `a wrong password must be 401 — got ${wrongPassword.raw}`);
  assert.equal(unknownEmail.statusCode, 401, `an unknown email must be 401 — got ${unknownEmail.raw}`);

  assert.ok(
    unknownTook >= BCRYPT_WORK_FLOOR_MS,
    `the unknown-email path must perform a real cost-12 verification — took ${String(unknownTook)} ms, under the ${String(BCRYPT_WORK_FLOOR_MS)} ms floor that separates bcrypt from an early return (wrong-password took ${String(wrongTook)} ms)`,
  );
});
