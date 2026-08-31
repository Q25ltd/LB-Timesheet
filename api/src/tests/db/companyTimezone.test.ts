/**
 * Company timezone authority — the database fact D18 needs before any shift
 * can be filed under a local calendar date.
 *
 * WRITTEN RED, DELIBERATELY. At the time of writing `Company` in
 * prisma/schema.prisma has no timezone field and no migration creates the
 * column, so the `before` hook fails with one precise sentence rather than
 * every assertion failing separately for the same reason.
 *
 * D18: `Shift.shiftDate` is the local calendar date on which the shift
 * started, derived from the start instant in the COMPANY's IANA timezone. The
 * phone is not the authority. That derivation is impossible while no company
 * timezone exists, which is exactly what this file proves is missing.
 *
 * Scope is the persisted authority only. No Start Shift, no route, no Shift
 * row: none of those are authorised yet, and a test reaching for them would
 * fail for reasons that have nothing to do with the schema. The conversion
 * semantics themselves are proven separately and purely in
 * src/lib/timezone.test.ts.
 *
 * The invariants under test, all of them database facts:
 *   1. Company carries a timezone column
 *   2. it is NOT NULL — no company can exist without a filing authority
 *   3. a company created without one gets the V1 default Europe/London
 *   4. the column default is itself a real IANA identifier
 *   5. a materially non-UK timezone persists verbatim — the default is a
 *      default, not an assumption
 *   6. no numeric UTC offset is stored, and nothing else in the schema carries
 *      a competing timezone authority
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { isIanaTimeZone } from "../../lib/timezone.js";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the company timezone tests");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

/**
 * Postgres not_null_violation. Asserted as a CODE for the reason
 * sessionPersistence.test.ts gives: it distinguishes "NOT NULL refused this"
 * from a CHECK (23514) or a unique index (23505), so a passing test cannot be
 * a different rejection wearing the right shape.
 */
const NOT_NULL_VIOLATION = "23502";

const TAG = `company-tz-test-${Date.now()}`;

/** One string field off an unknown row, narrowed rather than cast. */
function stringField(row: unknown, field: string): string | null {
  if (typeof row !== "object" || row === null || !(field in row)) return null;
  const value: unknown = Reflect.get(row, field);
  return typeof value === "string" ? value : null;
}

/**
 * The SQLSTATE behind a Prisma failure, or null when the error does not carry
 * one. The nesting path is the one observed under the PrismaPg driver adapter
 * — see the fuller explanation in sessionPersistence.test.ts.
 *
 * Two key names, both observed rather than assumed: a CHECK violation arrives
 * as `cause.code`, while this NOT NULL violation arrives as
 * `cause.originalCode` alongside `kind: "NullConstraintViolation"`. Reading
 * both keeps the assertion on the five-character Postgres class instead of
 * falling back to failure text, which would pass for any rejection at all.
 */
function sqlStateOf(error: unknown): string | null {
  const path = ["meta", "driverAdapterError", "cause"];
  let current: unknown = error;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) return null;
    current = Reflect.get(current, key);
  }
  if (typeof current !== "object" || current === null) return null;
  for (const key of ["code", "originalCode"]) {
    if (!(key in current)) continue;
    const code: unknown = Reflect.get(current, key);
    if (typeof code === "string") return code;
  }
  return null;
}

interface ColumnFacts {
  isNullable: string;
  columnDefault: string | null;
}

/** Read from the catalogue rather than assumed from the Prisma schema text. */
async function columnFacts(table: string, column: string): Promise<ColumnFacts | null> {
  const rows = await prisma.$queryRaw<unknown[]>`
    SELECT is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
  `;
  const row = rows[0];
  if (row === undefined) return null;
  const isNullable = stringField(row, "is_nullable");
  if (isNullable === null) return null;
  return { isNullable, columnDefault: stringField(row, "column_default") };
}

