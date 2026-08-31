/**
 * P1.2a RED — the protected-request pipeline against REAL persisted rows.
 *
 * Deliberately small. `src/lib/auth.test.ts` specifies the pipeline's
 * behaviour with injected fixtures; this file proves the other half: that the
 * pipeline resolves a real `Session` and a real `CompanyMembership` out of
 * PostgreSQL — rows created by the same migrations the product deploys.
 * Duplicating all six cases here would buy nothing and slow the gate.
 *
 * Two cases only:
 *   1. a persisted live Session + active CompanyMembership authenticate
 *   2. a token whose companyId disagrees with the persisted membership is
 *      refused (with a positive control, so it is not vacuously green)
 *
 * WRITTEN RED. `requireAuth` is a stub that reads nothing and `request.auth`
 * does not exist, so both fail today. No production interface is invented
 * here: `buildApp` already takes a structural database, and the real
 * PrismaClient satisfies it.
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the protected-request database tests");
}

// Set before app.js is imported — env.ts validates at import and exits on
// failure. DATABASE_URL is left exactly as the db-check runner supplied it.
process.env.JWT_SECRET = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV   = "test";
process.env.WEB_ORIGIN = "https://allowed.example.com";

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const SECRET = process.env.JWT_SECRET;

const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };
const TAG = `auth-req-test-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;

// The tests construct tokens independently so RED specifies the frozen token
// contract without depending on a production authentication implementation.
function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function signToken(claims: Record<string, string | number>): string {
  const header    = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload   = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function claimsFor(companyId: string): Record<string, string | number> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    sub:          userId,
    companyId,
    membershipId,
    sessionId,
    iat:          nowSeconds,
    exp:          nowSeconds + 15 * 60,
    iss:          "logisticbay-timesheets",
    aud:          "timesheets-api",
  };
}

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

let userId = "";
let companyId = "";
let otherCompanyId = "";
let membershipId = "";
let sessionId = "";

async function cleanup(): Promise<void> {
  // Sessions go with the user by the cascade proven in sessionPersistence.
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
}

before(async () => {
  await cleanup();
  const company = await prisma.company.create({ data: { name: `${TAG}-A`, joinCode: `${TAG}-A` } });
  const other   = await prisma.company.create({ data: { name: `${TAG}-B`, joinCode: `${TAG}-B` } });
  const user    = await prisma.user.create({
    data: { email: `${TAG}-driver@example.com`, name: `${TAG}-driver`, passwordHash: "not-a-real-hash" },
  });
  // role admin, while the token carries no role at all — so observing "admin"
  // can only mean the pipeline read this row.
  const membership = await prisma.companyMembership.create({
    data: { companyId: company.id, userId: user.id, role: "admin", active: true },
  });
  const session = await prisma.session.create({
    data: {
      userId:           user.id,
      expiresAt:        new Date(Date.now() + 90 * DAY),
      refreshTokenHash: createHmac("sha256", TAG).update("refresh").digest("hex"),
    },
  });

  companyId      = company.id;
  otherCompanyId = other.id;
  userId         = user.id;
  membershipId   = membership.id;
  sessionId      = session.id;
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

/** No config — the probe inherits F-10 default-deny, and is never made public. */
async function get(token: string) {
  const app = await buildApp(prisma);
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

test("a persisted live Session and active CompanyMembership authenticate a real protected request", async () => {
  const res = await get(signToken(claimsFor(companyId)));

  assert.equal(res.statusCode, 200, "a real session and membership must authenticate");
  const { auth } = AuthSnapshot.parse(res.json());
  assert.deepEqual(auth, {
    userId,
    companyId,
    membershipId,
    sessionId,
    role:             "admin",
    membershipStatus: "active",
  });
});

test("a token whose companyId disagrees with the persisted membership is refused, while the matching one succeeds", async () => {
  const control = await get(signToken(claimsFor(companyId)));
  assert.equal(control.statusCode, 200, "positive control: the matching company must authenticate");

  const res = await get(signToken(claimsFor(otherCompanyId)));
  assert.equal(res.statusCode, 401, "a real membership in company A must never authorise a token claiming company B");
  assert.deepEqual(res.json(), CANONICAL_401);
});
