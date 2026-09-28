/**
 * Trailers — what reaches the phone (D34).
 *
 * A trailer is its own asset with its own uses, beside the vehicle's and never
 * inside them. These prove the lifecycle — add, change, none, take again —
 * that each touches the trailer alone, that a van is never taken while a
 * trailer is in use, that fridge diesel lands on the exact refrigerated
 * trailer use it was begun for or nowhere, and that all of it survives a
 * restart and loads alongside days saved before trailers existed.
 */
import { File, Paths } from "expo-file-system";
import {
  OPEN_SHIFT_FILE,
  TrailerStillInUseError,
  addTrailerToOpenShift,
  changeTrailer,
  changeVehicle,
  clearOpenShift,
  endVehicleUse,
  newLocalId,
  readOpenShift,
  recordReeferDiesel,
  recordVehicleFill,
  removeReeferDiesel,
  startLocalShift,
  USAGE_STATE,
  type LocalShift,
  type VehicleDetails,
} from "../shift/localShift";
import { TRAILER_TYPE, type TrailerDetails } from "../shift/trailer";
import { FILL_TYPE } from "../shift/vehicleFill";

const STARTED_AT = new Date(2026, 8, 19, 5, 0);
const at = (hours: number, minutes = 0) => new Date(2026, 8, 19, hours, minutes);
const UNIT: VehicleDetails = { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 };
const RIGID: VehicleDetails = { vehicleClass: "class2", numberPlate: "RG12 IDD", startMileage: 50_000 };
const VAN: VehicleDetails = { vehicleClass: "van", numberPlate: "VN12 ABC", startMileage: 9_000 };
const FRIDGE: TrailerDetails = { trailerNumber: "TR1234", trailerType: TRAILER_TYPE.refrigerated };
const BOX: TrailerDetails = { trailerNumber: "TR5678", trailerType: TRAILER_TYPE.standard };

const storedFile = () => new File(Paths.document, OPEN_SHIFT_FILE);
const bytes = () => storedFile().textSync();

async function dayWith(vehicle: VehicleDetails | null = UNIT): Promise<LocalShift> {
  return startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle });
}

async function addTrailer(shift: LocalShift, trailer: TrailerDetails = FRIDGE, hour = 5, minutes = 35): Promise<LocalShift | null> {
  return addTrailerToOpenShift({ shiftId: shift.id, trailer, startedAt: at(hour, minutes) });
}

async function trailerTo(shift: LocalShift, next: TrailerDetails | null, hour: number): Promise<string> {
  const open = await readOpenShift();
  const ending = open?.trailer?.startedAt ?? "";
  await changeTrailer({ shiftId: shift.id, endingStartedAt: ending, next, changedAt: at(hour) });
  return ending;
}

async function diesel(shift: LocalShift, trailerStartedAt: string, over: { litres?: number | null; note?: string; fillId?: string; recordedAt?: Date } = {}) {
  return recordReeferDiesel({
    shiftId: shift.id, trailerStartedAt, usageState: USAGE_STATE.inUse, fillId: over.fillId ?? newLocalId(),
    recordedAt: over.recordedAt ?? at(8), litres: over.litres === undefined ? 120 : over.litres, note: over.note ?? "",
  });
}

const current = async () => (await readOpenShift())?.trailer ?? null;

beforeEach(async () => { await clearOpenShift(); });
afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// Persistence: old days, malformed days, restart
// ═══════════════════════════════════════════════════════════════════════════

const LEGACY = {
  id: "shift_legacy",
  workingFor: { kind: "personal" },
  startedAt: STARTED_AT.toISOString(),
  vehicle: { ...UNIT, startedAt: STARTED_AT.toISOString(), checks: [], fills: [] },
  previousVehicles: [],
  status: "open",
  createdAt: STARTED_AT.toISOString(),
};

test("a day saved BEFORE trailers existed loads, with no trailer and no trailer history", async () => {
  storedFile().write(JSON.stringify(LEGACY));

  const day = await readOpenShift();

  expect(day?.id).toBe("shift_legacy");
  expect(day?.trailer).toBeNull();
  expect(day?.previousTrailers).toEqual([]);
});

test("reading an old day does not rewrite it to add empty trailer fields", async () => {
  storedFile().write(JSON.stringify(LEGACY));
  const before = bytes();

  await readOpenShift();
  await readOpenShift();

  expect(bytes()).toBe(before);
  expect(before).not.toContain("trailer");
});

