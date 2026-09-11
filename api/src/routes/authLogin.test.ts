/**
 * Login RED — the INPUT CONTRACT of `POST /auth/login`, proven at the HTTP
 * boundary without a database.
 *
 * The same split `auth.test.ts` and `shifts.test.ts` established: this file
 * specifies what the boundary REFUSES before any row is read, and everything
 * that needs a persisted account — a successful authentication, the failure
 * privacy contract, the token's claims, what login must NOT create — lives in
 * `src/tests/db/login.test.ts`, because those are claims about behaviour
 * against real rows rather than about a schema.
 *
 * Consequently there is no "not 400" or "not 401" assertion here. Against a
 * route that does not exist, a negative-only assertion is vacuously green
 * (404 is not 401 either), so every case asserts the EXACT status the
 * contract requires.
 *
 * WRITTEN RED. `POST /auth/login` does not exist, so every case fails on
 * `404 !== 400` — an assertion-level failure naming the missing behaviour.
 * Nothing here imports a module that is not built: the route is reached by
 * URL through `app.inject`, and the stub below is a complete `AppDatabase`,
 * so a RED failure cannot be a missing import or a broken fixture.
 *
 * L1-L6 were written BEFORE the owner resolved the password contract; L7-L11
 * were added with that decision (2026-09-11). It is: login does NOT enforce
 * D23's 10-character minimum — a policy governs a NEW credential, while
 * authentication checks the one the driver has — but it DOES keep the
 * 72-UTF-8-byte cap, which is bcrypt's arithmetic rather than policy.
 *
 * Session creation and the success body are proven against real rows in
 * `src/tests/db/login.test.ts`, not here.
 *
 * Frozen by AUTH.md ("Login flow", "Route postures"), DECISIONS D13, D17,
 * D21 and D22.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { MembershipRole } from "../generated/enums.js";

// env.ts validates process.env at import time and exits on failure, so these
// must be set BEFORE app.js is loaded — the pattern app.test.ts established.
process.env.DATABASE_URL = "postgresql://app:app@localhost:5544/lb_timesheet_unused";
process.env.JWT_SECRET   = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV     = "test";
process.env.WEB_ORIGIN   = "https://allowed.example.com";

const { buildApp } = await import("../app.js");

const USER_ID       = "user_cmth00000000000000000001";
const COMPANY_ID    = "comp_cmth00000000000000000001";
const MEMBERSHIP_ID = "memb_cmth00000000000000000001";
const SESSION_ID    = "sess_cmth00000000000000000001";

const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };

// ─────────────────────────────────────────────────────────────────────────────
// The database stub
// ─────────────────────────────────────────────────────────────────────────────
// Every READ answers "nothing here" and every WRITE rejects. No case in this
// file may reach persistence: a call landing in one of these is itself the
// failure, rather than a setup gap that quietly made a case pass.

interface StubUserRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

interface StubSessionRow {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  /** Read by the refresh boundary; no case in this file refreshes. */
  previousRefreshTokenGraceUntil: Date | null;
}

interface StubMembershipRow {
  id: string;
  userId: string;
  companyId: string;
  role: MembershipRole;
  active: boolean;
}

interface StubDatabase {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  session: {
    findUnique(args: {
      where: { id?: string; refreshTokenHash?: string; previousRefreshTokenHash?: string };
    }): Promise<StubSessionRow | null>;
    updateMany(): Promise<{ count: number }>;
    create(): Promise<never>;
  };
  companyMembership: {
    findUnique(args: { where: { id: string } }): Promise<StubMembershipRow | null>;
    findMany(): Promise<never[]>;
    findFirst(): Promise<null>;
  };
  user: {
    findUnique(args: { where: { id?: string; email?: string } }): Promise<StubUserRow | null>;
    findFirst(args: { where: { email: string } }): Promise<null>;
    create(): Promise<never>;
  };
  shift: {
    // The cross-company open-shift guard's count. Zero: no case here has one.
    count(): Promise<number>;
    create(): Promise<never>;
    findFirst(): Promise<null>;
  };
  company: { findUnique(): Promise<{ timezone: string } | null> };
  $transaction(): Promise<never>;
}

