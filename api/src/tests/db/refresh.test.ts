/**
 * Refresh-token redemption, rotation, the grace window, reuse — and F-21's
 * closing evidence. Against a REAL database built by the real migrations.
 *
 * Every account here is created through the shipped `POST /auth/register`, so
 * the refresh credential under test is one the product actually issues.
 *
 * The F-21 case (F1) is the one to read first: it CRAFTS the cross-column
 * state the finding describes — one Session's current digest equal to another
 * Session's previous digest — and proves the resolution is deterministic.
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
  throw new Error("DATABASE_URL must be set to run the refresh database tests");
}

process.env.JWT_SECRET = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV   = "test";
process.env.WEB_ORIGIN = "https://allowed.example.com";

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `refresh-test-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };
const IDENTITY_AUDIENCE = "timesheets-identity";
const TENANT_AUDIENCE   = "timesheets-api";
const DAY = 24 * 60 * 60 * 1000;

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

function postRefresh(refreshToken: unknown): Promise<Injected> {
  return request("POST", "/auth/refresh", { payload: { refreshToken } });
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
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

/** A registered driver and the refresh secret registration issued. */
async function registeredDriver(): Promise<{ email: string; refreshToken: string; sessionId: string; userId: string }> {
  const email = freshEmail();
  const result = await request("POST", "/auth/register", {
    payload: { firstName: "Nerijus", lastName: "Kuizinas", email, password: PASSWORD },
  });
  assert.equal(result.statusCode, 201, `registration must succeed — got ${result.raw}`);

  const refreshToken = stringField(result.body, "refreshToken");
  const session = await prisma.session.findUnique({ where: { refreshTokenHash: digest(refreshToken) } });
  assert.ok(session !== null, "registration must have persisted the session its secret names");
  return { email, refreshToken, sessionId: session.id, userId: session.userId };
}

async function sessionById(id: string) {
  const row = await prisma.session.findUnique({ where: { id } });
  assert.ok(row !== null, "the session must still exist");
  return row;
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
  await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
}

before(cleanup);
beforeEach(cleanup);
after(async () => { await cleanup(); await prisma.$disconnect(); });

// ═════════════════════════════════════════════════════════════════════════════
// R1-R5. The ordinary rotation
// ═════════════════════════════════════════════════════════════════════════════

test("R1. a valid CURRENT refresh credential returns fresh identity material", async () => {
  const driver = await registeredDriver();

  const result = await postRefresh(driver.refreshToken);

  assert.equal(result.statusCode, 200, `a live credential must be redeemable — got ${result.raw}`);
  assert.ok(stringField(result.body, "identityToken").length > 0, "refresh must mint a new identity token");
  assert.ok(stringField(result.body, "refreshToken").length > 0, "and return a new refresh secret");
  assert.notEqual(stringField(result.body, "refreshToken"), driver.refreshToken, "the secret must ROTATE, not be echoed");
});

test("R2. rotation moves the presented digest to PREVIOUS and stores the new one as CURRENT", async () => {
  const driver = await registeredDriver();
  const beforeRotation = await sessionById(driver.sessionId);
  assert.equal(beforeRotation.previousRefreshTokenHash, null, "a never-rotated session has no previous digest");
  assert.equal(beforeRotation.previousRefreshTokenGraceUntil, null, "and therefore no grace deadline");

  const result = await postRefresh(driver.refreshToken);
  assert.equal(result.statusCode, 200, `rotation must succeed — got ${result.raw}`);
  const next = stringField(result.body, "refreshToken");

  const afterRotation = await sessionById(driver.sessionId);
  assert.equal(afterRotation.refreshTokenHash, digest(next), "the new secret's digest becomes CURRENT");
  assert.equal(afterRotation.previousRefreshTokenHash, digest(driver.refreshToken), "the presented digest becomes PREVIOUS");
  assert.ok(afterRotation.previousRefreshTokenGraceUntil !== null, "and gains a grace deadline");
  // AUTH.md's 60 seconds. Bounded rather than exact, because the deadline is
  // computed from the server clock at write time.
  const graceMs = afterRotation.previousRefreshTokenGraceUntil.getTime() - Date.now();
  assert.ok(graceMs > 0 && graceMs <= 60_000, `the grace window must be ~60s, was ${String(graceMs)}ms`);
});

