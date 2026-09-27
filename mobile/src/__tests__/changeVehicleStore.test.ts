/**
 * Changing vehicle — what reaches the phone.
 *
 * A day keeps the vehicle in use and every earlier USE of a vehicle, each
 * closed with the mileage and moment it ended. A change ends one use and
 * begins the next in one write; a return to an earlier plate is a NEW use,
 * with its own start mileage and no checks; and nothing about an earlier use
 * — its start, its checks, its certificate — is touched by what comes after.
 */
import { File, Paths } from "expo-file-system";
import {
  OPEN_SHIFT_FILE,
  USAGE_STATE,
  addVehicleToOpenShift,
  changeVehicle,
  clearOpenShift,
  completeVehicleCheck,
  endVehicleUse,
  newLocalId,
  readOpenShift,
  recordVehicleFill,
  saveVehicleCheckDraft,
  startLocalShift,
  type ChangeVehicleInput,
  type EndVehicleUseInput,
  type LocalShift,
  type VehicleDetails,
} from "../shift/localShift";
import { checklistFor, checklistItems } from "../shift/checklists";
import { checkStateOf, type CheckAnswer } from "../shift/vehicleCheck";

const STARTED_AT = new Date(2026, 8, 19, 5, 30);
const AB12: VehicleDetails = { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 };
const XY34: VehicleDetails = { vehicleClass: "class1", numberPlate: "XY34 ZZZ", startMileage: 220_000 };
const at = (hours: number, minutes = 0) => new Date(2026, 8, 19, hours, minutes);

const storedFile = () => new File(Paths.document, OPEN_SHIFT_FILE);

async function dayWith(vehicle: VehicleDetails = AB12): Promise<LocalShift> {
  return startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle });
}

/** The change from the vehicle in use now, as the screen would ask for it. */
async function changeFrom(shift: LocalShift, over: Partial<ChangeVehicleInput> & { next: VehicleDetails }): Promise<LocalShift | null> {
  const open = (await readOpenShift()) ?? shift;
  return changeVehicle({
    shiftId: shift.id,
    endingStartedAt: open.vehicle?.startedAt ?? "",
    endMileage: open.vehicle?.startMileage ?? 0,
    changedAt: at(9),
    ...over,
  });
}

const allOk = (vehicleClass: VehicleDetails["vehicleClass"] = "class1"): CheckAnswer[] =>
  checklistItems(checklistFor(vehicleClass)).map(entry => ({ key: entry.key, result: entry.defaultResult, note: "" }));

async function completeCheckOnCurrent(shift: LocalShift, checkId: string): Promise<void> {
  const open = await readOpenShift();
  const vehicleStartedAt = open?.vehicle?.startedAt ?? "";
  await completeVehicleCheck({
    shiftId: shift.id, vehicleStartedAt, checkId, startedAt: at(5, 40),
    answers: allOk(open?.vehicle?.vehicleClass), completedAt: at(5, 50), completedBy: "user_1",
  });
}

beforeEach(async () => { await clearOpenShift(); });
afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// Ending the vehicle in use
// ═══════════════════════════════════════════════════════════════════════════

test("the vehicle in use is CLOSED with the end mileage and the moment of the change", async () => {
  const shift = await dayWith();

  const day = await changeFrom(shift, { endMileage: 100_120, changedAt: at(9), next: XY34 });

  expect(day?.previousVehicles).toHaveLength(1);
  expect(day?.previousVehicles[0]).toMatchObject({ numberPlate: "AB12 CDE", endMileage: 100_120, endedAt: at(9).toISOString() });
  // The vehicle in use carries no end at all — not even an empty one.
  expect(day?.vehicle).not.toHaveProperty("endMileage");
  expect(day?.vehicle).not.toHaveProperty("endedAt");
});

test("an end mileage BELOW the start mileage is refused, and nothing is written", async () => {
  const shift = await dayWith();
  const before = storedFile().textSync();

  await expect(changeFrom(shift, { endMileage: 99_999, next: XY34 })).rejects.toThrow("below the start mileage");

  expect(storedFile().textSync()).toBe(before);
});

test("an end mileage EQUAL to the start mileage is accepted — a vehicle may not have moved", async () => {
  const shift = await dayWith();

  const day = await changeFrom(shift, { endMileage: 100_000, next: XY34 });

  expect(day?.previousVehicles[0]?.endMileage).toBe(100_000);
});

