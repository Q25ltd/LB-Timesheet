/**
 * The 0 / 1 / 2+ membership authentication contract, and company selection.
 *
 * AUTH.md's "Login flow" and D13 (explicitly unchanged by D21) freeze this:
 * identity authentication succeeds for everyone, and tenant authority is
 * auto-selected for exactly one active membership, chosen explicitly for two
 * or more, and absent for none.
 *
 * Memberships are seeded DIRECTLY. No onboarding exists — there is no
 * invitation flow and `Company.joinCode` is unused and blocked by F-18 — so
 * a fixture is the only way to reach these branches. That is a statement
 * about the product's current surface, not a shortcut: every assertion below
 * runs against the real routes and the real repositories.
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the company-selection tests");
}

process.env.JWT_SECRET = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV   = "test";
process.env.WEB_ORIGIN = "https://allowed.example.com";

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `select-test-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };
const CANONICAL_403 = { error: "Not allowed", code: "FORBIDDEN" };
const IDENTITY_AUDIENCE = "timesheets-identity";
const TENANT_AUDIENCE   = "timesheets-api";

let seq = 0;
function freshEmail(local = "driver"): string {
  seq += 1;
  return `${TAG}-${String(seq)}-${local}@example.com`;
}

interface Injected { statusCode: number; body: unknown; raw: string }

async function request(
  method: "GET" | "POST",
  url: string,
  options: { payload?: unknown; token?: string } = {},
): Promise<Injected> {
  const app = await buildApp(prisma);
  try {
    const res = await app.inject({
      method, url,
      ...(options.payload === undefined ? {} : { payload: options.payload as object }),
      headers: options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
    });
    return { statusCode: res.statusCode, body: res.body === "" ? null : (JSON.parse(res.body) as unknown), raw: res.body };
  } finally {
    await app.close();
  }
}

function field(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null || !(key in body)) return undefined;
  return Reflect.get(body, key);
}

function stringField(body: unknown, key: string): string {
  const value = field(body, key);
  assert.equal(typeof value, "string", `the response must carry \`${key}\` as a string`);
  return value as string;
}

function claimsOf(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  assert.ok(payload !== undefined && payload !== "", "a JWT must have a payload segment");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

function memberships(body: unknown): Record<string, unknown>[] {
  const value = field(body, "memberships");
  assert.ok(Array.isArray(value), "the response must carry a memberships array");
  return value as Record<string, unknown>[];
}

/** A registered account, and its id. */
async function registerDriver(): Promise<{ email: string; userId: string }> {
  const email = freshEmail();
  const result = await request("POST", "/auth/register", {
    payload: { firstName: "Nerijus", lastName: "Kuizinas", email, password: PASSWORD },
  });
  assert.equal(result.statusCode, 201, `registration must succeed — got ${result.raw}`);
  const user = await prisma.user.findUnique({ where: { email } });
  assert.ok(user !== null, "the account must exist");
  return { email, userId: user.id };
}

function login(email: string): Promise<Injected> {
  return request("POST", "/auth/login", { payload: { email, password: PASSWORD } });
}

async function seedMembership(
  userId: string, label: string, active = true,
): Promise<{ companyId: string; companyName: string; membershipId: string }> {
  seq += 1;
  const companyName = `${TAG}-${label}`;
  const company = await prisma.company.create({
    data: { name: companyName, joinCode: `${TAG}-join-${String(seq)}` },
  });
  const membership = await prisma.companyMembership.create({
    data: { companyId: company.id, userId, role: "driver", active },
  });
  return { companyId: company.id, companyName, membershipId: membership.id };
}

/** An OPEN shift, seeded directly — Start Shift's own route needs a tenant token. */
async function seedOpenShift(where: { userId: string; companyId: string; membershipId: string }): Promise<void> {
  await prisma.shift.create({
    data: {
      membershipId: where.membershipId,
      companyId:    where.companyId,
      userId:       where.userId,
      driverName:   "Nerijus Kuizinas",
      shiftDate:    new Date("2026-09-11T00:00:00.000Z"),
      startedAt:    new Date(),
      status:       "active",
    },
  });
}

function switchCompany(token: string, body: unknown): Promise<Injected> {
  return request("POST", "/auth/switch-company", { payload: body, token });
}

