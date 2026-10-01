/**
 * Session client kind — the server-enforced transport boundary between the
 * phone and the browser (owner decision B1, 2026-10-01; D45).
 *
 * A Session is created by exactly one kind of client and keeps that kind for
 * life:
 *
 *   mobile   refresh credential in SecureStore, presented in a JSON BODY
 *   browser  refresh credential in an HttpOnly cookie, never in JavaScript
 *
 * The body endpoint (`POST /auth/refresh`) must therefore redeem MOBILE
 * sessions only. A browser session's secret arriving in a body means it left
 * the cookie — exactly what the browser design exists to prevent — and it
 * must not work there. There is still ONE rotation implementation; the kind
 * is a condition it checks, not a second engine.
 *
 * WRITTEN RED. Before the migration there is no `clientKind` column, and
 * before the service change the body endpoint rotates any session.
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the session client-kind tests");
}

process.env.JWT_SECRET = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV   = "test";
process.env.WEB_ORIGIN = "https://allowed.example.com";

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `client-kind-test-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };
const NOT_NULL_VIOLATION = "23502";
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
function freshEmail(): string {
  seq += 1;
  return `${TAG}-${String(seq)}@example.com`;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface Injected { statusCode: number; body: unknown; raw: string }

async function post(url: string, payload: object): Promise<Injected> {
  const app = await buildApp(prisma);
  try {
    const res = await app.inject({ method: "POST", url, payload });
    return { statusCode: res.statusCode, body: res.body === "" ? null : (JSON.parse(res.body) as unknown), raw: res.body };
  } finally {
    await app.close();
  }
}

function stringField(body: unknown, key: string): string {
  const value: unknown = typeof body === "object" && body !== null ? Reflect.get(body, key) : undefined;
  assert.equal(typeof value, "string", `the response must carry \`${key}\` as a string`);
  return value as string;
}

function sqlStateOf(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error);
  return /Code: `(\w{5})`/.exec(text)?.[1] ?? null;
}

/** The persisted kind, read as text so the test does not depend on the generated enum. */
async function kindOf(sessionId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ kind: string }[]>`
    SELECT "clientKind"::text AS kind FROM "Session" WHERE id = ${sessionId}`;
  return rows[0]?.kind ?? null;
}

/** A registered account, through the shipped mobile registration. */
async function registered(): Promise<{ email: string; userId: string; sessionId: string; refreshToken: string }> {
  const email = freshEmail();
  const res = await post("/auth/register", { firstName: "Ana", lastName: "Kind", email, password: PASSWORD });
  assert.equal(res.statusCode, 201, `registration must succeed — got ${res.raw}`);
  const refreshToken = stringField(res.body, "refreshToken");
  const session = await prisma.session.findUnique({ where: { refreshTokenHash: digest(refreshToken) } });
  assert.ok(session !== null, "registration persisted the session its secret names");
  return { email, userId: session.userId, sessionId: session.id, refreshToken };
}

/**
 * A BROWSER session, seeded directly — on a COMPANY account, because only a
 * company account may hold one (D51: the database refuses a browser session
 * on a driver account). The browser login that creates one is covered in
 * browserSession.test.ts; this file proves the BODY endpoint's refusal
 * independently of it.
 */
