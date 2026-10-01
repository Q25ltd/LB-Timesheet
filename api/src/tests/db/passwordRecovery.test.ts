/**
 * Password recovery and change (owner decisions B4 token rules, B7 session
 * effects, 2026-10-01) — against a REAL database built by the real migrations.
 *
 *   POST /auth/password/forgot   public    { email }              → 204, always
 *   POST /auth/password/reset    public    { token, password }    → 204 | 400
 *   POST /auth/password/change   identity  { currentPassword, newPassword }
 *
 * Forgot answers identically whether or not the address has an account — the
 * lookup, the token and the email all happen after the reply.
 *
 * Reset: the 30-minute token, stored only as a digest, single use, newest
 * issue wins; the new password is held to the canonical policy; and ONE
 * transaction consumes the token, replaces the hash and revokes EVERY session
 * the account has, so no device stays signed in after a recovery.
 *
 * These are the WEBSITE's flows, so they act on COMPANY accounts (D51). Each
 * fixture also has a DRIVER account with the same email, signed in on a phone,
 * which every case must leave untouched.
 *
 * Change: the authenticated account, its current password, the canonical
 * policy for the new one; every OTHER session revoked, the current one kept.
 * Nobody — no company admin included — can name another account.
 *
 * WRITTEN RED.
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import type { MailMessage, Mailer } from "../../lib/mailer.js";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the password recovery tests");
}

const ORIGIN = "https://allowed.example.com";
process.env.JWT_SECRET  = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV    = "test";
process.env.WEB_ORIGIN  = ORIGIN;
process.env.WEB_APP_URL = ORIGIN;

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `password-recovery-test-${Date.now()}`;
const OLD_PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "a-brand-new-passphrase";
const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };
const CANONICAL_403 = { error: "Not allowed", code: "FORBIDDEN" };

let seq = 0;
function freshEmail(): string {
  seq += 1;
  return `${TAG}-${String(seq)}@example.com`;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const outbox: MailMessage[] = [];
const capturingMailer: Mailer = {
  send(message) {
    outbox.push(message);
    return Promise.resolve();
  },
};

interface Injected { statusCode: number; body: unknown; raw: string; setCookie: string | null }

async function inject(options: { url: string; method?: "GET" | "POST"; payload?: object; token?: string; cookie?: string; origin?: boolean }): Promise<Injected> {
  const app = await buildApp(prisma, { mailer: capturingMailer });
  try {
    const headers: Record<string, string> = {};
    if (options.origin === true) headers["origin"] = ORIGIN;
    if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
    if (options.cookie !== undefined) headers["cookie"] = options.cookie;
    const res = await app.inject({
      method: options.method ?? "POST", url: options.url, headers,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });
    const setCookie = res.headers["set-cookie"];
    return {
      statusCode: res.statusCode,
      body: res.body === "" ? null : (JSON.parse(res.body) as unknown),
      raw: res.body,
      setCookie: typeof setCookie === "string" ? setCookie : null,
    };
  } finally {
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

interface Devices {
  email: string;
  userId: string;
  /** The browser this test acts from. */
  here: { identityToken: string; cookieSecret: string };
  /** A second browser signed in to the SAME company account. */
  other: { identityToken: string; cookieSecret: string };
  /** A separate DRIVER account with the same email, on a phone (D51). */
  driver: { userId: string; refreshToken: string };
}

function cookieSecretOf(res: Injected): string {
  const secret = /^lbts_refresh=([^;]+)/.exec(res.setCookie ?? "")?.[1];
  assert.ok(secret !== undefined, "a browser sign-in sets the refresh cookie");
  return secret;
}

/**
 * One COMPANY account (the website's — D51) signed in on two browsers, and a
 * DRIVER account with the same email signed in on a phone. Website password
 * recovery and change act on the company account; the driver account must
 * come through every case untouched.
 */
