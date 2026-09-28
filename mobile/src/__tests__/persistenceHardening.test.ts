/**
 * The open shift's persistence under failure (2026-09-28, before Finish Shift).
 *
 *   UNREADABLE DAY   Start Shift never overwrites a day file it cannot read:
 *                    the exact bytes are moved to a recovery file first, and if
 *                    that fails nothing is started and the original stays.
 *   SAFE WRITES      every write goes to a complete, verified temporary sibling
 *                    and only then replaces the live file; a failed write
 *                    leaves the previous day exactly as it was, and a leftover
 *                    temporary file is never read as the day.
 *   TIME ORDER       no vehicle or trailer use is ever ended before it began —
 *                    refused at the store with the day unchanged, and refused
 *                    by the reader if a saved day claims it.
 */
import { Directory, File, Paths } from "expo-file-system";
import {
  OPEN_SHIFT_FILE,
  OPEN_SHIFT_TEMP_FILE,
  RECOVERY_FILE_PREFIX,
  SafeSaveFailedError,
  UseEndsBeforeItStartedError,
  USAGE_STATE,
  addTrailerToOpenShift,
  changeTrailer,
  changeVehicle,
  clearOpenShift,
  endVehicleUse,
  readOpenShift,
  recordVehicleFill,
  saveVehicleCheckDraft,
  startLocalShift,
  type LocalShift,
  type VehicleDetails,
} from "../shift/localShift";
import { TRAILER_TYPE } from "../shift/trailer";
import { FILL_TYPE } from "../shift/vehicleFill";

const STARTED_AT = new Date(2026, 8, 19, 5, 0);
const at = (hours: number, minutes = 0) => new Date(2026, 8, 19, hours, minutes);
const UNIT: VehicleDetails = { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 };
const OTHER: VehicleDetails = { vehicleClass: "class2", numberPlate: "XY34 ZZZ", startMileage: 220_000 };
const TR23 = { trailerNumber: "TR23", trailerType: TRAILER_TYPE.standard };

const live = () => new File(Paths.document, OPEN_SHIFT_FILE);
const temp = () => new File(Paths.document, OPEN_SHIFT_TEMP_FILE);
const bytes = () => live().textSync();
/** Every recovery file in the documents directory, name → bytes. */
function recoveries(): Map<string, string> {
  const found = new Map<string, string>();
  for (const entry of new Directory(Paths.document).list()) {
    const name = entry.uri.split("/").pop() ?? "";
    if (name.startsWith(RECOVERY_FILE_PREFIX) && entry instanceof File) found.set(name, entry.textSync());
  }
  return found;
}
function removeRecoveries(): void {
  for (const entry of new Directory(Paths.document).list()) {
    const name = entry.uri.split("/").pop() ?? "";
    if ((name.startsWith(RECOVERY_FILE_PREFIX) || name === OPEN_SHIFT_TEMP_FILE) && entry instanceof File) entry.delete();
  }
}
function writeRaw(target: File, content: string): void {
  target.create({ overwrite: true });
  target.write(content);
}
const dayWith = (vehicle: VehicleDetails | null = UNIT): Promise<LocalShift> =>
  startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle });
const UNREADABLE = '{"id":"yesterday","status":"open","vehicle":{"startMileage":12.5},"note":"do not lose me"}';

beforeEach(async () => {
  await clearOpenShift();
  removeRecoveries();
});
afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// An unreadable day is preserved, never overwritten
// ═══════════════════════════════════════════════════════════════════════════

test("Start Shift over an UNREADABLE day moves its exact bytes to a recovery file, then starts the new day", async () => {
  writeRaw(live(), UNREADABLE);
  expect(await readOpenShift()).toBeNull();

  const shift = await dayWith();

  const saved = [...recoveries().values()];
  expect(saved).toEqual([UNREADABLE]);
  expect([...recoveries().keys()][0]).toMatch(new RegExp(`^${RECOVERY_FILE_PREFIX}unreadable-\\d+-[0-9a-f-]{36}\\.json$`));
  expect((await readOpenShift())?.id).toBe(shift.id);
});

test("a recovery file is never read as the day — it sits outside the open-shift path", async () => {
  writeRaw(live(), UNREADABLE);
  await dayWith();
  await clearOpenShift();

  expect(await readOpenShift()).toBeNull();
  expect(recoveries().size).toBe(1);
});

test("if preserving the unreadable day FAILS, nothing is started and the original stays exactly as it was", async () => {
  writeRaw(live(), UNREADABLE);
  jest.spyOn(File.prototype, "moveSync").mockImplementation(() => { throw new Error("disk full"); });

  await expect(dayWith()).rejects.toThrow(Error);

  expect(bytes()).toBe(UNREADABLE);
  expect(recoveries().size).toBe(0);
});

