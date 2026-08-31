/**
 * P1.2a RED — the protected-request pipeline (AUTH.md, "Every protected
 * request"). Injection-level: the two identity reads are supplied as fixtures,
 * so these tests specify PIPELINE BEHAVIOUR and not a persistence detail the
 * DB suite already proves.
 *
 * WRITTEN RED, DELIBERATELY. At the time of writing `requireAuth` is a stub
 * that throws 401 for every protected request without reading anything, and
 * `request.auth` does not exist. So:
 *
 *   - the positive cases fail, because nothing can authenticate;
 *   - the negative cases are paired with a POSITIVE CONTROL in the same test,
 *     because a stub that denies everything makes a negative-only assertion
 *     vacuously green. The control is asserted FIRST, so the RED failure
 *     names the missing behaviour rather than the guarded one.
 *
 * Scope is exactly the six behaviours authorised for P1.2a. The wider negative
 * matrix (issuer, audience, alg:none, JWT exp, malformed claims, missing
 * session, session/user mismatch, missing membership, membership/user
 * mismatch, exact-now timing, inactive-membership 403 rules) is required
 * hardening, deferred to its own batch — not rejected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { MembershipRole } from "../generated/enums.js";

// env.ts validates process.env at import time and exits on failure, so these
// must be set BEFORE app.js is loaded. Hence the dynamic import below — the
// same pattern app.test.ts uses.
process.env.DATABASE_URL = "postgresql://app:app@localhost:5544/lb_timesheet_unused";
process.env.JWT_SECRET   = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV     = "test";
process.env.WEB_ORIGIN   = "https://allowed.example.com";

const { buildApp } = await import("../app.js");

const SECRET       = process.env.JWT_SECRET;
/** A different, equally valid-looking secret — for the forged-signature case. */
const OTHER_SECRET = "9c2e7a41b8d05f36e1a94c7b2d8f60e35a1c9b4d7e2f80a6";

const USER_ID       = "user_cmth00000000000000000001";
const COMPANY_ID    = "comp_cmth00000000000000000001";
const OTHER_COMPANY = "comp_cmth00000000000000000002";
const MEMBERSHIP_ID = "memb_cmth00000000000000000001";
const SESSION_ID    = "sess_cmth00000000000000000001";

/** The one body every authentication failure must produce. No variants. */
const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };

const MINUTE = 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Token minting
// ─────────────────────────────────────────────────────────────────────────────
// The tests construct tokens independently so RED specifies the frozen token
// contract without depending on a production authentication implementation.

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function signToken(claims: Record<string, string | number>, secret: string): string {
  const header    = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload   = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * AUTH.md's access token. Note what is NOT here: `role`. A role baked into a
 * token is authority that outlives its revocation, so the pipeline must load
 * it from the membership row — which is what case 1 and case 6 prove.
 */
function claimsFor(overrides: Record<string, string | number> = {}): Record<string, string | number> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    sub:          USER_ID,
    companyId:    COMPANY_ID,
    membershipId: MEMBERSHIP_ID,
    sessionId:    SESSION_ID,
    iat:          nowSeconds,
    exp:          nowSeconds + 15 * 60,
    iss:          "logisticbay-timesheets",
    aud:          "timesheets-api",
    ...overrides,
  };
}

/**
 * The frozen token with an explicit issue time and declared lifetime. `iat`
 * and `exp` are set together so a case states the token's TTL directly rather
 * than leaving it implied by claimsFor()'s default.
 */
function claimsWithLifetime(issuedSecondsAgo: number, lifetimeSeconds: number): Record<string, string | number> {
  const iat = Math.floor(Date.now() / 1000) - issuedSecondsAgo;
  return { ...claimsFor(), iat, exp: iat + lifetimeSeconds };
}

/**
 * The frozen token minus one or more registered claims.
 *
 * Absence is a DIFFERENT attack from a wrong value: a claim-value validator
 * skips a claim that is not present, so a token with no `exp` is not an
 * expired token — it is a token that never expires, and one with no `iss` is
 * not a foreign token but an unattributed one.
 */