test("R3. rotation NEVER extends the Session's absolute lifetime", async () => {
  // AUTH.md: the 90-day lifetime is the Session's, and rotating credentials
  // inside it is not a reason to move it. Without this, a driver who keeps
  // the app open becomes permanently authenticated.
  const driver = await registeredDriver();
  const beforeRotation = await sessionById(driver.sessionId);

  // Three rotations in sequence, carrying each issued secret forward.
  let token = driver.refreshToken;
  for (let i = 0; i < 3; i += 1) {
    const result = await postRefresh(token);
    assert.equal(result.statusCode, 200, `rotation ${String(i)} must succeed — got ${result.raw}`);
    token = stringField(result.body, "refreshToken");
  }

  const afterRotation = await sessionById(driver.sessionId);
  assert.equal(
    afterRotation.expiresAt.getTime(), beforeRotation.expiresAt.getTime(),
    "expiresAt must be byte-identical after rotation — rotation changes credentials, not lifetime",
  );
});

test("R4. the identity token refresh mints is an IDENTITY token and carries no tenant authority", async () => {
  const driver = await registeredDriver();

  const result = await postRefresh(driver.refreshToken);
  assert.equal(result.statusCode, 200, `rotation must succeed — got ${result.raw}`);
  const claims = claimsOf(stringField(result.body, "identityToken"));

  assert.equal(claims["aud"], IDENTITY_AUDIENCE, "refresh restores ACCOUNT identity (D21)");
  assert.equal(claims["sub"], driver.userId, "and names the account behind the credential");
  assert.equal(claims["sessionId"], driver.sessionId, "and the SAME session — refresh does not create one");
  for (const forbidden of ["companyId", "membershipId", "role"]) {
    assert.ok(!(forbidden in claims), `an identity token must not carry \`${forbidden}\` — claims were ${Object.keys(claims).join(", ")}`);
  }

  // And it works: the token is usable, not merely well-formed.
  const me = await request("GET", "/auth/me", { token: stringField(result.body, "identityToken") });
  assert.equal(me.statusCode, 200, `the refreshed token must authenticate /auth/me — got ${me.raw}`);
});

test("R5. no digest, hash or stored credential material appears in the response", async () => {
  const driver = await registeredDriver();

  const result = await postRefresh(driver.refreshToken);
  assert.equal(result.statusCode, 200, `rotation must succeed — got ${result.raw}`);

  const next = stringField(result.body, "refreshToken");
  assert.ok(!result.raw.includes(digest(next)), "the new secret's stored digest must never be returned");
  assert.ok(!result.raw.includes(digest(driver.refreshToken)), "nor the superseded one's");
  assert.ok(!result.raw.includes(driver.userId), "refresh discloses no account identifier in its body");
  assert.ok(!/\$2[aby]\$/.test(result.raw), "nothing bcrypt-shaped belongs in an authentication response");
});

// ═════════════════════════════════════════════════════════════════════════════
// R6-R9. The 60-second grace window
// ═════════════════════════════════════════════════════════════════════════════

test("R6. a PREVIOUS credential inside its grace window recovers — the lost-response path", async () => {
  const driver = await registeredDriver();
  const first = await postRefresh(driver.refreshToken);
  assert.equal(first.statusCode, 200, `the first rotation must succeed — got ${first.raw}`);

  // The client never saw `first`'s response. It retries with what it has.
  const retry = await postRefresh(driver.refreshToken);

  assert.equal(retry.statusCode, 200, `a previous credential inside grace must recover — got ${retry.raw}`);
  assert.ok(stringField(retry.body, "identityToken").length > 0, "and receive usable identity material");
  const recovered = stringField(retry.body, "refreshToken");
  assert.notEqual(recovered, driver.refreshToken, "with a freshly minted secret");
  assert.notEqual(recovered, stringField(first.body, "refreshToken"), "and not the one whose response was lost");
});