test("a recovery name that is already taken fails CLOSED — nothing overwritten, nothing started", async () => {
  writeRaw(live(), UNREADABLE);
  jest.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  jest.spyOn(Math, "random").mockReturnValue(0.5);
  // The very name the next preservation will choose is now taken.
  await dayWith();
  const [taken] = [...recoveries().keys()];
  expect(taken).toBeDefined();
  const takenBytes = recoveries().get(taken ?? "") ?? "";
  await clearOpenShift();
  writeRaw(live(), `${UNREADABLE} second`);

  await expect(dayWith()).rejects.toThrow(Error);

  expect(bytes()).toBe(`${UNREADABLE} second`);
  expect(recoveries().get(taken ?? "")).toBe(takenBytes);
});

test("CONTROL: a READABLE open day is simply returned — nothing is moved", async () => {
  const first = await dayWith();

  const again = await dayWith(OTHER);

  expect(again.id).toBe(first.id);
  expect(recoveries().size).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Safe replacement
// ═══════════════════════════════════════════════════════════════════════════

test("a successful write leaves the complete new day live, and no temporary file behind", async () => {
  const shift = await dayWith();

  await changeVehicle({ shiftId: shift.id, endingStartedAt: STARTED_AT.toISOString(), endMileage: 100_100, next: OTHER, changedAt: at(9) });

  expect(temp().exists).toBe(false);
  expect((await readOpenShift())?.vehicle?.numberPlate).toBe("XY34 ZZZ");
  expect(JSON.parse(bytes())).toMatchObject({ previousVehicles: [{ numberPlate: "AB12 CDE", endMileage: 100_100 }] });
});

test("a FAILED temporary write leaves the live day byte-for-byte, and the failure is reported", async () => {
  const shift = await dayWith();
  const before = bytes();
  jest.spyOn(File.prototype, "write").mockImplementation(() => { throw new Error("disk full"); });

  await expect(changeVehicle({ shiftId: shift.id, endingStartedAt: STARTED_AT.toISOString(), endMileage: 100_100, next: OTHER, changedAt: at(9) }))
    .rejects.toThrow(SafeSaveFailedError);

  jest.restoreAllMocks();
  expect(bytes()).toBe(before);
});

test("a temporary write that lands INCOMPLETE is never moved into place", async () => {
  const shift = await dayWith();
  const before = bytes();
  // The write returned, but reading the temporary file back finds only part of the day.
  jest.spyOn(File.prototype, "textSync").mockImplementation(function (this: File) {
    const stored = new TextDecoder().decode(this.bytesSync());
    return this.uri.endsWith(OPEN_SHIFT_TEMP_FILE) ? stored.slice(0, Math.floor(stored.length / 2)) : stored;
  });

  await expect(recordVehicleFill({
    shiftId: shift.id, vehicleStartedAt: STARTED_AT.toISOString(), usageState: USAGE_STATE.inUse,
    fillId: "f1", type: FILL_TYPE.fuel, recordedAt: at(6), litres: 50, note: "",
  })).rejects.toThrow(SafeSaveFailedError);

  jest.restoreAllMocks();
  expect(bytes()).toBe(before);
  expect(await readOpenShift()).not.toBeNull();
});

test("a FAILED replacement is reported — never silently counted as saved — and the previous day still reads", async () => {
  const shift = await dayWith();
  const before = bytes();
  jest.spyOn(File.prototype, "moveSync").mockImplementation(() => { throw new Error("rename failed"); });

  await expect(changeVehicle({ shiftId: shift.id, endingStartedAt: STARTED_AT.toISOString(), endMileage: 100_100, next: OTHER, changedAt: at(9) }))
    .rejects.toThrow(SafeSaveFailedError);

  jest.restoreAllMocks();
  expect(bytes()).toBe(before);
  expect((await readOpenShift())?.vehicle?.numberPlate).toBe("AB12 CDE");
});

test("a leftover temporary file is NEVER read as the day after a restart", async () => {
  await dayWith();
  const valid = bytes();
  await clearOpenShift();
  // A crash left a complete next day in the temporary file, and no live day.
  writeRaw(temp(), valid);

  expect(await readOpenShift()).toBeNull();
});

test("a leftover temporary file is PRESERVED as recovery at the next write — never promoted, never deleted", async () => {
  const shift = await dayWith();
  const leftover = bytes().replace("AB12 CDE", "UNCONFIRMED");
  writeRaw(temp(), leftover);

  await changeVehicle({ shiftId: shift.id, endingStartedAt: STARTED_AT.toISOString(), endMileage: 100_100, next: OTHER, changedAt: at(9) });

  expect(temp().exists).toBe(false);
  const saved = [...recoveries().entries()];
  expect(saved).toHaveLength(1);
  expect(saved[0]?.[0]).toMatch(new RegExp(`^${RECOVERY_FILE_PREFIX}unfinished-`));
  expect(saved[0]?.[1]).toBe(leftover);
  expect((await readOpenShift())?.vehicle?.numberPlate).toBe("XY34 ZZZ");
});

test("a next state the READER would refuse is never written — the live day is untouched", async () => {
  const shift = await dayWith();
  const before = bytes();
  const realStringify = JSON.stringify;
  // What reaches the disk is what JSON.stringify produced: NaN, for one,
  // silently becomes null. Here a serialisation the reader refuses.
  jest.spyOn(JSON, "stringify").mockImplementationOnce((value: unknown) =>
    realStringify(value).replace('"startMileage":100000', '"startMileage":12.5'));

  await expect(recordVehicleFill({
    shiftId: shift.id, vehicleStartedAt: STARTED_AT.toISOString(), usageState: USAGE_STATE.inUse,
    fillId: "f1", type: FILL_TYPE.fuel, recordedAt: at(6), litres: 50, note: "",
  })).rejects.toThrow("Refusing to store a day the reader would refuse");

  jest.restoreAllMocks();
  expect(bytes()).toBe(before);
  expect(temp().exists).toBe(false);
});

test("after a FAILED replacement the next write succeeds, and keeps the unconfirmed state as recovery", async () => {
  const shift = await dayWith();
  jest.spyOn(File.prototype, "moveSync").mockImplementationOnce(() => { throw new Error("rename failed"); });
  await expect(changeVehicle({ shiftId: shift.id, endingStartedAt: STARTED_AT.toISOString(), endMileage: 100_100, next: OTHER, changedAt: at(9) }))
    .rejects.toThrow(SafeSaveFailedError);
  jest.restoreAllMocks();
  const unconfirmed = temp().textSync();

  await changeVehicle({ shiftId: shift.id, endingStartedAt: STARTED_AT.toISOString(), endMileage: 100_200, next: OTHER, changedAt: at(10) });

  expect(temp().exists).toBe(false);
  expect([...recoveries().values()]).toEqual([unconfirmed]);
  expect((await readOpenShift())?.previousVehicles[0]?.endMileage).toBe(100_200);
});

test("Start Shift with only a leftover temporary file starts a fresh day and keeps the leftover as recovery", async () => {
  await dayWith();
  const leftover = bytes();
  await clearOpenShift();
  writeRaw(temp(), leftover);

  const shift = await dayWith(OTHER);

  expect(JSON.parse(bytes())).toMatchObject({ id: shift.id, vehicle: { numberPlate: "XY34 ZZZ" } });
  expect([...recoveries().values()]).toEqual([leftover]);
});

test("two queued writes both land, in order, through the safe path", async () => {
  const shift = await dayWith();

  await Promise.all([
    recordVehicleFill({ shiftId: shift.id, vehicleStartedAt: STARTED_AT.toISOString(), usageState: USAGE_STATE.inUse, fillId: "f1", type: FILL_TYPE.fuel, recordedAt: at(6), litres: 50, note: "" }),
    recordVehicleFill({ shiftId: shift.id, vehicleStartedAt: STARTED_AT.toISOString(), usageState: USAGE_STATE.inUse, fillId: "f2", type: FILL_TYPE.adblue, recordedAt: at(7), litres: null, note: "" }),
  ]);

  expect((await readOpenShift())?.vehicle?.fills.map(fill => fill.id)).toEqual(["f1", "f2"]);
  expect(temp().exists).toBe(false);
});

test.each([["mutation then Discard", true], ["Discard then mutation", false]])("%s: the day ends discarded — no write resurrects it", async (_order, mutationFirst) => {
  const shift = await dayWith();
  const mutate = () => saveVehicleCheckDraft({
    shiftId: shift.id, vehicleStartedAt: STARTED_AT.toISOString(), usageState: USAGE_STATE.inUse, checkId: "c1",
    startedAt: at(5, 5), answers: [{ key: "horn", result: "na", note: "" }],
  });

  await (mutationFirst ? Promise.all([mutate(), clearOpenShift()]) : Promise.all([clearOpenShift(), mutate()]));

  expect(live().exists).toBe(false);
  expect(await readOpenShift()).toBeNull();
});

test("a failed write followed by Discard leaves no day and no resurrection", async () => {
  const shift = await dayWith();
  jest.spyOn(File.prototype, "moveSync").mockImplementationOnce(() => { throw new Error("rename failed"); });

  await Promise.all([
    changeVehicle({ shiftId: shift.id, endingStartedAt: STARTED_AT.toISOString(), endMileage: 100_100, next: OTHER, changedAt: at(9) }).catch(() => null),
    clearOpenShift(),
  ]);
  jest.restoreAllMocks();

  expect(live().exists).toBe(false);
  expect(temp().exists).toBe(false);
  expect(await readOpenShift()).toBeNull();
  // Nor is the discarded day's unconfirmed change kept as recovery later.
  await dayWith(OTHER);
  expect(recoveries().size).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// No use ends before it began
// ═══════════════════════════════════════════════════════════════════════════

async function dayWithTrailer(): Promise<LocalShift> {
  const shift = await dayWith();
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(6) });
  return shift;
}

test.each([
  ["Change Vehicle", async (shift: LocalShift) => changeVehicle({ shiftId: shift.id, endingStartedAt: STARTED_AT.toISOString(), endMileage: 100_100, next: OTHER, changedAt: at(4, 59) })],
  ["No vehicle", async (shift: LocalShift) => endVehicleUse({ shiftId: shift.id, endingStartedAt: STARTED_AT.toISOString(), endMileage: 100_100, endedAt: at(4, 59) })],
] as const)("%s with the phone clock BEFORE the vehicle's start is refused, and the day is unchanged — restart included", async (_what, act) => {
  const shift = await dayWith();
  const before = bytes();

  await expect(act(shift)).rejects.toThrow(UseEndsBeforeItStartedError);

  expect(bytes()).toBe(before);
  expect((await readOpenShift())?.vehicle?.startedAt).toBe(STARTED_AT.toISOString());
});

test.each([
  ["Change Trailer", { trailerNumber: "GFD", trailerType: TRAILER_TYPE.standard }],
  ["No trailer", null],
] as const)("%s with the phone clock BEFORE the trailer's start is refused, and the day is unchanged — restart included", async (_what, next) => {
  const shift = await dayWithTrailer();
  const before = bytes();

  await expect(changeTrailer({ shiftId: shift.id, endingStartedAt: at(6).toISOString(), next, changedAt: at(5, 59) }))
    .rejects.toThrow(UseEndsBeforeItStartedError);

  expect(bytes()).toBe(before);
  expect((await readOpenShift())?.trailer?.trailerNumber).toBe("TR23");
});

test("an end at the very instant of the start is a use of no length — accepted, and it reads back", async () => {
  const shift = await dayWith();

  const day = await endVehicleUse({ shiftId: shift.id, endingStartedAt: STARTED_AT.toISOString(), endMileage: 100_000, endedAt: STARTED_AT });

  expect(day?.previousVehicles).toEqual([expect.objectContaining({ startedAt: STARTED_AT.toISOString(), endedAt: STARTED_AT.toISOString() })]);
  expect((await readOpenShift())?.previousVehicles).toHaveLength(1);
});

test("a trailer ended at the very instant it began is accepted, and it reads back", async () => {
  const shift = await dayWithTrailer();

  await changeTrailer({ shiftId: shift.id, endingStartedAt: at(6).toISOString(), next: null, changedAt: at(6) });

  expect((await readOpenShift())?.previousTrailers).toEqual([expect.objectContaining({ startedAt: at(6).toISOString(), endedAt: at(6).toISOString() })]);
});

test.each([
  ["an ended VEHICLE use", "previousVehicles", { ...UNIT, startedAt: at(9).toISOString(), checks: [], fills: [], endMileage: 100_100, endedAt: at(8).toISOString() }],
  ["an ended TRAILER use", "previousTrailers", { ...TR23, startedAt: at(9).toISOString(), reeferDiesel: [], checks: [], endedAt: at(8).toISOString() }],
] as const)("a saved day with %s that ended before it began fails CLOSED", async (_what, field, use) => {
  await dayWith();
  const day = JSON.parse(bytes()) as Record<string, unknown>;

  writeRaw(live(), JSON.stringify({ ...day, [field]: [use] }));

  expect(await readOpenShift()).toBeNull();
});

test("CONTROL: the same ended uses, in order, load", async () => {
  await dayWith();
  const day = JSON.parse(bytes()) as Record<string, unknown>;
  writeRaw(live(), JSON.stringify({
    ...day,
    previousVehicles: [{ ...UNIT, startedAt: at(4).toISOString(), checks: [], fills: [], endMileage: 100_000, endedAt: at(4).toISOString() }],
  }));

  expect(await readOpenShift()).not.toBeNull();
});