async function cleanup(): Promise<void> {
  // Order matters. `Shift`'s composite foreign key to `CompanyMembership` has
  // no `onDelete: Cascade` — deliberately, because a submitted timesheet must
  // not vanish when a membership is tidied up — so the fixture shifts have to
  // go first or the cascade from `User` hits SQLSTATE 23503.
  const companies = await prisma.company.findMany({
    where:  { name: { startsWith: TAG } },
    select: { id: true },
  });
  const companyIds = companies.map(company => company.id);
  if (companyIds.length > 0) {
    await prisma.shift.deleteMany({ where: { companyId: { in: companyIds } } });
  }
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
  await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
}

before(cleanup);
beforeEach(cleanup);
after(async () => { await cleanup(); await prisma.$disconnect(); });

// ═════════════════════════════════════════════════════════════════════════════
// N0-N4. What LOGIN returns for 0 / 1 / 2+ / inactive memberships
// ═════════════════════════════════════════════════════════════════════════════

test("N0. ZERO active memberships: identity only, empty list, NO tenant token", async () => {
  const driver = await registerDriver();

  const result = await login(driver.email);

  assert.equal(result.statusCode, 200, `a personal account must authenticate — got ${result.raw}`);
  assert.deepEqual(memberships(result.body), [], "no companies");
  assert.equal(field(result.body, "tenantToken"), undefined, "and no tenant authority of any kind (D21)");
  assert.ok(!result.raw.includes(TENANT_AUDIENCE), "nothing in the body carries the tenant audience");
});

test("N1. EXACTLY ONE active membership is auto-selected, and its claims come from the ROW", async () => {
  const driver = await registerDriver();
  const company = await seedMembership(driver.userId, "solo");

  const result = await login(driver.email);
  assert.equal(result.statusCode, 200, `login must succeed — got ${result.raw}`);

  // D12: a single-company driver never sees a picker and loses no taps.
  const tenantToken = stringField(result.body, "tenantToken");
  const claims = claimsOf(tenantToken);

  assert.equal(claims["aud"], TENANT_AUDIENCE, "the auto-selected token is a TENANT token");
  assert.equal(claims["sub"], driver.userId, "for this account");
  assert.equal(claims["companyId"], company.companyId, "scoped to the company on the membership ROW");
  assert.equal(claims["membershipId"], company.membershipId, "and naming that membership");
  assert.equal(typeof claims["sessionId"], "string", "on the session login created");
  // AUTH.md and D13: role is deliberately NOT a claim — it would be authority
  // that outlives its revocation. `requireAuth` reads it fresh every request.
  assert.ok(!("role" in claims), `role must never be a token claim — claims were ${Object.keys(claims).join(", ")}`);

  // The identity token is still issued alongside, and is still identity-only.
  const identityClaims = claimsOf(stringField(result.body, "identityToken"));
  assert.equal(identityClaims["aud"], IDENTITY_AUDIENCE, "a client that needs both receives both (D21)");
  assert.ok(!("companyId" in identityClaims), "and the identity half never carries tenant claims");

  assert.equal(memberships(result.body).length, 1, "the list still describes the company");
});

test("N2. TWO OR MORE active memberships: the list, and NO tenant token until an explicit choice", async () => {
  const driver = await registerDriver();
  const a = await seedMembership(driver.userId, "alpha");
  const b = await seedMembership(driver.userId, "bravo");

  const result = await login(driver.email);
  assert.equal(result.statusCode, 200, `login must succeed — got ${result.raw}`);

  assert.equal(field(result.body, "tenantToken"), undefined, "choosing between real companies is an EXPLICIT security event");
  assert.ok(!result.raw.includes(TENANT_AUDIENCE), "so no tenant-audience token may appear anywhere in the body");

  const list = memberships(result.body);
  assert.equal(list.length, 2, "both companies are offered");
  const ids = list.map(entry => entry["membershipId"]).sort();
  assert.deepEqual(ids, [a.membershipId, b.membershipId].sort(), "by membership id");

  // The minimum the UI needs, and nothing more: no `active`, no `joinedAt`,
  // no payroll reference, no company email or timezone.
  for (const entry of list) {
    assert.deepEqual(
      Object.keys(entry).sort(), ["companyId", "companyName", "membershipId", "role"],
      `a membership summary is exactly these four fields — got ${Object.keys(entry).join(", ")}`,
    );
  }
});

test("N3. ONLY-INACTIVE memberships behave exactly like zero active", async () => {
  const driver = await registerDriver();
  await seedMembership(driver.userId, "deactivated", false);

  const result = await login(driver.email);

  assert.equal(result.statusCode, 200, `a deactivated membership does not remove the ACCOUNT — got ${result.raw}`);
  assert.deepEqual(memberships(result.body), [], "an inactive membership is not offered (AUTH.md contract test 5)");
  assert.equal(field(result.body, "tenantToken"), undefined, "and is not a company to auto-select");
  assert.ok(!result.raw.includes(TENANT_AUDIENCE), "no tenant authority at all");
});

