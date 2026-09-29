/**
 * Stable use identity, correctable use times, and the company declaration
 * bound to one version (D42) — the store.
 *
 *   IDENTITY    every vehicle and trailer use gets a `useId` once, when it is
 *               created; nothing — a restart, a finish, a plate, a number or a
 *               time correction — changes it. A use stored before ids existed
 *               reads under one derived id, the same on every read, written
 *               out on the next save and kept from then on.
 *   TIMES       a use's start and end are its own facts, corrected on their
 *               own; the day must still hold, and no other use ever moves.
 *   DECLARATION a company's timesheet is stored with the version the driver
 *               declared; any later change means it must be declared again.
 */
import { Directory, File, Paths } from "expo-file-system";
import {
  COMPLETED_SHIFT_FILE_PREFIX,
  OPEN_SHIFT_FILE,
  TimesheetBoundsError,
  USAGE_STATE,
  UseTimesError,
  addTrailerToOpenShift,
  addVehicleToOpenShift,
  changeTrailer,
  changeVehicle,
  clearOpenShift,
  correctCompletedShift,
  correctNumberPlate,
  correctOpenShift,
  correctTrailerNumber,
  correctTrailerUseTimes,
  correctVehicleUseTimes,
  declarationHolds,
  declarationState,
  effectiveUses,
  endVehicleUse,
  finishOpenShift,
  listCompletedShifts,
  readCompletedShift,
  readOpenShift,
  recordReeferDiesel,
  recordVehicleFill,
  startLocalShift,
  timesheetVersion,
  type CompletedShift,
  type LocalShift,
  type VehicleDetails,
  type WorkingContext,
} from "../shift/localShift";
import { TRAILER_TYPE } from "../shift/trailer";
import { FILL_TYPE } from "../shift/vehicleFill";
import { USE_ENDED_BY } from "../shift/useEnd";
import { DECLARED_BY, correctDeclared, correctedVersion, declaredFinish, finishDeclared } from "./declared";

const at = (hours: number, minutes = 0) => new Date(2026, 8, 19, hours, minutes);
const iso = (hours: number, minutes = 0) => at(hours, minutes).toISOString();
const PERSONAL: WorkingContext = { kind: "personal" };
const NORTHGATE: WorkingContext = { kind: "company", membershipId: "m1", companyId: "c1", companyName: "Northgate Haulage" };
const UNIT: VehicleDetails = { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 };
const RIGID: VehicleDetails = { vehicleClass: "class2", numberPlate: "XY34 ZZZ", startMileage: 220_000 };
const VAN: VehicleDetails = { vehicleClass: "van", numberPlate: "VN11 AAA", startMileage: 5_000 };
const TR23 = { trailerNumber: "TR23", trailerType: TRAILER_TYPE.standard };
const RF77 = { trailerNumber: "RF77", trailerType: TRAILER_TYPE.refrigerated };

const openFile = () => new File(Paths.document, OPEN_SHIFT_FILE);
const openBytes = () => openFile().textSync();
const recordFile = (id: string) => new File(Paths.document, `${COMPLETED_SHIFT_FILE_PREFIX}${id}.json`);
const recordBytes = (id: string) => recordFile(id).textSync();
const rawOpen = (): Record<string, unknown> => JSON.parse(openBytes()) as Record<string, unknown>;

beforeEach(async () => {
  await clearOpenShift();
  for (const entry of new Directory(Paths.document).list()) {
    if (entry instanceof File) entry.delete();
  }
});
afterEach(() => { jest.restoreAllMocks(); });

async function open(): Promise<LocalShift> {
  const day = await readOpenShift();
  if (day === null) throw new Error("expected an open day");
  return day;
}

/** AB12 CDE 05:00–09:00 → XY34 ZZZ 09:00– (in use); TR23 06:00–12:00 → RF77 12:00– (in use). */
async function changedDay(workingFor: WorkingContext = PERSONAL): Promise<LocalShift> {
  const shift = await startLocalShift({ workingFor, startedAt: at(5), vehicle: UNIT });
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(6) });
  await changeVehicle({ shiftId: shift.id, endingUseId: (await open()).vehicle?.useId ?? "", endMileage: 100_100, next: RIGID, changedAt: at(9) });
  await changeTrailer({ shiftId: shift.id, endingUseId: (await open()).trailer?.useId ?? "", next: RF77, changedAt: at(12) });
  return open();
}

/** AB12 CDE 05:00–09:00 → XY34 ZZZ 09:00– (in use); no trailer to tow. */
async function vehicleDay(): Promise<LocalShift> {
  const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: at(5), vehicle: UNIT });
  await changeVehicle({ shiftId: shift.id, endingUseId: (await open()).vehicle?.useId ?? "", endMileage: 100_100, next: RIGID, changedAt: at(9) });
  return open();
}

async function finished(workingFor: WorkingContext = PERSONAL): Promise<CompletedShift> {
  const day = await changedDay(workingFor);
  const done = await finishDeclared({
    shiftId: day.id, vehicleUseId: day.vehicle?.useId ?? null, trailerUseId: day.trailer?.useId ?? null,
    finalMileage: 220_200, endedAt: at(17), nightOut: false, notes: "",
  });
  if (done === null) throw new Error("expected the day to finish");
  return done;
}

// ═══════════════════════════════════════════════════════════════════════════
// Identity: given once, never derived from what it names
// ═══════════════════════════════════════════════════════════════════════════

