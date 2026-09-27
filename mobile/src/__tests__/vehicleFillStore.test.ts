/**
 * Fuel and AdBlue — what reaches the phone.
 *
 * A fill belongs to the vehicle USE it went into, never to a number plate, and
 * a quantity nobody knows is stored as ABSENT — never as zero, and never
 * estimated. These prove both, and that nothing else in the day moves when one
 * is recorded, corrected or removed.
 */
import { File, Paths } from "expo-file-system";
import {
  OPEN_SHIFT_FILE,
  USAGE_STATE,
  changeVehicle,
  clearOpenShift,
  completeVehicleCheck,
  endVehicleUse,
  newLocalId,
  readOpenShift,
  recordVehicleFill,
  removeVehicleFill,
  startLocalShift,
  type LocalShift,
  type RecordVehicleFillInput,
  type VehicleDetails,
} from "../shift/localShift";
import { checklistFor, checklistItems } from "../shift/checklists";
import { FILL_TYPE, summariseFills, type VehicleFill } from "../shift/vehicleFill";
import { usageDistance, usageHistory } from "../shift/usedVehicles";
import { fillSummaryText } from "../screens/format";

/** Exactly these fields, and no others — the id is checked separately. */
const FILL_FIELDS = ["id", "litres", "note", "recordedAt", "type"];

const STARTED_AT = new Date(2026, 8, 19, 5, 30);
const AB12: VehicleDetails = { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 };
const XY34: VehicleDetails = { vehicleClass: "class1", numberPlate: "XY34 ZZZ", startMileage: 220_000 };
const at = (hours: number, minutes = 0) => new Date(2026, 8, 19, hours, minutes);

const storedFile = () => new File(Paths.document, OPEN_SHIFT_FILE);

async function dayWith(vehicle: VehicleDetails = AB12): Promise<LocalShift> {
  return startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle });
}

/** A fill on the vehicle in use, as the screen would record it. */
async function fill(shift: LocalShift, over: Partial<RecordVehicleFillInput> = {}): Promise<LocalShift | null> {
  const open = (await readOpenShift()) ?? shift;
  return recordVehicleFill({
    shiftId: shift.id,
    vehicleStartedAt: open.vehicle?.startedAt ?? "",
    usageState: USAGE_STATE.inUse,
    fillId: newLocalId(),
    type: FILL_TYPE.fuel,
    recordedAt: at(9),
    litres: 300,
    note: "",
    ...over,
  });
}

const fillsOn = async (): Promise<VehicleFill[]> => (await readOpenShift())?.vehicle?.fills ?? [];

async function changeTo(shift: LocalShift, next: VehicleDetails, hour: number): Promise<void> {
  const open = await readOpenShift();
  if (open?.vehicle == null) throw new Error("expected a vehicle in use");
  await changeVehicle({
    shiftId: shift.id, endingStartedAt: open.vehicle.startedAt,
    endMileage: open.vehicle.startMileage + 120, changedAt: at(hour), next,
  });
}

beforeEach(async () => { await clearOpenShift(); });
afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// What a fill records
// ═══════════════════════════════════════════════════════════════════════════

test("a KNOWN fuel quantity is stored on the vehicle in use", async () => {
  const shift = await dayWith();

  await fill(shift, { litres: 300, recordedAt: at(9, 15), note: "Truckstop" });

  const [stored] = await fillsOn();
  expect(Object.keys(stored ?? {}).sort()).toEqual(FILL_FIELDS);
  expect(stored).toMatchObject({ type: "fuel", recordedAt: at(9, 15).toISOString(), litres: 300, note: "Truckstop" });
  expect(stored?.id).not.toBe("");
});

test("an UNKNOWN fuel quantity is stored with NO litres — never 0", async () => {
  const shift = await dayWith();

  await fill(shift, { litres: null, note: "Yard pump — meter broken" });

  const [stored] = await fillsOn();
  expect(stored?.litres).toBeNull();
  // The distinction the whole feature rests on: absent is not zero.
  expect(stored?.litres).not.toBe(0);
  expect(JSON.parse(storedFile().textSync()) as unknown).toMatchObject({ vehicle: { fills: [{ litres: null }] } });
});

test("a KNOWN AdBlue quantity is stored, with its own type", async () => {
  const shift = await dayWith();

  await fill(shift, { type: FILL_TYPE.adblue, litres: 12.5 });

  expect(await fillsOn()).toMatchObject([{ type: "adblue", litres: 12.5 }]);
});

test("an UNKNOWN AdBlue quantity is stored without litres", async () => {
  const shift = await dayWith();

  await fill(shift, { type: FILL_TYPE.adblue, litres: null });

  expect(await fillsOn()).toMatchObject([{ type: "adblue", litres: null }]);
});