async function signedInEverywhere(): Promise<Devices> {
  const email = freshEmail();
  const reg = await inject({ url: "/auth/web/register", origin: true, payload: { firstName: "Pat", lastName: "Word", email, password: OLD_PASSWORD } });
  assert.equal(reg.statusCode, 201);
  const second = await inject({ url: "/auth/web/login", origin: true, payload: { email, password: OLD_PASSWORD } });
  assert.equal(second.statusCode, 200);
  const driver = await inject({ url: "/auth/register", payload: { firstName: "Pat", lastName: "Word", email, password: OLD_PASSWORD } });
  assert.equal(driver.statusCode, 201, "the same email may also be a driver account");
  const user = await prisma.user.findUniqueOrThrow({ where: { accountKind_email: { accountKind: "company", email } } });
  outbox.length = 0;   // registration's verification email is not under test here
  return {
    email, userId: user.id,
    here:   { identityToken: stringField(reg.body, "identityToken"), cookieSecret: cookieSecretOf(reg) },
    other:  { identityToken: stringField(second.body, "identityToken"), cookieSecret: cookieSecretOf(second) },
    driver: { userId: stringField(field(driver.body, "user"), "id"), refreshToken: stringField(driver.body, "refreshToken") },
  };
}

function forgot(email: string): Promise<Injected> {
  return inject({ url: "/auth/password/forgot", payload: { email } });
}

function reset(token: string, password = NEW_PASSWORD): Promise<Injected> {
  return inject({ url: "/auth/password/reset", payload: { token, password } });
}

function resetTokenSentTo(to: string, nth = 0): string {
  const message = outbox.filter(m => m.to === to)[nth];
  assert.ok(message !== undefined, `expected reset message #${String(nth)} to ${to}`);
  const match = /\/reset-password#token=([A-Za-z0-9_-]+)/.exec(message.text);
  assert.ok(match?.[1] !== undefined, "the message must carry a reset link");
  assert.ok(message.html.includes(`#token=${match[1]}`));
  return match[1];
}

/** The COMPANY account signs in on the website with this password. */
async function canLogIn(email: string, password: string): Promise<boolean> {
  return (await inject({ url: "/auth/web/login", origin: true, payload: { email, password } })).statusCode === 200;
}

async function cookieRefreshWorks(secret: string): Promise<boolean> {
  return (await inject({ url: "/auth/web/refresh", origin: true, cookie: `lbts_refresh=${secret}` })).statusCode === 200;
}

/** The same-email DRIVER account: still signs in on the phone with its own password, still refreshes. */
async function driverUntouched(devices: Devices): Promise<boolean> {
  const login = await inject({ url: "/auth/login", payload: { email: devices.email, password: OLD_PASSWORD } });
  const refreshed = await inject({ url: "/auth/refresh", payload: { refreshToken: devices.driver.refreshToken } });
  return login.statusCode === 200 && refreshed.statusCode === 200;
}