describe("a use's identity", () => {
  test("is given when the use is created — neither its start, its plate nor its number — and is on disk", async () => {
    const day = await changedDay();
    const uses = [...day.previousVehicles, day.vehicle, ...day.previousTrailers, day.trailer];
    const ids = uses.map(use => use?.useId ?? "");

    for (const use of uses) {
      expect(use?.useId).toMatch(/^[0-9a-f-]{36}$/);
      expect(use?.useId).not.toContain(use?.startedAt ?? "none");
    }
    expect(new Set(ids).size).toBe(4);
    expect(openBytes()).toContain(`"useId":"${day.vehicle?.useId ?? ""}"`);
  });

  test("survives a restart: read again from the file alone, every use has the same id", async () => {
    const day = await changedDay();
    const again = await open();
    expect(again).toEqual(day);
  });

  test("the SAME plate taken twice is two uses with two ids — a write to the second never reaches the first", async () => {
    const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: at(5), vehicle: UNIT });
    await changeVehicle({ shiftId: shift.id, endingUseId: (await open()).vehicle?.useId ?? "", endMileage: 100_100, next: RIGID, changedAt: at(9) });
    await changeVehicle({ shiftId: shift.id, endingUseId: (await open()).vehicle?.useId ?? "", endMileage: 220_050, next: { ...UNIT, startMileage: 100_100 }, changedAt: at(11) });
    const day = await open();
    const [first] = day.previousVehicles;
    expect(first?.numberPlate).toBe(day.vehicle?.numberPlate);
    expect(first?.useId).not.toBe(day.vehicle?.useId);

    await recordVehicleFill({
      shiftId: shift.id, vehicleUseId: day.vehicle?.useId ?? "", usageState: USAGE_STATE.inUse,
      fillId: "f1", type: FILL_TYPE.fuel, recordedAt: at(12), litres: 50, note: "",
    });

    const after = await open();
    expect(after.vehicle?.fills).toHaveLength(1);
    expect(after.previousVehicles[0]).toEqual(first);
  });

  test("the SAME trailer number taken twice is two uses with two ids", async () => {
    const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: at(5), vehicle: UNIT });
    await addTrailerToOpenShift({ shiftId: shift.id, trailer: RF77, startedAt: at(6) });
    await changeTrailer({ shiftId: shift.id, endingUseId: (await open()).trailer?.useId ?? "", next: TR23, changedAt: at(8) });
    await changeTrailer({ shiftId: shift.id, endingUseId: (await open()).trailer?.useId ?? "", next: RF77, changedAt: at(10) });
    const day = await open();
    const [first] = day.previousTrailers;

    await recordReeferDiesel({ shiftId: shift.id, trailerUseId: day.trailer?.useId ?? "", usageState: USAGE_STATE.inUse, fillId: "d1", recordedAt: at(11), litres: 40, note: "" });

    expect(first?.trailerNumber).toBe(day.trailer?.trailerNumber);
    expect(first?.useId).not.toBe(day.trailer?.useId);
    expect((await open()).previousTrailers[0]).toEqual(first);
    expect((await open()).trailer?.reeferDiesel).toHaveLength(1);
  });

  test("a plate or trailer number corrected keeps the use's id — and the next operation still finds it", async () => {
    const day = await changedDay();
    const vehicleId = day.previousVehicles[0]?.useId ?? "";
    const trailerId = day.previousTrailers[0]?.useId ?? "";

    await correctNumberPlate({ shiftId: day.id, useId: vehicleId, usageState: USAGE_STATE.ended, value: "AB12 CDF" });
    await correctTrailerNumber({ shiftId: day.id, useId: trailerId, usageState: USAGE_STATE.ended, value: "TR24" });

    const after = await open();
    expect(after.previousVehicles[0]).toMatchObject({ useId: vehicleId, numberPlate: "AB12 CDF" });
    expect(after.previousTrailers[0]).toMatchObject({ useId: trailerId, trailerNumber: "TR24" });
  });

  test("a start corrected keeps the use's id — the id is not its start", async () => {
    const day = await vehicleDay();
    const current = day.vehicle;
    if (current === null) throw new Error("expected a vehicle");

    await correctVehicleUseTimes({ shiftId: day.id, useId: current.useId, usageState: USAGE_STATE.inUse, startedAt: at(9, 30), endedAt: null });
    // The id still names it; its old start names nothing.
    await recordVehicleFill({
      shiftId: day.id, vehicleUseId: current.useId, usageState: USAGE_STATE.inUse,
      fillId: "f1", type: FILL_TYPE.adblue, recordedAt: at(10), litres: null, note: "",
    });

    const after = await open();
    expect(after.vehicle).toMatchObject({ useId: current.useId, startedAt: iso(9, 30) });
    expect(after.vehicle?.fills).toHaveLength(1);
  });

  test("the finish files every use under the id it had — and they still name them on the finished day", async () => {
    const day = await changedDay();
    const ids = [...day.previousVehicles, day.vehicle].map(use => use?.useId);
    const trailerIds = [...day.previousTrailers, day.trailer].map(use => use?.useId);

    const done = await finishDeclared({
      shiftId: day.id, vehicleUseId: day.vehicle?.useId ?? null, trailerUseId: day.trailer?.useId ?? null,
      finalMileage: 220_200, endedAt: at(17), nightOut: false, notes: "",
    });

    expect(done?.previousVehicles.map(use => use.useId)).toEqual(ids);
    expect(done?.previousTrailers.map(use => use.useId)).toEqual(trailerIds);
  });

  test("an unusable stored id — empty, too long, not a string — is not a day this app wrote", async () => {
    const day = await changedDay();
    for (const bad of ["", "x".repeat(65), 42]) {
      const raw = rawOpen();
      openFile().write(JSON.stringify({ ...raw, vehicle: { ...(raw["vehicle"] as Record<string, unknown>), useId: bad } }));
      expect(await readOpenShift()).toBeNull();
    }
    expect(day.id).not.toBe("");
  });

  test("two uses sharing one id in a day is not a day this app wrote", async () => {
    await changedDay();
    const raw = rawOpen();
    const [first] = raw["previousVehicles"] as Record<string, unknown>[];
    const current = raw["vehicle"] as Record<string, unknown>;
    openFile().write(JSON.stringify({ ...raw, vehicle: { ...current, useId: first?.["useId"] } }));

    expect(await readOpenShift()).toBeNull();
  });
});