test("closing keeps the use's START exactly as it was", async () => {
  const shift = await dayWith();
  const startedAt = shift.vehicle?.startedAt;

  const day = await changeFrom(shift, { endMileage: 100_120, next: XY34 });

  expect(day?.previousVehicles[0]?.startedAt).toBe(startedAt);
  expect(day?.previousVehicles[0]?.startMileage).toBe(100_000);
});

test("closing keeps the use's checks exactly as they were — a completed one AND a draft", async () => {
  const shift = await dayWith();
  await completeCheckOnCurrent(shift, "certificate");
  const withCertificate = (await readOpenShift())?.vehicle?.checks;
  const day = await changeFrom(shift, { endMileage: 100_120, next: XY34 });
  expect(day?.previousVehicles[0]?.checks).toEqual(withCertificate);

  // A draft left unfinished is kept as the unfinished draft it is.
  await saveVehicleCheckDraft({
    shiftId: shift.id, vehicleStartedAt: day?.vehicle?.startedAt ?? "", checkId: "draft", startedAt: at(9, 5),
    answers: [{ key: "horn", result: "fail", note: "Horn silent" }],
  });
  const withDraft = (await readOpenShift())?.vehicle?.checks;
  const later = await changeFrom(shift, { endMileage: 220_050, changedAt: at(11), next: { ...AB12, startMileage: 100_130 } });

  expect(later?.previousVehicles[1]?.checks).toEqual(withDraft);
  expect(later?.previousVehicles[1]?.checks[0]?.status).toBe("draft");
});

// ═══════════════════════════════════════════════════════════════════════════
// Beginning the next use
// ═══════════════════════════════════════════════════════════════════════════

test("the next vehicle is a NEW use: its own start mileage, its own start, and no checks", async () => {
  const shift = await dayWith();
  await completeCheckOnCurrent(shift, "certificate");

  const day = await changeFrom(shift, { endMileage: 100_120, changedAt: at(9), next: XY34 });

  expect(day?.vehicle).toEqual({ ...XY34, startedAt: at(9).toISOString(), checks: [], fills: [] });
  // One instant: the old use ends exactly as the new begins.
  expect(day?.previousVehicles[0]?.endedAt).toBe(day?.vehicle?.startedAt);
});

test("the plate is stored trimmed and upper-cased, as everywhere else", async () => {
  const shift = await dayWith();

  const day = await changeFrom(shift, { next: { vehicleClass: "class1", numberPlate: "  xy34 zzz ", startMileage: 5 } });

  expect(day?.vehicle?.numberPlate).toBe("XY34 ZZZ");
});

test("the ended use stays in the day's history — the change APPENDS, it does not replace", async () => {
  const shift = await dayWith();

  await changeFrom(shift, { endMileage: 100_120, next: XY34 });

  const stored = await readOpenShift();
  expect(stored?.previousVehicles.map(use => use.numberPlate)).toEqual(["AB12 CDE"]);
  expect(stored?.vehicle?.numberPlate).toBe("XY34 ZZZ");
});

test("the SAME plate can be used again — as a separate use, with its own start", async () => {
  const shift = await dayWith();
  await changeFrom(shift, { endMileage: 100_120, changedAt: at(9), next: XY34 });

  // Back to AB12 at 13:00, which someone else has moved 10 miles meanwhile.
  const day = await changeFrom(shift, { endMileage: 220_090, changedAt: at(13), next: { ...AB12, startMileage: 100_130 } });

  expect(day?.previousVehicles.map(use => use.numberPlate)).toEqual(["AB12 CDE", "XY34 ZZZ"]);
  expect(day?.vehicle).toMatchObject({ numberPlate: "AB12 CDE", startMileage: 100_130, startedAt: at(13).toISOString() });
  // Two uses of one truck, told apart by when each began.
  expect(day?.vehicle?.startedAt).not.toBe(day?.previousVehicles[0]?.startedAt);
  // Continuity is not enforced: the new start is what the driver read, not the old end.
  expect(day?.previousVehicles[0]?.endMileage).toBe(100_120);
});

