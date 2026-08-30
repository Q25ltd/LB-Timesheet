/**
 * db-smoke — prove the CONFIGURED database (normally your local dev
 * `lb_timesheet`) actually enforces the tenant-integrity guarantees this repo
 * depends on: the composite foreign keys, the closed MembershipRole
 * vocabulary, and the one-open-shift-per-user partial index.
 *
 * This is deliberately not `npm run test:db`. That command builds and
 * discards its own throwaway `lb_timesheet_check` database — it proves the
 * migrations themselves are correct, but never touches the database a
 * developer actually runs the app against. This script closes that gap: it
 * runs the same class of proof against whatever DATABASE_URL is configured,
 * so "CI is green" and "my dev database actually works" stop being two
 * different claims.
 *
 * Because it writes to a real, non-throwaway database, it fails closed
 * before opening a connection unless BOTH:
 *   - NODE_ENV is explicitly "development" or "test", and
 *   - the target is localhost/127.0.0.1 and named "lb_timesheet" or
 *     "lb_timesheet_check".
 *
 * All fixture writes happen inside one transaction. A bare Postgres
 * transaction is poisoned after its first error — every later statement
 * fails with 25P02 regardless of what it is — so each operation expected to
 * fail runs inside its own SAVEPOINT, rolled back to on failure, letting the
 * next check run cleanly. The whole transaction is then rolled back, and a
 * query outside it proves no tagged row survived: atomic cleanup plus a
 * postcondition check, not cleanup by convention.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { PrismaClient } from "../src/generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(API_ROOT, ".env") });

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1"]);
const ALLOWED_DATABASES = new Set(["lb_timesheet", "lb_timesheet_check"]);

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") {
  console.error("db-smoke: DATABASE_URL must be set");
  process.exit(1);
}

// Guards run — and can exit the process — before any connection is opened.
const nodeEnv = process.env.NODE_ENV;
if (nodeEnv !== "development" && nodeEnv !== "test") {
  console.error(
    `db-smoke: refusing to run — NODE_ENV is "${nodeEnv ?? "unset"}", must be exactly "development" or "test".`,
  );
  process.exit(1);
}

const target = new URL(databaseUrl);
const targetDatabase = target.pathname.replace(/^\//, "");
if (!ALLOWED_HOSTS.has(target.hostname) || !ALLOWED_DATABASES.has(targetDatabase)) {
  console.error(
    `db-smoke: refusing to run — target is "${target.hostname}/${targetDatabase}". ` +
      `Only localhost/127.0.0.1 with database "lb_timesheet" or "lb_timesheet_check" are permitted.`,
  );
  process.exit(1);
}

const TAG = `smoke-${Date.now()}`;

class IntentionalRollback extends Error {}

function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    return typeof err.code === "string" ? err.code : undefined;
  }
  return undefined;
}

async function main(url: string): Promise<void> {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  console.log(`db-smoke: target = ${target.hostname}/${targetDatabase}`);
  console.log("db-smoke: running tagged fixture checks inside a transaction that will be rolled back...\n");

  try {
    await prisma.$transaction(async tx => {
      let savepointCounter = 0;

      async function assertRejectsWithCode(
        operation: () => Promise<unknown>,
        expectedCode: string,
        description: string,
      ): Promise<void> {
        const savepoint = `sp_${savepointCounter}`;
        savepointCounter += 1;
        await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
        try {
          await operation();
        } catch (err) {
          await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          const code = errorCode(err);
          if (code === expectedCode) {
            console.log(`  ok   ${description} (rejected with ${expectedCode})`);
            return;
          }
          throw new Error(`${description}: expected Prisma error code ${expectedCode}, got ${code ?? String(err)}`);
        }
        await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
        throw new Error(`${description}: expected rejection with code ${expectedCode}, but the write succeeded`);
      }

      const company = await tx.company.create({ data: { name: `${TAG}-A`, joinCode: `${TAG}-A` } });
      const otherCompany = await tx.company.create({ data: { name: `${TAG}-B`, joinCode: `${TAG}-B` } });
      const driver = await tx.user.create({
        data: { email: `${TAG}-driver@example.com`, name: TAG, passwordHash: "not-a-real-hash" },
      });
      const membership = await tx.companyMembership.create({
        data: { companyId: company.id, userId: driver.id, role: "driver" },
      });

      await assertRejectsWithCode(
        () => tx.$executeRaw`UPDATE "CompanyMembership" SET "role" = 'owner' WHERE "id" = ${membership.id}`,
        "P2010",
        "MembershipRole rejects a value outside driver | admin",
      );

      await assertRejectsWithCode(
        () =>
          tx.shift.create({
            data: {
              membershipId: membership.id,
              companyId: otherCompany.id, // mismatched on purpose
              userId: driver.id,
              driverName: TAG,
              shiftDate: new Date("2026-01-01T00:00:00.000Z"),
              startedAt: new Date("2026-01-01T06:00:00.000Z"),
            },
          }),
        "P2003",
        "the composite FK rejects a Shift whose companyId disagrees with its membership",
      );

      await tx.shift.create({
        data: {
          membershipId: membership.id,
          companyId: company.id,
          userId: driver.id,
          driverName: TAG,
          shiftDate: new Date("2026-01-01T00:00:00.000Z"),
          startedAt: new Date("2026-01-01T06:00:00.000Z"),
        },
      });

      await assertRejectsWithCode(
        () =>
          tx.shift.create({
            data: {
              membershipId: membership.id,
              companyId: company.id,
              userId: driver.id,
              driverName: TAG,
              shiftDate: new Date("2026-01-02T00:00:00.000Z"),
              startedAt: new Date("2026-01-02T06:00:00.000Z"),
            },
          }),
        "P2002",
        "the partial index rejects a second open shift for the same user",
      );

      // Every guarantee held. Abort the whole transaction on purpose — none
      // of the fixtures above, valid or rejected, should survive.
      throw new IntentionalRollback();
    });
  } catch (err) {
    if (!(err instanceof IntentionalRollback)) {
      console.error("\ndb-smoke: FAILED");
      console.error(err instanceof Error ? err.message : err);
      await prisma.$disconnect();
      process.exit(1);
    }
  }

  const [residualCompanies, residualUsers] = await Promise.all([
    prisma.company.count({ where: { name: { startsWith: TAG } } }),
    prisma.user.count({ where: { email: { startsWith: TAG } } }),
  ]);

  await prisma.$disconnect();

  if (residualCompanies > 0 || residualUsers > 0) {
    console.error(
      `\ndb-smoke: FAILED — rollback left residue (companies=${residualCompanies}, users=${residualUsers})`,
    );
    process.exit(1);
  }

  console.log("\ndb-smoke: OK — guards enforced, all three constraints proved, zero residue after rollback");
}

await main(databaseUrl);