test("N4. a MIXTURE counts only the active ones — one active among inactive is still auto-selected", async () => {
  const driver = await registerDriver();
  const active = await seedMembership(driver.userId, "live");
  await seedMembership(driver.userId, "dead-1", false);
  await seedMembership(driver.userId, "dead-2", false);

  const result = await login(driver.email);
  assert.equal(result.statusCode, 200, `login must succeed — got ${result.raw}`);

  const list = memberships(result.body);
  assert.equal(list.length, 1, "only the active membership is offered");
  assert.equal(list[0]?.["membershipId"], active.membershipId, "the right one");

  // One ACTIVE membership is one membership, regardless of how many dead ones
  // sit beside it. Counting rows instead of active rows would break this.
  const claims = claimsOf(stringField(result.body, "tenantToken"));
  assert.equal(claims["membershipId"], active.membershipId, "and it is the one auto-selected");
});

// ═════════════════════════════════════════════════════════════════════════════
// P1-P6. POST /auth/switch-company
// ═════════════════════════════════════════════════════════════════════════════

test("P1. selecting an own ACTIVE membership yields a tenant token on the SAME session", async () => {
  const driver = await registerDriver();
  const a = await seedMembership(driver.userId, "alpha");
  await seedMembership(driver.userId, "bravo");

  const session = await login(driver.email);
  const identityToken = stringField(session.body, "identityToken");
  const identitySessionId = claimsOf(identityToken)["sessionId"];

  const result = await switchCompany(identityToken, { membershipId: a.membershipId });

  assert.equal(result.statusCode, 200, `a valid own active membership must be selectable — got ${result.raw}`);
  const claims = claimsOf(stringField(result.body, "tenantToken"));
  assert.equal(claims["aud"], TENANT_AUDIENCE, "it is a tenant token");
  assert.equal(claims["companyId"], a.companyId, "scoped to the row's company");
  assert.equal(claims["membershipId"], a.membershipId, "and its membership");
  // AUTH.md: "new access token scoped to that membership / SAME session".
  assert.equal(claims["sessionId"], identitySessionId, "on the SAME session — a switch does not create one");
  assert.ok(!("role" in claims), "and still no role claim");

  // And no second Session was created.
  assert.equal(
    await prisma.session.count({ where: { userId: driver.userId } }), 2,
    "registration's session and login's session — selection adds none",
  );

  // The echoed membership is the SERVER's row, not the request.
  const membership = field(result.body, "membership");
  assert.deepEqual(
    Object.keys(membership as Record<string, unknown>).sort(),
    ["companyId", "companyName", "membershipId", "role"],
    "the echoed summary is the same narrow four fields",
  );
  assert.equal((membership as Record<string, unknown>)["companyName"], a.companyName, "read from the database");
});

test("P2. another user's membership and an INACTIVE membership are refused IDENTICALLY", async () => {
  // The two must be indistinguishable, or the endpoint becomes an oracle for
  // "does this membership id exist, and whose is it" (D17).
  const driver = await registerDriver();
  await seedMembership(driver.userId, "own");
  const stranger = await registerDriver();
  const strangers = await seedMembership(stranger.userId, "stranger");
  const inactive = await seedMembership(driver.userId, "inactive", false);

  const identityToken = stringField((await login(driver.email)).body, "identityToken");

  const foreign  = await switchCompany(identityToken, { membershipId: strangers.membershipId });
  const disabled = await switchCompany(identityToken, { membershipId: inactive.membershipId });
  const absent   = await switchCompany(identityToken, { membershipId: "memb_does_not_exist" });

  for (const [name, answer] of [["another user's", foreign], ["an inactive", disabled], ["a nonexistent", absent]] as const) {
    assert.equal(answer.statusCode, 403, `${name} membership must be refused 403 — got ${answer.raw}`);
    assert.deepEqual(answer.body, CANONICAL_403, "with D17's generic authorization failure");
  }
  assert.equal(foreign.raw, disabled.raw, "byte-identical: which one it was must not leak");
  assert.equal(foreign.raw, absent.raw, "byte-identical for a membership that does not exist either");
});

