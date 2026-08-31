/**
 * P1.2b — the AUTHORIZED TENANT CONTEXT boundary (F-14).
 *
 * AUTH.md freezes two separate questions:
 *
 *   "is there a valid identity?"   → requireAuth        (auth.ts, P1.2a)
 *   "may this identity do this?"   → authorizeTenant    (authorization.ts)
 *
 * Until F-14 was closed only the first had an answer: `AuthContext` existed and
 * `TenantContext` existed, but nothing bridged them — `TenantContext.trust()`
 * had no production caller and `membershipStatus` was produced on every request
 * and read by nobody. A protected business route written then would have had to
 * build its own tenant authority, which is exactly the mistake AUTH.md's
 * "Deactivated membership — limited authority" section exists to prevent.
 *
 * WRITTEN RED, then made green by `./authorization.js` — these assertions are
 * unchanged from the reviewed RED apart from the authorization-failure test,
 * which was tightened once the owner froze the generic 403 contract.
 *
 * The import stays dynamic, and per test, as it was written: each behaviour
 * fails under its own name rather than the whole file failing to load, so a
 * regression reports WHICH invariant broke instead of merely that a module
 * did not resolve.
 *
 * Scope is the P1.2b invariant only:
 *   a protected business operation can obtain a TenantContext only from
 *   authenticated request.auth; inactive memberships are denied by default;
 *   any permitted inactive-member operation requires an explicit narrow path.
 *
 * Deliberately NOT here: the inactive-member exceptions themselves (finalise /
 * discard an already-open shift), any business route, any permissions
 * framework, and everything P1.2a, F-10 and F-11 already prove.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { TenantContext } from "./tenantContext.js";
import { AppError } from "./errors.js";
import type { MembershipRole } from "../generated/enums.js";

// env.ts validates process.env at import time and exits on failure, so these
// must be set BEFORE app.js is loaded — the same dynamic-import pattern
// auth.test.ts and app.test.ts use. The static imports above touch no env.
process.env.DATABASE_URL = "postgresql://app:app@localhost:5544/lb_timesheet_unused";
process.env.JWT_SECRET   = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV     = "test";
process.env.WEB_ORIGIN   = "https://allowed.example.com";

const { buildApp } = await import("../app.js");

const SECRET = process.env.JWT_SECRET;

const USER_ID       = "user_cmth00000000000000000001";
const COMPANY_ID    = "comp_cmth00000000000000000001";
const OTHER_COMPANY = "comp_cmth00000000000000000002";
const MEMBERSHIP_ID = "memb_cmth00000000000000000001";
const OTHER_MEMBER  = "memb_cmth00000000000000000002";
const SESSION_ID    = "sess_cmth00000000000000000001";

/**
 * The production boundary, resolved at call time.
 *
 * `src/lib/authorization.ts` was chosen because the `tenant-context-trust-sites`
 * rule already exempts `lib/auth*` — so the sanctioned bridge calls
 * `TenantContext.trust()` without any change to the static rules (engine.ts,
 * "TenantContext.trust is a liability").
 */
async function authorization(): Promise<typeof import("./authorization.js")> {
  return import("./authorization.js");
}

/**
 * P1.2a's trusted output, taken from the Fastify augmentation in auth.ts
 * rather than restated here. Reading the real type is the point: a RED that
 * invented its own six-field shape would keep passing if AuthContext changed
 * underneath it.
 */
type AuthenticatedContext = NonNullable<FastifyRequest["auth"]>;

/**
 * A complete, already-authenticated identity. Every field here has been
 * validated against persistence by requireAuth — which is why the P1.2b
 * boundary needs no database read of its own, and must not perform one.
 */