test("an empty note is stored as NONE, not as an empty string", async () => {
  const shift = await dayWith();

  await fill(shift, { note: "   " });

  expect((await fillsOn())[0]?.note).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// What is not a quantity
// ═══════════════════════════════════════════════════════════════════════════

test.each([
  ["zero",              0],
  ["a negative amount", -5],
  ["NaN",               Number.NaN],
  ["infinity",          Number.POSITIVE_INFINITY],
  ["more than two decimal places", 12.345],
  ["an impossible amount", 100_000],
])("%s is refused as a known quantity, and nothing is written", async (_why, litres) => {
  const shift = await dayWith();
  const before = storedFile().textSync();

  await expect(fill(shift, { litres })).rejects.toThrow("positive reading");

  expect(storedFile().textSync()).toBe(before);
  expect(await fillsOn()).toEqual([]);
});

test("an invalid time is refused, and so is an unknown type", async () => {
  const shift = await dayWith();
  const before = storedFile().textSync();

  await expect(fill(shift, { recordedAt: new Date("nonsense") })).rejects.toThrow("invalid time");
  // rules-ignore: none — the cast is the point: a type from outside TypeScript.
  await expect(fill(shift, { type: "petrol" as typeof FILL_TYPE.fuel })).rejects.toThrow("unknown type");

  expect(storedFile().textSync()).toBe(before);
});

test("an over-long note is refused rather than truncated", async () => {
  const shift = await dayWith();

  await expect(fill(shift, { note: "x".repeat(501) })).rejects.toThrow("over-long");

  expect(await fillsOn()).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Several fills, and both kinds
// ═══════════════════════════════════════════════════════════════════════════

test("several fuel fills all survive on one use, in the order they were recorded", async () => {
  const shift = await dayWith();

  await fill(shift, { litres: 300, recordedAt: at(9) });
  await fill(shift, { litres: null, recordedAt: at(12) });
  await fill(shift, { litres: 60.5, recordedAt: at(16) });

  expect((await fillsOn()).map(entry => entry.litres)).toEqual([300, null, 60.5]);
});

test("fuel and AdBlue live side by side on one use, each summarised on its own", async () => {
  const shift = await dayWith();

  await fill(shift, { type: FILL_TYPE.fuel, litres: 300 });
  await fill(shift, { type: FILL_TYPE.adblue, litres: 20 });
  await fill(shift, { type: FILL_TYPE.fuel, litres: 50 });

  const fills = await fillsOn();
  expect(summariseFills(fills, FILL_TYPE.fuel)).toEqual({ count: 2, knownLitres: 350, unknownCount: 0 });
  expect(summariseFills(fills, FILL_TYPE.adblue)).toEqual({ count: 1, knownLitres: 20, unknownCount: 0 });
});

// ═══════════════════════════════════════════════════════════════════════════
// What the summary is allowed to say
// ═══════════════════════════════════════════════════════════════════════════

test("a MIXED use reports the litres it knows and COUNTS the ones it does not", async () => {
  const shift = await dayWith();
  await fill(shift, { litres: 300 });
  await fill(shift, { litres: 50 });
  await fill(shift, { litres: null });

  const summary = summariseFills(await fillsOn(), FILL_TYPE.fuel);

  expect(summary).toEqual({ count: 3, knownLitres: 350, unknownCount: 1 });
  expect(fillSummaryText(summary)).toEqual({ amount: "350 L known", detail: "1 amount unknown" });
});

test("an ALL-UNKNOWN use never reports a quantity — not even zero", async () => {
  const shift = await dayWith();
  await fill(shift, { type: FILL_TYPE.adblue, litres: null });

  const summary = summariseFills(await fillsOn(), FILL_TYPE.adblue);

  expect(summary).toEqual({ count: 1, knownLitres: 0, unknownCount: 1 });
  expect(fillSummaryText(summary)).toEqual({ amount: "1 fill", detail: "Amount unknown" });
});

test("an ALL-KNOWN use reports the total and how many entries made it", async () => {
  const shift = await dayWith();
  await fill(shift, { litres: 0.1 });
  await fill(shift, { litres: 0.2 });

  const summary = summariseFills(await fillsOn(), FILL_TYPE.fuel);

  // Two decimal places in, two decimal places out — not 0.30000000000000004.
  expect(summary.knownLitres).toBe(0.3);
  expect(fillSummaryText(summary)).toEqual({ amount: "0.3 L", detail: "2 entries" });
});

test("a use with nothing recorded says nothing at all", () => {
  expect(fillSummaryText(summariseFills([], FILL_TYPE.fuel))).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// A fill belongs to the USE, not to the plate
// ═══════════════════════════════════════════════════════════════════════════

test("changing vehicle KEEPS the fills on the use that had them", async () => {
  const shift = await dayWith();
  await fill(shift, { litres: 300 });
  await fill(shift, { litres: null });

  await changeTo(shift, XY34, 11);

  const day = await readOpenShift();
  expect(day?.previousVehicles[0]?.fills.map(entry => entry.litres)).toEqual([300, null]);
  expect(day?.vehicle?.fills).toEqual([]);
});

test("a RETURNED-TO plate starts empty — an earlier use's fuel is never inherited", async () => {
  const shift = await dayWith();
  await fill(shift, { litres: 300 });
  await changeTo(shift, XY34, 11);
  await changeTo(shift, { ...AB12, startMileage: 100_500 }, 13);

  expect(await fillsOn()).toEqual([]);

  // And filling the new use does not touch the morning's record.
  await fill(shift, { litres: 60 });
  const day = await readOpenShift();
  expect(day?.vehicle?.fills.map(entry => entry.litres)).toEqual([60]);
  expect(day?.previousVehicles[0]?.fills.map(entry => entry.litres)).toEqual([300]);
});

test("ONE plate used three times keeps three separate fuel histories", async () => {
  const shift = await dayWith();
  await fill(shift, { litres: 300 });
  await changeTo(shift, XY34, 10);
  await fill(shift, { litres: null });
  await changeTo(shift, { ...AB12, startMileage: 100_400 }, 12);
  await fill(shift, { litres: 60 });

  const day = await readOpenShift();
  expect(day?.previousVehicles.map(use => [use.numberPlate, use.fills.map(entry => entry.litres)])).toEqual([
    ["AB12 CDE", [300]],
    ["XY34 ZZZ", [null]],
  ]);
  expect([day?.vehicle?.numberPlate, day?.vehicle?.fills.map(entry => entry.litres)]).toEqual(["AB12 CDE", [60]]);
});

test("a NEW fill may be recorded against a use that has ENDED, and lands only there", async () => {
  // D31: the driver who fuelled the last truck just before handing it back
  // records it against THAT use, from its own Edit.
  const shift = await dayWith();
  const endedAt = (await readOpenShift())?.vehicle?.startedAt ?? "";
  await changeTo(shift, XY34, 11);
  const before = await readOpenShift();

  await recordVehicleFill({
    shiftId: shift.id, vehicleStartedAt: endedAt, usageState: USAGE_STATE.ended, fillId: newLocalId(),
    type: FILL_TYPE.fuel, recordedAt: at(10, 45), litres: 300, note: "Before I handed it back",
  });

  const day = await readOpenShift();
  expect(day?.previousVehicles[0]?.fills).toMatchObject([{ litres: 300, note: "Before I handed it back" }]);
  // The vehicle in use gains nothing.
  expect(day?.vehicle?.fills).toEqual([]);
  // And the ended use is otherwise byte-for-byte what it was.
  const facts = (use?: { numberPlate: string; vehicleClass: string; startedAt: string; endedAt: string; startMileage: number; endMileage: number; checks: unknown[] }) =>
    use === undefined ? null : [use.numberPlate, use.vehicleClass, use.startedAt, use.endedAt, use.startMileage, use.endMileage, use.checks];
  expect(facts(day?.previousVehicles[0])).toEqual(facts(before?.previousVehicles[0]));
});

test("a retrospective fill is refused when the use does not exist — no fallback to the vehicle in use", async () => {
  const shift = await dayWith();
  await changeTo(shift, XY34, 11);
  const before = storedFile().textSync();

  const missing = await recordVehicleFill({
    shiftId: shift.id, vehicleStartedAt: "2026-09-19T04:00:00.000Z", usageState: USAGE_STATE.ended, fillId: newLocalId(),
    type: FILL_TYPE.fuel, recordedAt: at(12), litres: 100, note: "",
  });
  // A plate is not a use identity, and must not be read as one.
  const byPlate = await recordVehicleFill({
    shiftId: shift.id, vehicleStartedAt: "AB12 CDE", usageState: USAGE_STATE.ended, fillId: newLocalId(),
    type: FILL_TYPE.fuel, recordedAt: at(12), litres: 100, note: "",
  });

  expect([missing, byPlate]).toEqual([null, null]);
  expect(storedFile().textSync()).toBe(before);
});

test("the OLDEST use of a repeated plate can be targeted — the newest one is not assumed", async () => {
  const { shift, first, second } = await dayOfThreeUses();

  await recordVehicleFill({
    shiftId: shift.id, vehicleStartedAt: first, usageState: USAGE_STATE.ended, fillId: newLocalId(),
    type: FILL_TYPE.adblue, recordedAt: at(8, 30), litres: null, note: "",
  });

  expect((await usageFills(first)).map(entry => [entry.type, entry.litres])).toEqual([["fuel", 300], ["adblue", null]]);
  // The later use of the SAME registration is untouched.
  expect((await usageFills(second)).map(entry => [entry.type, entry.litres])).toEqual([["fuel", 60]]);
});

test("a day with NO vehicle cannot hold a fill", async () => {
  const shift = await startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle: null });
  const before = storedFile().textSync();

  const result = await recordVehicleFill({
    shiftId: shift.id, vehicleStartedAt: "", usageState: USAGE_STATE.inUse, fillId: newLocalId(),
    type: FILL_TYPE.fuel, recordedAt: at(9), litres: 100, note: "",
  });

  expect(result).toBeNull();
  expect(storedFile().textSync()).toBe(before);
});

test("a fill for a DIFFERENT day is refused", async () => {
  const shift = await dayWith();

  const result = await fill(shift, { shiftId: "someone-elses-day" });

  expect(result).toBeNull();
  expect(await fillsOn()).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// A fill begun under the vehicle in use FAILS CLOSED once that use has ended
// ═══════════════════════════════════════════════════════════════════════════

test("the vehicle in use CHANGED before the save: nothing is written — not to it, not to its replacement", async () => {
  const shift = await dayWith();
  const opened = (await readOpenShift())?.vehicle?.startedAt ?? "";
  // The fill screen was opened for AB12 CDE … and the driver changed vehicle.
  await changeTo(shift, XY34, 11);
  const before = storedFile().textSync();

  const result = await recordVehicleFill({
    shiftId: shift.id, vehicleStartedAt: opened, usageState: USAGE_STATE.inUse, fillId: newLocalId(),
    type: FILL_TYPE.fuel, recordedAt: at(10, 50), litres: 300, note: "",
  });

  expect(result).toBeNull();
  expect(storedFile().textSync()).toBe(before);
  const day = await readOpenShift();
  expect(day?.previousVehicles[0]?.fills).toEqual([]);
  expect(day?.vehicle?.fills).toEqual([]);
});

test("the vehicle in use was handed back with NO vehicle to follow: the save is refused", async () => {
  const shift = await dayWith();
  const opened = (await readOpenShift())?.vehicle?.startedAt ?? "";
  await endVehicleUse({ shiftId: shift.id, endingStartedAt: opened, endMileage: 100_050, endedAt: at(13) });
  const before = storedFile().textSync();

  const result = await recordVehicleFill({
    shiftId: shift.id, vehicleStartedAt: opened, usageState: USAGE_STATE.inUse, fillId: newLocalId(),
    type: FILL_TYPE.adblue, recordedAt: at(12), litres: null, note: "",
  });
  const removed = await removeVehicleFill({ shiftId: shift.id, vehicleStartedAt: opened, usageState: USAGE_STATE.inUse, fillId: "any" });

  expect([result, removed]).toEqual([null, null]);
  expect(storedFile().textSync()).toBe(before);
});

test("a correction begun under the vehicle in use cannot rewrite its entry once the use has ended", async () => {
  const shift = await dayWith();
  const opened = (await readOpenShift())?.vehicle?.startedAt ?? "";
  const id = newLocalId();
  await fill(shift, { fillId: id, litres: 300 });
  await changeTo(shift, XY34, 11);
  const before = storedFile().textSync();

  const edited = await fill(shift, { vehicleStartedAt: opened, fillId: id, litres: 30 });
  const removed = await removeVehicleFill({ shiftId: shift.id, vehicleStartedAt: opened, usageState: USAGE_STATE.inUse, fillId: id });

  expect([edited, removed]).toEqual([null, null]);
  expect(storedFile().textSync()).toBe(before);
});

test("the vehicle in use is not history: an ENDED-use write naming it is refused", async () => {
  const shift = await dayWith();
  const current = (await readOpenShift())?.vehicle?.startedAt ?? "";
  const before = storedFile().textSync();

  const result = await recordVehicleFill({
    shiftId: shift.id, vehicleStartedAt: current, usageState: USAGE_STATE.ended, fillId: newLocalId(),
    type: FILL_TYPE.fuel, recordedAt: at(9), litres: 100, note: "",
  });

  expect(result).toBeNull();
  expect(storedFile().textSync()).toBe(before);
});

test("CONTROL: the same use, while still in use, takes the fill", async () => {
  const shift = await dayWith();
  const opened = (await readOpenShift())?.vehicle?.startedAt ?? "";

  const result = await recordVehicleFill({
    shiftId: shift.id, vehicleStartedAt: opened, usageState: USAGE_STATE.inUse, fillId: newLocalId(),
    type: FILL_TYPE.fuel, recordedAt: at(10, 50), litres: 300, note: "",
  });

  expect(result?.vehicle?.fills).toMatchObject([{ litres: 300 }]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Correcting and removing
// ═══════════════════════════════════════════════════════════════════════════

test("re-recording the SAME id corrects that entry and leaves the others alone", async () => {
  const shift = await dayWith();
  const keep = newLocalId();
  const wrong = newLocalId();
  await fill(shift, { fillId: keep, litres: 300, recordedAt: at(9) });
  await fill(shift, { fillId: wrong, litres: 30, recordedAt: at(12), note: "typo" });

  await fill(shift, { fillId: wrong, litres: 300, recordedAt: at(12, 30), note: "" });

  expect(await fillsOn()).toEqual([
    { id: keep, type: "fuel", recordedAt: at(9).toISOString(), litres: 300, note: null },
    { id: wrong, type: "fuel", recordedAt: at(12, 30).toISOString(), litres: 300, note: null },
  ]);
});

test("a correction can turn a known amount into an UNKNOWN one, and back", async () => {
  const shift = await dayWith();
  const id = newLocalId();
  await fill(shift, { fillId: id, litres: 300 });

  await fill(shift, { fillId: id, litres: null });
  expect((await fillsOn())[0]?.litres).toBeNull();

  await fill(shift, { fillId: id, litres: 275.25 });
  expect((await fillsOn())[0]?.litres).toBe(275.25);
});

test("removing an entry takes ONLY that one", async () => {
  const shift = await dayWith();
  const first = newLocalId();
  const second = newLocalId();
  const third = newLocalId();
  await fill(shift, { fillId: first, litres: 300 });
  await fill(shift, { fillId: second, litres: null });
  await fill(shift, { fillId: third, litres: 60 });
  const open = await readOpenShift();

  await removeVehicleFill({ shiftId: shift.id, vehicleStartedAt: open?.vehicle?.startedAt ?? "", usageState: USAGE_STATE.inUse, fillId: second });

  expect((await fillsOn()).map(entry => entry.id)).toEqual([first, third]);
});

test("removing one that is not there changes nothing — a second press cannot take another", async () => {
  const shift = await dayWith();
  await fill(shift, { litres: 300 });
  const open = await readOpenShift();
  const before = storedFile().textSync();

  const day = await removeVehicleFill({ shiftId: shift.id, vehicleStartedAt: open?.vehicle?.startedAt ?? "", usageState: USAGE_STATE.inUse, fillId: "never-existed" });

  expect(day?.vehicle?.fills).toHaveLength(1);
  expect(storedFile().textSync()).toBe(before);
});

test("rapid repeated recording of ONE entry leaves one entry", async () => {
  const shift = await dayWith();
  const open = await readOpenShift();
  const once = {
    shiftId: shift.id, vehicleStartedAt: open?.vehicle?.startedAt ?? "", usageState: USAGE_STATE.inUse, fillId: newLocalId(),
    type: FILL_TYPE.fuel, recordedAt: at(9), litres: 300, note: "",
  };

  await Promise.all([recordVehicleFill(once), recordVehicleFill(once), recordVehicleFill(once)]);

  expect(await fillsOn()).toHaveLength(1);
});

test("recording a fill leaves the checks, the mileages and the day's history untouched", async () => {
  const shift = await dayWith();
  await completeVehicleCheck({
    shiftId: shift.id, vehicleStartedAt: shift.vehicle?.startedAt ?? "", checkId: "morning", startedAt: at(5, 40),
    answers: checklistItems(checklistFor("class1")).map(entry => ({ key: entry.key, result: entry.defaultResult, note: "" })),
    completedAt: at(5, 50), completedBy: "user_1",
  });
  await changeTo(shift, XY34, 10);
  const before = await readOpenShift();

  await fill(shift, { litres: 300 });
  const after = await readOpenShift();

  expect(after?.previousVehicles).toEqual(before?.previousVehicles);
  expect(after?.vehicle?.checks).toEqual(before?.vehicle?.checks);
  expect(after?.startedAt).toBe(before?.startedAt);
  expect(after?.vehicle).toMatchObject({
    numberPlate: before?.vehicle?.numberPlate, startMileage: before?.vehicle?.startMileage,
    startedAt: before?.vehicle?.startedAt,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Across a restart, and across builds
// ═══════════════════════════════════════════════════════════════════════════

test("fills survive a COLD START — they are in the file, not in memory", async () => {
  const shift = await dayWith();
  await fill(shift, { litres: 300, recordedAt: at(9) });
  await fill(shift, { litres: null, recordedAt: at(14), note: "No meter" });

  // Nothing in memory: the next read is the file's own answer.
  const recovered = await readOpenShift();

  expect(recovered?.vehicle?.fills).toMatchObject([
    { type: "fuel", recordedAt: at(9).toISOString(), litres: 300, note: null },
    { type: "fuel", recordedAt: at(14).toISOString(), litres: null, note: "No meter" },
  ]);
  expect(recovered?.vehicle?.fills.map(entry => Object.keys(entry).sort())).toEqual([FILL_FIELDS, FILL_FIELDS]);
});

test("a day saved BEFORE fills existed still loads, with none — and is not rewritten", async () => {
  const legacy = {
    id: "shift_legacy",
    workingFor: { kind: "personal" },
    startedAt: STARTED_AT.toISOString(),
    vehicle: { ...AB12, startedAt: STARTED_AT.toISOString(), checks: [] },
    status: "open",
    createdAt: STARTED_AT.toISOString(),
  };
  const bytes = JSON.stringify(legacy);
  storedFile().write(bytes);

  const day = await readOpenShift();

  expect(day?.vehicle?.fills).toEqual([]);
  // Reading is not writing: the old file is left exactly as it was.
  expect(storedFile().textSync()).toBe(bytes);
});

test("an old day can be filled, and only then gains the field", async () => {
  const legacy = {
    id: "shift_legacy",
    workingFor: { kind: "personal" },
    startedAt: STARTED_AT.toISOString(),
    vehicle: { ...AB12, startedAt: STARTED_AT.toISOString(), checks: [] },
    status: "open",
    createdAt: STARTED_AT.toISOString(),
  };
  storedFile().write(JSON.stringify(legacy));

  await recordVehicleFill({
    shiftId: "shift_legacy", vehicleStartedAt: STARTED_AT.toISOString(), usageState: USAGE_STATE.inUse, fillId: newLocalId(),
    type: FILL_TYPE.adblue, recordedAt: at(9), litres: null, note: "",
  });

  expect((await readOpenShift())?.vehicle?.fills).toMatchObject([{ type: "adblue", litres: null }]);
});

// ═══════════════════════════════════════════════════════════════════════════
// A broken record is never quietly dropped
// ═══════════════════════════════════════════════════════════════════════════

const dayWithFills = (fills: unknown): string => JSON.stringify({
  id: "shift_1",
  workingFor: { kind: "personal" },
  startedAt: STARTED_AT.toISOString(),
  vehicle: { ...AB12, startedAt: STARTED_AT.toISOString(), checks: [], fills },
  previousVehicles: [],
  status: "open",
  createdAt: STARTED_AT.toISOString(),
});

const WELL_FORMED = [{ id: "f1", type: "fuel", recordedAt: at(9).toISOString(), litres: 300, note: null }];

test("CONTROL: the same document, well formed, loads", async () => {
  storedFile().write(dayWithFills(WELL_FORMED));

  expect((await readOpenShift())?.vehicle?.fills).toEqual(WELL_FORMED);
});

test.each([
  ["fills that are not a list",   "300 litres"],
  ["a fill that is not an object", [42]],
  ["a fill with no id",           [{ ...WELL_FORMED[0], id: undefined }]],
  ["a fill of an unknown type",   [{ ...WELL_FORMED[0], type: "petrol" }]],
  ["a fill with no time",         [{ ...WELL_FORMED[0], recordedAt: undefined }]],
  ["a fill with a broken time",   [{ ...WELL_FORMED[0], recordedAt: "yesterday" }]],
  ["a fill with no litres field", [{ ...WELL_FORMED[0], litres: undefined }]],
  ["a fill measured in words",    [{ ...WELL_FORMED[0], litres: "lots" }]],
  ["a fill of zero litres",       [{ ...WELL_FORMED[0], litres: 0 }]],
  ["a fill of minus litres",      [{ ...WELL_FORMED[0], litres: -20 }]],
  ["two fills with one id",       [WELL_FORMED[0], WELL_FORMED[0]]],
])("%s makes the day unreadable rather than vanishing quietly", async (_why, fills) => {
  storedFile().write(dayWithFills(fills));

  // Fail closed, as a malformed mileage does: a day that quietly lost a
  // quantity would read as complete when it is not.
  expect(await readOpenShift()).toBeNull();
});

test("a fill records nothing about price, station or payment", async () => {
  const shift = await dayWith();
  await fill(shift, { litres: 300 });

  const stored = JSON.stringify((await fillsOn())[0]).toLowerCase();

  for (const absent of ["price", "cost", "vat", "supplier", "station", "card", "receipt", "gps", "tank"]) {
    expect(stored).not.toContain(absent);
  }
});

test("recording a fill never reaches the network", async () => {
  const shift = await dayWith();
  const fetched = jest.spyOn(globalThis, "fetch");

  await fill(shift, { litres: 300 });
  await fill(shift, { litres: null });

  expect(fetched).not.toHaveBeenCalled();
});

// ═══════════════════════════════════════════════════════════════════════════
// Correcting a use that has ENDED (owner decision, 2026-09-20)
// ═══════════════════════════════════════════════════════════════════════════

/** A day with two ended uses of AB12 CDE around one XY34 use, each fuelled. */
async function dayOfThreeUses(): Promise<{ shift: LocalShift; first: string; middle: string; second: string; fills: Record<string, string> }> {
  const shift = await dayWith();
  const first = (await readOpenShift())?.vehicle?.startedAt ?? "";
  const firstFill = newLocalId();
  await fill(shift, { fillId: firstFill, litres: 300, recordedAt: at(8) });

  await changeTo(shift, XY34, 10);
  const middle = (await readOpenShift())?.vehicle?.startedAt ?? "";
  const middleFill = newLocalId();
  await fill(shift, { fillId: middleFill, litres: null, recordedAt: at(11) });

  await changeTo(shift, { ...AB12, startMileage: 100_500 }, 12);
  const second = (await readOpenShift())?.vehicle?.startedAt ?? "";
  const secondFill = newLocalId();
  await fill(shift, { fillId: secondFill, litres: 60, recordedAt: at(13) });

  await changeTo(shift, { ...XY34, startMileage: 220_400 }, 14);
  return { shift, first, middle, second, fills: { first: firstFill, middle: middleFill, second: secondFill } };
}

const usageFills = async (startedAt: string): Promise<VehicleFill[]> => {
  const day = await readOpenShift();
  return day?.previousVehicles.find(use => use.startedAt === startedAt)?.fills ?? [];
};

test("an ENDED use's fill can be corrected, and only that use changes", async () => {
  const { shift, first, middle, second, fills } = await dayOfThreeUses();
  const before = await readOpenShift();

  await recordVehicleFill({
    shiftId: shift.id, vehicleStartedAt: first, usageState: USAGE_STATE.ended, fillId: fills.first ?? "",
    type: FILL_TYPE.fuel, recordedAt: at(8), litres: 30, note: "Was 300, actually 30",
  });

  expect(await usageFills(first)).toMatchObject([{ litres: 30, note: "Was 300, actually 30" }]);
  // The OTHER use of the same registration is untouched, and so is the third.
  expect(await usageFills(second)).toMatchObject([{ litres: 60 }]);
  expect(await usageFills(middle)).toMatchObject([{ litres: null }]);
  // And nothing but the fills moved.
  const after = await readOpenShift();
  expect(after?.previousVehicles.map(use => [use.numberPlate, use.startedAt, use.endedAt, use.startMileage, use.endMileage, use.vehicleClass]))
    .toEqual(before?.previousVehicles.map(use => [use.numberPlate, use.startedAt, use.endedAt, use.startMileage, use.endMileage, use.vehicleClass]));
});

test("correcting the FIRST use of a plate never touches the second — targeting is by use, not plate", async () => {
  const { shift, first, second, fills } = await dayOfThreeUses();

  await recordVehicleFill({
    shiftId: shift.id, vehicleStartedAt: second, usageState: USAGE_STATE.ended, fillId: fills.second ?? "",
    type: FILL_TYPE.adblue, recordedAt: at(13), litres: 20, note: "",
  });

  // The second use's entry became AdBlue; the first use's fuel is as it was.
  expect(await usageFills(second)).toMatchObject([{ type: "adblue", litres: 20 }]);
  expect(await usageFills(first)).toMatchObject([{ type: "fuel", litres: 300 }]);
});

test("an ENDED use's fill can be removed, and only that one goes", async () => {
  const { shift, first, second, fills } = await dayOfThreeUses();

  await removeVehicleFill({ shiftId: shift.id, vehicleStartedAt: first, usageState: USAGE_STATE.ended, fillId: fills.first ?? "" });

  expect(await usageFills(first)).toEqual([]);
  expect(await usageFills(second)).toHaveLength(1);
});

test("a completed CHECK on an ended use survives a fill correction", async () => {
  const shift = await dayWith();
  const first = shift.vehicle?.startedAt ?? "";
  await completeVehicleCheck({
    shiftId: shift.id, vehicleStartedAt: first, checkId: "morning", startedAt: at(5, 40),
    answers: checklistItems(checklistFor("class1")).map(entry => ({ key: entry.key, result: entry.defaultResult, note: "" })),
    completedAt: at(5, 50), completedBy: "user_1",
  });
  const fillId = newLocalId();
  await fill(shift, { fillId, litres: 300 });
  await changeTo(shift, XY34, 10);
  const certificate = (await readOpenShift())?.previousVehicles[0]?.checks;

  await recordVehicleFill({
    shiftId: shift.id, vehicleStartedAt: first, usageState: USAGE_STATE.ended, fillId, type: FILL_TYPE.fuel, recordedAt: at(8), litres: 310, note: "",
  });

  const after = (await readOpenShift())?.previousVehicles[0];
  expect(after?.checks).toEqual(certificate);
  expect(after?.fills).toMatchObject([{ litres: 310 }]);
});

test("a use that answers to no name is not corrected — nothing anywhere changes", async () => {
  const { shift, fills } = await dayOfThreeUses();
  const before = storedFile().textSync();

  const missing = await recordVehicleFill({
    shiftId: shift.id, vehicleStartedAt: "2026-09-19T23:59:00.000Z", usageState: USAGE_STATE.ended, fillId: fills.first ?? "",
    type: FILL_TYPE.fuel, recordedAt: at(8), litres: 1, note: "",
  });
  const empty = await recordVehicleFill({
    shiftId: shift.id, vehicleStartedAt: "", usageState: USAGE_STATE.inUse, fillId: fills.first ?? "",
    type: FILL_TYPE.fuel, recordedAt: at(8), litres: 1, note: "",
  });
  const removed = await removeVehicleFill({ shiftId: shift.id, vehicleStartedAt: "AB12 CDE", usageState: USAGE_STATE.ended, fillId: fills.first ?? "" });

  expect([missing, empty, removed]).toEqual([null, null, null]);
  expect(storedFile().textSync()).toBe(before);
});

test("a corrected historical fill survives a COLD START", async () => {
  const { shift, first, fills } = await dayOfThreeUses();
  await recordVehicleFill({
    shiftId: shift.id, vehicleStartedAt: first, usageState: USAGE_STATE.ended, fillId: fills.first ?? "",
    type: FILL_TYPE.fuel, recordedAt: at(8), litres: 275.5, note: "Corrected",
  });

  // Read again from the file alone.
  expect(await usageFills(first)).toMatchObject([{ litres: 275.5, note: "Corrected" }]);
});

test("each use keeps its OWN mileage, distance and fills — nothing is summed across uses", async () => {
  const { first, middle, second } = await dayOfThreeUses();
  const day = await readOpenShift();
  const use = (startedAt: string) => day?.previousVehicles.find(entry => entry.startedAt === startedAt);

  expect([use(first)?.startMileage, use(first)?.endMileage]).toEqual([100_000, 100_120]);
  expect([use(second)?.startMileage, use(second)?.endMileage]).toEqual([100_500, 100_620]);
  expect(usageDistance(use(first)!)).toBe(120);
  expect(usageDistance(use(second)!)).toBe(120);
  expect(summariseFills(use(first)?.fills ?? [], FILL_TYPE.fuel)).toEqual({ count: 1, knownLitres: 300, unknownCount: 0 });
  expect(summariseFills(use(second)?.fills ?? [], FILL_TYPE.fuel)).toEqual({ count: 1, knownLitres: 60, unknownCount: 0 });
  expect(summariseFills(use(middle)?.fills ?? [], FILL_TYPE.fuel)).toEqual({ count: 1, knownLitres: 0, unknownCount: 1 });
});

test("an equal start and end is a real use — it travelled 0 mi", async () => {
  const shift = await dayWith();
  const open = await readOpenShift();
  await changeVehicle({
    shiftId: shift.id, endingStartedAt: open?.vehicle?.startedAt ?? "",
    endMileage: 100_000, changedAt: at(9), next: XY34,
  });

  const stood = (await readOpenShift())?.previousVehicles[0];
  expect(usageDistance(stood!)).toBe(0);
});

test("the history is newest ENDED first, and reading it does not reorder the day", async () => {
  const { first, middle, second } = await dayOfThreeUses();
  const day = await readOpenShift();
  const before = storedFile().textSync();

  expect(usageHistory(day!).map(use => use.startedAt)).toEqual([second, middle, first].reverse().reverse());
  // Stored oldest-ended first, and still is: the order was copied, not moved.
  expect(day?.previousVehicles.map(use => use.startedAt)).toEqual([first, middle, second]);
  expect(storedFile().textSync()).toBe(before);
});