test("R7. recovery keeps the presented credential as the anchor and does NOT extend the deadline", async () => {
  // Two properties in one case because they are the same design decision: the
  // previous digest and its deadline are left untouched, so repeated retries
  // work AND a stolen previous credential cannot have its window stretched.
  const driver = await registeredDriver();
  await postRefresh(driver.refreshToken);
  const firstState = await sessionById(driver.sessionId);
  assert.ok(firstState.previousRefreshTokenGraceUntil !== null, "the first rotation sets a deadline");
  const deadline = firstState.previousRefreshTokenGraceUntil.getTime();

  const retry = await postRefresh(driver.refreshToken);
  assert.equal(retry.statusCode, 200, `recovery must succeed — got ${retry.raw}`);

  const retryState = await sessionById(driver.sessionId);
  assert.equal(
    retryState.previousRefreshTokenHash, digest(driver.refreshToken),
    "the presented credential stays the recovery anchor, so a further lost response can be retried",
  );
  assert.equal(
    retryState.previousRefreshTokenGraceUntil?.getTime(), deadline,
    "the deadline must NOT move — repeated retries cannot stretch the window",
  );
  assert.equal(
    retryState.refreshTokenHash, digest(stringField(retry.body, "refreshToken")),
    "and the newly issued secret is the current credential",
  );
});

test("R8. repeated grace retries all succeed and leave ONE coherent lineage", async () => {
  const driver = await registeredDriver();
  await postRefresh(driver.refreshToken);

  const issued: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const retry = await postRefresh(driver.refreshToken);
    assert.equal(retry.statusCode, 200, `grace retry ${String(i)} must succeed — got ${retry.raw}`);
    issued.push(stringField(retry.body, "refreshToken"));
  }

  assert.equal(new Set(issued).size, issued.length, "each retry mints a distinct secret");

  // Exactly one of them is live: the last. The earlier ones were superseded
  // and, because recovery does not touch the previous slot, they match nothing.
  const session = await sessionById(driver.sessionId);
  const last = issued[issued.length - 1];
  assert.ok(last !== undefined, "at least one retry must have issued a secret");
  assert.equal(session.refreshTokenHash, digest(last), "the last issued secret is the only current one");

  for (const superseded of issued.slice(0, -1)) {
    const refused = await postRefresh(superseded);
    assert.equal(refused.statusCode, 401, "an intermediate secret matches nothing and is refused");
    assert.deepEqual(refused.body, CANONICAL_401, "generically");
  }
});

test("R9. a PREVIOUS credential presented AFTER its window revokes the Session (reuse)", async () => {
  const driver = await registeredDriver();
  const rotated = await postRefresh(driver.refreshToken);
  assert.equal(rotated.statusCode, 200, `the rotation must succeed — got ${rotated.raw}`);
  const live = stringField(rotated.body, "refreshToken");

  // Expire the grace window by moving the deadline into the past — the same
  // state the clock would produce 61 seconds later, without waiting for it.
  await prisma.session.update({
    where: { id: driver.sessionId },
    data:  { previousRefreshTokenGraceUntil: new Date(Date.now() - 1000) },
  });

  const reused = await postRefresh(driver.refreshToken);

  assert.equal(reused.statusCode, 401, `reuse outside grace must be refused — got ${reused.raw}`);
  assert.deepEqual(reused.body, CANONICAL_401, "and say nothing about why");

  const session = await sessionById(driver.sessionId);
  assert.ok(session.revokedAt !== null, "AUTH.md: reuse outside the grace window REVOKES the session");

  // And the revocation is total: the credential that was still live is dead.
  const afterRevocation = await postRefresh(live);
  assert.equal(afterRevocation.statusCode, 401, "the live credential dies with the session");
  assert.deepEqual(afterRevocation.body, CANONICAL_401, "generically");
});

// ═════════════════════════════════════════════════════════════════════════════
// R10-R13. Everything else is refused, identically
// ═════════════════════════════════════════════════════════════════════════════

