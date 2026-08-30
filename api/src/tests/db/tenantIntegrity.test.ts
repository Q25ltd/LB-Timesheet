/**
 * Proves the tenant constraints are enforced by PostgreSQL, not by convention.
 * Requires a live database — run with `npm run test:db`.
 *
 * Two claims are under test:
 *   1. A Shift cannot contradict the CompanyMembership that authorised it
 *      (its companyId and userId must agree with the membership's).
 *   2. A ShiftSegment or ShiftSubmitJob cannot sit under a different company
 *      than its parent Shift.
 *
 * Schema inspection cannot prove either; only the database refusing the write can.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the database integrity tests");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

/**
 * A foreign-key violation specifically — not "any rejection". Passing a string
 * to assert.rejects sets the assertion MESSAGE, it does not match the error, so
 * a validation error would satisfy it and the test would prove nothing.
 */
const FOREIGN_KEY_VIOLATION = { name: "PrismaClientKnownRequestError", code: "P2003" };
const UNIQUE_VIOLATION      = { name: "PrismaClientKnownRequestError", code: "P2002" };

const TAG = `fk-test-${Date.now()}`;
let companyA = "";
let companyB = "";
let driver = "";
let outsider = "";
let membershipA = "";
let membershipB = "";
let shiftInA = "";