test("returning to a plate does NOT inherit its earlier check — the new use is not checked", async () => {
  const shift = await dayWith();
  await completeCheckOnCurrent(shift, "certificate");
  await changeFrom(shift, { endMileage: 100_120, changedAt: at(9), next: XY34 });

  const day = await changeFrom(shift, { endMileage: 220_090, changedAt: at(13), next: { ...AB12, startMileage: 100_130 } });

  expect(day?.vehicle?.checks).toEqual([]);
  expect(checkStateOf(day?.vehicle?.checks ?? [])).toBe("not-started");
  // The morning's certificate is where it was, unchanged.
  expect(checkStateOf(day?.previousVehicles[0]?.checks ?? [])).toBe("completed");
});

test("checking the returned-to vehicle makes a NEW check on the new use, leaving the old certificate alone", async () => {
  const shift = await dayWith();
  await completeCheckOnCurrent(shift, "morning");
  const certificate = (await readOpenShift())?.vehicle?.checks[0];
  await changeFrom(shift, { endMileage: 100_120, changedAt: at(9), next: XY34 });
  await changeFrom(shift, { endMileage: 220_090, changedAt: at(13), next: { ...AB12, startMileage: 100_130 } });

  await completeCheckOnCurrent(shift, "afternoon");

  const day = await readOpenShift();
  expect(day?.vehicle?.checks.map(check => check.id)).toEqual(["afternoon"]);
  expect(day?.previousVehicles[0]?.checks).toEqual([certificate]);
});

test("a check saved for an ENDED use is not written into the vehicle now in use", async () => {
  const shift = await dayWith();
  const morning = shift.vehicle?.startedAt ?? "";
  await changeFrom(shift, { endMileage: 100_120, next: XY34 });

  const stored = await saveVehicleCheckDraft({
    shiftId: shift.id, vehicleStartedAt: morning, checkId: "late", startedAt: at(9, 1),
    answers: [{ key: "horn", result: "na", note: "" }],
  });

  expect(stored).toBeNull();
  const day = await readOpenShift();
  expect(day?.vehicle?.checks).toEqual([]);
  expect(day?.previousVehicles[0]?.checks).toEqual([]);
});

test("several changes keep EVERY use, in the order they ended", async () => {
  const shift = await dayWith();
  await changeFrom(shift, { endMileage: 100_120, changedAt: at(9), next: XY34 });
  await changeFrom(shift, { endMileage: 220_090, changedAt: at(13), next: { ...AB12, startMileage: 100_130 } });
  await changeFrom(shift, { endMileage: 100_200, changedAt: at(15), next: { ...XY34, startMileage: 220_100 } });

  const day = await readOpenShift();

  expect(day?.previousVehicles.map(use => [use.numberPlate, use.startMileage, use.endMileage])).toEqual([
    ["AB12 CDE", 100_000, 100_120],
    ["XY34 ZZZ", 220_000, 220_090],
    ["AB12 CDE", 100_130, 100_200],
  ]);
  expect(day?.vehicle).toMatchObject({ numberPlate: "XY34 ZZZ", startMileage: 220_100 });
  const starts = [...(day?.previousVehicles ?? []), day?.vehicle].map(use => use?.startedAt);
  expect(new Set(starts).size).toBe(4);
});

// ═══════════════════════════════════════════════════════════════════════════
// Class belongs to the USE, not to the day (D30)
// ═══════════════════════════════════════════════════════════════════════════

test.each([
  ["class1", "class2"], ["class1", "van"], ["class1", "class1"],
  ["class2", "class1"], ["class2", "van"], ["class2", "class2"],
  ["van", "class1"], ["van", "class2"], ["van", "van"],
] as const)("a %s may be changed for a %s — every direction, and each use keeps its own class", async (from, to) => {
  const shift = await dayWith({ vehicleClass: from, numberPlate: "FROM 1", startMileage: 10 });

  const day = await changeFrom(shift, { endMileage: 20, next: { vehicleClass: to, numberPlate: "TO 1", startMileage: 30 } });

  expect(day?.vehicle?.vehicleClass).toBe(to);
  expect(day?.previousVehicles[0]?.vehicleClass).toBe(from);
});