test("R10. a revoked Session cannot refresh", async () => {
  const driver = await registeredDriver();
  await prisma.session.update({ where: { id: driver.sessionId }, data: { revokedAt: new Date() } });

  const result = await postRefresh(driver.refreshToken);

  assert.equal(result.statusCode, 401, `a revoked session must refuse — got ${result.raw}`);
  assert.deepEqual(result.body, CANONICAL_401, "generically");
});

test("R11. a Session past its absolute expiry cannot refresh, and refresh cannot resurrect it", async () => {
  const driver = await registeredDriver();
  await prisma.session.update({ where: { id: driver.sessionId }, data: { expiresAt: new Date(Date.now() - DAY) } });

  const result = await postRefresh(driver.refreshToken);

  assert.equal(result.statusCode, 401, `an expired session must refuse — got ${result.raw}`);
  assert.deepEqual(result.body, CANONICAL_401, "generically");

  const session = await sessionById(driver.sessionId);
  assert.ok(session.expiresAt.getTime() < Date.now(), "and the expiry must not have been pushed forward");
  assert.equal(session.refreshTokenHash, digest(driver.refreshToken), "nor the credential rotated");
});

test("R12. an unknown credential is refused, and the four failures are INDISTINGUISHABLE", async () => {
  const unknown = await postRefresh("a".repeat(43));

  assert.equal(unknown.statusCode, 401, `an unknown credential must be refused — got ${unknown.raw}`);

  // Build the other three failure states and compare the raw bodies. A
  // difference in any of them is an oracle for session existence or state.
  const revoked = await registeredDriver();
  await prisma.session.update({ where: { id: revoked.sessionId }, data: { revokedAt: new Date() } });
  const expired = await registeredDriver();
  await prisma.session.update({ where: { id: expired.sessionId }, data: { expiresAt: new Date(Date.now() - DAY) } });

  const answers = [
    unknown,
    await postRefresh(revoked.refreshToken),
    await postRefresh(expired.refreshToken),
  ];
  for (const answer of answers) {
    assert.equal(answer.statusCode, 401, "every refresh failure is 401");
    assert.equal(answer.raw, answers[0]?.raw, "and byte-identical — refresh is not an oracle for session state");
  }
});

