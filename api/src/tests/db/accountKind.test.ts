/**
 * Account kind (owner decision, 2026-10-01): a DRIVER account (phone) and a
 * COMPANY account (website) are separate accounts. The same email may exist
 * ONCE PER KIND — never twice within one kind — and a matching email never
 * relates the two.
 *
 * This file proves the identity layer only: the column, the per-kind
 * uniqueness, and that every lookup by email names its kind. Which surface
 * accepts which kind is the next increment's.
 *
 * WRITTEN RED.
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the account kind tests");
}

process.env.JWT_SECRET = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV   = "test";
process.env.WEB_ORIGIN = "https://allowed.example.com";

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `account-kind-test-${Date.now()}`;
const DRIVER_PASSWORD = "driver-password-one";
const COMPANY_PASSWORD = "company-password-two";
const UNIQUE_VIOLATION = "23505";
const NOT_NULL_VIOLATION = "23502";

let seq = 0;
function freshEmail(): string {
  seq += 1;
  return `${TAG}-${String(seq)}@example.com`;
}

function sqlStateOf(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error);
  return /Code: `(\w{5})`/.exec(text)?.[1] ?? null;
}

async function insertAccount(kind: "driver" | "company" | null, email: string, password = "unused-password"): Promise<{ id: string; error: unknown }> {
  const id = randomUUID();
  const passwordHash = await hash(password, 4);
  try {
    if (kind === null) {
      await prisma.$executeRaw`
        INSERT INTO "User" ("id", "email", "firstName", "lastName", "passwordHash", "updatedAt")
        VALUES (${id}, ${email}, 'A', 'B', ${passwordHash}, now())`;
    } else {
      await prisma.$executeRaw`
        INSERT INTO "User" ("id", "accountKind", "email", "firstName", "lastName", "passwordHash", "updatedAt")
        VALUES (${id}, ${kind}::"AccountKind", ${email}, 'A', 'B', ${passwordHash}, now())`;
    }
    return { id, error: null };
  } catch (error) {
    return { id, error };
  }
}

async function kindOf(email: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ kind: string }[]>`
    SELECT "accountKind"::text AS kind FROM "User" WHERE email = ${email} ORDER BY 1`;
  return rows.map(r => r.kind);
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

function userIdOf(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  const user: unknown = Reflect.get(body, "user");
  return typeof user === "object" && user !== null ? Reflect.get(user, "id") : undefined;
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(cleanup);
after(async () => { await cleanup(); await prisma.$disconnect(); });

test("AK1. every account has a kind — driver or company — NOT NULL and with NO default", async () => {
  const facts = await prisma.$queryRaw<{ is_nullable: string; column_default: string | null; udt_name: string }[]>`
    SELECT is_nullable, column_default, udt_name FROM information_schema.columns
    WHERE table_name = 'User' AND column_name = 'accountKind'`;
  assert.equal(facts.length, 1, "User must carry accountKind");
  assert.equal(facts[0]?.is_nullable, "NO");
  assert.equal(facts[0]?.column_default, null, "every creation path must state the kind");
  assert.equal(facts[0]?.udt_name, "AccountKind");

  const labels = await prisma.$queryRaw<{ label: string }[]>`
    SELECT enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'AccountKind' ORDER BY e.enumsortorder`;
  assert.deepEqual(labels.map(l => l.label), ["driver", "company"]);

  const unnamed = await insertAccount(null, freshEmail());
  assert.equal(sqlStateOf(unnamed.error), NOT_NULL_VIOLATION, "an account of no kind is refused");
});

test("AK2. one email per KIND: a driver and a company may share it; two of one kind may not, in any casing", async () => {
  const email = freshEmail();
  assert.equal((await insertAccount("driver", email)).error, null);
  assert.equal((await insertAccount("company", email)).error, null, "the same email as a company account is allowed");

  const secondDriver = await insertAccount("driver", email.toUpperCase());
  assert.equal(sqlStateOf(secondDriver.error), UNIQUE_VIOLATION, "a second driver account with that email is refused");
  const secondCompany = await insertAccount("company", `  ${email}`.trim().toUpperCase());
  assert.equal(sqlStateOf(secondCompany.error), UNIQUE_VIOLATION, "a second company account with that email is refused");

  assert.deepEqual(await kindOf(email), ["driver", "company"].sort());
});

test("AK3. phone registration creates a DRIVER account, and is not blocked by a company account with the same email", async () => {
  const email = freshEmail();
  await insertAccount("company", email, COMPANY_PASSWORD);

  const res = await post("/auth/register", { firstName: "Dee", lastName: "River", email, password: DRIVER_PASSWORD });
  assert.equal(res.statusCode, 201, `a company account must not block a driver registration — got ${res.raw}`);
  assert.deepEqual(await kindOf(email), ["company", "driver"]);

  const again = await post("/auth/register", { firstName: "Dee", lastName: "River", email, password: DRIVER_PASSWORD });
  assert.equal(again.statusCode, 409, "a second DRIVER account is still refused");
});

test("AK4. phone login finds the DRIVER account by email — never the company account sharing it", async () => {
  const email = freshEmail();
  // The company account is created FIRST, so an unscoped lookup by email
  // would be likely to find it.
  await insertAccount("company", email, COMPANY_PASSWORD);
  const driver = await post("/auth/register", { firstName: "Dee", lastName: "River", email, password: DRIVER_PASSWORD });
  assert.equal(driver.statusCode, 201);

  const asDriver = await post("/auth/login", { email, password: DRIVER_PASSWORD });
  assert.equal(asDriver.statusCode, 200, `the driver's own password signs the driver in — got ${asDriver.raw}`);
  assert.equal(userIdOf(asDriver.body), userIdOf(driver.body), "and it is the driver account that is signed in");

  const withCompanyPassword = await post("/auth/login", { email, password: COMPANY_PASSWORD });
  assert.equal(withCompanyPassword.statusCode, 401, "the company account's password is not the driver's");
});