function claimsWithout(...omitted: string[]): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(claimsFor()).filter(([key]) => !omitted.includes(key)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity fixtures
// ─────────────────────────────────────────────────────────────────────────────
// Only the columns the pipeline actually reads. Deliberately not the full
// Prisma row: naming more would freeze a production shape during RED.

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

/** Matches on id, so "the wrong id finds nothing" stays expressible later. */
function reads(session: SessionRow | null, membership: MembershipRow | null): IdentityReads {
  return {
    $queryRaw: () => Promise.resolve([{ ok: 1 }]),
    session: {
      findUnique: ({ where }) =>
        Promise.resolve(session !== null && session.id === where.id ? session : null),
    },
    companyMembership: {
      findUnique: ({ where }) =>
        Promise.resolve(membership !== null && membership.id === where.id ? membership : null),
    },
  };
}

function liveSession(): SessionRow {
  return { id: SESSION_ID, userId: USER_ID, expiresAt: new Date(Date.now() + 90 * 24 * 60 * MINUTE), revokedAt: null };
}

/**
 * role: "admin" on purpose. The default is driver and the token carries no
 * role at all, so observing "admin" can only mean the pipeline read this row.
 */
function activeMembership(companyId = COMPANY_ID): MembershipRow {
  return { id: MEMBERSHIP_ID, userId: USER_ID, companyId, role: "admin", active: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Probe route
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `.strict()` is what proves "exactly": an implementation that leaks an extra
 * field into AuthContext fails here rather than passing quietly.
 */
const AuthSnapshot = z.object({
  auth: z.object({
    userId:           z.string().max(64),
    companyId:        z.string().max(64),
    membershipId:     z.string().max(64),
    sessionId:        z.string().max(64),
    role:             z.enum(["driver", "admin"]),
    membershipStatus: z.enum(["active", "inactive"]),
  }).strict(),
});

/**
 * Registered with NO config, exactly the way a real feature route would be —
 * so it inherits F-10's default-deny with nothing done by hand. Never marked
 * public: making a probe public to obtain a green would prove nothing.
 */
async function get(identity: IdentityReads, token: string) {
  const app = await buildApp(identity);
  app.get("/test-only/protected", (request) => ({ auth: request.auth }));
  try {
    return await app.inject({
      method:  "GET",
      url:     "/test-only/protected",
      headers: { authorization: `Bearer ${token}` },
    });
  } finally {
    await app.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. A complete, valid identity authenticates
// ─────────────────────────────────────────────────────────────────────────────
test("1. a valid token, live session and matching membership authenticate, and the route observes exactly the AuthContext", async () => {
  const res = await get(reads(liveSession(), activeMembership()), signToken(claimsFor(), SECRET));

  assert.equal(res.statusCode, 200, "a complete valid identity must reach the route");
  const { auth } = AuthSnapshot.parse(res.json());
  assert.deepEqual(auth, {
    userId:           USER_ID,
    companyId:        COMPANY_ID,
    membershipId:     MEMBERSHIP_ID,
    sessionId:        SESSION_ID,
    role:             "admin",           // from the membership row, not the token
    membershipStatus: "active",          // derived from CompanyMembership.active
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A forged signature is not identity
// ─────────────────────────────────────────────────────────────────────────────
test("2. a token signed with a different secret is refused, while the same claims correctly signed succeed", async () => {
  const identity = reads(liveSession(), activeMembership());
  const claims   = claimsFor();

  const control = await get(identity, signToken(claims, SECRET));
  assert.equal(control.statusCode, 200, "positive control: the correctly signed token must authenticate");

  const forged = await get(identity, signToken(claims, OTHER_SECRET));
  assert.equal(forged.statusCode, 401, "a forged signature must never authenticate");
  assert.deepEqual(forged.json(), CANONICAL_401, "and must return the canonical envelope, not a 500 or a variant message");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Revocation ends access immediately, not at token expiry
// ─────────────────────────────────────────────────────────────────────────────
test("3. a revoked session is refused, while the identical token on a live session succeeds", async () => {
  const token = signToken(claimsFor(), SECRET);

  const control = await get(reads(liveSession(), activeMembership()), token);
  assert.equal(control.statusCode, 200, "positive control: the live session must authenticate");

  const revoked = { ...liveSession(), revokedAt: new Date(Date.now() - MINUTE) };
  const res = await get(reads(revoked, activeMembership()), token);
  assert.equal(res.statusCode, 401, "revoking a session must end access at once, not after the access token expires");
  assert.deepEqual(res.json(), CANONICAL_401);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The absolute session lifetime is real
// ─────────────────────────────────────────────────────────────────────────────
test("4. an expired session is refused, while the identical token on a live session succeeds", async () => {
  const token = signToken(claimsFor(), SECRET);

  const control = await get(reads(liveSession(), activeMembership()), token);
  assert.equal(control.statusCode, 200, "positive control: the live session must authenticate");

  const expired = { ...liveSession(), expiresAt: new Date(Date.now() - MINUTE) };
  const res = await get(reads(expired, activeMembership()), token);
  assert.equal(res.statusCode, 401, "a session past its absolute expiry must not authenticate a still-valid access token");
  assert.deepEqual(res.json(), CANONICAL_401);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The token's companyId is a claim to VALIDATE, never authority
// ─────────────────────────────────────────────────────────────────────────────
test("5. a token whose companyId disagrees with the loaded membership is refused, while the matching one succeeds", async () => {
  const token = signToken(claimsFor(), SECRET);

  const control = await get(reads(liveSession(), activeMembership(COMPANY_ID)), token);
  assert.equal(control.statusCode, 200, "positive control: token companyId agreeing with the membership must authenticate");

  const res = await get(reads(liveSession(), activeMembership(OTHER_COMPANY)), token);
  assert.equal(res.statusCode, 401, "a token must never be honoured for a company its membership does not belong to");
  assert.deepEqual(res.json(), CANONICAL_401);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Deactivation limits authority; it does not erase identity
// ─────────────────────────────────────────────────────────────────────────────
test("6. an inactive membership still authenticates and is represented explicitly as inactive", async () => {
  const inactive: MembershipRow = { ...activeMembership(), active: false };

  const res = await get(reads(liveSession(), inactive), signToken(claimsFor(), SECRET));

  assert.equal(res.statusCode, 200, "a deactivated driver must still be able to reach a route — the day's work is not erased");
  const { auth } = AuthSnapshot.parse(res.json());
  assert.equal(auth.membershipStatus, "inactive", "and must be represented explicitly as inactive, not silently active");
  assert.equal(auth.role, "admin", "with the role still loaded fresh from the membership record");
  assert.equal(auth.companyId, COMPANY_ID);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7-10. A registered claim that is ABSENT must not pass
// ─────────────────────────────────────────────────────────────────────────────
// AUTH.md freezes eight claims. `allowedIss`/`allowedAud` validate a claim's
// VALUE and skip it when it is missing, and expiry is only checked when `exp`
// exists — so presence has to be required explicitly. Each case below is a
// token that is otherwise complete and correctly signed.

test("7. a token with no `exp` is refused, while the complete token succeeds", async () => {
  const identity = reads(liveSession(), activeMembership());

  const control = await get(identity, signToken(claimsFor(), SECRET));
  assert.equal(control.statusCode, 200, "positive control: the complete token must authenticate");

  const res = await get(identity, signToken(claimsWithout("exp"), SECRET));
  assert.equal(res.statusCode, 401, "a token with no expiry claim never expires — it must not be accepted");
  assert.deepEqual(res.json(), CANONICAL_401);
});

test("8. a token with no `iss` is refused, while the complete token succeeds", async () => {
  const identity = reads(liveSession(), activeMembership());

  const control = await get(identity, signToken(claimsFor(), SECRET));
  assert.equal(control.statusCode, 200, "positive control: the complete token must authenticate");

  const res = await get(identity, signToken(claimsWithout("iss"), SECRET));
  assert.equal(res.statusCode, 401, "an unattributed token must not pass the issuer check by omitting it (D1)");
  assert.deepEqual(res.json(), CANONICAL_401);
});

test("9. a token with no `aud` is refused, while the complete token succeeds", async () => {
  const identity = reads(liveSession(), activeMembership());

  const control = await get(identity, signToken(claimsFor(), SECRET));
  assert.equal(control.statusCode, 200, "positive control: the complete token must authenticate");

  const res = await get(identity, signToken(claimsWithout("aud"), SECRET));
  assert.equal(res.statusCode, 401, "a token for no audience must not pass the audience check by omitting it (D1)");
  assert.deepEqual(res.json(), CANONICAL_401);
});

test("10. a token missing every registered claim is refused, while the complete token succeeds", async () => {
  const identity = reads(liveSession(), activeMembership());

  const control = await get(identity, signToken(claimsFor(), SECRET));
  assert.equal(control.statusCode, 200, "positive control: the complete token must authenticate");

  // The identity claims alone, correctly signed: no iat, exp, iss or aud.
  const res = await get(identity, signToken(claimsWithout("iat", "exp", "iss", "aud"), SECRET));
  assert.equal(res.statusCode, 401, "dropping the registered claims must not be a way past them");
  assert.deepEqual(res.json(), CANONICAL_401);
});

// ─────────────────────────────────────────────────────────────────────────────
// 11-16. The frozen 15-minute access-token TTL
// ─────────────────────────────────────────────────────────────────────────────
// AUTH.md freezes the access token at "TTL 15 minutes" — a property of the
// token's own claims (exp - iat), not of when it happens to be inspected. The
// invariant is 0 < exp - iat <= 900. Every token below is otherwise complete
// and correctly signed, on a live session with a matching membership.

test("11. a token whose declared lifetime is exactly 900 seconds authenticates", async () => {
  const res = await get(reads(liveSession(), activeMembership()), signToken(claimsWithLifetime(0, 900), SECRET));

  assert.equal(res.statusCode, 200, "exactly the frozen TTL is valid — the boundary must not be off by one");
  const { auth } = AuthSnapshot.parse(res.json());
  assert.equal(auth.membershipStatus, "active");
});

test("12. a token declaring 960 seconds is refused", async () => {
  const identity = reads(liveSession(), activeMembership());

  const control = await get(identity, signToken(claimsWithLifetime(0, 900), SECRET));
  assert.equal(control.statusCode, 200, "positive control: the 900-second token must authenticate");

  const res = await get(identity, signToken(claimsWithLifetime(0, 960), SECRET));
  assert.equal(res.statusCode, 401, "one minute over the frozen TTL must be refused");
  assert.deepEqual(res.json(), CANONICAL_401);
});

test("13. a token declaring a 24-hour lifetime is refused", async () => {
  const identity = reads(liveSession(), activeMembership());

  const control = await get(identity, signToken(claimsWithLifetime(0, 900), SECRET));
  assert.equal(control.statusCode, 200, "positive control: the 900-second token must authenticate");

  const res = await get(identity, signToken(claimsWithLifetime(0, 24 * 60 * 60), SECRET));
  assert.equal(res.statusCode, 401, "a long-lived token must be refused outright, not honoured for its first 15 minutes");
  assert.deepEqual(res.json(), CANONICAL_401);
});

test("14. a token issued 10 minutes ago with a 900-second lifetime still authenticates", async () => {
  // The discriminating case. An implementation that checked wall-clock AGE
  // (`now - iat > 900`) instead of the DECLARED lifetime would pass 11-13 and
  // fail here — and would also be wrong about clock skew, since age depends on
  // this server's clock while exp - iat does not.
  const res = await get(reads(liveSession(), activeMembership()), signToken(claimsWithLifetime(600, 900), SECRET));

  assert.equal(res.statusCode, 200, "a correctly minted token with 5 minutes left must still authenticate");
  const { auth } = AuthSnapshot.parse(res.json());
  assert.equal(auth.sessionId, SESSION_ID);
});

test("15. a token whose exp equals its iat is refused", async () => {
  const identity = reads(liveSession(), activeMembership());

  const control = await get(identity, signToken(claimsWithLifetime(0, 900), SECRET));
  assert.equal(control.statusCode, 200, "positive control: the 900-second token must authenticate");

  const res = await get(identity, signToken(claimsWithLifetime(0, 0), SECRET));
  assert.equal(res.statusCode, 401, "a zero lifetime is malformed, not a valid instantaneous token");
  assert.deepEqual(res.json(), CANONICAL_401);
});

test("16. a token whose exp precedes its iat is refused", async () => {
  const identity = reads(liveSession(), activeMembership());

  const control = await get(identity, signToken(claimsWithLifetime(0, 900), SECRET));
  assert.equal(control.statusCode, 200, "positive control: the 900-second token must authenticate");

  // exp 60s BEFORE iat, while exp itself is still in the future — so the
  // verifier's own expiry check cannot catch it. Only the lifetime relationship can.
  const res = await get(identity, signToken(claimsWithLifetime(-300, -60), SECRET));
  assert.equal(res.statusCode, 401, "a negative lifetime is malformed");
  assert.deepEqual(res.json(), CANONICAL_401);
});