test("R13. a malformed or empty credential is refused by the DTO, before any lookup", async () => {
  for (const bad of ["", "x".repeat(65)]) {
    const result = await postRefresh(bad);
    assert.equal(result.statusCode, 400, `"${bad.slice(0, 8)}…" must be a malformed request — got ${result.raw}`);
  }
  for (const bad of [42, null, true, { token: "x" }, ["x"]]) {
    const result = await postRefresh(bad);
    assert.equal(result.statusCode, 400, `a ${typeof bad} credential must be refused, never coerced`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// C1-C3. Concurrency — the reason rotation is a conditional write
// ═════════════════════════════════════════════════════════════════════════════

test("C1. two SIMULTANEOUS refreshes of the same credential leave exactly ONE usable lineage", async () => {
  // The failure this guards: read-then-write would let both mint, both write,
  // and the second overwrite the first — so a client would hold a secret the
  // database had already replaced and be silently logged out.
  //
  // WHAT THIS CASE MAY NOT ASSERT (F-27). It once required the literal pair
  // `[200, 401]`. That is stronger than the architecture actually promises and
  // was measured to be false: when the first request COMMITS before the second
  // resolves, the second finds the presented digest in the PREVIOUS column and
  // legitimately succeeds through grace recovery — the very mechanism AUTH.md
  // provides so a lost response is survivable. Two 200s are therefore a
  // correct outcome, not a defect, and a test asserting otherwise is asserting
  // an implementation timing accident.
  //
  // The real invariant, and what is asserted below: at most one request may
  // rotate the presented credential as CURRENT, the Session must not fork, and
  // there must never be two independently usable refresh lineages.
  const driver = await registeredDriver();
  const lifetimeBefore = (await sessionById(driver.sessionId)).expiresAt.getTime();

  const answers = await Promise.all([postRefresh(driver.refreshToken), postRefresh(driver.refreshToken)]);

  const succeeded = answers.filter(answer => answer.statusCode === 200);
  assert.ok(succeeded.length >= 1, `at least one concurrent refresh must succeed — got ${answers.map(a => String(a.statusCode)).join(", ")}`);
  for (const refused of answers.filter(answer => answer.statusCode !== 200)) {
    assert.equal(refused.statusCode, 401, "a refused concurrent refresh must be the canonical 401");
    assert.deepEqual(refused.body, CANONICAL_401, "and must disclose nothing about why it lost");
  }

  const session = await sessionById(driver.sessionId);

  // ONE usable lineage. Every other issued secret must be dead on arrival.
  const issued = succeeded.map(answer => stringField(answer.body, "refreshToken"));
  const usable = issued.filter(secret => digest(secret) === session.refreshTokenHash);
  assert.equal(usable.length, 1, `exactly ONE issued secret may be the current credential — ${String(issued.length)} were issued`);

  // The Session must not have forked: every token names the same session.
  for (const answer of succeeded) {
    assert.equal(
      claimsOf(stringField(answer.body, "identityToken")).sessionId, driver.sessionId,
      "every concurrently issued identity token must name the SAME session",
    );
  }

  assert.equal(session.previousRefreshTokenHash, digest(driver.refreshToken), "the presented credential stays the grace anchor");
  assert.equal(session.revokedAt, null, "concurrency is not reuse — the session must not be revoked");
  assert.equal(session.expiresAt.getTime(), lifetimeBefore, "and the absolute lifetime must not move");

  // The superseded secrets cannot be redeemed, and asking does not revoke.
  for (const dead of issued.filter(secret => digest(secret) !== session.refreshTokenHash)) {
    const refused = await postRefresh(dead);
    assert.equal(refused.statusCode, 401, "a superseded issued secret must not be redeemable");
  }
  assert.equal((await sessionById(driver.sessionId)).revokedAt, null, "and redeeming one must not revoke the session");

  // The one live secret works — proof nothing overwrote it.
  const again = await postRefresh(usable[0] ?? "");
  assert.equal(again.statusCode, 200, `the surviving secret must be usable — got ${again.raw}`);
});

test("C2. a request refused by the race is NOT logged out — its credential still recovers", async () => {
  // Why a concurrent 401 is survivable rather than a lost session: the
  // credential that client still holds is now the PREVIOUS one, inside its
  // window. This holds whatever the interleaving produced above, which is why
  // this case no longer asserts that exactly one request lost.
  const driver = await registeredDriver();
  const answers = await Promise.all([postRefresh(driver.refreshToken), postRefresh(driver.refreshToken)]);
  assert.ok(answers.some(answer => answer.statusCode === 200), "at least one concurrent refresh must succeed");

  const recovery = await postRefresh(driver.refreshToken);
  assert.equal(recovery.statusCode, 200, `the presented credential must still recover — got ${recovery.raw}`);

  const session = await sessionById(driver.sessionId);
  assert.equal(
    session.refreshTokenHash, digest(stringField(recovery.body, "refreshToken")),
    "and the recovered secret becomes the one live credential",
  );
});

test("C3. a CURRENT and a PREVIOUS request racing leave one coherent lineage", async () => {
  const driver = await registeredDriver();
  const first = await postRefresh(driver.refreshToken);
  assert.equal(first.statusCode, 200, `setup rotation must succeed — got ${first.raw}`);
  const current = stringField(first.body, "refreshToken");

  // One request presents the live credential, the other the grace credential,
  // at the same moment.
  const [byCurrent, byPrevious] = await Promise.all([postRefresh(current), postRefresh(driver.refreshToken)]);

  // Both MAY succeed — they are different credentials and each write is
  // conditioned on its own column. What must hold is that the row is
  // consistent afterwards and exactly one secret is live.
  const session = await sessionById(driver.sessionId);
  const live = [byCurrent, byPrevious]
    .filter(answer => answer.statusCode === 200)
    .map(answer => stringField(answer.body, "refreshToken"));
  assert.ok(live.length >= 1, "at least one of the two must succeed");

  const stillValid: string[] = [];
  for (const secret of live) {
    if (session.refreshTokenHash === digest(secret)) stillValid.push(secret);
  }
  assert.equal(stillValid.length, 1, `exactly ONE issued secret may be the current credential — ${String(live.length)} succeeded`);
  assert.ok(session.revokedAt === null, "and the race must not have revoked the session");
  assert.notEqual(session.previousRefreshTokenHash, session.refreshTokenHash, "the row's own distinctness invariant holds");
});

test("C4. rotateCurrent applies ONLY to the digest the caller presented — the conditional write, proven deterministically", async () => {
  // WHY THIS IS NOT A RACE (F-26). C1 asserts the state a race leaves behind,
  // but a race cannot prove WHY that state is safe: the interleaving is not
  // ours to choose, and the one that would expose a missing condition occurs
  // only under a timing no test can force. Removing the condition therefore
  // left every concurrency case green.
  //
  // Atomicity is a property of the WRITE, so it is proven here directly, with
  // no concurrency at all. The guarantee: `rotateCurrent`'s `where` restates
  // the digest the caller believed was current, so a caller acting on a
  // superseded digest matches NO row — which is what makes it impossible for
  // two callers to rotate the same credential as CURRENT.
  const driver = await registeredDriver();
  const first = await postRefresh(driver.refreshToken);
  assert.equal(first.statusCode, 200, `setup rotation must succeed — got ${first.raw}`);

  const live = stringField(first.body, "refreshToken");
  const { refreshRepository } = await import("../../repositories/refreshRepository.js");
  const sessions = refreshRepository(prisma);
  const now = new Date();
  const appliedDigest = digest(`${TAG}-conditional-applied`);
  const staleDigest   = digest(`${TAG}-conditional-stale`);

  // POSITIVE CONTROL: the digest that IS current rotates, so the refusal
  // below is attributable to the condition and not to an impossible call.
  const applied = await sessions.rotateCurrent({
    sessionId:       driver.sessionId,
    presentedDigest: digest(live),
    nextDigest:      appliedDigest,
    graceUntil:      new Date(now.getTime() + 60_000),
    now,
  });
  assert.equal(applied, true, "the digest that is current must rotate");

  // The SAME call again, still naming the digest it believed was current.
  // Only the row has moved on; every argument but `nextDigest` is identical.
  const stale = await sessions.rotateCurrent({
    sessionId:       driver.sessionId,
    presentedDigest: digest(live),
    nextDigest:      staleDigest,
    graceUntil:      new Date(now.getTime() + 60_000),
    now,
  });
  assert.equal(stale, false, "a caller acting on a SUPERSEDED digest must match no row");

  const afterState = await sessionById(driver.sessionId);
  assert.equal(afterState.refreshTokenHash, appliedDigest, "the refused write applied nothing");
  assert.notEqual(afterState.refreshTokenHash, staleDigest, "and the stale caller's digest was never written");
  assert.equal(afterState.revokedAt, null, "a refused conditional write is not a reuse, so nothing is revoked");
});

// ═════════════════════════════════════════════════════════════════════════════
// F1-F2. F-21: the cross-column digest, resolved deterministically
// ═════════════════════════════════════════════════════════════════════════════

test("F1. F-21: `resolve` picks the CURRENT holder when one digest matches two Sessions", async () => {
  // The exact state F-21 describes, crafted directly because no product path
  // can produce it — it needs a 256-bit collision between two CSPRNG secrets.
  // The DATABASE permits it: the two unique indexes are per-column and the
  // CHECK constraint is per-row, so nothing forbids one Session's current
  // digest equalling another's previous.
  //
  // Asserted against the repository itself, so the property under test is the
  // LOOKUP and nothing else — no rotation, no HTTP, no interpretation.
  const { refreshRepository } = await import("../../repositories/refreshRepository.js");
  const sessions = refreshRepository(prisma);

  const alice = await registeredDriver();
  const bob   = await registeredDriver();

  const shared = digest(alice.refreshToken);
  await prisma.session.update({
    where: { id: bob.sessionId },
    data:  { previousRefreshTokenHash: shared, previousRefreshTokenGraceUntil: new Date(Date.now() + 60_000) },
  });

  // Prove the ambiguity is real before proving it is resolved. This `OR` is
  // written HERE, in a test, deliberately — it is the query the production
  // repository's database interface cannot express.
  const ambiguous = await prisma.session.findMany({
    where: { OR: [{ refreshTokenHash: shared }, { previousRefreshTokenHash: shared }] },
  });
  assert.equal(ambiguous.length, 2, "one digest must genuinely match two Session rows for this case to mean anything");

  const resolved = await sessions.resolve(shared);
  assert.ok(resolved !== null, "the digest must resolve to a session");
  assert.equal(resolved.matched, "current", "the CURRENT column has precedence");
  assert.equal(resolved.session.id, alice.sessionId, "so the live credential's holder is chosen");
  assert.notEqual(resolved.session.id, bob.sessionId, "never the session that merely held the digest as previous");
});

test("F2. F-21: the resolution is stable across repetitions, not planner-dependent", async () => {
  const { refreshRepository } = await import("../../repositories/refreshRepository.js");
  const sessions = refreshRepository(prisma);

  const alice = await registeredDriver();
  const bob   = await registeredDriver();
  const shared = digest(alice.refreshToken);
  await prisma.session.update({
    where: { id: bob.sessionId },
    data:  { previousRefreshTokenHash: shared, previousRefreshTokenGraceUntil: new Date(Date.now() + 60_000) },
  });

  for (let i = 0; i < 8; i += 1) {
    const resolved = await sessions.resolve(shared);
    assert.equal(resolved?.session.id, alice.sessionId, `iteration ${String(i)} resolved to the wrong session`);
    assert.equal(resolved?.matched, "current", `iteration ${String(i)} matched the wrong column`);
  }
});

test("F3. F-21: end to end, the two possible precedences give OPPOSITE observable outcomes — and current wins", async () => {
  // The discriminating case. With the collision in place:
  //
  //   current-first (correct)  → Alice is chosen; her rotation must write the
  //                             presented digest into her PREVIOUS slot, which
  //                             Bob already occupies, so the unique index
  //                             refuses it and the answer is a generic 401.
  //                             Bob's row is untouched.
  //   previous-first (wrong)   → Bob is chosen; a grace recovery writes a
  //                             fresh CURRENT digest to BOB and returns 200.
  //
  // So "401 and Bob unchanged" is positive proof of current precedence, and it
  // is proof that cannot be produced by the wrong implementation.
  const alice = await registeredDriver();
  const bob   = await registeredDriver();

  const shared = digest(alice.refreshToken);
  await prisma.session.update({
    where: { id: bob.sessionId },
    data:  { previousRefreshTokenHash: shared, previousRefreshTokenGraceUntil: new Date(Date.now() + 60_000) },
  });

  const result = await postRefresh(alice.refreshToken);

  assert.equal(result.statusCode, 401, `the collision must fail CLOSED, not 500 — got ${result.raw}`);
  assert.deepEqual(result.body, CANONICAL_401, "and generically: a 500 here would be an oracle for session state");

  const bobSession = await sessionById(bob.sessionId);
  assert.equal(bobSession.refreshTokenHash, digest(bob.refreshToken), "Bob's credential must be UNCHANGED — a previous-first implementation would have rotated it");
  assert.equal(bobSession.revokedAt, null, "and his session must not be revoked");

  const aliceSession = await sessionById(alice.sessionId);
  assert.equal(aliceSession.refreshTokenHash, shared, "Alice's credential is unchanged too — the refused write applied nothing");
  assert.equal(aliceSession.revokedAt, null, "and a refused rotation is not a reuse, so nothing is revoked");
});

// ═════════════════════════════════════════════════════════════════════════════
// R14. Refresh never yields tenant authority
// ═════════════════════════════════════════════════════════════════════════════

test("R14. refresh issues no tenant token, even for a driver who holds an active membership", async () => {
  const driver = await registeredDriver();
  const company = await prisma.company.create({ data: { name: `${TAG}-co`, joinCode: `${TAG}-join-${String(seq)}` } });
  await prisma.companyMembership.create({
    data: { companyId: company.id, userId: driver.userId, role: "driver", active: true },
  });

  const result = await postRefresh(driver.refreshToken);
  assert.equal(result.statusCode, 200, `rotation must succeed — got ${result.raw}`);

  // Refresh restores ACCOUNT identity. Company authority is a separate
  // security event (`/auth/switch-company`), and refresh must not shortcut it.
  assert.equal(field(result.body, "tenantToken"), undefined, "refresh must not mint a tenant token");
  assert.ok(!result.raw.includes(TENANT_AUDIENCE), "and nothing in the body may carry the tenant audience");
  assert.ok(!result.raw.includes(company.id), "nor disclose a company identifier");
});

// ═════════════════════════════════════════════════════════════════════════════
// R15. The grace deadline is a DATABASE predicate, not only a clock check
// ═════════════════════════════════════════════════════════════════════════════

test("R15. the grace deadline is enforced by the atomic DB predicate, not only by the service's clock check", async () => {
  // WHY THIS CASE EXISTS AT THE REPOSITORY LEVEL (F-26).
  //
  // `refresh()` compares `graceUntil` against `now` in JavaScript and revokes
  // before it ever calls the repository, so EVERY route-level expired-window
  // case — R9 included — is answered by that check. The `where` clause's own
  // `previousRefreshTokenGraceUntil: { gt: now }` is therefore never the thing
  // under test through the HTTP surface, and deleting it left the whole suite
  // green.
  //
  // That predicate is the TOCTOU guard: the service reads the deadline and
  // then writes, and a credential whose window closes between those two
  // moments must not rotate. Calling the repository directly, with `now` as
  // the only variable, is the one way to reach the write with an expired
  // deadline and prove the database refuses it.
  const driver = await registeredDriver();
  await postRefresh(driver.refreshToken);   // driver.refreshToken is now PREVIOUS

  const state = await sessionById(driver.sessionId);
  assert.ok(state.previousRefreshTokenGraceUntil !== null, "the rotation must have set a grace deadline");
  const deadline = state.previousRefreshTokenGraceUntil;

  const { refreshRepository } = await import("../../repositories/refreshRepository.js");
  const sessions = refreshRepository(prisma);
  const presentedDigest = digest(driver.refreshToken);
  const insideDigest    = digest(`${TAG}-inside-window`);
  const outsideDigest   = digest(`${TAG}-outside-window`);

  // POSITIVE CONTROL FIRST, so the refusal below is attributable to the
  // deadline rather than to a call that could never have applied.
  const inside = await sessions.rotateFromGrace({
    sessionId: driver.sessionId,
    presentedDigest,
    nextDigest: insideDigest,
    now:        new Date(deadline.getTime() - 1000),
  });
  assert.equal(inside, true, "one second inside the window the recovery rotation must apply");

  // `now` is the ONLY thing that differs. At the deadline the predicate is
  // `graceUntil > now`, which is false, so the write must match no row.
  const outside = await sessions.rotateFromGrace({
    sessionId: driver.sessionId,
    presentedDigest,
    nextDigest: outsideDigest,
    now:        new Date(deadline.getTime()),
  });
  assert.equal(outside, false, "at the deadline the DATABASE must refuse the recovery rotation");

  const afterState = await sessionById(driver.sessionId);
  assert.equal(
    afterState.refreshTokenHash, insideDigest,
    "the refused write applied NOTHING — the current digest is still the one the accepted call wrote",
  );
  assert.notEqual(
    afterState.refreshTokenHash, outsideDigest,
    "and the expired call's digest was never written",
  );
  assert.equal(
    afterState.previousRefreshTokenGraceUntil?.getTime(), deadline.getTime(),
    "a refused recovery cannot move the deadline either",
  );
});