describe("a use stored before ids existed", () => {
  function storeLegacyDay(): string {
    const document = {
      id: "11111111-2222-4333-8444-555555555555", workingFor: PERSONAL, startedAt: iso(5),
      vehicle: { ...RIGID, startedAt: iso(9), checks: [], fills: [] },
      previousVehicles: [{ ...UNIT, startedAt: iso(5), checks: [], fills: [], endMileage: 100_100, endedAt: iso(9) }],
      trailer: { ...TR23, startedAt: iso(6), checks: [], reeferDiesel: [] },
      previousTrailers: [],
      status: "open", createdAt: iso(5),
    };
    openFile().create({ overwrite: true });
    openFile().write(JSON.stringify(document));
    return openBytes();
  }

  test("reads under an id derived from its kind and start — the same on every read, distinct within the day, and reading writes nothing", async () => {
    const bytes = storeLegacyDay();

    const first = await open();
    const second = await open();

    expect(first.previousVehicles[0]?.useId).toBe(`legacy-vehicle-${iso(5)}`);
    expect(first.vehicle?.useId).toBe(`legacy-vehicle-${iso(9)}`);
    expect(first.trailer?.useId).toBe(`legacy-trailer-${iso(6)}`);
    expect(second).toEqual(first);
    expect(openBytes()).toBe(bytes);
  });

  test("its id is written out on the next save, and stays its id when its start is then corrected", async () => {
    storeLegacyDay();
    const day = await open();
    const legacy = day.previousVehicles[0]?.useId ?? "";

    await correctVehicleUseTimes({ shiftId: day.id, useId: legacy, usageState: USAGE_STATE.ended, startedAt: at(5, 15), endedAt: at(9) });
    // The start the id was derived from has moved; the id has not — and every other use's id is written out too.
    expect((rawOpen()["previousVehicles"] as unknown[])[0]).toMatchObject({ useId: legacy, startedAt: iso(5, 15) });
    expect(rawOpen()["vehicle"]).toMatchObject({ useId: `legacy-vehicle-${iso(9)}` });
    await recordVehicleFill({ shiftId: day.id, vehicleUseId: legacy, usageState: USAGE_STATE.ended, fillId: "f", type: FILL_TYPE.fuel, recordedAt: at(6), litres: 5, note: "" });

    expect((await open()).previousVehicles[0]).toMatchObject({ useId: legacy, startedAt: iso(5, 15), fills: [expect.objectContaining({ id: "f" })] });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Times: each use's own, corrected on their own; the day must still hold
// ═══════════════════════════════════════════════════════════════════════════

describe("correcting a vehicle use's times", () => {
  test("an ended use's start and end are corrected — its id, plate, mileage and every other use unchanged", async () => {
    const day = await vehicleDay();
    const target = day.previousVehicles[0];
    if (target === undefined) throw new Error("expected an ended use");

    await correctVehicleUseTimes({ shiftId: day.id, useId: target.useId, usageState: USAGE_STATE.ended, startedAt: at(5, 10), endedAt: at(8, 45) });

    const after = await open();
    expect(after.previousVehicles[0]).toEqual({ ...target, startedAt: iso(5, 10), endedAt: iso(8, 45) });
    expect(after.vehicle).toEqual(day.vehicle);
  });

  test("the vehicle IN USE has a start and no end — an end for it is refused, writing nothing", async () => {
    const day = await changedDay();
    const before = openBytes();

    await expect(correctVehicleUseTimes({ shiftId: day.id, useId: day.vehicle?.useId ?? "", usageState: USAGE_STATE.inUse, startedAt: at(9), endedAt: at(10) }))
      .rejects.toThrow("Refusing an end for a use still in use");
    expect(openBytes()).toBe(before);
  });

  test.each([
    ["an end before its start",                        { startedAt: at(7), endedAt: at(6) },        "end-before-start"],
    ["a start before the shift began",                 { startedAt: at(4, 59), endedAt: at(9) },    "before-shift-start"],
    ["an end after the next vehicle began (overlap)",  { startedAt: at(5), endedAt: at(9, 1) },     "overlaps"],
  ] as const)("%s is refused with its rule — nothing is written, no use moves", async (_why, times, kind) => {
    const day = await changedDay();
    const before = openBytes();

    const refused = correctVehicleUseTimes({ shiftId: day.id, useId: day.previousVehicles[0]?.useId ?? "", usageState: USAGE_STATE.ended, ...times });

    await expect(refused).rejects.toBeInstanceOf(UseTimesError);
    await expect(refused).rejects.toMatchObject({ problem: { kind } });
    expect(openBytes()).toBe(before);
  });

  test("two uses of a kind may not START at the same instant — even one of no length", async () => {
    const day = await changedDay();
    const before = openBytes();

    await expect(correctVehicleUseTimes({ shiftId: day.id, useId: day.previousVehicles[0]?.useId ?? "", usageState: USAGE_STATE.ended, startedAt: at(9), endedAt: at(9) }))
      .rejects.toMatchObject({ problem: { kind: "overlaps" } });
    expect(openBytes()).toBe(before);
  });

  test("a change leaves the gap it makes: A's end earlier never moves B's start (D32)", async () => {
    const day = await vehicleDay();

    await correctVehicleUseTimes({ shiftId: day.id, useId: day.previousVehicles[0]?.useId ?? "", usageState: USAGE_STATE.ended, startedAt: at(5), endedAt: at(8, 30) });

    const after = await open();
    expect(after.previousVehicles[0]?.endedAt).toBe(iso(8, 30));
    expect(after.vehicle?.startedAt).toBe(iso(9));
  });

  test("B's start later never moves A's end — but a trailer left without a towing vehicle it had is refused", async () => {
    const day = await changedDay();
    const before = openBytes();

    // TR23 06:00–12:00 is towed by AB12 until 09:00 and by XY34 from 09:00: a gap would strand it.
    await expect(correctVehicleUseTimes({ shiftId: day.id, useId: day.vehicle?.useId ?? "", usageState: USAGE_STATE.inUse, startedAt: at(9, 30), endedAt: null }))
      .rejects.toMatchObject({ problem: { kind: "trailer-untowed", name: "trailer TR23" } });
    expect(openBytes()).toBe(before);
  });

  test("with no trailer at stake, B's start later is corrected alone — A's end stays", async () => {
    const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: at(5), vehicle: UNIT });
    await changeVehicle({ shiftId: shift.id, endingUseId: (await open()).vehicle?.useId ?? "", endMileage: 100_100, next: VAN, changedAt: at(9) });
    const day = await open();

    await correctVehicleUseTimes({ shiftId: day.id, useId: day.vehicle?.useId ?? "", usageState: USAGE_STATE.inUse, startedAt: at(9, 30), endedAt: null });

    const after = await open();
    expect(after.previousVehicles[0]?.endedAt).toBe(iso(9));
    expect(after.vehicle?.startedAt).toBe(iso(9, 30));
  });

  test("No Vehicle, then a vehicle added later: the gap is real, and either side is corrected without moving the other", async () => {
    const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: at(5), vehicle: VAN });
    await endVehicleUse({ shiftId: shift.id, endingUseId: (await open()).vehicle?.useId ?? "", endMileage: 5_100, endedAt: at(9) });
    await addVehicleToOpenShift({ vehicle: UNIT, startedAt: at(11) });
    const day = await open();

    await correctVehicleUseTimes({ shiftId: day.id, useId: day.previousVehicles[0]?.useId ?? "", usageState: USAGE_STATE.ended, startedAt: at(5), endedAt: at(10) });
    await correctVehicleUseTimes({ shiftId: day.id, useId: day.vehicle?.useId ?? "", usageState: USAGE_STATE.inUse, startedAt: at(10, 30), endedAt: null });

    const after = await open();
    expect(after.previousVehicles[0]).toMatchObject({ startedAt: iso(5), endedAt: iso(10) });
    expect(after.vehicle).toMatchObject({ startedAt: iso(10, 30) });
    await expect(correctVehicleUseTimes({ shiftId: day.id, useId: day.vehicle?.useId ?? "", usageState: USAGE_STATE.inUse, startedAt: at(9, 59), endedAt: null }))
      .rejects.toMatchObject({ problem: { kind: "overlaps" } });
  });

  test("a use named in the wrong state, or by its old start, or by its plate, corrects nothing", async () => {
    const day = await changedDay();
    const before = openBytes();
    const ended = day.previousVehicles[0];

    for (const [useId, state] of [
      [ended?.useId ?? "", USAGE_STATE.inUse],
      [ended?.startedAt ?? "", USAGE_STATE.ended],
      [ended?.numberPlate ?? "", USAGE_STATE.ended],
      ["", USAGE_STATE.ended],
    ] as const) {
      expect(await correctVehicleUseTimes({ shiftId: day.id, useId, usageState: state, startedAt: at(5, 5), endedAt: state === USAGE_STATE.inUse ? null : at(8) })).toBeNull();
    }
    expect(openBytes()).toBe(before);
  });
});