test("a day that has used a UNIT is not locked to units — Class 2 → Van → Class 1 → Class 2", async () => {
  const shift = await dayWith({ vehicleClass: "class2", numberPlate: "RG11 AAA", startMileage: 10 });

  await changeFrom(shift, { endMileage: 60, changedAt: at(9), next: { vehicleClass: "van", numberPlate: "VN11 BBB", startMileage: 500 } });
  await changeFrom(shift, { endMileage: 560, changedAt: at(12), next: { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 } });
  const day = await changeFrom(shift, { endMileage: 100_300, changedAt: at(16), next: { vehicleClass: "class2", numberPlate: "RG11 AAA", startMileage: 90 } });

  expect(day?.previousVehicles.map(use => [use.vehicleClass, use.numberPlate])).toEqual([
    ["class2", "RG11 AAA"],
    ["van", "VN11 BBB"],
    ["class1", "AB12 CDE"],
  ]);
  expect(day?.vehicle).toMatchObject({ vehicleClass: "class2", numberPlate: "RG11 AAA", startMileage: 90 });
});

test.each([
  ["an empty plate",            { ...XY34, numberPlate: "   " }],
  ["a negative start mileage",  { ...XY34, startMileage: -1 }],
  ["a fractional start mileage", { ...XY34, startMileage: 12.5 }],
])("%s for the next vehicle is refused, and nothing is written", async (_why, next) => {
  const shift = await dayWith();
  const before = storedFile().textSync();

  await expect(changeFrom(shift, { next })).rejects.toThrow();

  expect(storedFile().textSync()).toBe(before);
});

test("a next use starting at the SAME instant as another is refused — a use is identified by its start", async () => {
  // The Start Shift vehicle began at the declared 05:30; a change stamped at
  // exactly that instant would give two uses one identity.
  const shift = await dayWith();

  await expect(changeFrom(shift, { changedAt: STARTED_AT, next: XY34 })).rejects.toThrow("same instant");
});

// ═══════════════════════════════════════════════════════════════════════════
// Once, whole, and only for the day it was begun on
// ═══════════════════════════════════════════════════════════════════════════

test("rapid repeated confirmations change ONCE — one ended use, one new use", async () => {
  const shift = await dayWith();
  const input = { endMileage: 100_120, changedAt: at(9), next: XY34 };

  const results = await Promise.all([changeFrom(shift, input), changeFrom(shift, input), changeFrom(shift, input)]);

  const day = await readOpenShift();
  expect(day?.previousVehicles).toHaveLength(1);
  expect(day?.vehicle?.numberPlate).toBe("XY34 ZZZ");
  for (const result of results) expect(result).toEqual(day);
});

test("a change whose write FAILS leaves the day exactly as it was — and the next attempt works", async () => {
  const shift = await dayWith();
  const before = storedFile().textSync();
  jest.spyOn(File.prototype, "write").mockImplementationOnce(() => { throw new Error("disk full"); });

  await expect(changeFrom(shift, { endMileage: 100_120, next: XY34 })).rejects.toThrow("disk full");

  // No half-change: the vehicle in use is still in use, with no end recorded.
  expect(storedFile().textSync()).toBe(before);
  const unchanged = await readOpenShift();
  expect(unchanged?.previousVehicles).toEqual([]);
  expect(unchanged?.vehicle?.numberPlate).toBe("AB12 CDE");

  const retried = await changeFrom(shift, { endMileage: 100_120, next: XY34 });
  expect(retried?.previousVehicles).toHaveLength(1);
});

test("a change for a day that is no longer the one open writes nothing", async () => {
  const shift = await dayWith();
  await clearOpenShift();
  await dayWith(XY34);
  const before = storedFile().textSync();

  const result = await changeVehicle({
    shiftId: shift.id, endingStartedAt: shift.vehicle?.startedAt ?? "", endMileage: 100_120, changedAt: at(9), next: XY34,
  });

  expect(result).toBeNull();
  expect(storedFile().textSync()).toBe(before);
});

test("a day with NO vehicle has nothing to change, and is returned untouched", async () => {
  const shift = await startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle: null });
  const before = storedFile().textSync();

  const result = await changeVehicle({ shiftId: shift.id, endingStartedAt: "", endMileage: 1, changedAt: at(9), next: XY34 });

  expect(result).toEqual(shift);
  expect(storedFile().textSync()).toBe(before);
});

