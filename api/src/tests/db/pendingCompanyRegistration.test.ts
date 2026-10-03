/**
 * Pending company registration — the persistence foundation for company-first
 * registration (D51; increment 3 of its build).
 *
 * A company ACCOUNT that has given its company's name, but whose email has not
 * yet been confirmed, holds ONE pending registration. It is not a Company:
 * storing it creates no Company and no membership. (Increment 4 will confirm
 * the email, create the Company and the initial administrator membership, and
 * remove the pending row — all in one transaction. Nothing here does that.)
 *
 * Guaranteed by the DATABASE:
 *   - only a COMPANY account can own one (composite foreign key to
 *     User(id, accountKind) plus a CHECK that the kind is `company`);
 *   - at most ONE per company account (unique on the account) — which says
 *     nothing about how many administrators a Company may later have;
 *   - the company name is 1–200 characters with no leading or trailing
 *     whitespace. Names are NOT unique: two companies may share one.
 *
 *   - the company's TIMEZONE is required and has the shape of an IANA place —
 *     Area/Location — never an offset, UTC or an Etc/ zone (D53). Whether the
 *     runtime resolves it is the application's check (`isCompanyTimeZone`);
 *     the database refuses what can never be one.
 *
 * No expiry and no clean-up: an unconfirmed registration stays (O1 open).
 *
 * WRITTEN RED — raw SQL throughout, so it does not depend on generated code.
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
  throw new Error("DATABASE_URL must be set to run the pending company registration tests");
}

process.env.JWT_SECRET = "4f8a1c9e2b7d6053e9a8c1f4b2d70e6a5c3f9b1d8e0a7c24";
process.env.NODE_ENV   = "test";
process.env.WEB_ORIGIN = "https://allowed.example.com";

const { buildApp } = await import("../../app.js");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `pending-company-test-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";
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

async function account(kind: "driver" | "company", email = freshEmail()): Promise<string> {
  const id = randomUUID();
  const passwordHash = await hash(PASSWORD, 4);
  await prisma.$executeRaw`
    INSERT INTO "User" ("id", "accountKind", "email", "firstName", "lastName", "passwordHash", "updatedAt")
    VALUES (${id}, ${kind}::"AccountKind", ${email}, 'Ada', 'Admin', ${passwordHash}, now())`;
  return id;
}

/**
 * Insert a pending registration; null on success, the error otherwise. The
 * company's timezone defaults to a NON-UK zone: nothing about a pending
 * registration is British (D52, D53).
 */
async function pending(userId: string, kind: "driver" | "company", companyName: string, timezone = "America/Chicago"): Promise<unknown> {
  try {
    await prisma.$executeRaw`
      INSERT INTO "PendingCompanyRegistration" ("id", "userId", "accountKind", "companyName", "timezone")
      VALUES (${randomUUID()}, ${userId}, ${kind}::"AccountKind", ${companyName}, ${timezone})`;
    return null;
  } catch (error) {
    return error;
  }
}

