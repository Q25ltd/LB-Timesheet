/**
 * Company A / Company B isolation, proven through the REPOSITORY API — the
 * code services will actually call — against a real migrated database.
 *
 * tenantIntegrity.test.ts proves the database constraints; this file proves
 * the application boundary above them: that knowing another company's ID
 * gets you nothing, that cross-tenant and nonexistent are indistinguishable,
 * and that legitimate same-company work still flows.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "../../generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { shiftRepository } from "../../repositories/shiftRepository.js";
import { TenantContext } from "../../lib/tenantContext.js";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL must be set to run the repository boundary tests");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repo = shiftRepository(prisma);

const TAG = `repo-test-${Date.now()}`;
let ctxA!: TenantContext;
let ctxB!: TenantContext;
let ctxA2!: TenantContext;
let shiftA = "";
let shiftB = "";
let segmentB = "";
let segmentA = "";
let shiftAExtra = "";

async function cleanup(): Promise<void> {
  await prisma.shiftSubmitJob.deleteMany({ where: { shift: { driverName: { startsWith: TAG } } } });
  await prisma.shiftSegment.deleteMany({ where: { shift: { driverName: { startsWith: TAG } } } });
  await prisma.shift.deleteMany({ where: { driverName: { startsWith: TAG } } });
  await prisma.companyMembership.deleteMany({ where: { user: { email: { startsWith: TAG } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
}

before(async () => {
  await cleanup();
  const companyA = await prisma.company.create({ data: { name: `${TAG}-A`, joinCode: `${TAG}-A` } });
  const companyB = await prisma.company.create({ data: { name: `${TAG}-B`, joinCode: `${TAG}-B` } });
  // One driver per company — the one-open-shift invariant is per USER, so two
  // concurrent open shifts need two people.
  const driverA = await prisma.user.create({
    data: { email: `${TAG}-a@example.com`, name: `${TAG}-a`, passwordHash: "not-a-real-hash" },
  });
  const driverB = await prisma.user.create({
    data: { email: `${TAG}-b@example.com`, name: `${TAG}-b`, passwordHash: "not-a-real-hash" },
  });
  const memberA = await prisma.companyMembership.create({ data: { companyId: companyA.id, userId: driverA.id } });
  const memberB = await prisma.companyMembership.create({ data: { companyId: companyB.id, userId: driverB.id } });

  ctxA = TenantContext.trust({ companyId: companyA.id, userId: driverA.id, membershipId: memberA.id });
  ctxB = TenantContext.trust({ companyId: companyB.id, userId: driverB.id, membershipId: memberB.id });

  const a = await repo.create(ctxA, {
    driverName: `${TAG}-a`, shiftDate: new Date("2026-08-30T00:00:00.000Z"), startedAt: new Date("2026-08-30T05:43:00.000Z"),
  });
  const b = await repo.create(ctxB, {
    driverName: `${TAG}-b`, shiftDate: new Date("2026-08-30T00:00:00.000Z"), startedAt: new Date("2026-08-30T06:02:00.000Z"),
  });
  shiftA = a.id;
  shiftB = b.id;

  const seg = await repo.addSegment(ctxB, shiftB, {
    sequence: 1, truckReg: "BB24 XYZ", startedAt: new Date("2026-08-30T06:02:00.000Z"),
  });
  assert.ok(seg, "setup: company B's own segment must be creatable");
  segmentB = seg.id;

  // A second driver in Company A itself — every test above proves
  // cross-COMPANY isolation; this is the same-company case F-03 exists for.
  const driverA2 = await prisma.user.create({
    data: { email: `${TAG}-a2@example.com`, name: `${TAG}-a2`, passwordHash: "not-a-real-hash" },
  });
  const memberA2 = await prisma.companyMembership.create({ data: { companyId: companyA.id, userId: driverA2.id } });
  ctxA2 = TenantContext.trust({ companyId: companyA.id, userId: driverA2.id, membershipId: memberA2.id });

  const segA = await repo.addSegment(ctxA, shiftA, {
    sequence: 1, truckReg: "AA24 ABC", startedAt: new Date("2026-08-30T05:43:00.000Z"),
  });
  assert.ok(segA, "setup: driver A's own segment must be creatable");
  segmentA = segA.id;

  // A dedicated, CLOSED shift for driver A. Driver A already has shiftA open,
  // and the one-open-shift index would reject a second open one; closed
  // shifts aren't limited. Using a fresh, untouched shift for the delete and
  // enqueue probes below means a broken boundary can't destroy a fixture
  // other tests still need, and the outbox's own @@unique([shiftId]) can
  // never fire and mask the ownership check with an unrelated P2002.
  shiftAExtra = (await prisma.shift.create({
    data: {
      membershipId: memberA.id,
      companyId: companyA.id,
      userId: driverA.id,
      driverName: `${TAG}-a`,
      shiftDate: new Date("2026-08-29T00:00:00.000Z"),
      startedAt: new Date("2026-08-29T05:00:00.000Z"),
      status: "voided",
    },
  })).id;
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

// ── Reads ────────────────────────────────────────────────────────────────────

test("Company A reads its own shift", async () => {
  const shift = await repo.findById(ctxA, shiftA);
  assert.equal(shift?.id, shiftA);
  assert.equal(shift?.companyId, ctxA.companyId);
});

test("Company A CANNOT read Company B's shift by knowing its ID", async () => {
  assert.equal(await repo.findById(ctxA, shiftB), null);
});

test("cross-tenant and nonexistent are INDISTINGUISHABLE — no existence oracle", async () => {
  const crossTenant = await repo.findById(ctxA, shiftB);
  const nonexistent = await repo.findById(ctxA, "clzzzzzzzzzzzzzzzzzzzzzzz");
  assert.equal(crossTenant, null);
  assert.equal(nonexistent, null);
  // deletes and updates likewise return the same shape for both:
  assert.equal(await repo.update(ctxA, shiftB, { notes: "x" }),
               await repo.update(ctxA, "clzzzzzzzzzzzzzzzzzzzzzzz", { notes: "x" }));
  assert.equal(await repo.delete(ctxA, "clzzzzzzzzzzzzzzzzzzzzzzz"), false);
});

test("listOwn returns only the caller's own shifts", async () => {
  const own = await repo.listOwn(ctxA);
  assert.ok(own.some(shift => shift.id === shiftA));
  assert.ok(!own.some(shift => shift.id === shiftB), "another tenant's shift leaked into listOwn");
});

// ── Writes across the boundary ───────────────────────────────────────────────

test("Company A CANNOT update Company B's shift by ID — and B's data is untouched", async () => {
  assert.equal(await repo.update(ctxA, shiftB, { notes: "graffiti from A" }), null);
  const fromB = await repo.findById(ctxB, shiftB);
  assert.equal(fromB?.notes, null, "B's shift must be unmodified");
});

test("Company A CANNOT delete Company B's shift by ID — and it survives", async () => {
  assert.equal(await repo.delete(ctxA, shiftB), false);
  assert.equal((await repo.findById(ctxB, shiftB))?.id, shiftB);
});

test("Company A CANNOT attach a segment to Company B's shift", async () => {
  assert.equal(
    await repo.addSegment(ctxA, shiftB, { sequence: 9, truckReg: "AA24 XYZ", startedAt: new Date() }),
    null,
  );
  const fromB = await repo.findById(ctxB, shiftB);
  assert.equal(fromB?.segments.length, 1, "B must still have exactly its own segment");
});

test("Company A CANNOT update Company B's segment by ID", async () => {
  assert.equal(await repo.updateSegment(ctxA, segmentB, { notes: "crossed the boundary" }), false);
  const fromB = await repo.findById(ctxB, shiftB);
  assert.equal(fromB?.segments[0]?.notes, null, "B's segment must be unmodified");
});

test("Company A CANNOT enqueue a submit job for Company B's shift", async () => {
  assert.equal(await repo.enqueueSubmitJob(ctxA, shiftB), null);
  const jobs = await prisma.shiftSubmitJob.count({ where: { shiftId: shiftB } });
  assert.equal(jobs, 0, "no outbox row may exist for B's shift");
});

// ── Legitimate same-company operations keep working ─────────────────────────

test("same-company update, segment work and submit all succeed", async () => {
  const updated = await repo.update(ctxB, shiftB, { notes: "checked and correct" });
  assert.equal(updated?.notes, "checked and correct");

  assert.equal(
    await repo.updateSegment(ctxB, segmentB, {
      endedAt: new Date("2026-08-30T11:30:00.000Z"),
      truckChecks: [{ key: "tyres_wheels", label: "Tyres and wheels", result: "pass", note: null }],
    }),
    true,
  );

  const job = await repo.enqueueSubmitJob(ctxB, shiftB);
  assert.equal(job?.companyId, ctxB.companyId);
});
// ── Same-company driver isolation (F-03) ─────────────────────────────────────
// Everything above proves cross-COMPANY isolation. These prove the narrower,
// previously-untested case: two drivers who share a company must still be
// isolated from each other's shifts. Today every method below except
// listOwn/create is scoped by companyId alone, so driver A2 can currently
// reach driver A's data just by knowing its ID — that's the bug this proves.

test("driver A2 CANNOT read driver A's shift, though they share a company", async () => {
  assert.equal(await repo.findById(ctxA2, shiftA), null);
});

test("driver A2 CANNOT update driver A's shift — and A's data is untouched", async () => {
  assert.equal(await repo.update(ctxA2, shiftA, { notes: "graffiti from A2" }), null);
  const fromA = await repo.findById(ctxA, shiftA);
  assert.equal(fromA?.notes, null, "A's shift must be unmodified by a same-company driver");
});

test("driver A2 CANNOT attach a segment to driver A's shift", async () => {
  assert.equal(
    await repo.addSegment(ctxA2, shiftA, { sequence: 9, truckReg: "ZZ24 XYZ", startedAt: new Date() }),
    null,
  );
  const fromA = await repo.findById(ctxA, shiftA);
  assert.equal(fromA?.segments.length, 1, "A must still have exactly its own segment");
});

test("driver A2 CANNOT update driver A's segment", async () => {
  assert.equal(await repo.updateSegment(ctxA2, segmentA, { notes: "crossed the same-company boundary" }), false);
  const fromA = await repo.findById(ctxA, shiftA);
  assert.equal(fromA?.segments[0]?.notes, null, "A's segment must be unmodified");
});

test("driver A2 CANNOT enqueue a submit job for driver A's shift", async () => {
  assert.equal(await repo.enqueueSubmitJob(ctxA2, shiftAExtra), null);
  const jobs = await prisma.shiftSubmitJob.count({ where: { shiftId: shiftAExtra } });
  assert.equal(jobs, 0, "no outbox row may exist for A's shift, created by A2");
});

test("driver A2 CANNOT delete driver A's shift — and it survives", async () => {
  assert.equal(await repo.delete(ctxA2, shiftAExtra), false);
  assert.equal((await repo.findById(ctxA, shiftAExtra))?.id, shiftAExtra);
});

test("driver A2 CAN still fully operate on their own same-company shift", async () => {
  const own = await repo.create(ctxA2, {
    driverName: `${TAG}-a2`,
    shiftDate: new Date("2026-08-30T00:00:00.000Z"),
    startedAt: new Date("2026-08-30T07:15:00.000Z"),
  });

  const updated = await repo.update(ctxA2, own.id, { notes: "A2's own note" });
  assert.equal(updated?.notes, "A2's own note");

  const seg = await repo.addSegment(ctxA2, own.id, {
    sequence: 1, truckReg: "AA24 A2X", startedAt: new Date("2026-08-30T07:15:00.000Z"),
  });
  assert.ok(seg, "A2 must be able to add a segment to their own shift");
  assert.equal(await repo.updateSegment(ctxA2, seg.id, { odometerEnd: 12345 }), true);

  const job = await repo.enqueueSubmitJob(ctxA2, own.id);
  assert.equal(job?.companyId, ctxA2.companyId);
});