test("the change survives a COLD START — current and every earlier use, read from the file alone", async () => {
  const shift = await dayWith();
  await completeCheckOnCurrent(shift, "morning");
  await changeFrom(shift, { endMileage: 100_120, changedAt: at(9), next: XY34 });
  await changeFrom(shift, { endMileage: 220_090, changedAt: at(13), next: { ...AB12, startMileage: 100_130 } });

  // What a relaunch sees: the bytes on disk, and nothing in memory.
  const onDisk: unknown = JSON.parse(storedFile().textSync());
  const recovered = await readOpenShift();

  expect(recovered).toEqual(onDisk);
  expect(recovered?.previousVehicles.map(use => [use.numberPlate, use.endMileage, use.endedAt])).toEqual([
    ["AB12 CDE", 100_120, at(9).toISOString()],
    ["XY34 ZZZ", 220_090, at(13).toISOString()],
  ]);
  expect(checkStateOf(recovered?.previousVehicles[0]?.checks ?? [])).toBe("completed");
  expect(recovered?.vehicle).toMatchObject({ numberPlate: "AB12 CDE", startMileage: 100_130, checks: [], fills: [] });
});

// ═══════════════════════════════════════════════════════════════════════════
// Days saved before vehicles could be changed
// ═══════════════════════════════════════════════════════════════════════════

function storeDocument(document: unknown): string {
  const file = storedFile();
  file.create({ overwrite: true });
  const bytes = JSON.stringify(document);
  file.write(bytes);
  return bytes;
}

test("a day saved BEFORE vehicles could be changed still loads, with no earlier uses — and is not rewritten", async () => {
  // The oldest shape a phone may hold: one vehicle, no use start, no checks, no history.
  const bytes = storeDocument({
    id: "11111111-2222-4333-8444-555555555555", workingFor: { kind: "personal" },
    startedAt: STARTED_AT.toISOString(),
    vehicle: { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 },
    status: "open", createdAt: STARTED_AT.toISOString(),
  });

  const day = await readOpenShift();

  expect(day?.previousVehicles).toEqual([]);
  expect(day?.vehicle).toEqual({ ...AB12, startedAt: STARTED_AT.toISOString(), checks: [], fills: [] });
  // Reading is not writing.
  expect(storedFile().textSync()).toBe(bytes);
});

test("an old day can be changed like any other — its vehicle becomes the first earlier use", async () => {
  storeDocument({
    id: "11111111-2222-4333-8444-555555555555", workingFor: { kind: "personal" },
    startedAt: STARTED_AT.toISOString(),
    vehicle: { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 },
    status: "open", createdAt: STARTED_AT.toISOString(),
  });
  const shift = await readOpenShift();
  if (shift === null) throw new Error("expected the old day to load");

  const day = await changeFrom(shift, { endMileage: 100_120, next: XY34 });

  expect(day?.previousVehicles[0]).toMatchObject({ ...AB12, startedAt: STARTED_AT.toISOString(), endMileage: 100_120 });
});

const ended = (over: Record<string, unknown> = {}) => ({
  ...AB12, startedAt: STARTED_AT.toISOString(), checks: [], fills: [], endMileage: 100_120, endedAt: at(9).toISOString(), ...over,
});
const current = { ...XY34, startedAt: at(9).toISOString(), checks: [], fills: [] };

test.each([
  ["earlier uses that are not a list",       { previousVehicles: "AB12 CDE" }],
  ["an earlier use with no end mileage",     { previousVehicles: [ended({ endMileage: undefined })] }],
  ["an earlier use ending BELOW its start",  { previousVehicles: [ended({ endMileage: 99_000 })] }],
  ["an earlier use with no end time",        { previousVehicles: [ended({ endedAt: undefined })] }],
  ["an earlier use with no start",           { previousVehicles: [ended({ startedAt: undefined })] }],
  ["a vehicle in use that carries an end",   { vehicle: { ...current, endMileage: 220_010 } }],
  ["two uses sharing one start",             { previousVehicles: [ended({ startedAt: at(9).toISOString() })] }],
])("%s is not a day this app wrote — reported as no open day, and the file is left in place", async (_why, over) => {
  const bytes = storeDocument({
    id: "11111111-2222-4333-8444-555555555555", workingFor: { kind: "personal" },
    startedAt: STARTED_AT.toISOString(), vehicle: current, previousVehicles: [ended()],
    status: "open", createdAt: STARTED_AT.toISOString(), ...over,
  });

  expect(await readOpenShift()).toBeNull();
  expect(storedFile().textSync()).toBe(bytes);
});

