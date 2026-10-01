/**
 * F-18 — `Company.joinCode` is removed, and no company-wide join credential
 * takes its place (owner decision B2, 2026-10-01).
 *
 * WRITTEN RED. Before the removal migration the column is `TEXT NOT NULL
 * UNIQUE`, so creating a company from its name alone is refused by NOT NULL
 * (SQLSTATE 23502) — which is exactly why company creation could not be
 * built without either inventing a permanent plaintext credential or
 * resolving F-18 first.
 *
 * The invariants, all database facts:
 *   1. a Company is created from its name alone — no join credential exists
 *      to be generated, defaulted or stored;
 *   2. no column on Company is a join credential under any spelling, and no
 *      index survives on one.
 *
 * Driver/company invitation and consent are designed separately; nothing
 * here stands in for them.
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the company join-credential tests");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const TAG = `company-join-test-${Date.now()}`;

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "Company" WHERE "name" LIKE ${`${TAG}%`}`;
}

before(cleanup);
after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("J1. a Company is created from its name alone — no join credential is required", async () => {
  // Raw SQL naming only the columns company creation actually knows. Through
  // the generated client this would be a COMPILE error while the column is
  // required, which is not an honest runtime RED; the database is the
  // authority on what a row needs.
  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "Company" ("id", "name", "updatedAt") VALUES (${id}, ${`${TAG}-name-only`}, now())`;

  const row = await prisma.company.findUnique({ where: { id } });
  assert.ok(row !== null, "the company must exist after an insert that names no join credential");
});

test("J2. no Company column or index is a join credential, under any spelling", async () => {
  const columns = await prisma.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'Company' AND column_name ILIKE '%join%'`;
  assert.deepEqual(columns.map(c => c.column_name), [], "Company must carry no join-credential column");

  const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'Company' AND indexdef ILIKE '%join%'`;
  assert.deepEqual(indexes.map(i => i.indexname), [], "no index may survive on a removed join credential");
});
