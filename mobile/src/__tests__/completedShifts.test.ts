/**
 * Finished days on the phone — listing and reading them back (2026-09-28).
 *
 * `listCompletedShifts` is what Home's Recent Timesheets and the Timesheets
 * tab read. It lists ONLY finished days' records, each through the strict
 * reader, newest first by the day itself — and one damaged record never takes
 * the others with it.
 */
import { File } from "expo-file-system";
import {
  COMPLETED_SHIFT_FILE_PREFIX,
  OPEN_SHIFT_FILE,
  OPEN_SHIFT_TEMP_FILE,
  RECOVERY_FILE_PREFIX,
  SafeSaveFailedError,
  clearOpenShift,
  listCompletedShifts,
  readCompletedShift,
  readOpenShift,
  startLocalShift,
  type CompletedShift,
  type VehicleDetails,
} from "../shift/localShift";
import { finishDeclared } from "./declared";
import { accountDirectoryOf, scopeFor } from "./testScope";

/** The signed-in driver's records — F-31: every store call names its account. */
const SCOPE = scopeFor("user_1");

const UNIT: VehicleDetails = { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 };
const day = (date: number, hours: number, minutes = 0) => new Date(2026, 8, date, hours, minutes);
const recordFile = (id: string) => new File(accountDirectoryOf(SCOPE), `${COMPLETED_SHIFT_FILE_PREFIX}${id}.json`);

/** Start a day and finish it through the real store — the only way a record is written. */
/** `companyName` null is a Personal day. */
async function finishedDay(startedAt: Date, endedAt: Date, companyName: string | null = null): Promise<CompletedShift> {
  const shift = await startLocalShift(SCOPE, {
    workingFor: companyName === null
      ? { kind: "personal" }
      : { kind: "company", membershipId: "m1", companyId: "c1", companyName },
    startedAt,
    vehicle: null,
  });
  const done = await finishDeclared(SCOPE, {
    shiftId: shift.id, vehicleUseId: null, trailerUseId: null,
    finalMileage: null, endedAt, nightOut: false, notes: "",
  });
  if (done === null) throw new Error("expected the day to finish");
  return done;
}

function removeEveryFile(): void {
  for (const entry of accountDirectoryOf(SCOPE).list()) {
    if (entry instanceof File) entry.delete();
  }
}

beforeEach(async () => {
  await clearOpenShift(SCOPE);
  removeEveryFile();
});
afterEach(() => { jest.restoreAllMocks(); });

test("with no finished day there is nothing to list", async () => {
  expect(await listCompletedShifts(SCOPE)).toEqual({ timesheets: [], unreadable: 0 });
});

test("one finished day is listed exactly as it reads back", async () => {
  const done = await finishedDay(day(19, 5), day(19, 17));

  expect(await listCompletedShifts(SCOPE)).toEqual({ timesheets: [done], unreadable: 0 });
  expect(await readCompletedShift(SCOPE, done.id)).toEqual(done);
});

test("several finished days are listed NEWEST FIRST by the day itself, not by file", async () => {
  const middle = await finishedDay(day(18, 6), day(18, 14));
  const newest = await finishedDay(day(20, 5), day(20, 12));
  const oldest = await finishedDay(day(16, 7), day(16, 15));

  expect((await listCompletedShifts(SCOPE)).timesheets.map(shift => shift.id)).toEqual([newest.id, middle.id, oldest.id]);
});

test("two days starting at the same moment are ordered by their finish, then by id — stable", async () => {
  // Ids chosen so that id order is the OPPOSITE of the right order: only the
  // finish can put these two the right way round.
  const random = jest.spyOn(Math, "random").mockReturnValue(0);
  const shorter = await finishedDay(day(19, 5), day(19, 9));
  random.mockReturnValue(0.999);
  const longer = await finishedDay(day(19, 5), day(19, 17));
  random.mockRestore();
  expect(shorter.id < longer.id).toBe(true);

  const listed = (await listCompletedShifts(SCOPE)).timesheets.map(shift => shift.id);
  expect(listed).toEqual([longer.id, shorter.id]);
  expect((await listCompletedShifts(SCOPE)).timesheets.map(shift => shift.id)).toEqual(listed);
});

test("a day that CROSSED MIDNIGHT and one that ran over SEVERAL DAYS are listed with their real times", async () => {
  const overnight = await finishedDay(day(18, 22), day(19, 6));
  const multiDay = await finishedDay(day(14, 6), day(16, 18));

  const listed = (await listCompletedShifts(SCOPE)).timesheets;

  expect(listed.map(shift => [shift.startedAt, shift.endedAt])).toEqual([
    [overnight.startedAt, day(19, 6).toISOString()],
    [multiDay.startedAt, day(16, 18).toISOString()],
  ]);
});