describe("correcting a trailer use's times", () => {
  test("an ended trailer's start and end are corrected — its id and the trailer after it unchanged", async () => {
    const day = await changedDay();
    const target = day.previousTrailers[0];
    if (target === undefined) throw new Error("expected an ended trailer");

    await correctTrailerUseTimes({ shiftId: day.id, useId: target.useId, usageState: USAGE_STATE.ended, startedAt: at(6, 15), endedAt: at(11, 30) });

    const after = await open();
    expect(after.previousTrailers[0]).toEqual({ ...target, startedAt: iso(6, 15), endedAt: iso(11, 30) });
    expect(after.trailer).toEqual(day.trailer);
  });

  test("a trailer may not overlap the next, nor start before any towing vehicle", async () => {
    const day = await changedDay();
    const id = day.previousTrailers[0]?.useId ?? "";
    const before = openBytes();

    await expect(correctTrailerUseTimes({ shiftId: day.id, useId: id, usageState: USAGE_STATE.ended, startedAt: at(6), endedAt: at(12, 1) }))
      .rejects.toMatchObject({ problem: { kind: "overlaps", name: "trailer RF77" } });
    await expect(correctTrailerUseTimes({ shiftId: day.id, useId: id, usageState: USAGE_STATE.ended, startedAt: at(4, 30), endedAt: at(12) }))
      .rejects.toMatchObject({ problem: { kind: "before-shift-start" } });
    expect(openBytes()).toBe(before);
  });

  test("No Trailer: the trailer handed back keeps its own end, corrected alone", async () => {
    const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: at(5), vehicle: UNIT });
    await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(6) });
    await changeTrailer({ shiftId: shift.id, endingUseId: (await open()).trailer?.useId ?? "", next: null, changedAt: at(10) });
    const day = await open();

    await correctTrailerUseTimes({ shiftId: day.id, useId: day.previousTrailers[0]?.useId ?? "", usageState: USAGE_STATE.ended, startedAt: at(6), endedAt: at(9, 45) });

    expect((await open()).previousTrailers[0]).toMatchObject({ startedAt: iso(6), endedAt: iso(9, 45) });
    expect((await open()).trailer).toBeNull();
  });
});