function noRows(): StubDatabase {
  const write = (what: string) => () =>
    Promise.reject(new Error(`no case in routes/authLogin.test.ts may reach ${what} persistence`));

  return {
    $queryRaw: () => Promise.resolve([{ ok: 1 }]),
    session: {
      // A login that got this far would be reading a session by id, which
      // login never does — it is answered "absent" rather than made to throw,
      // so a failure is attributed to the assertion and not to the stub.
      findUnique: () => Promise.resolve(null),
      updateMany: () => Promise.resolve({ count: 0 }),
      create:     write("session"),
    },
    companyMembership: {
      findUnique: () => Promise.resolve(null),
      findMany:   () => Promise.resolve([]),
      findFirst:  () => Promise.resolve(null),
    },
    user: {
      // Deliberately "no such account" for every lookup: every case in this
      // file is refused by the DTO, so the account read must never decide one.
      findUnique: () => Promise.resolve(null),
      findFirst:  () => Promise.resolve(null),
      create:     write("user"),
    },
    shift: {
      count:     () => Promise.resolve(0),
      create:    write("shift"),
      findFirst: () => Promise.resolve(null),
    },
    company:      { findUnique: () => Promise.resolve({ timezone: "Europe/London" }) },
    $transaction: write("transactional"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Injection
// ─────────────────────────────────────────────────────────────────────────────

interface Injected {
  statusCode: number;
  body: unknown;
}

async function login(payload: unknown, headers: Record<string, string> = {}): Promise<Injected> {
  const app = await buildApp(noRows());
  try {
    const res = await app.inject({
      method:  "POST",
      url:     "/auth/login",
      payload: payload as object,
      headers,
    });
    return { statusCode: res.statusCode, body: res.body === "" ? null : (JSON.parse(res.body) as unknown) };
  } finally {
    await app.close();
  }
}

/** The two fields login accepts, and nothing else (AUTH.md, "Login flow"). */
function credentials(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email:    "driver@example.com",
    password: "correct-horse-battery",
    ...overrides,
  };
}

/** The one envelope a rejected DTO produces — `invalidRequest`'s shape. */
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
// L1. The login route is PUBLIC
// ═════════════════════════════════════════════════════════════════════════════
// A driver logging in has no token by definition, so the default-deny hook
// must not be what answers. Proven with a malformed body, which needs no
// persistence and therefore permits an EXACT status assertion rather than the
// vacuous "not 401".

test("L1. POST /auth/login is public: with no Authorization header the request reaches validation, not the auth boundary", async () => {
  const result = await login({});

  assertValidationFailure(result, "an unauthenticated malformed login must be answered 400 by the route, not 401 by the default-deny hook");
  assert.notDeepEqual(result.body, CANONICAL_401, "a public route must not produce the authentication envelope");
});

test("L1b. a stale or forged Authorization header does not change how login is answered", async () => {
  // A phone whose 15-minute identity token has expired still has it in
  // memory and may attach it. Login is public, so the header is irrelevant —
  // it must not be verified, and it must not turn a malformed body into 401.
  const result = await login({}, { authorization: "Bearer not-a-real-token" });

  assertValidationFailure(result, "a public route must answer on the body's merits regardless of a presented token");
});

// ═════════════════════════════════════════════════════════════════════════════
// L2-L4. The DTO is EXACTLY two fields
// ═════════════════════════════════════════════════════════════════════════════

test("L2. both fields are required", async () => {
  for (const field of ["email", "password"]) {
    const body = credentials();
    delete body[field];
    assertValidationFailure(await login(body), `a login missing ${field} must be refused`);
  }
});

test("L3. an authority field in the body is REFUSED, never ignored", async () => {
  // Each of these is a client attempting to name identity or authority the
  // server owns. AUTH.md: a companyId arriving in a request body is never
  // authority — and silently dropping it makes the attempt invisible, where a
  // 400 makes it an error the client and the log both see.
  const smuggled: Record<string, unknown> = {
    companyId:     COMPANY_ID,
    membershipId:  MEMBERSHIP_ID,
    userId:        USER_ID,
    id:            USER_ID,
    sessionId:     SESSION_ID,
    role:          "admin",
    passwordHash:  "$2a$12$forged",
    identityToken: "forged.identity.token",
    refreshToken:  "forged-refresh-secret",
    memberships:   [{ companyId: COMPANY_ID }],
  };

  for (const [field, value] of Object.entries(smuggled)) {
    const result = await login(credentials({ [field]: value }));
    assertValidationFailure(result, `a login carrying ${field} must be refused, not accepted with the field ignored`);
  }
});

test("L4. an unrecognised field is refused even when it is harmless", async () => {
  // Not about this field. A DTO that tolerates one unknown key tolerates all
  // of them, which is how the fields in L3 get through a later refactor.
  assertValidationFailure(
    await login(credentials({ rememberMe: true })),
    "an unknown field must be refused — strictness is the mechanism L3 depends on",
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// L5. The email field is bounded and must be an address
// ═════════════════════════════════════════════════════════════════════════════
// CLAUDE.md caps emails at 320. Unbounded input on a PUBLIC route is a denial
// of service, and this route is public by contract (L1) and sits behind only
// the flat IP limit F-15 describes.

test("L5. the email is bounded at 320 and must be an email address", async () => {
  assertValidationFailure(
    await login(credentials({ email: `${"a".repeat(320)}@example.com` })),
    "an over-long email must be refused before any account lookup",
  );
  assertValidationFailure(
    await login(credentials({ email: "not-an-email" })),
    "a value that cannot be an address must be refused by shape",
  );
  assertValidationFailure(
    await login(credentials({ email: "   " })),
    "whitespace is not an email address",
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// L6. Types are not coerced into credentials
// ═════════════════════════════════════════════════════════════════════════════

test("L6. a non-string email or password is refused rather than coerced", async () => {
  for (const value of [42, true, null, { toString: "driver@example.com" }, ["driver@example.com"]]) {
    assertValidationFailure(
      await login(credentials({ email: value })),
      `an email of type ${typeof value} must be refused, never coerced into one`,
    );
    assertValidationFailure(
      await login(credentials({ password: value })),
      `a password of type ${typeof value} must be refused, never coerced into one`,
    );
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// L7-L10. The password field is a CREDENTIAL, not a new password
// ═════════════════════════════════════════════════════════════════════════════
// Owner decision, 2026-09-11: login does NOT enforce D23's 10-character
// minimum. A policy governs a NEW credential; authentication checks the one
// the driver actually has. Enforcing it here would lock every existing
// account out the day the minimum changed.
//
// What DOES survive is the part that is arithmetic rather than policy: bcrypt
// reads at most 72 BYTES, so a longer input cannot be anyone's stored
// credential and is refused as a malformed request.
//
// The stub has no accounts, so anything the DTO ACCEPTS reaches credential
// verification and is answered with the canonical 401. That contrast — 400
// for a refused request, 401 for a refused credential — is what these cases
// actually distinguish.

/** The canonical 401 these cases expect once the DTO has accepted the input. */
function assertCredentialFailure(result: Injected, why: string): void {
  assert.equal(result.statusCode, 401, why);
  assert.deepEqual(result.body, CANONICAL_401, "credential failure is the project's one authentication envelope (D17)");
}

test("L7. a password shorter than Registration's minimum reaches credential verification, not policy validation", async () => {
  // Six characters. D23 would refuse this as a NEW password; login must not,
  // because an account created under an older policy still has to get in.
  const result = await login(credentials({ password: "short1" }));

  assertCredentialFailure(result, "a short password must be answered 401 by credential verification, never 400 by a policy check");
});

test("L8. an empty password is a malformed request, not a credential", async () => {
  // Nothing to verify. Refused before any bcrypt work rather than being
  // hashed as if it were a real attempt.
  assertValidationFailure(await login(credentials({ password: "" })), "an empty password is not a credential");
});

test("L9. a password longer than 72 UTF-8 bytes is refused as a request, not silently truncated by bcrypt", async () => {
  assertValidationFailure(
    await login(credentials({ password: "a".repeat(73) })),
    "bcrypt reads 72 bytes; a longer value cannot be anyone's stored credential",
  );
});

test("L10. the 72-byte cap is measured in UTF-8 BYTES, not JavaScript characters", async () => {
  // "é" is ONE character and TWO bytes. 36 of them are 36 characters and
  // exactly 72 bytes — the boundary, and it must be ACCEPTED, which is proven
  // by it reaching credential verification rather than validation.
  const atBoundary = "é".repeat(36);
  assert.equal(atBoundary.length, 36, "36 characters");
  assert.equal(Buffer.byteLength(atBoundary, "utf8"), 72, "and exactly 72 UTF-8 bytes");

  assertCredentialFailure(
    await login(credentials({ password: atBoundary })),
    "exactly 72 bytes is within the cap and must reach verification",
  );

  // One byte over. A character `.max()` alone would accept this — 37
  // characters is well under 72 — which is why the byte check is the
  // load-bearing one.
  const overBoundary = "é".repeat(37);
  assert.equal(overBoundary.length, 37, "37 characters, comfortably under a character cap of 72");
  assert.equal(Buffer.byteLength(overBoundary, "utf8"), 74, "but 74 UTF-8 bytes");

  assertValidationFailure(
    await login(credentials({ password: overBoundary })),
    "74 bytes is over the cap even though 37 characters is not",
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// L11. An unknown account is answered by the credential boundary
// ═════════════════════════════════════════════════════════════════════════════

test("L11. a well-formed login for an account that does not exist is the canonical 401, and discloses nothing", async () => {
  const result = await login(credentials());

  assertCredentialFailure(result, "an unknown account must be refused as a credential failure");
  // No hint that the ACCOUNT was the missing half, and nothing bcrypt-shaped.
  assert.ok(!JSON.stringify(result.body).includes("email"), "the failure must not mention the email");
  assert.ok(!/\$2[aby]\$/.test(JSON.stringify(result.body)), "nothing bcrypt-shaped belongs in a failure body");
});