test.each([
  ["a trailer of an unknown type", { trailer: { ...FRIDGE, trailerType: "curtainsider", startedAt: at(6).toISOString(), reeferDiesel: [], checks: [] } }],
  ["a trailer with no number", { trailer: { ...FRIDGE, trailerNumber: "", startedAt: at(6).toISOString(), reeferDiesel: [], checks: [] } }],
  ["a trailer with no start", { trailer: { ...FRIDGE, reeferDiesel: [], checks: [] } }],
  ["a trailer with no diesel list", { trailer: { ...FRIDGE, startedAt: at(6).toISOString() } }],
  ["a trailer in use that claims an end", { trailer: { ...FRIDGE, startedAt: at(6).toISOString(), reeferDiesel: [], endedAt: at(7).toISOString() } }],
  ["fridge diesel on a STANDARD trailer", { trailer: { ...BOX, startedAt: at(6).toISOString(), reeferDiesel: [{ id: "f1", recordedAt: at(7).toISOString(), litres: 10, note: null }] } }],
  ["a diesel entry recorded as ZERO", { trailer: { ...FRIDGE, startedAt: at(6).toISOString(), reeferDiesel: [{ id: "f1", recordedAt: at(7).toISOString(), litres: 0, note: null }] } }],
  ["two diesel entries with one id", { trailer: { ...FRIDGE, startedAt: at(6).toISOString(), reeferDiesel: [
    { id: "f1", recordedAt: at(7).toISOString(), litres: 10, note: null }, { id: "f1", recordedAt: at(8).toISOString(), litres: 20, note: null },
  ] } }],
  ["a trailer history that is not a list", { previousTrailers: "TR1234" }],
  ["an ended trailer with no end", { previousTrailers: [{ ...FRIDGE, startedAt: at(6).toISOString(), reeferDiesel: [], checks: [] }] }],
  ["two trailer uses with one start", {
    trailer: { ...BOX, startedAt: at(6).toISOString(), reeferDiesel: [], checks: [] },
    previousTrailers: [{ ...FRIDGE, startedAt: at(6).toISOString(), reeferDiesel: [], endedAt: at(6).toISOString() }],
  }],
])("PRESENT but malformed trailer data fails the day closed: %s", async (_why, over) => {
  storedFile().write(JSON.stringify({ ...LEGACY, ...over }));

  expect(await readOpenShift()).toBeNull();
});

test("CONTROL: the same trailer data, well formed, loads", async () => {
  storedFile().write(JSON.stringify({
    ...LEGACY,
    trailer: { ...FRIDGE, startedAt: at(6).toISOString(), reeferDiesel: [{ id: "f1", recordedAt: at(7).toISOString(), litres: null, note: null }] },
    previousTrailers: [{ ...BOX, startedAt: at(5).toISOString(), reeferDiesel: [], endedAt: at(6).toISOString() }],
  }));

  const day = await readOpenShift();

  expect(day?.trailer).toMatchObject({ trailerNumber: "TR1234", reeferDiesel: [{ litres: null }] });
  expect(day?.previousTrailers).toHaveLength(1);
});

test("a day with a trailer, its diesel and its history survives a COLD START from the file alone", async () => {
  const shift = await dayWith();
  await addTrailer(shift, BOX, 5, 35);
  await trailerTo(shift, FRIDGE, 9);
  await diesel(shift, (await current())?.startedAt ?? "", { litres: null, note: "Yard tank" });
  const onDisk = JSON.parse(bytes()) as unknown;

  const day = await readOpenShift();

  expect(day).toEqual(onDisk);
  expect(day?.trailer).toMatchObject({ trailerNumber: "TR1234", trailerType: "refrigerated", reeferDiesel: [{ litres: null, note: "Yard tank" }] });
  expect(day?.previousTrailers).toMatchObject([{ trailerNumber: "TR5678", trailerType: "standard", endedAt: at(9).toISOString() }]);
});

test("the no-trailer state survives a restart: trailer null, history kept, shift open", async () => {
  const shift = await dayWith();
  await addTrailer(shift);
  await trailerTo(shift, null, 11);

  const day = await readOpenShift();

  expect(day?.status).toBe("open");
  expect(day?.trailer).toBeNull();
  expect(day?.previousTrailers).toHaveLength(1);
});

test("nothing about trailers reaches the network", async () => {
  const fetched = jest.spyOn(globalThis, "fetch");
  const shift = await dayWith();

  await addTrailer(shift);
  await diesel(shift, (await current())?.startedAt ?? "");
  await trailerTo(shift, BOX, 9);
  await trailerTo(shift, null, 10);

  expect(fetched).not.toHaveBeenCalled();
});