describe("the shift and its first use", () => {
  test("a shift may start before its first use: correcting the start EARLIER moves no use", async () => {
    const day = await changedDay();

    await correctOpenShift({ shiftId: day.id, workingFor: PERSONAL, startedAt: at(4, 30) });

    const after = await open();
    expect(after.startedAt).toBe(iso(4, 30));
    expect(after.previousVehicles[0]?.startedAt).toBe(iso(5));
    expect(after.previousTrailers[0]?.startedAt).toBe(iso(6));
  });

  test("a start LATER than a use began is still refused — the use is never dragged with it", async () => {
    const day = await changedDay();
    const before = openBytes();

    await expect(correctOpenShift({ shiftId: day.id, workingFor: PERSONAL, startedAt: at(5, 30) })).rejects.toBeInstanceOf(TimesheetBoundsError);
    expect(openBytes()).toBe(before);
  });

  test("the first vehicle's start may then be corrected later than the shift's", async () => {
    const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: at(5), vehicle: VAN });
    const id = (await open()).vehicle?.useId ?? "";

    await correctVehicleUseTimes({ shiftId: shift.id, useId: id, usageState: USAGE_STATE.inUse, startedAt: at(5, 20), endedAt: null });

    const after = await open();
    expect(after.startedAt).toBe(iso(5));
    expect(after.vehicle).toMatchObject({ useId: id, startedAt: iso(5, 20) });
  });
});