test("P3. switch-company requires an IDENTITY token — a tenant token is the wrong KIND", async () => {
  const driver = await registerDriver();
  const a = await seedMembership(driver.userId, "solo");
  const session = await login(driver.email);
  const tenantToken = stringField(session.body, "tenantToken");

  const anonymous = await switchCompany("", { membershipId: a.membershipId });
  assert.equal(anonymous.statusCode, 401, "no token is refused");

  // D21's symmetry: a more authoritative token is still the wrong kind, and
  // the audience check refuses it before a claim is read.
  const withTenant = await switchCompany(tenantToken, { membershipId: a.membershipId });
  assert.equal(withTenant.statusCode, 401, `a tenant token must not authorize an identity route — got ${withTenant.raw}`);
  assert.deepEqual(withTenant.body, CANONICAL_401, "generically");
});

test("P4. the DTO is exactly one field — authority in the body is REFUSED, never used", async () => {
  const driver = await registerDriver();
  const a = await seedMembership(driver.userId, "alpha");
  const stranger = await registerDriver();
  const strangers = await seedMembership(stranger.userId, "stranger");
  const identityToken = stringField((await login(driver.email)).body, "identityToken");

  // A client naming the company, the user, the session or a role.
  for (const [name, value] of Object.entries({
    companyId:    strangers.companyId,
    userId:       stranger.userId,
    sessionId:    "sess_forged",
    role:         "admin",
    active:       true,
    companyName:  "Somebody Else Ltd",
    tenantToken:  "forged.tenant.token",
    unexpected:   1,
  })) {
    const result = await switchCompany(identityToken, { membershipId: a.membershipId, [name]: value });
    assert.equal(result.statusCode, 400, `a request carrying ${name} must be REFUSED, not accepted with the field ignored — got ${result.raw}`);
  }

  // And the honest one still works, proving the refusals were about the extra
  // fields rather than a broken route.
  const ok = await switchCompany(identityToken, { membershipId: a.membershipId });
  assert.equal(ok.statusCode, 200, `the one-field request must still succeed — got ${ok.raw}`);
  assert.equal(claimsOf(stringField(ok.body, "tenantToken"))["companyId"], a.companyId, "scoped to the driver's OWN company");
});

test("P5. a tenant token for company A does not become authority for company B", async () => {
  const driver = await registerDriver();
  const a = await seedMembership(driver.userId, "alpha");
  const b = await seedMembership(driver.userId, "bravo");
  const identityToken = stringField((await login(driver.email)).body, "identityToken");

  const tokenA = stringField((await switchCompany(identityToken, { membershipId: a.membershipId })).body, "tenantToken");
  const tokenB = stringField((await switchCompany(identityToken, { membershipId: b.membershipId })).body, "tenantToken");

  assert.notEqual(tokenA, tokenB, "each selection mints its own token");
  assert.equal(claimsOf(tokenA)["companyId"], a.companyId, "A's token is scoped to A");
  assert.equal(claimsOf(tokenB)["companyId"], b.companyId, "B's token is scoped to B");
  // Selecting B did not retroactively re-point A's token: a token is a fixed
  // grant, and switching company issues a new one rather than widening one.
  assert.equal(claimsOf(tokenA)["companyId"], a.companyId, "and A's token still says A afterwards");
  assert.equal(claimsOf(tokenA)["sessionId"], claimsOf(tokenB)["sessionId"], "both on the one device session");
});

test("P6. selection does not touch the refresh credential lineage", async () => {
  const driver = await registerDriver();
  const a = await seedMembership(driver.userId, "solo");
  const session = await login(driver.email);
  const refreshToken = stringField(session.body, "refreshToken");
  const sessionRow = await prisma.session.findUnique({
    where: { refreshTokenHash: createHash("sha256").update(refreshToken).digest("hex") },
  });
  assert.ok(sessionRow !== null, "login's secret must name a session");

  await switchCompany(stringField(session.body, "identityToken"), { membershipId: a.membershipId });

  const later = await prisma.session.findUnique({ where: { id: sessionRow.id } });
  assert.equal(later?.refreshTokenHash, sessionRow.refreshTokenHash, "the credential is untouched");
  assert.equal(later?.previousRefreshTokenHash, null, "no rotation happened");
  assert.equal(later?.expiresAt.getTime(), sessionRow.expiresAt.getTime(), "and no lifetime change");
});

// ═════════════════════════════════════════════════════════════════════════════
// O1-O3. The cross-company open-shift guard
// ═════════════════════════════════════════════════════════════════════════════