async function browserSession(options: { previous?: string } = {}): Promise<{ sessionId: string; refreshToken: string }> {
  const userId = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "User" ("id", "accountKind", "email", "firstName", "lastName", "passwordHash", "updatedAt")
    VALUES (${userId}, 'company'::"AccountKind", ${freshEmail()}, 'Co', 'Admin', 'not-a-real-hash', now())`;
  const refreshToken = randomBytes(32).toString("base64url");
  const sessionId = randomUUID();
  const previousHash = options.previous === undefined ? null : digest(options.previous);
  const graceUntil = options.previous === undefined ? null : new Date(Date.now() + 60_000);
  await prisma.$executeRaw`
    INSERT INTO "Session" ("id", "userId", "accountKind", "clientKind", "expiresAt", "refreshTokenHash",
                           "previousRefreshTokenHash", "previousRefreshTokenGraceUntil", "updatedAt")
    VALUES (${sessionId}, ${userId}, 'company'::"AccountKind", 'browser'::"SessionClientKind", ${new Date(Date.now() + 7 * DAY)},
            ${digest(refreshToken)}, ${previousHash}, ${graceUntil}, now())`;
  return { sessionId, refreshToken };
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(cleanup);
after(async () => { await cleanup(); await prisma.$disconnect(); });

test("K1. every Session names its client kind — the column is NOT NULL and has NO default", async () => {
  const facts = await prisma.$queryRaw<{ is_nullable: string; column_default: string | null; udt_name: string }[]>`
    SELECT is_nullable, column_default, udt_name FROM information_schema.columns
    WHERE table_name = 'Session' AND column_name = 'clientKind'`;
  assert.equal(facts.length, 1, "Session must carry a clientKind column");
  assert.equal(facts[0]?.is_nullable, "NO", "a session of unknown kind must not be representable");
  assert.equal(facts[0]?.column_default, null, "no default: every creation path must state its kind, so none inherits one silently");
  assert.equal(facts[0]?.udt_name, "SessionClientKind", "a closed enum, not free text");

  const labels = await prisma.$queryRaw<{ label: string }[]>`
    SELECT enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'SessionClientKind' ORDER BY e.enumsortorder`;
  assert.deepEqual(labels.map(l => l.label), ["mobile", "browser"]);

  const account = await registered();
  let caught: unknown = null;
  try {
    await prisma.$executeRaw`
      INSERT INTO "Session" ("id", "userId", "expiresAt", "refreshTokenHash", "updatedAt")
      VALUES (${randomUUID()}, ${account.userId}, ${new Date(Date.now() + DAY)}, ${digest(randomUUID())}, now())`;
  } catch (error) {
    caught = error;
  }
  assert.equal(sqlStateOf(caught), NOT_NULL_VIOLATION, "an insert naming no kind must be refused by NOT NULL");
});

test("K2. mobile registration and mobile login create MOBILE sessions with the 90-day lifetime", async () => {
  const account = await registered();
  assert.equal(await kindOf(account.sessionId), "mobile");

  const login = await post("/auth/login", { email: account.email, password: PASSWORD });
  assert.equal(login.statusCode, 200, `login must succeed — got ${login.raw}`);
  const loginSession = await prisma.session.findUnique({ where: { refreshTokenHash: digest(stringField(login.body, "refreshToken")) } });
  assert.ok(loginSession !== null);
  assert.equal(await kindOf(loginSession.id), "mobile");

  // B1: the browser lifetime is NOT applied to the phone.
  for (const session of [await prisma.session.findUniqueOrThrow({ where: { id: account.sessionId } }), loginSession]) {
    const lifetime = session.expiresAt.getTime() - session.createdAt.getTime();
    assert.ok(Math.abs(lifetime - 90 * DAY) < 60_000, `a mobile session lives 90 days, lived ${String(lifetime)}ms`);
  }
});

test("K3. a mobile session still refreshes through the body — positive control", async () => {
  const account = await registered();
  const res = await post("/auth/refresh", { refreshToken: account.refreshToken });
  assert.equal(res.statusCode, 200, `a mobile credential must redeem through the body — got ${res.raw}`);
  assert.equal(await kindOf(account.sessionId), "mobile", "rotation never changes the kind");
});

test("K4. a BROWSER session's CURRENT credential is refused by the body endpoint, and nothing rotates", async () => {
  const browser = await browserSession();
  const prior = await prisma.session.findUniqueOrThrow({ where: { id: browser.sessionId } });

  const res = await post("/auth/refresh", { refreshToken: browser.refreshToken });

  assert.equal(res.statusCode, 401, `a browser secret in a body must not redeem — got ${res.raw}`);
  assert.deepEqual(res.body, CANONICAL_401, "refused exactly as every other refresh failure is");
  const latest = await prisma.session.findUniqueOrThrow({ where: { id: browser.sessionId } });
  assert.equal(latest.refreshTokenHash, prior.refreshTokenHash, "the credential did not rotate");
  assert.equal(latest.previousRefreshTokenHash, null, "no previous digest was written");
  assert.equal(latest.revokedAt, null, "a transport refusal is not a reuse decision — nothing is revoked");
  assert.equal(await kindOf(browser.sessionId), "browser", "a browser session never silently becomes a mobile one");
});

test("K5. a BROWSER session's PREVIOUS credential inside grace is refused by the body endpoint too", async () => {
  const superseded = randomBytes(32).toString("base64url");
  const browser = await browserSession({ previous: superseded });
  const prior = await prisma.session.findUniqueOrThrow({ where: { id: browser.sessionId } });

  const res = await post("/auth/refresh", { refreshToken: superseded });

  assert.equal(res.statusCode, 401, `the grace path must enforce the kind as well — got ${res.raw}`);
  assert.deepEqual(res.body, CANONICAL_401);
  const latest = await prisma.session.findUniqueOrThrow({ where: { id: browser.sessionId } });
  assert.equal(latest.refreshTokenHash, prior.refreshTokenHash, "no recovery rotation happened");
  assert.equal(latest.revokedAt, null);
});

test("K6. the repository's conditional writes restate the kind — a mismatched kind matches no row", async () => {
  // The service refuses a mismatch first, so this proves the WRITE carries the
  // condition too (the F-26 discipline): a caller that got the kind wrong
  // cannot rotate even if the service check were removed.
  const browser = await browserSession();
  const { refreshRepository } = await import("../../repositories/refreshRepository.js");
  const sessions = refreshRepository(prisma);
  const now = new Date();

  const wrongKind = await sessions.rotateCurrent({
    sessionId: browser.sessionId, clientKind: "mobile",
    presentedDigest: digest(browser.refreshToken), nextDigest: digest(`${TAG}-wrong`),
    graceUntil: new Date(now.getTime() + 60_000), now,
  });
  assert.equal(wrongKind, false, "a mobile-transport rotation must not apply to a browser session");

  const rightKind = await sessions.rotateCurrent({
    sessionId: browser.sessionId, clientKind: "browser",
    presentedDigest: digest(browser.refreshToken), nextDigest: digest(`${TAG}-right`),
    graceUntil: new Date(now.getTime() + 60_000), now,
  });
  assert.equal(rightKind, true, "positive control: the matching kind rotates");
});

test("K7. a BROWSER session's stale credential in a body cannot trigger REUSE revocation either", async () => {
  // Without the service's kind check, a browser credential past its grace
  // window would reach reuse detection through the body and revoke the
  // browser session — the body transport would still be able to ACT on a
  // browser session. The conditional writes cannot catch this: revocation is
  // not a rotation. This case is what makes the service check load-bearing.
  const superseded = randomBytes(32).toString("base64url");
  const browser = await browserSession({ previous: superseded });
  await prisma.session.update({
    where: { id: browser.sessionId },
    data:  { previousRefreshTokenGraceUntil: new Date(Date.now() - 1000) },
  });

  const res = await post("/auth/refresh", { refreshToken: superseded });

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, CANONICAL_401);
  const latest = await prisma.session.findUniqueOrThrow({ where: { id: browser.sessionId } });
  assert.equal(latest.revokedAt, null, "the body transport must not be able to revoke a browser session");
});

test("K8. the recovery rotation's conditional write restates the kind as well", async () => {
  const superseded = randomBytes(32).toString("base64url");
  const browser = await browserSession({ previous: superseded });
  const { refreshRepository } = await import("../../repositories/refreshRepository.js");
  const sessions = refreshRepository(prisma);
  const now = new Date();

  const wrongKind = await sessions.rotateFromGrace({
    sessionId: browser.sessionId, clientKind: "mobile",
    presentedDigest: digest(superseded), nextDigest: digest(`${TAG}-grace-wrong`), now,
  });
  assert.equal(wrongKind, false, "a mobile-transport recovery must not apply to a browser session");

  const rightKind = await sessions.rotateFromGrace({
    sessionId: browser.sessionId, clientKind: "browser",
    presentedDigest: digest(superseded), nextDigest: digest(`${TAG}-grace-right`), now,
  });
  assert.equal(rightKind, true, "positive control: the matching kind recovers");
});