// ═══════════════════════════════════════════════════════════════════════════
// Adding a trailer
// ═══════════════════════════════════════════════════════════════════════════

test.each([["a Class 1", UNIT], ["a Class 2", RIGID]] as const)("%s may take a trailer", async (_what, vehicle) => {
  const shift = await dayWith(vehicle);

  const day = await addTrailer(shift, BOX);

  expect(day?.trailer).toMatchObject({ trailerNumber: "TR5678", trailerType: "standard" });
});

test("a VAN cannot take a trailer — refused, writing nothing", async () => {
  const shift = await dayWith(VAN);
  const before = bytes();

  await expect(addTrailer(shift)).rejects.toThrow(Error);

  expect(bytes()).toBe(before);
  expect(await current()).toBeNull();
});

test("with NO vehicle in use there is nothing to tow — Add Trailer is refused", async () => {
  const shift = await dayWith(null);
  const before = bytes();

  await expect(addTrailer(shift)).rejects.toThrow(Error);

  expect(bytes()).toBe(before);
});

test("the trailer number is trimmed and upper-cased, and never format-checked", async () => {
  const shift = await dayWith();

  await addTrailer(shift, { trailerNumber: "  fleet-07/b ", trailerType: TRAILER_TYPE.standard });

  expect((await current())?.trailerNumber).toBe("FLEET-07/B");
});

test.each([["an empty number", { ...BOX, trailerNumber: "   " }], ["an unknown type", { ...BOX, trailerType: "tanker" as typeof TRAILER_TYPE.standard }]])(
  "%s is refused, writing nothing",
  async (_why, trailer) => {
    const shift = await dayWith();
    const before = bytes();

    await expect(addTrailer(shift, trailer)).rejects.toThrow(Error);

    expect(bytes()).toBe(before);
  },
);

test.each([["Standard", BOX], ["Refrigerated", FRIDGE]] as const)("a %s trailer is stored as that, with no diesel yet", async (_what, trailer) => {
  const shift = await dayWith();

  await addTrailer(shift, trailer);

  expect(await current()).toEqual({ ...trailer, startedAt: at(5, 35).toISOString(), reeferDiesel: [], checks: [] });
});

test("a trailer's use begins when IT was taken — the vehicle's start is not borrowed or rewritten", async () => {
  const shift = await dayWith();
  const vehicleBefore = JSON.stringify(shift.vehicle);

  await addTrailer(shift, FRIDGE, 5, 35);

  const day = await readOpenShift();
  expect(day?.trailer?.startedAt).toBe(at(5, 35).toISOString());
  expect(day?.vehicle?.startedAt).toBe(STARTED_AT.toISOString());
  expect(JSON.stringify(day?.vehicle)).toBe(vehicleBefore);
});