test("CONTROL: the same document, well formed, loads", async () => {
  storeDocument({
    id: "11111111-2222-4333-8444-555555555555", workingFor: { kind: "personal" },
    startedAt: STARTED_AT.toISOString(), vehicle: current, previousVehicles: [ended()],
    status: "open", createdAt: STARTED_AT.toISOString(),
  });

  const day = await readOpenShift();

  expect(day?.previousVehicles).toEqual([ended()]);
  expect(day?.vehicle).toEqual(current);
});

test("changing vehicle makes NO request", async () => {
  const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(() => Promise.reject(new Error("offline")));
  const shift = await dayWith();

  await changeFrom(shift, { endMileage: 100_120, next: XY34 });

  expect(fetchSpy).not.toHaveBeenCalled();
});

// ═══════════════════════════════════════════════════════════════════════════
// Giving a vehicle up with NOTHING to follow (D32)
// ═══════════════════════════════════════════════════════════════════════════

const RIGID: VehicleDetails = { vehicleClass: "class2", numberPlate: "RG11 AAA", startMileage: 40_000 };
const VAN: VehicleDetails = { vehicleClass: "van", numberPlate: "VN11 BBB", startMileage: 500 };

/** End the vehicle in use and carry on without one, as the screen asks for it. */
async function endFrom(shift: LocalShift, over: Partial<EndVehicleUseInput> = {}): Promise<LocalShift | null> {
  const open = (await readOpenShift()) ?? shift;
  return endVehicleUse({
    shiftId: shift.id,
    endingStartedAt: open.vehicle?.startedAt ?? "",
    endMileage: open.vehicle?.startMileage ?? 0,
    endedAt: at(13),
    ...over,
  });
}

/** A fill on the vehicle in use — what must still be there after it is given up. */
async function fill(shift: LocalShift, litres: number | null, type: "fuel" | "adblue", recordedAt: Date): Promise<void> {
  const open = await readOpenShift();
  await recordVehicleFill({
    shiftId: shift.id, vehicleStartedAt: open?.vehicle?.startedAt ?? "", usageState: USAGE_STATE.inUse, fillId: newLocalId(),
    type, recordedAt, litres, note: "",
  });
}

test.each([["a Class 1", AB12], ["a Class 2", RIGID], ["a van", VAN]] as const)(
  "%s in use can be given up with no vehicle to follow — the shift stays open",
  async (_what, vehicle) => {
    const shift = await dayWith(vehicle);

    const day = await endFrom(shift, { endMileage: vehicle.startMileage + 40 });

    expect(day?.vehicle).toBeNull();
    expect(day?.status).toBe("open");
    expect(day?.previousVehicles).toHaveLength(1);
    expect(day?.previousVehicles[0]).toMatchObject({
      vehicleClass: vehicle.vehicleClass,
      numberPlate: vehicle.numberPlate,
      startMileage: vehicle.startMileage,
      endMileage: vehicle.startMileage + 40,
    });
    // The day is still there to work in — nothing was discarded.
    expect(storedFile().exists).toBe(true);
    expect(await readOpenShift()).not.toBeNull();
  },
);

test("an end mileage BELOW the start is refused, nothing is written, and the vehicle stays in use", async () => {
  const shift = await dayWith();
  const before = storedFile().textSync();

  await expect(endFrom(shift, { endMileage: 99_999 })).rejects.toThrow("below the start mileage");

  expect(storedFile().textSync()).toBe(before);
  expect((await readOpenShift())?.vehicle).not.toBeNull();
});

test("an end mileage EQUAL to the start is accepted — a vehicle may not have moved", async () => {
  const shift = await dayWith();

  const day = await endFrom(shift, { endMileage: 100_000 });

  expect(day?.previousVehicles[0]?.endMileage).toBe(100_000);
});

test.each([
  ["a fractional reading", { endMileage: 100_100.5 }],
  ["a negative reading",   { endMileage: -1 }],
  ["a moment that is not one", { endedAt: new Date(Number.NaN) }],
])("%s is refused, and nothing is written", async (_why, over) => {
  const shift = await dayWith();
  const before = storedFile().textSync();

  await expect(endFrom(shift, over)).rejects.toThrow("Refusing an invalid end");

  expect(storedFile().textSync()).toBe(before);
});