async function cleanup(): Promise<void> {
  await prisma.shiftSubmitJob.deleteMany({ where: { shift: { driverName: TAG } } });
  await prisma.shiftSegment.deleteMany({ where: { shift: { driverName: TAG } } });
  await prisma.shift.deleteMany({ where: { driverName: TAG } });
  await prisma.companyMembership.deleteMany({ where: { user: { email: { startsWith: TAG } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
}

before(async () => {
  await cleanup();
  const a = await prisma.company.create({ data: { name: `${TAG}-A`, joinCode: `${TAG}-A` } });
  const b = await prisma.company.create({ data: { name: `${TAG}-B`, joinCode: `${TAG}-B` } });
  const d = await prisma.user.create({
    data: { email: `${TAG}-driver@example.com`, name: TAG, passwordHash: "not-a-real-hash" },
  });
  const o = await prisma.user.create({
    data: { email: `${TAG}-outsider@example.com`, name: `${TAG}-out`, passwordHash: "not-a-real-hash" },
  });
  companyA = a.id;
  companyB = b.id;
  driver = d.id;
  outsider = o.id;

  // The driver holds memberships in BOTH companies — the multi-company case (D12).
  const mA = await prisma.companyMembership.create({ data: { companyId: companyA, userId: driver } });
  const mB = await prisma.companyMembership.create({ data: { companyId: companyB, userId: driver } });
  membershipA = mA.id;
  membershipB = mB.id;

  const shift = await prisma.shift.create({
    data: {
      membershipId: membershipA,
      companyId: companyA,
      userId: driver,
      driverName: TAG,
      shiftDate: new Date("2026-08-25T00:00:00.000Z"),
      startedAt: new Date("2026-08-25T05:43:00.000Z"),
    },
  });
  shiftInA = shift.id;
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

// ── Shift is bound to the membership that authorised it ─────────────────────

test("a Shift consistent with its membership is accepted", async () => {
  const shift = await prisma.shift.create({
    data: {
      membershipId: membershipB,
      companyId: companyB,
      userId: driver,
      driverName: TAG,
      shiftDate: new Date("2026-08-26T00:00:00.000Z"),
      startedAt: new Date("2026-08-26T05:43:00.000Z"),
      status: "submitted",
    },
  });
  assert.equal(shift.membershipId, membershipB);
});

test("PostgreSQL REJECTS a Shift whose companyId disagrees with its membership", async () => {
  await assert.rejects(
    prisma.shift.create({
      data: {
        membershipId: membershipA,   // membership belongs to company A
        companyId: companyB,         // ...but the row claims company B
        userId: driver,
        driverName: TAG,
        shiftDate: new Date("2026-08-27T00:00:00.000Z"),
        startedAt: new Date("2026-08-27T05:43:00.000Z"),
        // Closed on purpose: the driver already holds an open draft, and a
        // second OPEN shift would be rejected by Shift_one_open_per_user
        // (P2002) BEFORE the FK could reject it — this test must isolate the
        // membership constraint. The open-shift invariant has its own tests.
        status: "voided",
      },
    }),
    FOREIGN_KEY_VIOLATION,
  );
});

// ── One open shift per user (partial unique index from invariants.sql) ──────

test("PostgreSQL REJECTS a second OPEN shift for the same user — even in another company", async () => {
  // shiftInA (draft) is already open. membershipB is a perfectly valid
  // membership in another company — the invariant is per USER, one body.
  await assert.rejects(
    prisma.shift.create({
      data: {
        membershipId: membershipB,
        companyId: companyB,
        userId: driver,
        driverName: TAG,
        shiftDate: new Date("2026-08-29T00:00:00.000Z"),
        startedAt: new Date("2026-08-29T05:43:00.000Z"),
        status: "active",
      },
    }),
    UNIQUE_VIOLATION,
  );
});

test("a CLOSED shift does not block, and reopening past a live open shift is refused", async () => {
  // Any number of closed shifts is fine…
  const closed = await prisma.shift.create({
    data: {
      membershipId: membershipB,
      companyId: companyB,
      userId: driver,
      driverName: TAG,
      shiftDate: new Date("2026-08-30T00:00:00.000Z"),
      startedAt: new Date("2026-08-30T05:43:00.000Z"),
      status: "submitted",
    },
  });
  // …but flipping one back to OPEN while another open shift exists is refused —
  // the invariant holds on UPDATE, not just on create.
  await assert.rejects(
    prisma.shift.update({ where: { id: closed.id }, data: { status: "active" } }),
    UNIQUE_VIOLATION,
  );
});

test("PostgreSQL REJECTS a Shift whose userId disagrees with its membership", async () => {
  await assert.rejects(
    prisma.shift.create({
      data: {
        membershipId: membershipA,
        companyId: companyA,
        userId: outsider,            // not the member
        driverName: TAG,
        shiftDate: new Date("2026-08-28T00:00:00.000Z"),
        startedAt: new Date("2026-08-28T05:43:00.000Z"),
      },
    }),
    FOREIGN_KEY_VIOLATION,
  );
});

test("PostgreSQL REJECTS moving a Shift to another company", async () => {
  await assert.rejects(
    prisma.shift.update({ where: { id: shiftInA }, data: { companyId: companyB } }),
    FOREIGN_KEY_VIOLATION,
  );
});

// ── Children cannot sit under a different company than their parent shift ───

test("a ShiftSegment under the correct company is accepted", async () => {
  const segment = await prisma.shiftSegment.create({
    data: {
      companyId: companyA,
      shiftId: shiftInA,
      sequence: 1,
      truckReg: "AB24 XYZ",
      startedAt: new Date("2026-08-25T05:43:00.000Z"),
    },
  });
  assert.equal(segment.companyId, companyA);
});

test("PostgreSQL REJECTS a ShiftSegment whose companyId differs from its shift's", async () => {
  await assert.rejects(
    prisma.shiftSegment.create({
      data: {
        companyId: companyB,
        shiftId: shiftInA,
        sequence: 2,               // 2, not 1 — a duplicate sequence would fail for the wrong reason
        truckReg: "CD25 XYZ",
        startedAt: new Date("2026-08-25T11:30:00.000Z"),
      },
    }),
    FOREIGN_KEY_VIOLATION,
  );
});

test("PostgreSQL REJECTS moving an existing segment to another company", async () => {
  const segment = await prisma.shiftSegment.findFirstOrThrow({
    where: { shiftId: shiftInA, sequence: 1 },
  });
  await assert.rejects(
    prisma.shiftSegment.update({ where: { id: segment.id }, data: { companyId: companyB } }),
    FOREIGN_KEY_VIOLATION,
  );
});

test("a ShiftSubmitJob under the correct company is accepted", async () => {
  const job = await prisma.shiftSubmitJob.create({
    data: { companyId: companyA, shiftId: shiftInA },
  });
  assert.equal(job.companyId, companyA);
});

test("PostgreSQL REJECTS a ShiftSubmitJob whose companyId differs from its shift's", async () => {
  await assert.rejects(
    prisma.shiftSubmitJob.create({ data: { companyId: companyB, shiftId: shiftInA } }),
    FOREIGN_KEY_VIOLATION,
  );
});

// ── Tenant-safe lookup primitive ─────────────────────────────────────────────

test("the composite unique gives services a tenant-safe lookup primitive", async () => {
  const wrongTenant = await prisma.shift.findUnique({
    where: { id_companyId: { id: shiftInA, companyId: companyB } },
  });
  assert.equal(wrongTenant, null, "a shift must not be findable under the wrong company");

  const rightTenant = await prisma.shift.findUnique({
    where: { id_companyId: { id: shiftInA, companyId: companyA } },
  });
  assert.equal(rightTenant?.id, shiftInA);
});