describe("a finished day's use times", () => {
  test("a use the finish ended, whose end is corrected, stops following the finish — the mark is dropped", async () => {
    const done = await finished();
    const closed = done.previousTrailers[1];
    expect(closed?.endedBy).toBe(USE_ENDED_BY.finish);

    await correctTrailerUseTimes({ shiftId: done.id, useId: closed?.useId ?? "", usageState: USAGE_STATE.ended, startedAt: at(12), endedAt: at(16, 30) });

    const stored = await readCompletedShift(done.id);
    expect(stored?.previousTrailers[1]).toEqual({ ...closed, endedAt: iso(16, 30), endedBy: undefined });
    expect(Object.keys(stored?.previousTrailers[1] ?? {})).not.toContain("endedBy");
    // A later finish correction no longer moves it; the vehicle the finish ended still follows.
    const later = await correctDeclared({
      shiftId: done.id, basedOn: null, correctionId: "c1", workingFor: PERSONAL, startedAt: at(5), endedAt: at(17, 30),
      nightOut: false, notes: "", correctedAt: at(18), correctedBy: DECLARED_BY,
    });
    if (later === null) throw new Error("expected the correction");
    const uses = effectiveUses(later);
    expect(uses.previousTrailers[1]?.endedAt).toBe(iso(16, 30));
    expect(uses.previousVehicles[1]?.endedAt).toBe(iso(17, 30));
  });

  test("its START alone corrected keeps it following the finish", async () => {
    const done = await finished();
    const closed = done.previousTrailers[1];

    await correctTrailerUseTimes({ shiftId: done.id, useId: closed?.useId ?? "", usageState: USAGE_STATE.ended, startedAt: at(12, 5), endedAt: at(17) });

    expect((await readCompletedShift(done.id))?.previousTrailers[1]).toEqual({ ...closed, startedAt: iso(12, 5) });
  });

  test("a vehicle the finish ended cannot have its end corrected so as to strand the trailer it towed", async () => {
    const done = await finished();
    const before = recordBytes(done.id);

    await expect(correctVehicleUseTimes({ shiftId: done.id, useId: done.previousVehicles[1]?.useId ?? "", usageState: USAGE_STATE.ended, startedAt: at(9), endedAt: at(16, 30) }))
      .rejects.toMatchObject({ problem: { kind: "trailer-untowed", name: "trailer RF77" } });
    expect(recordBytes(done.id)).toBe(before);
  });

  test("a use may not end after the day finished", async () => {
    const done = await finished();
    const before = recordBytes(done.id);

    await expect(correctVehicleUseTimes({ shiftId: done.id, useId: done.previousVehicles[0]?.useId ?? "", usageState: USAGE_STATE.ended, startedAt: at(5), endedAt: at(17, 1) }))
      .rejects.toMatchObject({ problem: { kind: "after-shift-finish" } });
    expect(recordBytes(done.id)).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The company declaration: bound to one version
// ═══════════════════════════════════════════════════════════════════════════

describe("a company's declaration", () => {
  test("is filed with the finish: the version declared is the version stored, by the driver, at the press", async () => {
    const done = await finished(NORTHGATE);

    expect(done.declaration).toMatchObject({ version: timesheetVersion(done), declaredBy: DECLARED_BY });
    expect(declarationHolds(done)).toBe(true);
  });

  test("a company's day is never filed without a declaration — nothing written, the day stays open", async () => {
    const day = await changedDay(NORTHGATE);
    const before = openBytes();

    await expect(finishOpenShift({
      shiftId: day.id, vehicleUseId: day.vehicle?.useId ?? null, trailerUseId: day.trailer?.useId ?? null,
      finalMileage: 220_200, endedAt: at(17), nightOut: false, notes: "", declared: null,
    })).rejects.toThrow("without its declaration");
    expect(openBytes()).toBe(before);
    expect(recordFile(day.id).exists).toBe(false);
  });

  test("a declaration of a version the store would NOT file files nothing", async () => {
    const day = await changedDay(NORTHGATE);
    const finish = await declaredFinish({
      shiftId: day.id, vehicleUseId: day.vehicle?.useId ?? null, trailerUseId: day.trailer?.useId ?? null,
      finalMileage: 220_200, endedAt: at(17), nightOut: false, notes: "",
    });

    expect(await finishOpenShift({ ...finish, notes: "typed after the review" })).toBeNull();
    expect(recordFile(day.id).exists).toBe(false);
    expect(await readOpenShift()).not.toBeNull();
  });

  test("a Personal day carries none, whatever is sent", async () => {
    const done = await finished(PERSONAL);
    expect(done.declaration).toBeUndefined();
    expect(declarationHolds(done)).toBe(true);
  });

  test("a use's fill, mileage, check or time changed on a company's day: the declaration no longer holds", async () => {
    const done = await finished(NORTHGATE);

    await recordVehicleFill({
      shiftId: done.id, vehicleUseId: done.previousVehicles[0]?.useId ?? "", usageState: USAGE_STATE.ended,
      fillId: "late", type: FILL_TYPE.fuel, recordedAt: at(7), litres: 80, note: "",
    });

    const changed = await readCompletedShift(done.id);
    if (changed === null) throw new Error("expected the day");
    expect(changed.declaration).toEqual(done.declaration);
    expect(declarationHolds(changed)).toBe(false);
  });

  test("declared again with nothing changed: the declaration is renewed and NO correction is appended", async () => {
    const done = await finished(NORTHGATE);
    await correctVehicleUseTimes({ shiftId: done.id, useId: done.previousVehicles[0]?.useId ?? "", usageState: USAGE_STATE.ended, startedAt: at(5, 5), endedAt: at(9) });
    const changed = await readCompletedShift(done.id);
    if (changed === null) throw new Error("expected the day");

    const redeclared = await correctDeclared({
      shiftId: done.id, basedOn: null, correctionId: "r1", workingFor: NORTHGATE, startedAt: at(5), endedAt: at(17),
      nightOut: false, notes: "", correctedAt: at(18), correctedBy: DECLARED_BY,
    });

    expect(redeclared?.corrections).toBeUndefined();
    expect(redeclared?.declaration?.version).toBe(timesheetVersion(changed));
    expect(redeclared === null ? false : declarationHolds(redeclared)).toBe(true);
  });

  test.each([
    ["Notes",        { notes: "Waited at the gate" }],
    ["Night Out",    { nightOut: true }],
    ["a time",       { endedAt: at(17, 30) }],
    ["working for",  { workingFor: { kind: "company", membershipId: "m2", companyId: "c2", companyName: "Eastway Freight" } as WorkingContext }],
    ["to Personal",  { workingFor: PERSONAL }],
  ] as const)("changing %s on a company's day without a declaration writes nothing", async (_what, change) => {
    const done = await finished(NORTHGATE);
    const before = recordBytes(done.id);

    await expect(correctCompletedShift({
      shiftId: done.id, basedOn: null, correctionId: "c1", workingFor: NORTHGATE, startedAt: at(5), endedAt: at(17),
      nightOut: false, notes: "", correctedAt: at(18), correctedBy: DECLARED_BY, ...change, declared: null,
    })).rejects.toThrow("without its declaration");
    expect(recordBytes(done.id)).toBe(before);
  });

  test("a company's day made Personal, declared, drops the declaration — a Personal day carries none", async () => {
    const done = await finished(NORTHGATE);

    const personal = await correctDeclared({
      shiftId: done.id, basedOn: null, correctionId: "c1", workingFor: PERSONAL, startedAt: at(5), endedAt: at(17),
      nightOut: false, notes: "", correctedAt: at(18), correctedBy: DECLARED_BY,
    });

    expect(personal?.corrections).toHaveLength(1);
    expect(personal?.declaration).toBeUndefined();
  });

  test("a Personal day's ordinary correction needs no declaration; making it a company's does", async () => {
    const done = await finished(PERSONAL);
    const base = { shiftId: done.id, basedOn: null, startedAt: at(5), endedAt: at(17), nightOut: false, correctedAt: at(18), correctedBy: DECLARED_BY };

    const noted = await correctCompletedShift({ ...base, correctionId: "c1", workingFor: PERSONAL, notes: "Quiet day", declared: null });
    expect(noted?.corrections).toHaveLength(1);
    const before = recordBytes(done.id);
    await expect(correctCompletedShift({ ...base, basedOn: "c1", correctionId: "c2", workingFor: NORTHGATE, notes: "Quiet day", declared: null }))
      .rejects.toThrow("without its declaration");
    expect(recordBytes(done.id)).toBe(before);
  });

  test("a declaration of a version other than the one the correction produces saves nothing", async () => {
    const done = await finished(NORTHGATE);
    const before = recordBytes(done.id);
    const input = {
      shiftId: done.id, basedOn: null, correctionId: "c1", workingFor: NORTHGATE, startedAt: at(5), endedAt: at(17),
      nightOut: false, notes: "Reviewed", correctedAt: at(18), correctedBy: DECLARED_BY,
    };
    const shown = correctedVersion(done, { ...input, notes: "What the review showed" });

    expect(await correctCompletedShift({ ...input, declared: { at: at(18), by: DECLARED_BY, version: shown } })).toBeNull();
    expect(recordBytes(done.id)).toBe(before);
  });

  test("a valid declaration of THIS version is confirmed; one legitimate correction later it is changed — not unconfirmed", async () => {
    const done = await finished(NORTHGATE);
    expect(declarationState(done)).toBe("confirmed");

    await recordVehicleFill({
      shiftId: done.id, vehicleUseId: done.previousVehicles[0]?.useId ?? "", usageState: USAGE_STATE.ended,
      fillId: "late", type: FILL_TYPE.fuel, recordedAt: at(7), litres: 80, note: "",
    });

    const changed = await readCompletedShift(done.id);
    if (changed === null) throw new Error("expected the day");
    expect(declarationState(changed)).toBe("changed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// No valid declaration: never recorded, or damaged — readable, never trusted
// ═══════════════════════════════════════════════════════════════════════════

describe("a company's timesheet with no valid declaration", () => {
  /** A company's finished day, its stored declaration replaced — or removed with `undefined`. */
  async function storedWith(declaration: unknown, over: Record<string, unknown> = {}): Promise<{ done: CompletedShift; bytes: string }> {
    const done = await finished(NORTHGATE);
    const raw = JSON.parse(recordBytes(done.id)) as Record<string, unknown>;
    const { declaration: _declared, ...facts } = raw;
    recordFile(done.id).write(JSON.stringify(declaration === undefined ? { ...facts, ...over } : { ...facts, declaration, ...over }));
    return { done, bytes: recordBytes(done.id) };
  }

  test("NONE recorded — a day finished before declarations were stored — reads, needs confirmation, and is not rewritten", async () => {
    const { done, bytes } = await storedWith(undefined);

    const read = await readCompletedShift(done.id);

    expect(read).not.toBeNull();
    expect(read?.declaration).toBeUndefined();
    expect(read === null ? null : declarationState(read)).toBe("unconfirmed");
    expect(recordBytes(done.id)).toBe(bytes);
  });

  test.each([
    ["an empty version",                   (valid: Record<string, unknown>) => ({ ...valid, version: "" })],
    ["an over-long version",               (valid: Record<string, unknown>) => ({ ...valid, version: "v".repeat(65) })],
    ["no declaredBy",                      (valid: Record<string, unknown>) => ({ version: valid["version"], declaredAt: valid["declaredAt"] })],
    ["an empty declaredBy",                (valid: Record<string, unknown>) => ({ ...valid, declaredBy: "" })],
    ["a declaredAt that is not an instant", (valid: Record<string, unknown>) => ({ ...valid, declaredAt: "yesterday" })],
    ["no declaredAt",                      (valid: Record<string, unknown>) => ({ version: valid["version"], declaredBy: valid["declaredBy"] })],
    ["a number",                           () => 42],
    ["a list",                             (valid: Record<string, unknown>) => [valid]],
    ["null",                               () => null],
  ])("DAMAGED — %s — the day still reads, the declaration is not trusted in any part, nothing is made up, and reading writes nothing", async (_why, damage) => {
    const probe = await finished(NORTHGATE);
    const valid = { ...(probe.declaration ?? {}) } as Record<string, unknown>;
    await clearOpenShift();
    recordFile(probe.id).delete();
    const { done, bytes } = await storedWith(damage(valid));

    const read = await readCompletedShift(done.id);

    expect(read).not.toBeNull();
    expect(read?.declaration).toBeUndefined();
    expect(read === null ? null : declarationState(read)).toBe("unconfirmed");
    expect(recordBytes(done.id)).toBe(bytes);
    // Listed as the driver's timesheet — not set aside as unreadable.
    const listed = await listCompletedShifts();
    expect(listed.timesheets.map(day => day.id)).toEqual([done.id]);
    expect(listed.unreadable).toBe(0);
  });

  test("damaged declaration or not, a damaged FACT still fails closed", async () => {
    const { done } = await storedWith({ version: "", declaredAt: "yesterday", declaredBy: "" }, { nightOut: "yes" });
    expect(await readCompletedShift(done.id)).toBeNull();
    await clearOpenShift();
    recordFile(done.id).delete();
    const withValid = await finished(NORTHGATE);
    const raw = JSON.parse(recordBytes(withValid.id)) as Record<string, unknown>;
    recordFile(withValid.id).write(JSON.stringify({ ...raw, endedAt: "not a time" }));
    expect(await readCompletedShift(withValid.id)).toBeNull();
  });

  test("a Personal day with a damaged declaration needs none", async () => {
    const done = await finished(PERSONAL);
    const raw = JSON.parse(recordBytes(done.id)) as Record<string, unknown>;
    recordFile(done.id).write(JSON.stringify({ ...raw, declaration: { version: "" } }));

    const read = await readCompletedShift(done.id);
    expect(read === null ? null : declarationState(read)).toBe("not-required");
  });

  test.each([["none recorded", undefined], ["damaged", { version: "", declaredAt: "yesterday", declaredBy: "" }]] as const)(
    "%s: Review and Confirm records a VALID declaration of the current version — and changes no fact, no use, no correction",
    async (_why, declaration) => {
      const { done } = await storedWith(declaration);
      const before = await readCompletedShift(done.id);
      if (before === null) throw new Error("expected the day");

      const confirmed = await correctDeclared({
        shiftId: done.id, basedOn: null, correctionId: "r1", workingFor: NORTHGATE, startedAt: at(5), endedAt: at(17),
        nightOut: false, notes: "", correctedAt: at(18), correctedBy: DECLARED_BY,
      });

      if (confirmed === null) throw new Error("expected the declaration");
      expect(declarationState(confirmed)).toBe("confirmed");
      expect(confirmed.declaration).toMatchObject({ version: timesheetVersion(before), declaredBy: DECLARED_BY });
      expect(confirmed.corrections).toBeUndefined();
      const { declaration: _new, ...rest } = confirmed;
      expect(rest).toEqual(before);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Legacy towing gaps: kept readable; only NEW gaps are refused
// ═══════════════════════════════════════════════════════════════════════════

describe("a day that already holds a trailer without a towing vehicle", () => {
  /** TR23 06:00–10:00 towed only 06:00–07:00 (AB12 05:00–07:00, XY34 from 08:00); RF77 in use from 11:00. */
  function storeGapDay(): string {
    const document = {
      id: "11111111-2222-4333-8444-555555555555", workingFor: PERSONAL, startedAt: iso(5),
      vehicle: { ...RIGID, useId: "v-xy34", startedAt: iso(8), checks: [], fills: [] },
      previousVehicles: [{ ...UNIT, useId: "v-ab12", startedAt: iso(5), checks: [], fills: [], endMileage: 100_100, endedAt: iso(7) }],
      trailer: { ...RF77, useId: "t-rf77", startedAt: iso(11), checks: [], reeferDiesel: [] },
      previousTrailers: [{ ...TR23, useId: "t-tr23", startedAt: iso(6), checks: [], reeferDiesel: [], endedAt: iso(10) }],
      status: "open", createdAt: iso(5),
    };
    openFile().create({ overwrite: true });
    openFile().write(JSON.stringify(document));
    return openBytes();
  }

  test("stays readable, exactly as stored — the stronger rule does not reach back", async () => {
    const bytes = storeGapDay();

    const day = await readOpenShift();

    expect(day?.previousTrailers[0]).toMatchObject({ useId: "t-tr23", startedAt: iso(6), endedAt: iso(10) });
    expect(openBytes()).toBe(bytes);
  });

  test("a correction that leaves the OLD gap as it was is allowed", async () => {
    storeGapDay();

    await correctVehicleUseTimes({ shiftId: "11111111-2222-4333-8444-555555555555", useId: "v-xy34", usageState: USAGE_STATE.inUse, startedAt: at(8, 10), endedAt: null });

    expect((await open()).vehicle?.startedAt).toBe(iso(8, 10));
  });

  test("a correction that would make a NEW gap is refused, writing nothing", async () => {
    const bytes = storeGapDay();

    await expect(correctVehicleUseTimes({ shiftId: "11111111-2222-4333-8444-555555555555", useId: "v-xy34", usageState: USAGE_STATE.inUse, startedAt: at(11, 30), endedAt: null }))
      .rejects.toMatchObject({ problem: { kind: "trailer-untowed", name: "trailer RF77" } });
    expect(openBytes()).toBe(bytes);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Use times are not judged against the device clock (D42)
// ═══════════════════════════════════════════════════════════════════════════

test("a use's time ahead of the device clock is not refused for that alone", async () => {
  const now = new Date();
  const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: now, vehicle: VAN });
  const id = (await open()).vehicle?.useId ?? "";
  const ahead = new Date(now.getTime() + 2 * 3_600_000);

  await correctVehicleUseTimes({ shiftId: shift.id, useId: id, usageState: USAGE_STATE.inUse, startedAt: ahead, endedAt: null });

  expect((await open()).vehicle?.startedAt).toBe(ahead.toISOString());
});