test("it closes EXACTLY ONE use — the one in use — and leaves the earlier ones exactly as they were", async () => {
  const shift = await dayWith();
  await changeFrom(shift, { endMileage: 100_120, changedAt: at(9), next: XY34 });
  const before = (await readOpenShift())?.previousVehicles;

  const day = await endFrom(shift, { endMileage: 220_300, endedAt: at(13) });

  expect(day?.previousVehicles).toHaveLength(2);
  expect(day?.previousVehicles[0]).toEqual(before?.[0]);
  expect(day?.previousVehicles[1]).toMatchObject({
    numberPlate: "XY34 ZZZ", startMileage: 220_000, endMileage: 220_300, endedAt: at(13).toISOString(),
  });
});

test("the closed use keeps its start and gains the two facts the driver gave", async () => {
  const shift = await dayWith();
  const startedAt = shift.vehicle?.startedAt;

  const day = await endFrom(shift, { endMileage: 100_250, endedAt: at(13) });

  expect(day?.previousVehicles[0]).toMatchObject({
    startedAt, startMileage: 100_000, endMileage: 100_250, endedAt: at(13).toISOString(),
  });
});

test("the SHIFT is untouched — same day, same declared start, same context, still open", async () => {
  const shift = await dayWith();

  const day = await endFrom(shift, { endMileage: 100_250 });

  expect(day).toMatchObject({
    id: shift.id, startedAt: shift.startedAt, createdAt: shift.createdAt,
    status: "open", workingFor: { kind: "personal" },
  });
});

test("checks, fuel and AdBlue stay on the use that had them", async () => {
  const shift = await dayWith();
  await completeCheckOnCurrent(shift, "morning");
  await fill(shift, 300, "fuel", at(8));
  await fill(shift, null, "adblue", at(8, 30));
  const held = (await readOpenShift())?.vehicle;

  const day = await endFrom(shift, { endMileage: 100_250 });

  const [closed] = day?.previousVehicles ?? [];
  expect(closed?.checks).toEqual(held?.checks);
  expect(checkStateOf(closed?.checks ?? [])).toBe("completed");
  expect(closed?.fills).toEqual(held?.fills);
  expect(closed?.fills.map(entry => [entry.type, entry.litres])).toEqual([["fuel", 300], ["adblue", null]]);
});

test("a RESTART during the gap restores an OPEN day with no vehicle and its history intact", async () => {
  const shift = await dayWith();
  await fill(shift, 300, "fuel", at(8));
  await endFrom(shift, { endMileage: 100_250, endedAt: at(13) });

  // Read again from the file alone.
  const day = await readOpenShift();

  expect(day?.status).toBe("open");
  expect(day?.vehicle).toBeNull();
  expect(day?.previousVehicles).toHaveLength(1);
  expect(day?.previousVehicles[0]).toMatchObject({
    numberPlate: "AB12 CDE", startMileage: 100_000, endMileage: 100_250, endedAt: at(13).toISOString(),
  });
  expect(day?.previousVehicles[0]?.fills).toMatchObject([{ type: "fuel", litres: 300 }]);
});

test("a later vehicle begins a NEW use at ITS OWN time, and the real gap survives", async () => {
  const shift = await dayWith();
  await endFrom(shift, { endMileage: 100_250, endedAt: at(13) });

  const day = await addVehicleToOpenShift({ vehicle: XY34, startedAt: at(15) });

  expect(day?.vehicle).toEqual({ ...XY34, startedAt: at(15).toISOString(), checks: [], fills: [] });
  // NO use covers 13:00–15:00: the gap is the absence of one, not a record of one.
  expect(day?.previousVehicles).toHaveLength(1);
  const [closed] = day?.previousVehicles ?? [];
  expect(closed?.endedAt).toBe(at(13).toISOString());
  expect(Date.parse(day?.vehicle?.startedAt ?? "") - Date.parse(closed?.endedAt ?? "")).toBe(2 * 60 * 60 * 1000);
});