async function storedNames(userId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    SELECT "companyName" AS name FROM "PendingCompanyRegistration" WHERE "userId" = ${userId}`;
  return rows.map(r => r.name);
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "Company" WHERE name LIKE ${`${TAG}%`}`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE email LIKE ${`${TAG}%`}`;
}

before(cleanup);
beforeEach(cleanup);
after(async () => { await cleanup(); await prisma.$disconnect(); });

test("P1. a company account can own a pending registration, stored exactly as given — and it has a creation time", async () => {
  const owner = await account("company");
  assert.equal(await pending(owner, "company", "Kuizinas Haulage Ltd"), null);

  const rows = await prisma.$queryRaw<{ name: string; created: Date | null }[]>`
    SELECT "companyName" AS name, "createdAt" AS created FROM "PendingCompanyRegistration" WHERE "userId" = ${owner}`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.name, "Kuizinas Haulage Ltd", "spelling and casing are kept");
  assert.ok(rows[0]?.created instanceof Date, "the database stamps when it was created");
});

test("P2. a DRIVER account can never own a pending registration — refused by the database", async () => {
  const driver = await account("driver");
  // Claiming its true kind: refused by the CHECK (only `company` may own one).
  assert.equal(sqlStateOf(await pending(driver, "driver", "Driver Co")), CHECK_VIOLATION);
  // Claiming to be a company: refused by the composite foreign key.
  assert.equal(sqlStateOf(await pending(driver, "company", "Driver Co")), FK_VIOLATION);
  assert.deepEqual(await storedNames(driver), []);
});

test("P3. a company account holds at most ONE pending registration", async () => {
  const owner = await account("company");
  assert.equal(await pending(owner, "company", "First Name Ltd"), null);
  assert.equal(sqlStateOf(await pending(owner, "company", "Second Name Ltd")), UNIQUE_VIOLATION);
  assert.deepEqual(await storedNames(owner), ["First Name Ltd"]);
});

test("P4. company names are NOT unique — two company accounts may register the same name", async () => {
  const a = await account("company");
  const b = await account("company");
  assert.equal(await pending(a, "company", "Same Name Haulage"), null);
  assert.equal(await pending(b, "company", "Same Name Haulage"), null);
});

test("P5. the name is at most 200 characters — 200 accepted, 201 refused, counted in characters", async () => {
  const at = await account("company");
  const over = await account("company");
  const accented = await account("company");
  assert.equal(await pending(at, "company", "x".repeat(200)), null);
  assert.equal(sqlStateOf(await pending(over, "company", "x".repeat(201))), CHECK_VIOLATION);
  // 200 accented characters are 400 bytes: the limit is characters, as the form's is.
  assert.equal(await pending(accented, "company", "é".repeat(200)), null);
});

test("P6. an empty or whitespace-only name is refused", async () => {
  const owner = await account("company");
  for (const name of ["", " ", "   ", "\t", "\n"]) {
    assert.equal(sqlStateOf(await pending(owner, "company", name)), CHECK_VIOLATION, `refused: ${JSON.stringify(name)}`);
  }
  assert.deepEqual(await storedNames(owner), []);
});

test("P7. a stored name is always trimmed — leading or trailing whitespace is refused; inner spacing is kept", async () => {
  const owner = await account("company");
  for (const name of [" Acme", "Acme ", "  Acme  ", "\tAcme", "Acme\n"]) {
    assert.equal(sqlStateOf(await pending(owner, "company", name)), CHECK_VIOLATION, `refused: ${JSON.stringify(name)}`);
  }
  assert.equal(await pending(owner, "company", "Acme  Road   Haulage"), null, "spacing inside the name is the owner's spelling");
  assert.deepEqual(await storedNames(owner), ["Acme  Road   Haulage"]);
});

test("P8 + P9. storing a pending registration creates NO Company and NO membership", async () => {
  const owner = await account("company");
  const name = `${TAG}-not-yet-a-company`;

  assert.equal(await pending(owner, "company", name), null);

  assert.equal(await prisma.company.count({ where: { name } }), 0, "no Company carries the pending name");
  assert.equal(await prisma.companyMembership.count({ where: { userId: owner } }), 0, "the account holds no membership");
});

test("P10. a pending company registration changes nothing for the DRIVER account sharing its email", async () => {
  const email = freshEmail();
  const app = await buildApp(prisma);
  try {
    const driver = await app.inject({ method: "POST", url: "/auth/register", payload: { firstName: "Dee", lastName: "River", email, password: PASSWORD } });
    assert.equal(driver.statusCode, 201);
    const company = await account("company", email);
    assert.equal(await pending(company, "company", "Same Email Haulage"), null);

    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: PASSWORD } });
    assert.equal(login.statusCode, 200, "the driver still signs in on the phone");
    const body: unknown = login.json();
    assert.ok(typeof body === "object" && body !== null);
    assert.deepEqual(Reflect.get(body, "memberships"), [], "and gains no company from the pending registration");
    assert.equal(Reflect.get(body, "tenantToken"), undefined);
  } finally {
    await app.close();
  }
});

test("P11. deleting the company account removes its pending registration with it", async () => {
  const owner = await account("company");
  assert.equal(await pending(owner, "company", "Short Lived Ltd"), null);
  await prisma.$executeRaw`DELETE FROM "User" WHERE id = ${owner}`;
  assert.deepEqual(await storedNames(owner), []);
});

test("P12. exactly ONE uniqueness rule enforces one-per-account — the (userId, accountKind) key Prisma's one-to-one relation needs, and no redundant second index", async () => {
  // The catalog, not behaviour: a duplicate insert is refused whether one
  // unique index exists or two, so only the metadata can tell them apart.
  const unique = await prisma.$queryRaw<{ name: string; columns: string }[]>`
    SELECT i.relname AS name,
           string_agg(a.attname, ',' ORDER BY array_position(x.indkey::int2[], a.attnum)) AS columns
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (x.indkey)
     WHERE t.relname = 'PendingCompanyRegistration' AND x.indisunique AND NOT x.indisprimary
     GROUP BY i.relname
     ORDER BY i.relname`;
  assert.deepEqual(unique, [{ name: "PendingCompanyRegistration_userId_accountKind_key", columns: "userId,accountKind" }]);

  // It is enough on its own: the composite foreign key gives each userId one
  // possible accountKind, so (userId, accountKind) is unique iff userId is.
  const owner = await account("company");
  assert.equal(await pending(owner, "company", "Only Once Ltd"), null);
  assert.equal(sqlStateOf(await pending(owner, "company", "Twice Ltd")), UNIQUE_VIOLATION);
});

// ═════════════════════════════════════════════════════════════════════════════
// The company's timezone (D53) — chosen at registration, held until the
// Company exists, and copied into it then (increment 4)
// ═════════════════════════════════════════════════════════════════════════════

async function storedTimezone(userId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ timezone: string }[]>`
    SELECT "timezone" FROM "PendingCompanyRegistration" WHERE "userId" = ${userId}`;
  return rows[0]?.timezone ?? null;
}

test("P13. a pending registration holds the company's chosen timezone — a non-UK place, exactly as chosen", async () => {
  const tokyo = await account("company");
  const kyiv = await account("company");
  assert.equal(await pending(tokyo, "company", "Tokyo Haulage KK", "Asia/Tokyo"), null);
  assert.equal(await pending(kyiv, "company", "Kyiv Freight", "Europe/Kyiv"), null);
  assert.equal(await storedTimezone(tokyo), "Asia/Tokyo");
  assert.equal(await storedTimezone(kyiv), "Europe/Kyiv", "kept as chosen, never rewritten to another name for the zone");
});

test("P14. the timezone is REQUIRED — there is no default, and certainly not Europe/London", async () => {
  const owner = await account("company");
  let error: unknown = null;
  try {
    await prisma.$executeRaw`
      INSERT INTO "PendingCompanyRegistration" ("id", "userId", "accountKind", "companyName")
      VALUES (${randomUUID()}, ${owner}, 'company'::"AccountKind", 'No Zone Ltd')`;
  } catch (caught) {
    error = caught;
  }
  assert.equal(sqlStateOf(error), NOT_NULL_VIOLATION, "a missing timezone is refused, not defaulted");
  assert.deepEqual(await storedNames(owner), []);
});

test("P15. what can never be a company's zone is refused by the database — offsets, UTC, Etc/, abbreviations, junk", async () => {
  const owner = await account("company");
  for (const zone of ["", "+01:00", "-05:00", "UTC+1", "UTC", "GMT", "Etc/GMT+5", "Etc/UTC", "BST",
    "europe/london", "Europe/London ", "Europe//London", "Europe/", `Europe/${"x".repeat(80)}`]) {
    assert.equal(sqlStateOf(await pending(owner, "company", "Bad Zone Ltd", zone)), CHECK_VIOLATION, `refused: ${JSON.stringify(zone)}`);
  }
  assert.deepEqual(await storedNames(owner), []);
});

test("P16. the timezone belongs to the REGISTRATION, not the administrator — no Company, no membership, and the account is unchanged", async () => {
  const owner = await account("company");
  const accountBefore = await prisma.$queryRaw<{ row: string }[]>`SELECT row_to_json(u)::text AS row FROM "User" u WHERE id = ${owner}`;
  assert.equal(await pending(owner, "company", `${TAG}-zone-co`, "Australia/Sydney"), null);
  const accountAfter = await prisma.$queryRaw<{ row: string }[]>`SELECT row_to_json(u)::text AS row FROM "User" u WHERE id = ${owner}`;
  assert.deepEqual(accountAfter, accountBefore, "the account carries no timezone of its own");
  assert.equal(await prisma.company.count({ where: { name: `${TAG}-zone-co` } }), 0);
  assert.equal(await prisma.companyMembership.count({ where: { userId: owner } }), 0);
});
