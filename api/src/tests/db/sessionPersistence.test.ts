/**
 * Session persistence foundation — the database facts AUTH.md's Session
 * concept needs before any authentication code exists.
 *
 * WRITTEN RED, DELIBERATELY. At the time of writing there is no Session model
 * in prisma/schema.prisma and no migration creating the table, so every
 * assertion here is expected to fail. The `before` hook exists to make that
 * failure ONE precise sentence rather than nine confusing TypeErrors from
 * reaching through an undefined client model.
 *
 * Scope is persistence only. No JWT, no requireAuth, no refresh rotation, no
 * AuthContext — none of those are authorised yet, and a test reaching for them
 * would fail for reasons that have nothing to do with the schema.
 *
 * The invariants under test, all of them database facts that only the database
 * refusing a write can prove:
 *   1. a Session belongs to a User and carries no company authority
 *   2. the current refresh-token hash is unique
 *   3. many sessions may have no previous hash at all
 *   4. a non-null previous refresh-token hash is unique
 *   5. a previous hash without its grace deadline is refused
 *   6. a grace deadline without a previous hash is refused
 *   7. a previous hash equal to the current hash is refused
 *   8. deleting a User deletes its Sessions
 *   9. expiresAt and revokedAt can represent live, expired and revoked
 *
 * Requires a live database — run with `npm run test:db`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the session persistence tests");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

/** Unique-index violation — see tenantIntegrity.test.ts for why the shape matters. */
const UNIQUE_VIOLATION = { name: "PrismaClientKnownRequestError", code: "P2002" };

/**
 * Postgres check_violation. Asserted as a CODE, never a message: it is what
 * distinguishes "a CHECK constraint refused this" from a NOT NULL (23502) or a
 * unique index (23505), so a passing test cannot be a different rejection
 * wearing the right shape.
 */
const CHECK_VIOLATION = "23514";

const TAG = `session-test-${Date.now()}`;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * A realistic stand-in for the stored credential: SHA-256 hex, the
 * deterministic digest the design calls for precisely because refresh has to
 * look a session up BY this value. Distinct labels give distinct hashes, so a
 * uniqueness test fails for the reason it claims to.
 */
function hash(label: string): string {
  return createHash("sha256").update(`${TAG}:${label}`).digest("hex");
}

/** Only the users this file created — the shared check database holds others. */
async function cleanup(): Promise<void> {
  // Sessions go with them, by the cascade test 8 proves. Nothing here depends
  // on the Session model existing, so cleanup stays quiet while it does not.
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
}

async function makeUser(label: string): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `${TAG}-${label}@example.com`, name: `${TAG}-${label}`, passwordHash: "not-a-real-hash" },
  });
  return user.id;
}

/** Table names in the public schema, read from the catalogue rather than assumed. */
async function tableExists(table: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<unknown[]>`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${table}
  `;
  return rows.length > 0;
}

/** One string field off an unknown row, narrowed rather than cast. */
function stringField(row: unknown, field: string): string | null {
  if (typeof row !== "object" || row === null || !(field in row)) return null;
  const value: unknown = Reflect.get(row, field);
  return typeof value === "string" ? value : null;
}