test("ADD IS NOT CHANGE: a second Add — or a rapid double tap — never replaces the trailer in use", async () => {
  const shift = await dayWith();

  await Promise.all([addTrailer(shift, FRIDGE, 5, 35), addTrailer(shift, BOX, 5, 36), addTrailer(shift, FRIDGE, 5, 37)]);

  const day = await readOpenShift();
  expect(day?.trailer).toMatchObject({ trailerNumber: "TR1234", startedAt: at(5, 35).toISOString() });
  expect(day?.previousTrailers).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Changing the trailer, and No trailer
// ═══════════════════════════════════════════════════════════════════════════

test("Change Trailer ends EXACTLY the trailer in use, and the next begins at the same instant", async () => {
  const shift = await dayWith();
  await addTrailer(shift, FRIDGE, 5, 30);

  const ended = await trailerTo(shift, BOX, 9);

  const day = await readOpenShift();
  expect(day?.previousTrailers).toEqual([{ ...FRIDGE, startedAt: ended, reeferDiesel: [], checks: [], endedAt: at(9).toISOString() }]);
  expect(day?.trailer).toEqual({ ...BOX, startedAt: at(9).toISOString(), reeferDiesel: [], checks: [] });
});

test("the SAME trailer taken again is a NEW use, and inherits none of the earlier use's diesel", async () => {
  const shift = await dayWith();
  await addTrailer(shift, FRIDGE, 5, 30);
  await diesel(shift, (await current())?.startedAt ?? "", { litres: 80 });
  await trailerTo(shift, BOX, 9);
  await trailerTo(shift, FRIDGE, 13);

  const day = await readOpenShift();
  expect(day?.trailer).toEqual({ ...FRIDGE, startedAt: at(13).toISOString(), reeferDiesel: [], checks: [] });
  // The morning's use keeps its own 80 L.
  expect(day?.previousTrailers.map(use => [use.trailerNumber, use.reeferDiesel.map(fill => fill.litres)]))
    .toEqual([["TR1234", [80]], ["TR5678", []]]);
});

test("earlier trailer uses are never rewritten by a later change", async () => {
  const shift = await dayWith();
  await addTrailer(shift, FRIDGE, 5, 30);
  await trailerTo(shift, BOX, 9);
  const first = JSON.stringify((await readOpenShift())?.previousTrailers[0]);

  await trailerTo(shift, FRIDGE, 13);
  await trailerTo(shift, null, 15);

  expect(JSON.stringify((await readOpenShift())?.previousTrailers[0])).toBe(first);
});

test("the change applies ONCE: a stale or repeated press for a trailer no longer in use writes nothing", async () => {
  const shift = await dayWith();
  await addTrailer(shift, FRIDGE, 5, 30);
  const stale = (await current())?.startedAt ?? "";
  await trailerTo(shift, BOX, 9);
  const before = bytes();

  await changeTrailer({ shiftId: shift.id, endingStartedAt: stale, next: null, changedAt: at(10) });

  expect(bytes()).toBe(before);
});

test("NO TRAILER ends the trailer in use, and leaves the shift open and the vehicle untouched", async () => {
  const shift = await dayWith();
  await addTrailer(shift);
  const vehicle = JSON.stringify((await readOpenShift())?.vehicle);

  await trailerTo(shift, null, 11);

  const day = await readOpenShift();
  expect(day?.trailer).toBeNull();
  expect(day?.status).toBe("open");
  expect(day?.previousTrailers).toMatchObject([{ trailerNumber: "TR1234", endedAt: at(11).toISOString() }]);
  expect(JSON.stringify(day?.vehicle)).toBe(vehicle);
});

test("a trailer taken after a gap starts at ITS time — the gap is kept, and no record fills it", async () => {
  const shift = await dayWith();
  await addTrailer(shift, FRIDGE, 5, 30);
  await trailerTo(shift, null, 11);

  await addTrailer(shift, BOX, 14, 0);

  const day = await readOpenShift();
  expect(day?.previousTrailers).toHaveLength(1);
  expect(day?.previousTrailers[0]?.endedAt).toBe(at(11).toISOString());
  expect(day?.trailer?.startedAt).toBe(at(14).toISOString());
});


// ═══════════════════════════════════════════════════════════════════════════
// Vehicle and trailer are independent — except that a van tows nothing
// ═══════════════════════════════════════════════════════════════════════════

test.each([["unit → unit", { ...UNIT, numberPlate: "CD34 EFG" }], ["unit → Class 2", RIGID]] as const)(
  "changing vehicle (%s) leaves the trailer in use exactly as it was",
  async (_what, next) => {
    const shift = await dayWith();
    await addTrailer(shift);
    await diesel(shift, (await current())?.startedAt ?? "");
    const trailer = JSON.stringify(await current());

    await changeVehicle({ shiftId: shift.id, endingStartedAt: STARTED_AT.toISOString(), endMileage: 100_100, next, changedAt: at(10) });

    const day = await readOpenShift();
    expect(day?.vehicle?.numberPlate).toBe(next.numberPlate);
    expect(JSON.stringify(day?.trailer)).toBe(trailer);
    expect(day?.previousTrailers).toEqual([]);
  },
);

test("No VEHICLE while a trailer is in use is REFUSED — neither the vehicle nor the trailer changes", async () => {
  const shift = await dayWith();
  await addTrailer(shift);
  const before = bytes();

  await expect(endVehicleUse({
    shiftId: shift.id, endingStartedAt: STARTED_AT.toISOString(), endMileage: 100_050, endedAt: at(10),
  })).rejects.toThrow(TrailerStillInUseError);

  expect(bytes()).toBe(before);
  const day = await readOpenShift();
  expect(day?.vehicle?.numberPlate).toBe("AB12 CDE");
  expect(day?.previousVehicles).toEqual([]);
  expect(day?.trailer?.trailerNumber).toBe("TR1234");
  expect(day?.previousTrailers).toEqual([]);
});

test("after the driver explicitly chooses No trailer, No vehicle succeeds", async () => {
  const shift = await dayWith();
  await addTrailer(shift);
  await trailerTo(shift, null, 9);

  const day = await endVehicleUse({
    shiftId: shift.id, endingStartedAt: STARTED_AT.toISOString(), endMileage: 100_050, endedAt: at(10),
  });

  expect(day?.vehicle).toBeNull();
  expect(day?.trailer).toBeNull();
  expect(day?.status).toBe("open");
});

test("changing TO A VAN while a trailer is in use is REFUSED — neither vehicle nor trailer changes", async () => {
  const shift = await dayWith();
  await addTrailer(shift);
  const before = bytes();

  await expect(changeVehicle({
    shiftId: shift.id, endingStartedAt: STARTED_AT.toISOString(), endMileage: 100_050, next: VAN, changedAt: at(10),
  })).rejects.toThrow(TrailerStillInUseError);

  expect(bytes()).toBe(before);
  const day = await readOpenShift();
  expect(day?.vehicle?.numberPlate).toBe("AB12 CDE");
  expect(day?.trailer?.trailerNumber).toBe("TR1234");
});

// ─── The invariant, as the reader enforces it on a saved day ──────────────

const TRAILER_ON_DISK = { ...FRIDGE, startedAt: at(6).toISOString(), reeferDiesel: [], checks: [] };
const onDiskVehicle = (details: VehicleDetails) => ({ ...details, startedAt: STARTED_AT.toISOString(), checks: [], fills: [] });

test.each([
  ["Class 1 + trailer", onDiskVehicle(UNIT), TRAILER_ON_DISK, true],
  ["Class 2 + trailer", onDiskVehicle(RIGID), TRAILER_ON_DISK, true],
  ["Class 1 + no trailer", onDiskVehicle(UNIT), null, true],
  ["van + no trailer", onDiskVehicle(VAN), null, true],
  ["no vehicle + no trailer", null, null, true],
  ["van + trailer", onDiskVehicle(VAN), TRAILER_ON_DISK, false],
  ["NO vehicle + trailer", null, TRAILER_ON_DISK, false],
] as const)("a saved day with %s is %s", async (_what, vehicle, trailer, valid) => {
  storedFile().write(JSON.stringify({ ...LEGACY, vehicle, trailer, previousTrailers: [] }));

  const day = await readOpenShift();

  if (valid) expect(day?.id).toBe("shift_legacy");
  // Not written by this app, and not guessed at: the day fails closed.
  else expect(day).toBeNull();
});

test("CONTROL: once the trailer is handed back, the van may be taken", async () => {
  const shift = await dayWith();
  await addTrailer(shift);
  await trailerTo(shift, null, 9);

  const day = await changeVehicle({
    shiftId: shift.id, endingStartedAt: STARTED_AT.toISOString(), endMileage: 100_050, next: VAN, changedAt: at(10),
  });

  expect(day?.vehicle?.vehicleClass).toBe("van");
});

// ═══════════════════════════════════════════════════════════════════════════
// Fridge diesel
// ═══════════════════════════════════════════════════════════════════════════

test("a STANDARD trailer has no fridge unit: fridge diesel is refused, writing nothing", async () => {
  const shift = await dayWith();
  await addTrailer(shift, BOX);
  const before = bytes();

  const result = await diesel(shift, (await current())?.startedAt ?? "");

  expect(result).toBeNull();
  expect(bytes()).toBe(before);
});

test("a REFRIGERATED trailer takes a KNOWN amount, with its time and note", async () => {
  const shift = await dayWith();
  await addTrailer(shift);

  await diesel(shift, (await current())?.startedAt ?? "", { litres: 85.5, note: "Depot pump 2", recordedAt: at(7, 45) });

  expect((await current())?.reeferDiesel).toMatchObject([{ litres: 85.5, note: "Depot pump 2", recordedAt: at(7, 45).toISOString() }]);
});

test("an UNKNOWN amount is stored as null — never 0 — and needs no note", async () => {
  const shift = await dayWith();
  await addTrailer(shift);

  await diesel(shift, (await current())?.startedAt ?? "", { litres: null });

  const [stored] = (await current())?.reeferDiesel ?? [];
  expect(stored?.litres).toBeNull();
  expect(stored?.note).toBeNull();
  expect(bytes()).toContain('"litres":null');
});

test.each([["zero", 0], ["a negative amount", -5], ["three decimal places", 12.345]])("%s is refused as a known amount", async (_why, litres) => {
  const shift = await dayWith();
  await addTrailer(shift);
  const before = bytes();

  await expect(diesel(shift, (await current())?.startedAt ?? "", { litres })).rejects.toThrow(Error);

  expect(bytes()).toBe(before);
});

test("several diesel entries stay separate, in the order recorded", async () => {
  const shift = await dayWith();
  await addTrailer(shift);
  const trailer = (await current())?.startedAt ?? "";

  await diesel(shift, trailer, { litres: 50, recordedAt: at(7) });
  await diesel(shift, trailer, { litres: null, recordedAt: at(10) });
  await diesel(shift, trailer, { litres: 30, recordedAt: at(12) });

  expect((await current())?.reeferDiesel.map(fill => fill.litres)).toEqual([50, null, 30]);
});

test("fridge diesel NEVER touches the vehicle's Fuel — and vehicle Fuel never touches the trailer", async () => {
  const shift = await dayWith();
  await addTrailer(shift);
  await diesel(shift, (await current())?.startedAt ?? "", { litres: 90 });
  await recordVehicleFill({
    shiftId: shift.id, vehicleStartedAt: STARTED_AT.toISOString(), usageState: USAGE_STATE.inUse,
    fillId: newLocalId(), type: FILL_TYPE.fuel, recordedAt: at(9), litres: 300, note: "",
  });

  const day = await readOpenShift();
  expect(day?.vehicle?.fills.map(fill => fill.litres)).toEqual([300]);
  expect(day?.trailer?.reeferDiesel.map(fill => fill.litres)).toEqual([90]);
});

test("STALE: the trailer changed while the form was open — nothing is written, not even to its replacement", async () => {
  const shift = await dayWith();
  await addTrailer(shift, FRIDGE, 5, 30);
  const opened = (await current())?.startedAt ?? "";
  // The replacement is ALSO refrigerated, and even has the same number.
  await trailerTo(shift, FRIDGE, 9);
  const before = bytes();

  const result = await diesel(shift, opened, { litres: 70 });
  const removed = await removeReeferDiesel({ shiftId: shift.id, trailerStartedAt: opened, usageState: USAGE_STATE.inUse, fillId: "any" });

  expect([result, removed]).toEqual([null, null]);
  expect(bytes()).toBe(before);
  const day = await readOpenShift();
  expect(day?.trailer?.reeferDiesel).toEqual([]);
  expect(day?.previousTrailers[0]?.reeferDiesel).toEqual([]);
});

test("STALE: the trailer was handed back with none to follow — nothing is written", async () => {
  const shift = await dayWith();
  await addTrailer(shift);
  const opened = (await current())?.startedAt ?? "";
  await trailerTo(shift, null, 9);
  const before = bytes();

  expect(await diesel(shift, opened)).toBeNull();
  expect(bytes()).toBe(before);
});

test.each([["a trailer number", "TR1234"], ["nothing", ""], ["a time no trailer use began at", "2026-09-19T03:00:00.000Z"]])(
  "a diesel entry named by %s lands nowhere",
  async (_why, trailerStartedAt) => {
    const shift = await dayWith();
    await addTrailer(shift);
    const before = bytes();

    expect(await diesel(shift, trailerStartedAt)).toBeNull();
    expect(bytes()).toBe(before);
  },
);

test("re-recording the same id CORRECTS that entry; a rapid double save leaves one entry", async () => {
  const shift = await dayWith();
  await addTrailer(shift);
  const trailer = (await current())?.startedAt ?? "";
  const id = newLocalId();

  await Promise.all([diesel(shift, trailer, { fillId: id, litres: 40 }), diesel(shift, trailer, { fillId: id, litres: 40 })]);
  await diesel(shift, trailer, { fillId: id, litres: null });

  expect((await current())?.reeferDiesel).toMatchObject([{ id, litres: null }]);
});

test("removing an entry takes only that one", async () => {
  const shift = await dayWith();
  await addTrailer(shift);
  const trailer = (await current())?.startedAt ?? "";
  const keep = newLocalId();
  const mistake = newLocalId();
  await diesel(shift, trailer, { fillId: keep, litres: 40 });
  await diesel(shift, trailer, { fillId: mistake, litres: 4 });

  await removeReeferDiesel({ shiftId: shift.id, trailerStartedAt: trailer, usageState: USAGE_STATE.inUse, fillId: mistake });

  expect((await current())?.reeferDiesel.map(fill => fill.id)).toEqual([keep]);
});