async function storedHash(userId: string): Promise<string> {
  return (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).passwordHash;
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(async () => { await cleanup(); outbox.length = 0; });
after(async () => { await cleanup(); await prisma.$disconnect(); });

// ═════════════════════════════════════════════════════════════════════════════
// Forgot
// ═════════════════════════════════════════════════════════════════════════════

test("PR1. forgot answers BYTE-IDENTICALLY for a known and an unknown address; only the account's owner is mailed", async () => {
  const devices = await signedInEverywhere();

  const known = await forgot(devices.email);
  const unknown = await forgot(freshEmail());
  const malformedCase = await forgot(`  ${devices.email.toUpperCase()}  `);

  assert.equal(known.statusCode, 204);
  for (const res of [unknown, malformedCase]) {
    assert.equal(res.statusCode, known.statusCode);
    assert.equal(res.raw, known.raw, "no body difference discloses whether an account exists");
  }
  assert.deepEqual(outbox.map(m => m.to), [devices.email, devices.email], "one message per request for the real account; none for the unknown");
  const driverTokens = await prisma.accountToken.count({ where: { userId: devices.driver.userId } });
  assert.equal(driverTokens, 0, "the website's recovery issues nothing to the DRIVER account sharing the email (D51)");

  const rows = await prisma.$queryRaw<{ row: string }[]>`SELECT row_to_json(t)::text AS row FROM "AccountToken" t WHERE "userId" = ${devices.userId} AND purpose = 'password_reset'`;
  const token = resetTokenSentTo(devices.email, 1);
  assert.equal(rows.length, 1, "one reset row — the second request replaced the first");
  assert.ok(!(rows[0]?.row ?? "").includes(token), "the plaintext appears in no column");
  assert.ok((rows[0]?.row ?? "").includes(digest(token)));
});

// ═════════════════════════════════════════════════════════════════════════════
// Reset
// ═════════════════════════════════════════════════════════════════════════════

test("PR2. reset replaces the company account's password and revokes EVERY one of its sessions in one act — the same-email driver account untouched", async () => {
  const devices = await signedInEverywhere();
  assert.ok(await cookieRefreshWorks(devices.other.cookieSecret));
  const driverHashBefore = await storedHash(devices.driver.userId);
  await forgot(devices.email);

  const res = await reset(resetTokenSentTo(devices.email));

  assert.equal(res.statusCode, 204, `a fresh token resets — got ${res.raw}`);
  assert.ok(await canLogIn(devices.email, NEW_PASSWORD), "the new password works");
  assert.ok(!await canLogIn(devices.email, OLD_PASSWORD), "the old one does not");
  assert.ok(/^\$2[aby]\$12\$/.test(await storedHash(devices.userId)), "bcrypt at the unchanged cost 12");

  const live = await prisma.session.count({ where: { userId: devices.userId, revokedAt: null } });
  // The two `canLogIn` checks above created sessions AFTER the reset; only
  // those may be live. Every session from before is revoked.
  assert.equal(live, 1, "only the session created by logging in with the new password is live");
  assert.ok(!await cookieRefreshWorks(devices.here.cookieSecret), "this browser's cookie is dead");
  assert.ok(!await cookieRefreshWorks(devices.other.cookieSecret), "and the other browser's");
  for (const token of [devices.here.identityToken, devices.other.identityToken]) {
    const me = await inject({ method: "GET", url: "/auth/me", token });
    assert.equal(me.statusCode, 401, "and so is every access token issued before the reset");
  }

  // The DRIVER account with the same email is a different account (D51).
  assert.equal(await storedHash(devices.driver.userId), driverHashBefore, "its password is unchanged");
  assert.ok(await driverUntouched(devices), "and its phone stays signed in");
});

test("PR3. used, expired, tampered, superseded and wrong-purpose tokens are refused identically and change NOTHING", async () => {
  const devices = await signedInEverywhere();
  await forgot(devices.email);
  const first = resetTokenSentTo(devices.email);
  await forgot(devices.email);
  const second = resetTokenSentTo(devices.email, 1);
  const hashBefore = await storedHash(devices.userId);

  const superseded = await reset(first);
  const tampered = await reset((second[0] === "A" ? "B" : "A") + second.slice(1));
  const unknown = await reset("y".repeat(43));
  assert.equal(superseded.statusCode, 400);
  assert.equal(field(superseded.body, "code"), "TOKEN_INVALID");
  for (const res of [tampered, unknown]) assert.equal(res.raw, superseded.raw);
  assert.equal(await storedHash(devices.userId), hashBefore, "nothing changed");
  assert.ok(await cookieRefreshWorks(devices.other.cookieSecret), "and nobody was signed out");

  await prisma.$executeRaw`UPDATE "AccountToken" SET "issuedAt" = now() - interval '40 minutes', "expiresAt" = now() - interval '10 minutes' WHERE "userId" = ${devices.userId}`;
  const expired = await reset(second);
  assert.equal(expired.raw, superseded.raw, "expired is refused identically");
  assert.equal(await storedHash(devices.userId), hashBefore);

  // A fresh token works once, and only once.
  await forgot(devices.email);
  const third = resetTokenSentTo(devices.email, 2);
  assert.equal((await reset(third)).statusCode, 204);
  const reused = await reset(third, "yet-another-passphrase");
  assert.equal(reused.raw, superseded.raw);
  assert.ok(await canLogIn(devices.email, NEW_PASSWORD), "the reuse changed nothing");

  // An email-verification token is not a reset token.
  const signedIn = await inject({ url: "/auth/web/login", origin: true, payload: { email: devices.email, password: NEW_PASSWORD } });
  const verify = await inject({ url: "/auth/email-verification", token: stringField(signedIn.body, "identityToken") });
  assert.equal(verify.statusCode, 204);
  const verificationMessage = outbox.find(m => m.subject.includes("Confirm"));
  const verificationToken = /#token=([A-Za-z0-9_-]+)/.exec(verificationMessage?.text ?? "")?.[1];
  assert.ok(verificationToken !== undefined);
  assert.equal((await reset(verificationToken, "never-applied-password")).raw, superseded.raw);
  assert.ok(await canLogIn(devices.email, NEW_PASSWORD));
});

test("PR4. the new password is held to the canonical policy, and a refused password does NOT spend the token", async () => {
  const devices = await signedInEverywhere();
  await forgot(devices.email);
  const token = resetTokenSentTo(devices.email);

  const tooShort = await reset(token, "short");
  assert.equal(tooShort.statusCode, 400);
  assert.equal(field(tooShort.body, "code"), "VALIDATION");
  // 25 × "é" is 25 characters but 50 bytes; 37 of them is 74 bytes > 72.
  const tooManyBytes = await reset(token, "é".repeat(37));
  assert.equal(tooManyBytes.statusCode, 400, "the cap is 72 UTF-8 BYTES, not characters (D23)");

  assert.equal((await reset(token)).statusCode, 204, "the token survived the refused attempts");
});

test("PR5. two simultaneous resets with one token: exactly ONE applies", async () => {
  const devices = await signedInEverywhere();
  await forgot(devices.email);
  const token = resetTokenSentTo(devices.email);

  const results = await Promise.all([reset(token, "concurrent-one-pass"), reset(token, "concurrent-two-pass")]);
  assert.deepEqual(results.map(r => r.statusCode).sort(), [204, 400]);
  const winner = results[0]?.statusCode === 204 ? "concurrent-one-pass" : "concurrent-two-pass";
  const loser = winner === "concurrent-one-pass" ? "concurrent-two-pass" : "concurrent-one-pass";
  assert.ok(await canLogIn(devices.email, winner));
  assert.ok(!await canLogIn(devices.email, loser), "the refused reset wrote nothing");
});

test("PR6. the reset DTO is strict and bounded", async () => {
  for (const payload of [{}, { token: "abc" }, { password: NEW_PASSWORD }, { token: "", password: NEW_PASSWORD },
    { token: "a".repeat(65), password: NEW_PASSWORD }, { token: "abc", password: NEW_PASSWORD, email: "x@example.com" }]) {
    const res = await inject({ url: "/auth/password/reset", payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
  for (const payload of [{}, { email: "not-an-address" }, { email: "a@example.com", userId: "x" }]) {
    const res = await inject({ url: "/auth/password/forgot", payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Change
// ═════════════════════════════════════════════════════════════════════════════

function change(token: string, payload: object): Promise<Injected> {
  return inject({ url: "/auth/password/change", token, payload });
}

test("PC1. change keeps the CURRENT session and revokes every OTHER one — and never touches the same-email driver account", async () => {
  const devices = await signedInEverywhere();
  // `here` is the browser making the change.
  const res = await change(devices.here.identityToken, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });

  assert.equal(res.statusCode, 204, `a correct current password changes it — got ${res.raw}`);
  assert.ok(await canLogIn(devices.email, NEW_PASSWORD));
  assert.ok(!await canLogIn(devices.email, OLD_PASSWORD));
  assert.ok(/^\$2[aby]\$12\$/.test(await storedHash(devices.userId)), "bcrypt at the unchanged cost 12");

  const me = await inject({ method: "GET", url: "/auth/me", token: devices.here.identityToken });
  assert.equal(me.statusCode, 200, "the session that made the change is still signed in");
  assert.ok(await cookieRefreshWorks(devices.here.cookieSecret), "and can still refresh");
  assert.ok(!await cookieRefreshWorks(devices.other.cookieSecret), "every OTHER session of this account is revoked");
  const otherMe = await inject({ method: "GET", url: "/auth/me", token: devices.other.identityToken });
  assert.equal(otherMe.statusCode, 401);
  assert.ok(await driverUntouched(devices), "the driver account with the same email is a different account (D51)");
});

test("PC2. a wrong current password is the generic 403 and changes nothing", async () => {
  const devices = await signedInEverywhere();
  const hashBefore = await storedHash(devices.userId);
  const res = await change(devices.other.identityToken, { currentPassword: "not-my-password-at-all", newPassword: NEW_PASSWORD });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, CANONICAL_403);
  assert.equal(await storedHash(devices.userId), hashBefore);
  assert.ok(await cookieRefreshWorks(devices.here.cookieSecret), "nobody was signed out");
});

test("PC3. change requires an identity token, the canonical policy, and can name nobody else", async () => {
  const devices = await signedInEverywhere();
  const anonymous = await inject({ url: "/auth/password/change", payload: { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD } });
  assert.equal(anonymous.statusCode, 401);
  assert.deepEqual(anonymous.body, CANONICAL_401);

  assert.equal((await change(devices.other.identityToken, { currentPassword: OLD_PASSWORD, newPassword: "short" })).statusCode, 400);
  assert.equal((await change(devices.other.identityToken, { currentPassword: OLD_PASSWORD, newPassword: "é".repeat(37) })).statusCode, 400);

  const victim = await signedInEverywhere();
  for (const extra of [{ userId: victim.userId }, { email: victim.email }, { membershipId: "m" }, { companyId: "c" }]) {
    const res = await change(devices.other.identityToken, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD, ...extra });
    assert.equal(res.statusCode, 400, `refused, not ignored: ${Object.keys(extra).join(",")}`);
  }
  assert.ok(await canLogIn(victim.email, OLD_PASSWORD), "no other account's password can be touched");
  assert.ok(await canLogIn(devices.email, OLD_PASSWORD), "and the refused requests changed nothing");
});

// ═════════════════════════════════════════════════════════════════════════════
// Atomicity, proven by failing a write INSIDE the transaction
// ═════════════════════════════════════════════════════════════════════════════
//
// PostgreSQL refuses a NUL byte in `text`. Handing the repository one, in the
// value written AFTER the first write has already succeeded, makes the second
// write fail mid-transaction — the one interleaving that distinguishes "both
// or neither" from "whatever happened first".

test("PR7. a reset that fails part-way leaves the token unspent, the password unchanged and every session alive", async () => {
  const devices = await signedInEverywhere();
  await forgot(devices.email);
  const token = resetTokenSentTo(devices.email);
  const hashBefore = await storedHash(devices.userId);
  const { passwordRepository } = await import("../../repositories/passwordRepository.js");

  // The token is consumed first; the hash write then fails.
  await assert.rejects(passwordRepository(prisma).redeemReset({
    tokenHash: digest(token), userId: devices.userId, passwordHash: "bad\u0000hash", now: new Date(),
  }));

  assert.equal(await storedHash(devices.userId), hashBefore);
  assert.ok(await cookieRefreshWorks(devices.other.cookieSecret), "no session was revoked");
  assert.equal((await reset(token)).statusCode, 204, "and the token was NOT consumed — it still works");
});

test("PC4. a change that fails part-way leaves the password unchanged", async () => {
  const devices = await signedInEverywhere();
  const hashBefore = await storedHash(devices.userId);
  const { passwordRepository } = await import("../../repositories/passwordRepository.js");

  // The hash is written first; the session revocation then fails.
  await assert.rejects(passwordRepository(prisma).changePassword({
    userId: devices.userId, keepSessionId: "bad\u0000id", passwordHash: "$2b$12$replacement-hash-that-must-not-land", now: new Date(),
  }));

  assert.equal(await storedHash(devices.userId), hashBefore, "the hash write was rolled back with the failed revocation");
  assert.ok(await canLogIn(devices.email, OLD_PASSWORD));
});