test("O1. a switch is refused while an open shift belongs to ANOTHER company, opaquely", async () => {
  // AUTH.md: "which company is this shift for" must never be ambiguous. The
  // 409 is Start Shift's exact code and says nothing about where the open
  // shift is, so company B never learns the driver is on shift for company A.
  const driver = await registerDriver();
  const a = await seedMembership(driver.userId, "alpha");
  const b = await seedMembership(driver.userId, "bravo");
  await seedOpenShift({ userId: driver.userId, companyId: a.companyId, membershipId: a.membershipId });

  const identityToken = stringField((await login(driver.email)).body, "identityToken");
  const result = await switchCompany(identityToken, { membershipId: b.membershipId });

  assert.equal(result.statusCode, 409, `switching away from an open shift must be refused — got ${result.raw}`);
  assert.deepEqual(
    result.body, { error: "You already have an open shift", code: "SHIFT_ALREADY_OPEN" },
    "with Start Shift's canonical opaque conflict (one concept, one name)",
  );
  assert.ok(!result.raw.includes(a.companyId), "and it must not disclose the other company's id");
  assert.ok(!result.raw.includes(a.companyName), "nor its name");
  assert.ok(!result.raw.includes(a.membershipId), "nor the membership the shift belongs to");
});

test("O2. selecting the company the open shift BELONGS to is allowed", async () => {
  // The guard protects against ambiguity, not against working. Refusing here
  // would lock a driver out of their own open shift.
  const driver = await registerDriver();
  const a = await seedMembership(driver.userId, "alpha");
  await seedMembership(driver.userId, "bravo");
  await seedOpenShift({ userId: driver.userId, companyId: a.companyId, membershipId: a.membershipId });

  const identityToken = stringField((await login(driver.email)).body, "identityToken");
  const result = await switchCompany(identityToken, { membershipId: a.membershipId });

  assert.equal(result.statusCode, 200, `the open shift's own company must remain selectable — got ${result.raw}`);
  assert.equal(claimsOf(stringField(result.body, "tenantToken"))["companyId"], a.companyId, "scoped to it");
});

test("O3. a CLOSED shift elsewhere does not block a switch", async () => {
  const driver = await registerDriver();
  const a = await seedMembership(driver.userId, "alpha");
  const b = await seedMembership(driver.userId, "bravo");
  await prisma.shift.create({
    data: {
      membershipId: a.membershipId, companyId: a.companyId, userId: driver.userId,
      driverName: "Nerijus Kuizinas", shiftDate: new Date("2026-09-10T00:00:00.000Z"),
      startedAt: new Date(Date.now() - 86_400_000), status: "submitted",
    },
  });

  const identityToken = stringField((await login(driver.email)).body, "identityToken");
  const result = await switchCompany(identityToken, { membershipId: b.membershipId });

  assert.equal(result.statusCode, 200, `a submitted shift is not open — got ${result.raw}`);
});

test("O4. the guard cannot be used as a cross-tenant data path", async () => {
  // The read exists to answer one boolean. This case pins what it must NOT
  // become: no response on any path may carry another company's data, and the
  // driver's own identity for the query comes from the session, never a body.
  const driver = await registerDriver();
  const a = await seedMembership(driver.userId, "alpha");
  const b = await seedMembership(driver.userId, "bravo");
  await seedOpenShift({ userId: driver.userId, companyId: a.companyId, membershipId: a.membershipId });
  const shift = await prisma.shift.findFirst({ where: { userId: driver.userId } });
  assert.ok(shift !== null, "the fixture shift must exist");

  const identityToken = stringField((await login(driver.email)).body, "identityToken");

  // Refused switch: nothing about the other company or the shift.
  const blocked = await switchCompany(identityToken, { membershipId: b.membershipId });
  for (const secret of [shift.id, shift.driverName, a.companyId, a.companyName, a.membershipId]) {
    assert.ok(!blocked.raw.includes(secret), `the 409 must not disclose ${secret}`);
  }

  // A stranger cannot aim the query at this driver: `userId` is not accepted,
  // and the identity used is the authenticated one.
  const stranger = await registerDriver();
  const strangerToken = stringField((await login(stranger.email)).body, "identityToken");
  const aimed = await switchCompany(strangerToken, { membershipId: a.membershipId, userId: driver.userId });
  assert.equal(aimed.statusCode, 400, "a userId in the body is refused outright");

  const withoutUserId = await switchCompany(strangerToken, { membershipId: a.membershipId });
  assert.equal(withoutUserId.statusCode, 403, "and the stranger cannot select a membership that is not theirs");
  assert.deepEqual(withoutUserId.body, CANONICAL_403, "generically");
});