test("a DAMAGED record is left out — and every readable day is still listed", async () => {
  const first = await finishedDay(day(18, 6), day(18, 14));
  const second = await finishedDay(day(19, 6), day(19, 14));
  const broken = await finishedDay(day(20, 6), day(20, 14));
  recordFile(broken.id).write("{ not json");
  const misshapen = await finishedDay(day(21, 6), day(21, 14));
  const record = JSON.parse(recordFile(misshapen.id).textSync()) as Record<string, unknown>;
  recordFile(misshapen.id).write(JSON.stringify({ ...record, nightOut: "maybe" }));

  expect((await listCompletedShifts(SCOPE)).timesheets.map(shift => shift.id)).toEqual([second.id, first.id]);
  // Left out — and counted, so the driver can be told. Neither is deleted or repaired.
  expect((await listCompletedShifts(SCOPE)).unreadable).toBe(2);
  expect(recordFile(broken.id).textSync()).toBe("{ not json");
  expect(recordFile(misshapen.id).exists).toBe(true);
});

test("a record filed under ANOTHER day's name is not listed as that day", async () => {
  const real = await finishedDay(day(19, 6), day(19, 14));
  const impostor = recordFile("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  impostor.create();
  impostor.write(recordFile(real.id).textSync());

  expect((await listCompletedShifts(SCOPE)).timesheets.map(shift => shift.id)).toEqual([real.id]);
  expect((await listCompletedShifts(SCOPE)).unreadable).toBe(1);
});

test("the open day, its temporary file, recovery files and unrelated files are never listed", async () => {
  const done = await finishedDay(day(18, 6), day(18, 14));
  const open = await startLocalShift(SCOPE, { workingFor: { kind: "personal" }, startedAt: day(19, 6), vehicle: UNIT });
  const copy = recordFile(done.id).textSync();
  for (const name of [
    OPEN_SHIFT_TEMP_FILE,
    `${RECOVERY_FILE_PREFIX}unreadable-1-x.json`,
    `${RECOVERY_FILE_PREFIX}unfinished-2-y.json`,
    "notes.json",
    `${COMPLETED_SHIFT_FILE_PREFIX}${done.id}.json.bak`,
  ]) {
    const file = new File(accountDirectoryOf(SCOPE), name);
    file.create({ overwrite: true });
    file.write(copy);
  }

  // Not finished days' records at all — neither listed nor counted as unreadable.
  expect(await listCompletedShifts(SCOPE)).toMatchObject({ unreadable: 0 });
  expect((await listCompletedShifts(SCOPE)).timesheets.map(shift => shift.id)).toEqual([done.id]);
  expect((await readOpenShift(SCOPE))?.id).toBe(open.id);
  expect(new File(accountDirectoryOf(SCOPE), OPEN_SHIFT_FILE).exists).toBe(true);
});

test("an id finds EXACTLY its own day; an unknown, empty or unsafe id finds nothing and never throws", async () => {
  const first = await finishedDay(day(18, 6), day(18, 14), "Northgate Haulage");
  const second = await finishedDay(day(19, 6), day(19, 14), "Northgate Haulage");

  expect(await readCompletedShift(SCOPE, first.id)).toEqual(first);
  expect(await readCompletedShift(SCOPE, second.id)).toEqual(second);
  for (const id of ["", "nope", "../logisticbay-open-shift", `${first.id}/..`, "a b"]) {
    expect(await readCompletedShift(SCOPE, id)).toBeNull();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Finish and the list
// ═══════════════════════════════════════════════════════════════════════════

test("a finished day is listable IMMEDIATELY, and is no longer the open day", async () => {
  const done = await finishedDay(day(19, 5), day(19, 17));

  expect(await readOpenShift(SCOPE)).toBeNull();
  expect((await listCompletedShifts(SCOPE)).timesheets.map(shift => shift.id)).toEqual([done.id]);
});

test("a FAILED finish lists nothing — the day stays open, and no record appears", async () => {
  const shift = await startLocalShift(SCOPE, { workingFor: { kind: "personal" }, startedAt: day(19, 5), vehicle: null });
  jest.spyOn(File.prototype, "write").mockImplementation(() => { throw new Error("disk full"); });

  await expect(finishDeclared(SCOPE, {
    shiftId: shift.id, vehicleUseId: null, trailerUseId: null, finalMileage: null,
    endedAt: day(19, 17), nightOut: false, notes: "",
  })).rejects.toThrow(SafeSaveFailedError);

  jest.restoreAllMocks();
  expect(await listCompletedShifts(SCOPE)).toEqual({ timesheets: [], unreadable: 0 });
  expect((await readOpenShift(SCOPE))?.id).toBe(shift.id);
});

test("a DOUBLE finish lists ONE day", async () => {
  const shift = await startLocalShift(SCOPE, { workingFor: { kind: "personal" }, startedAt: day(19, 5), vehicle: null });
  const finish = {
    shiftId: shift.id, vehicleUseId: null, trailerUseId: null, finalMileage: null,
    endedAt: day(19, 17), nightOut: true, notes: "",
  };

  await Promise.all([finishDeclared(SCOPE, finish), finishDeclared(SCOPE, finish)]);

  expect((await listCompletedShifts(SCOPE)).timesheets.map(listed => listed.id)).toEqual([shift.id]);
});