async function sessionColumnNames(): Promise<string[]> {
  const rows = await prisma.$queryRaw<unknown[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Session'
  `;
  return rows.map(row => stringField(row, "column_name")).filter((n): n is string => n !== null);
}

/** Every table "Session" points at by a foreign key, unquoted. */
async function sessionForeignKeyTargets(): Promise<string[]> {
  const rows = await prisma.$queryRaw<unknown[]>`
    SELECT confrelid::regclass::text AS referenced
    FROM pg_constraint
    WHERE conrelid = '"Session"'::regclass AND contype = 'f'
  `;
  return rows
    .map(row => stringField(row, "referenced"))
    .filter((n): n is string => n !== null)
    .map(name => name.replace(/"/g, ""));
}

/**
 * The SQLSTATE behind a Prisma failure, or null when the error does not carry
 * one. Narrowed from unknown throughout — no casts, and no matching on message
 * text.
 *
 * The path is `meta.driverAdapterError.cause.code`, observed rather than
 * assumed: under the PrismaPg driver adapter the Postgres error is nested
 * inside the DriverAdapterError rather than exposed as a flat `meta.code`.
 * Reading it here means these tests assert a five-character Postgres error
 * class — "23514" is check_violation, as opposed to 23502 not_null_violation
 * or 23505 unique_violation — instead of the failure text, which would pass
 * for any rejection at all.
 */
function sqlStateOf(error: unknown): string | null {
  const path = ["meta", "driverAdapterError", "cause"];
  let current: unknown = error;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) return null;
    current = Reflect.get(current, key);
  }
  if (typeof current !== "object" || current === null || !("code" in current)) return null;
  const code: unknown = Reflect.get(current, "code");
  return typeof code === "string" ? code : null;
}

interface SessionRow {
  id: string;
  userId: string;
  expiresAt: Date;
  refreshTokenHash: string;
  previousRefreshTokenHash: string | null;
  previousRefreshTokenGraceUntil: Date | null;
}

/**
 * ONE raw INSERT statement, used by both the positive control and the three
 * CHECK-constraint rejections. Raw rather than the client, because a CHECK
 * violation has to arrive as a database error to prove anything — and because
 * the same well-formed statement succeeding in the control is what makes the
 * three failures attributable to the constraints instead of to a typo.
 */
function insertSessionRow(row: SessionRow): Promise<number> {
  return prisma.$executeRaw`
    INSERT INTO "Session" (
      "id", "userId", "expiresAt", "revokedAt", "refreshTokenHash",
      "previousRefreshTokenHash", "previousRefreshTokenGraceUntil",
      "createdAt", "updatedAt"
    ) VALUES (
      ${row.id}, ${row.userId}, ${row.expiresAt}, NULL, ${row.refreshTokenHash},
      ${row.previousRefreshTokenHash}, ${row.previousRefreshTokenGraceUntil},
      NOW(), NOW()
    )
  `;
}

async function expectCheckViolation(row: SessionRow, what: string): Promise<void> {
  let caught: unknown = null;
  try {
    await insertSessionRow(row);
  } catch (error) {
    caught = error;
  }
  assert.notEqual(caught, null, `${what} — the database accepted it`);
  assert.equal(
    sqlStateOf(caught),
    CHECK_VIOLATION,
    `${what} — must be refused by a CHECK constraint (SQLSTATE ${CHECK_VIOLATION})`,
  );
}

before(async () => {
  assert.ok(
    await tableExists("Session"),
    'the "Session" table does not exist. The Session persistence foundation has not been built yet — ' +
    "no model in prisma/schema.prisma, no migration creating the table. Every test in this file " +
    "depends on it, so they are all failing for this one reason.",
  );
  await cleanup();
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

// ── 1. A Session is the User's, and knows nothing about companies ───────────
// AUTH.md: a Session is one authenticated device and SURVIVES company
// switching. Storing a company on it would create a second authority for
// "which company is this request for" that the access token could contradict.
test("a Session belongs to a User and carries no company authority", async () => {
  const columns = await sessionColumnNames();
  assert.ok(columns.includes("userId"), "Session must be owned by a User");
  assert.equal(
    columns.includes("companyId"), false,
    "Session must NOT carry companyId — it survives company switching (AUTH.md)",
  );

  const targets = await sessionForeignKeyTargets();
  assert.deepEqual(targets, ["User"], "Session must reference User and nothing else");

  // A user with no membership and no company anywhere still gets a session:
  // authentication proves global User identity, authorization comes later.
  const loner = await makeUser("loner");
  const session = await prisma.session.create({
    data: {
      userId: loner,
      expiresAt: new Date(Date.now() + 90 * DAY),
      refreshTokenHash: hash("loner-current"),
    },
  });
  assert.equal(session.userId, loner);
  assert.equal(session.revokedAt, null, "a new session is not revoked");
  assert.equal(session.previousRefreshTokenHash, null, "a new session has no superseded token");
  assert.equal(session.previousRefreshTokenGraceUntil, null, "and therefore no grace deadline");
});

// ── 2. The current refresh-token hash is the lookup key ─────────────────────
// Refresh resolves a presented token BY this column. Two sessions sharing one
// makes that resolution ambiguous, which is the whole point of the constraint.
test("a duplicate refreshTokenHash is rejected", async () => {
  const first = await makeUser("dup-current-a");
  const second = await makeUser("dup-current-b");
  const shared = hash("shared-current");

  await prisma.session.create({
    data: { userId: first, expiresAt: new Date(Date.now() + 90 * DAY), refreshTokenHash: shared },
  });

  await assert.rejects(
    prisma.session.create({
      data: { userId: second, expiresAt: new Date(Date.now() + 90 * DAY), refreshTokenHash: shared },
    }),
    UNIQUE_VIOLATION,
  );
});

// ── 3. Never-rotated sessions must not collide with each other ──────────────
// Postgres treats NULLs as distinct under a unique index, which is exactly why
// the column is nullable rather than defaulting to "": an empty string would
// collide across every fresh session and the second device could not log in.
test("many sessions may have a null previousRefreshTokenHash", async () => {
  const user = await makeUser("many-null-previous");
  const expiresAt = new Date(Date.now() + 90 * DAY);

  await prisma.session.create({ data: { userId: user, expiresAt, refreshTokenHash: hash("null-prev-1") } });
  await prisma.session.create({ data: { userId: user, expiresAt, refreshTokenHash: hash("null-prev-2") } });
  await prisma.session.create({ data: { userId: user, expiresAt, refreshTokenHash: hash("null-prev-3") } });

  // Several devices per person is normal; only the credential must be unique.
  const count = await prisma.session.count({ where: { userId: user, previousRefreshTokenHash: null } });
  assert.equal(count, 3);
});

// ── 4. The grace-window hash is a lookup key too ────────────────────────────
test("a duplicate non-null previousRefreshTokenHash is rejected", async () => {
  const first = await makeUser("dup-previous-a");
  const second = await makeUser("dup-previous-b");
  const sharedPrevious = hash("shared-previous");
  const expiresAt = new Date(Date.now() + 90 * DAY);
  const graceUntil = new Date(Date.now() + 60 * 1000);

  await prisma.session.create({
    data: {
      userId: first,
      expiresAt,
      refreshTokenHash: hash("dup-previous-current-a"),
      previousRefreshTokenHash: sharedPrevious,
      previousRefreshTokenGraceUntil: graceUntil,
    },
  });

  await assert.rejects(
    prisma.session.create({
      data: {
        userId: second,
        expiresAt,
        refreshTokenHash: hash("dup-previous-current-b"),
        previousRefreshTokenHash: sharedPrevious,
        previousRefreshTokenGraceUntil: graceUntil,
      },
    }),
    UNIQUE_VIOLATION,
  );
});

// ── Positive control for the raw path ───────────────────────────────────────
// Without this, the three rejections below could all be a malformed statement
// rather than the constraints doing their job.
test("a fully-formed rotated Session row inserts through the same raw statement", async () => {
  const user = await makeUser("raw-control");
  const id = `${TAG}-raw-control`;
  const inserted = await insertSessionRow({
    id,
    userId: user,
    expiresAt: new Date(Date.now() + 90 * DAY),
    refreshTokenHash: hash("control-current"),
    previousRefreshTokenHash: hash("control-previous"),
    previousRefreshTokenGraceUntil: new Date(Date.now() + 60 * 1000),
  });
  assert.equal(inserted, 1, "the raw INSERT statement itself must be well-formed");
});

// ── 5 & 6. The superseded token and its deadline are one fact ───────────────
// Either half alone is unreadable: a hash with no deadline is either valid
// forever or dead on arrival depending on which way the code reads null.
test("a previousRefreshTokenHash without a grace deadline is rejected", async () => {
  const user = await makeUser("previous-without-grace");
  await expectCheckViolation(
    {
      id: `${TAG}-previous-without-grace`,
      userId: user,
      expiresAt: new Date(Date.now() + 90 * DAY),
      refreshTokenHash: hash("orphan-hash-current"),
      previousRefreshTokenHash: hash("orphan-hash-previous"),
      previousRefreshTokenGraceUntil: null,
    },
    "a previous refresh-token hash with no grace deadline",
  );
});

test("a grace deadline without a previousRefreshTokenHash is rejected", async () => {
  const user = await makeUser("grace-without-previous");
  await expectCheckViolation(
    {
      id: `${TAG}-grace-without-previous`,
      userId: user,
      expiresAt: new Date(Date.now() + 90 * DAY),
      refreshTokenHash: hash("orphan-grace-current"),
      previousRefreshTokenHash: null,
      previousRefreshTokenGraceUntil: new Date(Date.now() + 60 * 1000),
    },
    "a grace deadline with no previous refresh-token hash",
  );
});

// ── 7. A rotation that rotated nothing ──────────────────────────────────────
// The same token in both slots makes the grace window meaningless and
// "is this the current or the previous token?" unanswerable.
test("a previousRefreshTokenHash equal to the current hash is rejected", async () => {
  const user = await makeUser("previous-equals-current");
  const same = hash("same-in-both-slots");
  await expectCheckViolation(
    {
      id: `${TAG}-previous-equals-current`,
      userId: user,
      expiresAt: new Date(Date.now() + 90 * DAY),
      refreshTokenHash: same,
      previousRefreshTokenHash: same,
      previousRefreshTokenGraceUntil: new Date(Date.now() + 60 * 1000),
    },
    "the same token hash in both the current and previous slots",
  );
});

// ── 8. A deleted person leaves no sessions behind ───────────────────────────
test("deleting a User deletes that User's Sessions", async () => {
  const user = await makeUser("cascade");
  const expiresAt = new Date(Date.now() + 90 * DAY);
  await prisma.session.create({ data: { userId: user, expiresAt, refreshTokenHash: hash("cascade-1") } });
  await prisma.session.create({ data: { userId: user, expiresAt, refreshTokenHash: hash("cascade-2") } });
  assert.equal(await prisma.session.count({ where: { userId: user } }), 2);

  await prisma.user.delete({ where: { id: user } });

  assert.equal(
    await prisma.session.count({ where: { userId: user } }), 0,
    "sessions must not outlive the User they authenticate",
  );
});

// ── 9. Live, expired and revoked are three distinguishable states ───────────
// expiresAt is the absolute 90-day device lifetime; revokedAt is an explicit
// decision. They are independent: neither can express the other's state.
test("expiresAt and revokedAt represent live, expired and revoked sessions", async () => {
  const user = await makeUser("states");
  const future = new Date(Date.now() + 90 * DAY);
  const past = new Date(Date.now() - HOUR);

  const live = await prisma.session.create({
    data: { userId: user, expiresAt: future, refreshTokenHash: hash("state-live") },
  });
  const expired = await prisma.session.create({
    data: { userId: user, expiresAt: past, refreshTokenHash: hash("state-expired") },
  });
  const revoked = await prisma.session.create({
    data: { userId: user, expiresAt: future, revokedAt: past, refreshTokenHash: hash("state-revoked") },
  });

  assert.equal(expired.revokedAt, null, "an expired session need not be revoked");
  assert.ok(expired.expiresAt.getTime() < Date.now(), "an expired session's lifetime is in the past");
  assert.notEqual(revoked.revokedAt, null, "a revoked session records when");
  assert.ok(revoked.expiresAt.getTime() > Date.now(), "a session can be revoked while still unexpired");

  // The query requireAuth will eventually make: unrevoked AND unexpired.
  const usable = await prisma.session.findMany({
    where: { userId: user, revokedAt: null, expiresAt: { gt: new Date() } },
  });
  assert.deepEqual(usable.map(s => s.id), [live.id], "exactly one of the three is usable");
});
