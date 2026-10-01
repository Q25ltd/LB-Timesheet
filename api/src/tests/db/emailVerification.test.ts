/**
 * Email-ownership verification (owner decision B4, 2026-10-01) — against a
 * REAL database built by the real migrations.
 *
 *   POST /auth/web/register                 also sends a verification email
 *   POST /auth/email-verification           identity — (re)send to MY address
 *   POST /auth/email-verification/confirm   public   — the TOKEN is the credential
 *   GET  /auth/me                           now says whether the email is verified
 *
 * The token: 32 random bytes, delivered once in an email link, stored ONLY as
 * a SHA-256 digest; 24-hour expiry fixed at issue; single use; a newer issue
 * replaces the older (one row per user and purpose, enforced by a unique
 * key); consumption is one conditional write that also stamps
 * `User.emailVerifiedAt`.
 *
 * Login is unchanged: an unverified account authenticates exactly as before,
 * on the phone and in the browser. Verification gates COMPANY CREATION, which
 * is the next increment's.
 *
 * WRITTEN RED.
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import type { MailMessage, Mailer } from "../../lib/mailer.js";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the email verification tests");
}

const ORIGIN = "https://allowed.example.com";
process.env.JWT_SECRET  = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV    = "test";
process.env.WEB_ORIGIN  = ORIGIN;
process.env.WEB_APP_URL = ORIGIN;

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `email-verify-test-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const HOUR = 60 * 60 * 1000;

let seq = 0;
function freshEmail(): string {
  seq += 1;
  return `${TAG}-${String(seq)}@example.com`;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Every message the app sent, in order — the test's inbox. */
const outbox: MailMessage[] = [];
const capturingMailer: Mailer = {
  send(message) {
    outbox.push(message);
    return Promise.resolve();
  },
};

interface Injected { statusCode: number; body: unknown; raw: string }

async function inject(options: { url: string; method?: "GET" | "POST"; payload?: object; token?: string; origin?: boolean }): Promise<Injected> {
  const app = await buildApp(prisma, { mailer: capturingMailer });
  try {
    const headers: Record<string, string> = {};
    if (options.origin !== false) headers["origin"] = ORIGIN;
    if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
    const res = await app.inject({
      method: options.method ?? "POST", url: options.url, headers,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });
    return { statusCode: res.statusCode, body: res.body === "" ? null : (JSON.parse(res.body) as unknown), raw: res.body };
  } finally {
    // Closing settles any email the request scheduled, so the outbox is final.
    await app.close();
  }
}

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? (Reflect.get(body, key) as unknown) : undefined;
}

function stringField(body: unknown, key: string): string {
  const value = field(body, key);
  assert.equal(typeof value, "string", `the response must carry \`${key}\` as a string`);
  return value as string;
}

/** The verification token in the one message sent to `to`, read out of its link. */
function tokenSentTo(to: string, nth = 0): string {
  const messages = outbox.filter(m => m.to === to);
  const message = messages[nth];
  assert.ok(message !== undefined, `expected message #${String(nth)} to ${to}; the outbox holds ${String(messages.length)}`);
  const match = /\/verify-email#token=([A-Za-z0-9_-]+)/.exec(message.text);
  assert.ok(match?.[1] !== undefined, "the message must carry a verification link");
  assert.ok(message.html.includes(`#token=${match[1]}`), "the HTML part carries the same link");
  return match[1];
}

async function webRegistered(): Promise<{ email: string; userId: string; identityToken: string; token: string }> {
  const email = freshEmail();
  const res = await inject({ url: "/auth/web/register", payload: { firstName: "Vera", lastName: "Fied", email, password: PASSWORD } });
  assert.equal(res.statusCode, 201, `web registration must succeed — got ${res.raw}`);
  const user = await prisma.user.findUniqueOrThrow({ where: { accountKind_email: { accountKind: "driver", email } } });
  return { email, userId: user.id, identityToken: stringField(res.body, "identityToken"), token: tokenSentTo(email) };
}

function confirm(token: string): Promise<Injected> {
  return inject({ url: "/auth/email-verification/confirm", payload: { token }, origin: false });
}

async function verifiedAt(userId: string): Promise<Date | null> {
  const rows = await prisma.$queryRaw<{ at: Date | null }[]>`SELECT "emailVerifiedAt" AS at FROM "User" WHERE id = ${userId}`;
  return rows[0]?.at ?? null;
}

function sqlStateOf(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error);
  return /Code: `(\w{5})`/.exec(text)?.[1] ?? null;
}