function authenticatedAs(
  membershipStatus: "active" | "inactive",
  role: MembershipRole = "driver",
): AuthenticatedContext {
  return {
    userId:       USER_ID,
    companyId:    COMPANY_ID,
    membershipId: MEMBERSHIP_ID,
    sessionId:    SESSION_ID,
    role,
    membershipStatus,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. An active identity becomes tenant authority — completely
// ─────────────────────────────────────────────────────────────────────────────
test("1. an active authenticated context is authorized, and the tenant authority carries exactly the authenticated company, user and membership", async () => {
  const { authorizeTenant } = await authorization();

  const ctx = authorizeTenant(authenticatedAs("active"));

  assert.ok(
    ctx instanceof TenantContext,
    "the bridge must produce the NOMINAL TenantContext repositories accept — a structurally identical object literal is exactly what tenantContext.ts's private brand exists to reject",
  );
  assert.equal(ctx.companyId, COMPANY_ID, "cross-company isolation hangs off companyId");
  assert.equal(ctx.userId, USER_ID);
  assert.equal(
    ctx.membershipId, MEMBERSHIP_ID,
    "membershipId is what separates two drivers INSIDE one company (D15): shiftRepository.findById/update/delete all filter on it, so a bridge that produced only { userId, companyId } would silently widen every one of those reads to the whole company",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Deny by default — with a positive control, so the assertion is not vacuous
// ─────────────────────────────────────────────────────────────────────────────
test("2. an inactive authenticated context is refused ordinary tenant authority, while the identical active context is authorized", async () => {
  const { authorizeTenant } = await authorization();

  // Asserted FIRST: a bridge that refused everything would make the denial
  // below trivially green and prove nothing.
  assert.ok(
    authorizeTenant(authenticatedAs("active")) instanceof TenantContext,
    "positive control: an active membership must obtain ordinary tenant authority",
  );

  assert.throws(
    () => authorizeTenant(authenticatedAs("inactive")),
    AppError,
    'AUTH.md freezes "Default is deny: every route requires an active membership unless it explicitly opts in" — ordinary tenant authority must not be issued to an inactive membership',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Authorization failure must not masquerade as authentication failure
// ─────────────────────────────────────────────────────────────────────────────
// P1.2a deliberately AUTHENTICATES an inactive membership (auth.test.ts case
// 6). If this boundary answered 401 it would collapse the two concepts and
// contradict that frozen contract — the identity is valid; the permission is
// not.
test("3. the refusal of an inactive membership is an authorization failure, not an authentication failure", async () => {
  const { authorizeTenant } = await authorization();

  let thrown: unknown;
  try {
    authorizeTenant(authenticatedAs("inactive"));
  } catch (error) {
    thrown = error;
  }

  assert.ok(
    thrown instanceof AppError,
    "the denial must travel through the one error envelope; anything else is masked to a 500 by the global handler and tells the client nothing true",
  );
  // The owner-frozen generic authorization contract.
  assert.equal(thrown.statusCode, 403, "the identity is valid; the permission is not");
  assert.equal(thrown.code,       "FORBIDDEN");
  assert.equal(thrown.message,    "Not allowed");

  assert.notEqual(
    thrown.message, "Not authenticated",
    "the canonical authentication message must not be reused for an authorization denial",
  );

  // Generic ON PURPOSE. The public response must not disclose that the reason
  // was specifically a deactivated membership: a denial that explains itself
  // is an oracle for account state, which is exactly what the 401 path avoids
  // by answering every authentication failure identically.
  assert.equal(thrown.details, undefined, "no details channel to leak account state through");
  const disclosed = `${thrown.code ?? ""} ${thrown.message}`.toLowerCase();
  for (const leak of ["member", "inactive", "active", "deactivat", "driver", "admin", "company"]) {
    assert.ok(
      !disclosed.includes(leak),
      `the public 403 must not disclose why authorization failed — it contains "${leak}"`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The denial is keyed on membershipStatus alone — nothing else buys a pass
// ─────────────────────────────────────────────────────────────────────────────
// AUTH.md's two permitted inactive operations (read, and update/submit, an
// ALREADY-OPEN shift) are real and will be built. This test fixes the shape of
// that future: they cannot arrive by softening the ordinary path, because the
// ordinary path's denial does not depend on any attribute a caller can vary.
test("4. inactive is denied on the ordinary path whatever the role, and the ordinary path takes no second argument through which a bypass could be requested", async () => {
  const { authorizeTenant } = await authorization();

  assert.ok(
    authorizeTenant(authenticatedAs("active", "admin")) instanceof TenantContext,
    "positive control: an active admin must obtain ordinary tenant authority",
  );

  assert.throws(
    () => authorizeTenant(authenticatedAs("inactive", "admin")),
    AppError,
    "an inactive ADMIN is still inactive — role must never be a bypass, or every deactivated owner keeps full authority",
  );
  assert.throws(
    () => authorizeTenant(authenticatedAs("inactive", "driver")),
    AppError,
    "and the driver case is the one that actually happens: a deactivated driver must not start new work",
  );

  // The ordinary path is unary: there is no required options/capability
  // parameter through which "allow inactive" could be passed, so a future
  // exception has to be a SEPARATE, separately-named export that a reviewer
  // can grep for. Honest limit: a DEFAULTED second parameter would not change
  // Function.length, so this pins the required arity only — that any inactive
  // exception is a distinct export, and not a flag, is a GREEN design
  // constraint for owner review, not something a test can assert before the
  // exception exists.
  assert.equal(
    authorizeTenant.length, 1,
    "ordinary authorization takes the authenticated context and nothing else",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The authority source is request.auth — proven through the real pipeline
// ─────────────────────────────────────────────────────────────────────────────
// The only test here that needs Fastify composition, because "where does the
// authority come from" is a property of the assembled request path, not of a
// function called in isolation. This is AUTH.md contract test 16 applied to
// the P1.2b bridge.

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

interface IdentityReads {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  session: { findUnique(args: { where: { id: string } }): Promise<SessionRow | null> };
  companyMembership: { findUnique(args: { where: { id: string } }): Promise<MembershipRow | null> };
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

/** The frozen access token (AUTH.md), minted independently of any production minter. */
function accessToken(): string {
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

function activeIdentity(): IdentityReads {
  const session: SessionRow = {
    id: SESSION_ID, userId: USER_ID,
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), revokedAt: null,
  };
  const membership: MembershipRow = {
    id: MEMBERSHIP_ID, userId: USER_ID, companyId: COMPANY_ID, role: "driver", active: true,
  };
  return {
    $queryRaw: () => Promise.resolve([{ ok: 1 }]),
    session:           { findUnique: ({ where }) => Promise.resolve(session.id === where.id ? session : null) },
    companyMembership: { findUnique: ({ where }) => Promise.resolve(membership.id === where.id ? membership : null) },
  };
}

test("5. the authorized tenant authority is scoped to the authenticated identity even when the request body supplies a different company, membership and user", async () => {
  const { authorizeTenant } = await authorization();

  const app = await buildApp(activeIdentity());
  // Registered with NO config, exactly as a real feature route would be, so it
  // inherits F-10's default-deny rather than being waved through by hand.
  app.post("/test-only/authorized", (request) => {
    const auth = request.auth;
    if (auth === undefined) throw new AppError(500, "probe reached without an AuthContext");
    const ctx = authorizeTenant(auth);
    return { companyId: ctx.companyId, userId: ctx.userId, membershipId: ctx.membershipId };
  });

  let body: unknown;
  let statusCode: number;
  try {
    const res = await app.inject({
      method:  "POST",
      url:     "/test-only/authorized",
      headers: { authorization: `Bearer ${accessToken()}` },
      // Hostile tenant identity, in the one place a client controls. The
      // probe never reads it; the point is that the bridge offers it no
      // channel at all (AUTH.md: "A companyId, membershipId or userId
      // arriving in a request body, query or path is never authority").
      payload: { companyId: OTHER_COMPANY, membershipId: OTHER_MEMBER, userId: "user_cmth00000000000000000002" },
    });
    statusCode = res.statusCode;
    body = res.json();
  } finally {
    await app.close();
  }

  assert.equal(statusCode, 200, "an active membership with a valid token must reach the route and be authorized");
  assert.deepEqual(body, {
    companyId:    COMPANY_ID,
    userId:       USER_ID,
    membershipId: MEMBERSHIP_ID,
  }, "tenant authority must come from the persisted, authenticated identity in request.auth — never from anything the caller sent");
});