async function columnNames(table: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<unknown[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
  `;
  return rows.map(row => stringField(row, "column_name")).filter((n): n is string => n !== null);
}

async function cleanup(): Promise<void> {
  await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
}

before(async () => {
  assert.ok(
    (await columnFacts("Company", "timezone")) !== null,
    'the "Company" table has no "timezone" column. The company IANA timezone authority D18 ' +
    "requires has not been built yet — no field in prisma/schema.prisma, no migration adding " +
    "the column. Every test in this file depends on it, so they are all failing for this one " +
    "reason, and no shift date can be derived correctly until it exists.",
  );
  await cleanup();
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

// ── 2. Every company has a filing authority, always ─────────────────────────
// A nullable column would mean "some companies have no timezone", and shift
// creation would then need a fallback — which is precisely the device-timezone
// or hard-coded-UK assumption D18 forbids.
test("Company.timezone is NOT NULL and PostgreSQL refuses to blank it", async () => {
  const facts = await columnFacts("Company", "timezone");
  assert.notEqual(facts, null);
  assert.equal(facts?.isNullable, "NO", "a company without a timezone must not be representable");

  const company = await prisma.company.create({
    data: { name: `${TAG}-not-null`, joinCode: `${TAG}-not-null` },
  });

  let caught: unknown = null;
  try {
    await prisma.$executeRaw`UPDATE "Company" SET "timezone" = NULL WHERE "id" = ${company.id}`;
  } catch (error) {
    caught = error;
  }
  assert.notEqual(caught, null, "the database accepted a NULL timezone");
  assert.equal(
    sqlStateOf(caught),
    NOT_NULL_VIOLATION,
    `blanking the timezone must be refused by NOT NULL (SQLSTATE ${NOT_NULL_VIOLATION})`,
  );
});

// ── 3 & 4. The V1 default exists in the database, and is a real zone ────────
test("a Company created without a timezone gets the V1 default Europe/London", async () => {
  const company = await prisma.company.create({
    data: { name: `${TAG}-default`, joinCode: `${TAG}-default` },
  });
  assert.equal(company.timezone, "Europe/London");

  // Read back from the database, not from the client's own return value: the
  // default has to be the DATABASE's, so that a write which never mentions the
  // column still lands a usable authority.
  const persisted = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  assert.equal(persisted.timezone, "Europe/London");
});

test("the column default stored in PostgreSQL is a real IANA identifier", async () => {
  const facts = await columnFacts("Company", "timezone");
  const rendered = facts?.columnDefault ?? "";
  // Postgres renders a text default as 'Europe/London'::text.
  const literal = /^'(.*)'::/.exec(rendered)?.[1] ?? "";
  assert.notEqual(literal, "", `unexpected default rendering: ${rendered}`);
  assert.ok(
    isIanaTimeZone(literal),
    `the database default ${literal} must itself be a valid IANA timezone identifier`,
  );
});

// ── 5. Europe/London is a default, not an assumption ────────────────────────
test("a materially non-UK company timezone persists verbatim", async () => {
  for (const timezone of ["Europe/Vilnius", "America/New_York", "Asia/Dubai", "Australia/Sydney"]) {
    const company = await prisma.company.create({
      data: { name: `${TAG}-${timezone}`, joinCode: `${TAG}-${timezone}`, timezone },
    });
    const persisted = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
    assert.equal(
      persisted.timezone,
      timezone,
      "the identifier must round-trip unchanged — not normalised, not converted to an offset",
    );
    assert.ok(isIanaTimeZone(persisted.timezone));
  }
});

// ── 6. One timezone authority, and it is an identifier ──────────────────────
test("the timezone authority exists once, on Company, and nowhere else", async () => {
  assert.ok((await columnNames("Company")).includes("timezone"));

  for (const table of ["Shift", "ShiftSegment", "ShiftSubmitJob", "User", "CompanyMembership", "Session"]) {
    const columns = await columnNames(table);
    assert.equal(
      columns.some(name => name.toLowerCase().includes("timezone") || name.toLowerCase().includes("utcoffset")),
      false,
      `${table} must not carry a competing timezone authority — the company's is the only one (D18)`,
    );
  }

  // A numeric offset cannot express a zone: +01:00 is Europe/London in July
  // and Europe/Berlin in January, and DST makes it wrong twice a year.
  const stored = await prisma.company.findMany({
    where: { name: { startsWith: TAG } },
    select: { timezone: true },
  });
  for (const { timezone } of stored) {
    assert.equal(/^[+−-]/.test(timezone), false, "an offset must never be stored as the authority");
  }
});
