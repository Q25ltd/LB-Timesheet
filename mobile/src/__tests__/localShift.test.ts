/**
 * The driver's local open shift — the day as the phone holds it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS ON THE DEVICE AND NOT ON A SERVER
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A driver books on in a yard, in a lay-by, in a loading bay under a steel
 * roof. The working day cannot depend on a network round trip, so starting a
 * shift writes a local record and nothing else (D28). No request is made, none
 * is awaited, and a dead network changes nothing — the cases below prove that
 * by making `fetch` throw and starting a shift anyway.
 *
 * ONE OPEN SHIFT, and this is the invariant with teeth. A driver has one
 * working day at a time. Pressing the button twice, retrying after a stutter,
 * or reopening the app mid-shift must never produce a second record — so
 * `startLocalShift` is idempotent by design: it returns the shift already open
 * rather than replacing it or adding to it.
 *
 * DURABILITY IS THE POINT, so these tests do not stub the store. They drive
 * the real module against `expo-file-system`'s in-memory filesystem, which
 * gives a genuine create/write/read round trip — a module rebuilt from scratch
 * reads back what an earlier one wrote, which is what an app restart is.
 */
import { File, Paths } from "expo-file-system";
import { clearOpenShift, readOpenShift, startLocalShift, OPEN_SHIFT_FILE } from "../shift/localShift";
import type { LocalVehicle, WorkingContext } from "../shift/localShift";

const PERSONAL: WorkingContext = { kind: "personal" };
const NORTHGATE: WorkingContext = {
  kind: "company",
  membershipId: "mem_1",
  companyId: "co_1",
  companyName: "Northgate Logistics",
};

const LORRY: LocalVehicle = { vehicleClass: "class1", numberPlate: "AB24 XYZ", startMileage: 184_203 };

const STARTED_AT = new Date(2026, 8, 13, 5, 45);

function storedFile(): File {
  return new File(Paths.document, OPEN_SHIFT_FILE);
}

beforeEach(async () => { await clearOpenShift(); });

// ═══════════════════════════════════════════════════════════════════════════
// Starting a day
// ═══════════════════════════════════════════════════════════════════════════

test("no shift is open on a fresh device", async () => {
  await expect(readOpenShift()).resolves.toBeNull();
});

test("starting a shift persists it, and it reads back identically", async () => {
  const started = await startLocalShift({ workingFor: PERSONAL, startedAt: STARTED_AT, vehicle: null });

  const recovered = await readOpenShift();
  expect(recovered).toEqual(started);
  expect(recovered?.status).toBe("open");
  expect(recovered?.startedAt).toBe(STARTED_AT.toISOString());
});

test("a shift started with NO vehicle persists no vehicle at all", async () => {
  await startLocalShift({ workingFor: PERSONAL, startedAt: STARTED_AT, vehicle: null });

  const recovered = await readOpenShift();
  // Not an empty object, not a placeholder plate, not a zero mileage: null.
  expect(recovered?.vehicle).toBeNull();
});

test("a shift started WITH a vehicle persists exactly what the driver entered", async () => {
  await startLocalShift({ workingFor: NORTHGATE, startedAt: STARTED_AT, vehicle: LORRY });

  const recovered = await readOpenShift();
  expect(recovered?.vehicle).toEqual(LORRY);
  expect(recovered?.workingFor).toEqual(NORTHGATE);
});

test("the intended company is carried, and Personal is carried as itself", async () => {
  await startLocalShift({ workingFor: NORTHGATE, startedAt: STARTED_AT, vehicle: null });
  expect((await readOpenShift())?.workingFor).toEqual(NORTHGATE);

  await clearOpenShift();
  await startLocalShift({ workingFor: PERSONAL, startedAt: STARTED_AT, vehicle: null });
  // No invented company stands in for Personal (D27, D21).
  expect((await readOpenShift())?.workingFor).toEqual({ kind: "personal" });
});

test("every shift gets its own stable identifier", async () => {
  const first = await startLocalShift({ workingFor: PERSONAL, startedAt: STARTED_AT, vehicle: null });
  await clearOpenShift();
  const second = await startLocalShift({ workingFor: PERSONAL, startedAt: STARTED_AT, vehicle: null });

  expect(first.id).not.toBe(second.id);
  expect(first.id).toHaveLength(36);
});

// ═══════════════════════════════════════════════════════════════════════════
// One open shift, whatever the driver does to the button
// ═══════════════════════════════════════════════════════════════════════════

test("pressing start twice returns the SAME shift — no duplicate is created", async () => {
  const first = await startLocalShift({ workingFor: PERSONAL, startedAt: STARTED_AT, vehicle: null });
  const second = await startLocalShift({ workingFor: PERSONAL, startedAt: STARTED_AT, vehicle: null });

  expect(second.id).toBe(first.id);
  expect(await readOpenShift()).toEqual(first);
});