test("the earlier use's END is not rewritten to meet the vehicle that arrives later", async () => {
  const shift = await dayWith();
  await endFrom(shift, { endMileage: 100_250, endedAt: at(13) });
  const closedBefore = (await readOpenShift())?.previousVehicles[0];

  await addVehicleToOpenShift({ vehicle: XY34, startedAt: at(15) });

  expect((await readOpenShift())?.previousVehicles[0]).toEqual(closedBefore);
});

test("re-taking the SAME plate after the gap is a separate use — nothing is carried over", async () => {
  const shift = await dayWith();
  await completeCheckOnCurrent(shift, "morning");
  await fill(shift, 300, "fuel", at(8));
  await fill(shift, 40, "adblue", at(8, 30));
  await endFrom(shift, { endMileage: 100_250, endedAt: at(13) });

  const day = await addVehicleToOpenShift({ vehicle: { ...AB12, startMileage: 100_250 }, startedAt: at(15) });

  expect(day?.vehicle).toMatchObject({ numberPlate: "AB12 CDE", startMileage: 100_250, checks: [], fills: [] });
  expect(day?.vehicle?.startedAt).toBe(at(15).toISOString());
  // The morning's use still holds every bit of it.
  expect(day?.previousVehicles).toHaveLength(1);
  expect(day?.previousVehicles[0]?.fills).toHaveLength(2);
  expect(checkStateOf(day?.previousVehicles[0]?.checks ?? [])).toBe("completed");
});

test("three presses of the same confirmation close ONE use", async () => {
  const shift = await dayWith();
  const endingStartedAt = shift.vehicle?.startedAt ?? "";
  const press = () => endVehicleUse({ shiftId: shift.id, endingStartedAt, endMileage: 100_250, endedAt: at(13) });

  const days = await Promise.all([press(), press(), press()]);

  for (const day of days) expect(day?.vehicle).toBeNull();
  expect((await readOpenShift())?.previousVehicles).toHaveLength(1);
  expect((await readOpenShift())?.vehicle).toBeNull();
});

test("it ends the day and the use NAMED — another day, or a use not in use, changes nothing", async () => {
  const shift = await dayWith();
  const before = storedFile().textSync();

  expect(await endVehicleUse({
    shiftId: "11111111-2222-4333-8444-999999999999",
    endingStartedAt: shift.vehicle?.startedAt ?? "", endMileage: 100_250, endedAt: at(13),
  })).toBeNull();
  const unchanged = await endVehicleUse({
    shiftId: shift.id, endingStartedAt: at(4).toISOString(), endMileage: 100_250, endedAt: at(13),
  });

  expect(unchanged?.vehicle).not.toBeNull();
  expect(unchanged?.previousVehicles).toEqual([]);
  expect(storedFile().textSync()).toBe(before);
});

test("a day that already has no vehicle cannot be ended again", async () => {
  const shift = await dayWith();
  await endFrom(shift, { endMileage: 100_250, endedAt: at(13) });
  const before = storedFile().textSync();

  const day = await endFrom(shift, { endMileage: 100_900, endedAt: at(14) });

  expect(day?.vehicle).toBeNull();
  expect(day?.previousVehicles).toHaveLength(1);
  expect(storedFile().textSync()).toBe(before);
});

test("a vehicle whose start COLLIDES with an earlier use's is refused — that day would not load", async () => {
  const shift = await dayWith();
  const startedAt = shift.vehicle?.startedAt ?? "";
  await endFrom(shift, { endMileage: 100_250, endedAt: at(13) });
  const before = storedFile().textSync();

  // A phone whose clock has gone backwards, onto the instant an earlier use
  // began. One use, one start (`asLocalShift`): writing it would make the
  // driver's whole day unreadable, so it is refused instead.
  await expect(addVehicleToOpenShift({ vehicle: XY34, startedAt: new Date(startedAt) })).rejects.toThrow("same instant");

  expect(storedFile().textSync()).toBe(before);
  expect((await readOpenShift())?.vehicle).toBeNull();
  // A real later moment is a real, separate use.
  const day = await addVehicleToOpenShift({ vehicle: XY34, startedAt: at(15) });
  expect(day?.vehicle?.startedAt).toBe(at(15).toISOString());
});

test("giving a vehicle up makes NO request", async () => {
  const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(() => Promise.reject(new Error("offline")));
  const shift = await dayWith();

  await endFrom(shift, { endMileage: 100_250 });

  expect(fetchSpy).not.toHaveBeenCalled();
});