async function rawInsertToken(values: { userId: string; purpose: string; issuedAt: Date; expiresAt: Date; consumedAt?: Date }): Promise<unknown> {
  try {
    await prisma.$executeRaw`
      INSERT INTO "AccountToken" ("id", "userId", "purpose", "tokenHash", "issuedAt", "expiresAt", "consumedAt")
      VALUES (${randomUUID()}, ${values.userId}, ${values.purpose}::"AccountTokenPurpose", ${digest(randomUUID())},
              ${values.issuedAt}, ${values.expiresAt}, ${values.consumedAt ?? null})`;
    return null;
  } catch (error) {
    return error;
  }
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(async () => { await cleanup(); outbox.length = 0; });
after(async () => { await cleanup(); await prisma.$disconnect(); });

test("V1. web registration sends ONE verification email; the account starts unverified; only a DIGEST is stored", async () => {
  const account = await webRegistered();

  assert.equal(outbox.filter(m => m.to === account.email).length, 1);
  assert.equal(await verifiedAt(account.userId), null, "unverified until the link is used");

  const me = await inject({ method: "GET", url: "/auth/me", token: account.identityToken });
  assert.equal(me.statusCode, 200);
  assert.equal(field(me.body, "emailVerified"), false);

  const rows = await prisma.$queryRaw<{ row: string }[]>`SELECT row_to_json(t)::text AS row FROM "AccountToken" t WHERE "userId" = ${account.userId}`;
  assert.equal(rows.length, 1);
  assert.ok(!(rows[0]?.row ?? "").includes(account.token), "the plaintext token must appear in NO column");
  assert.ok((rows[0]?.row ?? "").includes(digest(account.token)), "what is stored is its SHA-256 digest");
});

test("V2. confirming the token verifies the email, consumes the token, and /auth/me says so", async () => {
  const account = await webRegistered();

  const res = await confirm(account.token);
  assert.equal(res.statusCode, 204, `a fresh token must verify — got ${res.raw}`);

  assert.ok(await verifiedAt(account.userId) !== null);
  const token = await prisma.$queryRaw<{ consumed: boolean }[]>`SELECT "consumedAt" IS NOT NULL AS consumed FROM "AccountToken" WHERE "userId" = ${account.userId}`;
  assert.equal(token[0]?.consumed, true);
  const me = await inject({ method: "GET", url: "/auth/me", token: account.identityToken });
  assert.equal(field(me.body, "emailVerified"), true);
});

test("V3. used, expired, tampered and unknown tokens are refused IDENTICALLY, and change nothing", async () => {
  const used = await webRegistered();
  assert.equal((await confirm(used.token)).statusCode, 204);
  const firstVerifiedAt = await verifiedAt(used.userId);

  const reused = await confirm(used.token);
  assert.equal(reused.statusCode, 400);
  assert.equal(field(reused.body, "code"), "TOKEN_INVALID");
  assert.equal((await verifiedAt(used.userId))?.getTime(), firstVerifiedAt?.getTime(), "the first verification time is kept");

  const expiring = await webRegistered();
  await prisma.$executeRaw`UPDATE "AccountToken" SET "issuedAt" = now() - interval '25 hours', "expiresAt" = now() - interval '1 hour' WHERE "userId" = ${expiring.userId}`;
  const expired = await confirm(expiring.token);
  assert.equal(expired.statusCode, 400);
  assert.equal(await verifiedAt(expiring.userId), null, "an expired token verifies nothing");

  const tampering = await webRegistered();
  const flipped = (tampering.token[0] === "A" ? "B" : "A") + tampering.token.slice(1);
  const tampered = await confirm(flipped);
  assert.equal(await verifiedAt(tampering.userId), null);

  const unknown = await confirm("x".repeat(43));

  for (const res of [expired, tampered, unknown]) {
    assert.equal(res.statusCode, 400);
    assert.equal(res.raw, reused.raw, "every refusal is byte-identical");
  }
});

test("V4. a newer issue SUPERSEDES the older token; one row per user and purpose", async () => {
  const account = await webRegistered();
  const resend = await inject({ url: "/auth/email-verification", token: account.identityToken, origin: false });
  assert.equal(resend.statusCode, 204, `an authenticated resend is accepted — got ${resend.raw}`);
  const newer = tokenSentTo(account.email, 1);
  assert.notEqual(newer, account.token);

  assert.equal((await confirm(account.token)).statusCode, 400, "the superseded token no longer works");
  assert.equal(await verifiedAt(account.userId), null);
  assert.equal((await confirm(newer)).statusCode, 204, "the newest one does");

  const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "AccountToken" WHERE "userId" = ${account.userId}`;
  assert.equal(Number(rows[0]?.n), 1);
});

test("V5. resend is IDENTITY-posture: an anonymous caller is refused; a verified account is sent nothing", async () => {
  const anonymous = await inject({ url: "/auth/email-verification", origin: false });
  assert.equal(anonymous.statusCode, 401);
  assert.deepEqual(anonymous.body, CANONICAL_401);

  const account = await webRegistered();
  assert.equal((await confirm(account.token)).statusCode, 204);
  outbox.length = 0;
  const again = await inject({ url: "/auth/email-verification", token: account.identityToken, origin: false });
  assert.equal(again.statusCode, 204);
  assert.equal(outbox.length, 0, "an already-verified address is not mailed again");
});

test("V6. a phone-registered account is NOT mailed at registration (mobile unchanged) but can verify through resend, and still logs in unverified", async () => {
  const email = freshEmail();
  const registered = await inject({ url: "/auth/register", origin: false, payload: { firstName: "Mo", lastName: "Bile", email, password: PASSWORD } });
  assert.equal(registered.statusCode, 201);
  assert.equal(outbox.length, 0, "mobile registration sends no email");

  const login = await inject({ url: "/auth/login", origin: false, payload: { email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, "an unverified account logs in on the phone");
  const webLogin = await inject({ url: "/auth/web/login", payload: { email, password: PASSWORD } });
  assert.equal(webLogin.statusCode, 200, "and in the browser");

  const resend = await inject({ url: "/auth/email-verification", token: stringField(registered.body, "identityToken"), origin: false });
  assert.equal(resend.statusCode, 204);
  assert.equal((await confirm(tokenSentTo(email))).statusCode, 204);
});

test("V7. two simultaneous confirmations of one token: exactly ONE succeeds", async () => {
  const account = await webRegistered();
  const results = await Promise.all([confirm(account.token), confirm(account.token), confirm(account.token)]);
  assert.deepEqual(results.map(r => r.statusCode).sort(), [204, 400, 400]);
});

test("V8. the DATABASE refuses a second token row, a verification token living past 24 hours, and consumption after expiry", async () => {
  const account = await webRegistered();
  const issuedAt = new Date();

  const second = await rawInsertToken({ userId: account.userId, purpose: "email_verification", issuedAt, expiresAt: new Date(issuedAt.getTime() + HOUR) });
  assert.equal(sqlStateOf(second), UNIQUE_VIOLATION, "one verification token per user, by unique key");

  await prisma.$executeRaw`DELETE FROM "AccountToken" WHERE "userId" = ${account.userId}`;
  const tooLong = await rawInsertToken({ userId: account.userId, purpose: "email_verification", issuedAt, expiresAt: new Date(issuedAt.getTime() + 24 * HOUR + 1000) });
  assert.equal(sqlStateOf(tooLong), CHECK_VIOLATION, "a verification token cannot outlive 24 hours");

  const resetTooLong = await rawInsertToken({ userId: account.userId, purpose: "password_reset", issuedAt, expiresAt: new Date(issuedAt.getTime() + 31 * 60 * 1000) });
  assert.equal(sqlStateOf(resetTooLong), CHECK_VIOLATION, "a reset token cannot outlive 30 minutes");

  const backwards = await rawInsertToken({ userId: account.userId, purpose: "email_verification", issuedAt, expiresAt: issuedAt });
  assert.equal(sqlStateOf(backwards), CHECK_VIOLATION, "a token must expire after it was issued");

  const lateConsume = await rawInsertToken({
    userId: account.userId, purpose: "email_verification", issuedAt,
    expiresAt: new Date(issuedAt.getTime() + HOUR), consumedAt: new Date(issuedAt.getTime() + 2 * HOUR),
  });
  assert.equal(sqlStateOf(lateConsume), CHECK_VIOLATION, "a token cannot be consumed after it expired");

  const valid = await rawInsertToken({ userId: account.userId, purpose: "email_verification", issuedAt, expiresAt: new Date(issuedAt.getTime() + 24 * HOUR) });
  assert.equal(valid, null, "positive control: a well-formed 24-hour token inserts");
});

test("V9. the confirm DTO is strict and bounded", async () => {
  for (const payload of [{}, { token: "" }, { token: "a".repeat(65) }, { token: "abc", userId: "x" }]) {
    const res = await inject({ url: "/auth/email-verification/confirm", payload, origin: false });
    assert.equal(res.statusCode, 400, `refused: ${JSON.stringify(payload)}`);
    assert.equal(field(res.body, "code"), "VALIDATION");
  }
});

test("V10. a token of ANOTHER purpose cannot verify an email, even when live", async () => {
  const account = await webRegistered();
  const resetSecret = `reset-${randomUUID()}`;
  const issuedAt = new Date();
  await prisma.$executeRaw`
    INSERT INTO "AccountToken" ("id", "userId", "purpose", "tokenHash", "issuedAt", "expiresAt")
    VALUES (${randomUUID()}, ${account.userId}, 'password_reset'::"AccountTokenPurpose", ${digest(resetSecret)},
            ${issuedAt}, ${new Date(issuedAt.getTime() + 20 * 60 * 1000)})`;

  const res = await confirm(resetSecret);
  assert.equal(res.statusCode, 400, "a reset token is not an ownership proof");
  assert.equal(await verifiedAt(account.userId), null);
  const reset = await prisma.$queryRaw<{ consumed: boolean }[]>`
    SELECT "consumedAt" IS NOT NULL AS consumed FROM "AccountToken" WHERE "userId" = ${account.userId} AND purpose = 'password_reset'`;
  assert.equal(reset[0]?.consumed, false, "and it is not consumed by the attempt");
});