test("a second start with DIFFERENT details does not overwrite the open shift", async () => {
  // A retry must not silently re-time the working day, and a stray press must
  // not swap the driver's vehicle out from under them.
  const first = await startLocalShift({ workingFor: PERSONAL, startedAt: STARTED_AT, vehicle: null });

  const again = await startLocalShift({
    workingFor: NORTHGATE,
    startedAt: new Date(2026, 8, 13, 11, 0),
    vehicle: LORRY,
  });

  expect(again).toEqual(first);
  expect((await readOpenShift())?.vehicle).toBeNull();
});

test("many rapid starts in parallel still leave exactly one shift", async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      startLocalShift({ workingFor: PERSONAL, startedAt: STARTED_AT, vehicle: null })),
  );

  const ids = new Set(results.map(shift => shift.id));
  expect(ids.size).toBe(1);
  expect((await readOpenShift())?.id).toBe(results[0]?.id);
});

// ═══════════════════════════════════════════════════════════════════════════
// Survives the app dying
// ═══════════════════════════════════════════════════════════════════════════

test("everything needed to recover the day reaches the FILE — nothing is held in memory", async () => {
  const started = await startLocalShift({ workingFor: NORTHGATE, startedAt: STARTED_AT, vehicle: LORRY });

  // Read back off the filesystem directly, bypassing the module entirely.
  // Whatever is here is what a relaunched app has to work with.
  const onDisk: unknown = JSON.parse(storedFile().textSync());
  expect(onDisk).toEqual(started);
});

test("COLD START: a shift this module never created is recovered from the file alone", async () => {
  // The restart path, expressed the only way a single process honestly can.
  // `jest.resetModules()` cannot stand in for it: the in-memory filesystem the
  // native module is mocked with is itself a module, so resetting the registry
  // wipes the simulated disk as well as the app — proving nothing. Writing the
  // document by hand and reading it through the public API exercises exactly
  // what a relaunch does: reconstruct the day from bytes, with no prior state.
  const shift = {
    id: "11111111-2222-4333-8444-555555555555",
    workingFor: NORTHGATE,
    startedAt: STARTED_AT.toISOString(),
    vehicle: LORRY,
    status: "open",
    createdAt: STARTED_AT.toISOString(),
  };
  const file = storedFile();
  file.create({ overwrite: true });
  file.write(JSON.stringify(shift));

  const recovered = await readOpenShift();

  expect(recovered).toEqual(shift);
  expect(recovered?.vehicle).toEqual(LORRY);
});

test("a recovered open shift blocks a new one — the day continues rather than restarting", async () => {
  const file = storedFile();
  file.create({ overwrite: true });
  file.write(JSON.stringify({
    id: "11111111-2222-4333-8444-555555555555",
    workingFor: PERSONAL,
    startedAt: STARTED_AT.toISOString(),
    vehicle: null,
    status: "open",
    createdAt: STARTED_AT.toISOString(),
  }));

  const attempted = await startLocalShift({ workingFor: NORTHGATE, startedAt: new Date(), vehicle: LORRY });

  expect(attempted.id).toBe("11111111-2222-4333-8444-555555555555");
  expect(attempted.vehicle).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// The network is irrelevant
// ═══════════════════════════════════════════════════════════════════════════

test("starting a shift makes NO request", async () => {
  const fetchSpy = jest.spyOn(global, "fetch");

  await startLocalShift({ workingFor: NORTHGATE, startedAt: STARTED_AT, vehicle: LORRY });

  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

test("a DEAD network cannot stop a shift starting", async () => {
  const fetchSpy = jest.spyOn(global, "fetch")
    .mockImplementation(() => Promise.reject(new Error("Network request failed")));

  const started = await startLocalShift({ workingFor: PERSONAL, startedAt: STARTED_AT, vehicle: null });

  expect(started.status).toBe("open");
  expect(await readOpenShift()).toEqual(started);
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

// ═══════════════════════════════════════════════════════════════════════════
// Reading something that is not a shift
// ═══════════════════════════════════════════════════════════════════════════

test("an unreadable file reports NO open shift rather than crashing or guessing", async () => {
  const file = storedFile();
  file.create({ overwrite: true });
  file.write("{ this is not json");

  // Reporting "unknown" as "none" is the safe direction: the alternative is
  // an app that cannot open. The file is left alone rather than destroyed.
  await expect(readOpenShift()).resolves.toBeNull();
  expect(file.exists).toBe(true);
});

test("a file of the wrong shape reports NO open shift", async () => {
  const file = storedFile();
  file.create({ overwrite: true });
  file.write(JSON.stringify({ id: "x", status: "open" }));

  await expect(readOpenShift()).resolves.toBeNull();
});

test("clearing removes the open shift", async () => {
  await startLocalShift({ workingFor: PERSONAL, startedAt: STARTED_AT, vehicle: null });

  await clearOpenShift();

  await expect(readOpenShift()).resolves.toBeNull();
  expect(storedFile().exists).toBe(false);
});
