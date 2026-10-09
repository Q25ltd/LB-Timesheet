/**
 * Login racing a password replacement — against a REAL database built by the
 * real migrations.
 *
 * A reset revokes EVERY session and a change every OTHER one, so the old
 * password must not be able to open a new session once the replacement has
 * committed. Login verifies the stored hash with ~240 ms of bcrypt and only
 * then inserts the Session, so the replacement can commit inside that window:
 *
 *   LR1  the replacement COMMITS between login's credential read and its
 *        session write — made deterministic by committing it from inside the
 *        read, the way F-26 varies `now` instead of hoping for a race.
 *   LR2  the replacement is IN FLIGHT (hash written, sessions revoked, not yet
 *        committed) when login reaches its write. Without a lock login sees the
 *        committed OLD hash, inserts, and its session outlives the revocation
 *        that was already written.
 *   LR3  control: with no replacement, login still creates exactly one session.
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
import { AppError } from "../../lib/errors.js";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the login race tests");
}

process.env.JWT_SECRET = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV   = "test";
process.env.WEB_ORIGIN = "https://allowed.example.com";

const { buildApp } = await import("../../app.js");
const { login } = await import("../../services/login.js");
const { identityRepository } = await import("../../repositories/identityRepository.js");
const { passwordRepository } = await import("../../repositories/passwordRepository.js");
const { hashPassword } = await import("../../lib/password.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const app = await buildApp(prisma);

const TAG = `login-race-test-${Date.now()}`;
const OLD_PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "a-brand-new-passphrase";

let seq = 0;
async function driver(): Promise<{ userId: string; email: string }> {
  seq += 1;
  const email = `${TAG}-${String(seq)}@example.com`;
  const res = await app.inject({ method: "POST", url: "/auth/register", payload: { firstName: "Race", lastName: "Driver", email, password: OLD_PASSWORD } });
  assert.equal(res.statusCode, 201);
  const user = await prisma.user.findUniqueOrThrow({ where: { accountKind_email: { accountKind: "driver", email } } });
  return { userId: user.id, email };
}

async function liveSessions(userId: string): Promise<number> {
  return prisma.session.count({ where: { userId, revokedAt: null } });
}

/** A live reset token for `userId`, issued now — the plaintext and its digest. */
async function liveResetToken(userId: string): Promise<string> {
  const token = `${TAG}-token-${String(seq)}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const issuedAt = new Date();
  await prisma.accountToken.create({
    data: { userId, purpose: "password_reset", tokenHash, issuedAt, expiresAt: new Date(issuedAt.getTime() + 30 * 60_000) },
  });
  return tokenHash;
}

function isUnauthenticated(error: unknown): boolean {
  return error instanceof AppError && error.statusCode === 401 && error.code === "UNAUTHENTICATED";
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(cleanup);
after(async () => { await cleanup(); await app.close(); await prisma.$disconnect(); });

test("LR1. a reset that COMMITS while login is verifying the old password leaves login refused and no session alive", async () => {
  const { userId, email } = await driver();
  const tokenHash = await liveResetToken(userId);
  const accounts = identityRepository(prisma);
  const passwords = passwordRepository(prisma);
  const replacement = await hashPassword(NEW_PASSWORD);

  // The credential is read, THEN the reset commits — before login has
  // verified the old password and written its session.
  const racing: typeof accounts = {
    ...accounts,
    async findCredentialByEmail(kind, address) {
      const credential = await accounts.findCredentialByEmail(kind, address);
      assert.ok(await passwords.redeemReset({ tokenHash, userId, passwordHash: replacement, now: new Date() }), "the reset applied");
      return credential;
    },
  };

  await assert.rejects(login({ email, password: OLD_PASSWORD }, "mobile", racing, app.jwt), isUnauthenticated,
    "the old password must not open a session after the reset committed");
  assert.equal(await liveSessions(userId), 0, "no session survives the reset");
});

test("LR2. a reset IN FLIGHT when login writes its session: the session never outlives the revocation", async () => {
  const { userId, email } = await driver();
  const replacement = await hashPassword(NEW_PASSWORD);
  const accounts = identityRepository(prisma);

  let loginSettled = false;
  let releaseReset: () => void = () => undefined;
  const loginMayFinish = new Promise<void>(resolve => { releaseReset = resolve; });

  // The reset's own transaction, in its own order: hash, then every session —
  // held open until login has settled or had ample time to reach its write.
  const reset = prisma.$transaction(async tx => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash: replacement } });
    await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await Promise.race([loginMayFinish, new Promise(resolve => setTimeout(resolve, 1500))]);
  }, { timeout: 10_000 });

  // Give the reset's writes a head start, so login reads while they are uncommitted.
  await new Promise(resolve => setTimeout(resolve, 100));
  const attempt = (async () => {
    try {
      await login({ email, password: OLD_PASSWORD }, "mobile", accounts, app.jwt);
      return "authenticated" as const;
    } catch (error: unknown) {
      if (isUnauthenticated(error)) return "refused" as const;
      throw error;
    } finally {
      loginSettled = true;
      releaseReset();
    }
  })();

  await reset;
  const outcome = await attempt;
  assert.ok(loginSettled);
  assert.equal(await liveSessions(userId), 0, `no session may outlive the reset (login ${outcome})`);
  assert.equal(outcome, "refused", "login with the replaced password is refused");
});

test("LR3. control: with no replacement, login with the current password creates exactly one live session", async () => {
  const { userId, email } = await driver();
  const sessionsBefore = await liveSessions(userId);
  const result = await login({ email, password: OLD_PASSWORD }, "mobile", identityRepository(prisma), app.jwt);
  assert.equal(typeof result.result.refreshToken, "string");
  assert.equal(await liveSessions(userId), sessionsBefore + 1);
});
