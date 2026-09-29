/**
 * Finish Shift — the store (2026-09-28).
 *
 * Finishing turns the open day into a COMPLETED local record, in one queued
 * operation, and nothing before that: the flow's screens only read. The
 * record is the driver's; nothing is sent (D28).
 *
 *   BUILD      `completedFrom` — the one function that turns an open day and
 *              the driver's finish into the record, used for the Review and
 *              by the store alike
 *   FINISH     `finishOpenShift` — exact shift, exact current vehicle and
 *              trailer, serialised, idempotent, fail-closed
 *   RECOVER    `readCompletedShift` / `readOpenShift` after a restart
 */
import { File, Paths } from "expo-file-system";
import { checklistFor, checklistItems, trailerChecklistFor } from "../shift/checklists";
import {
  COMPLETED_SHIFT_FILE_PREFIX,
  FinishTooEarlyError,
  OPEN_SHIFT_FILE,
  OPEN_SHIFT_TEMP_FILE,
  SHIFT_NOTES_MAX_LENGTH,
  SafeSaveFailedError,
  USAGE_STATE,
  addTrailerToOpenShift,
  addVehicleToOpenShift,
  changeTrailer,
  changeVehicle,
  clearOpenShift,
  completeTrailerCheck,
  completeVehicleCheck,
  completedFrom,
  earliestFinish,
  endVehicleUse,
  finishOpenShift,
  readCompletedShift,
  readOpenShift,
  recordReeferDiesel,
  recordVehicleFill,
  reviseTrailerCheck,
  reviseVehicleCheck,
  saveTrailerCheckDraft,
  saveVehicleCheckDraft,
  startLocalShift,
  type FinishShiftInput,
  type VehicleClass,
  type VehicleDetails,
} from "../shift/localShift";
import { TRAILER_TYPE, type TrailerDetails } from "../shift/trailer";
import { FILL_TYPE } from "../shift/vehicleFill";
import { CHECK_RESULT, effectiveItems, type CheckAnswer } from "../shift/vehicleCheck";
import { ANY_USE_ID, trailerUseAt, vehicleUseAt } from "./useIdAt";
import { declaredFinish, finishDeclared } from "./declared";

const STARTED_AT = new Date(2026, 8, 19, 5, 0);
const at = (hours: number, minutes = 0) => new Date(2026, 8, 19, hours, minutes);
const DRIVER = "user_finish_1";
const vehicleOf = (vehicleClass: VehicleClass, numberPlate = "AB12 CDE", startMileage = 100_000): VehicleDetails =>
  ({ vehicleClass, numberPlate, startMileage });
const UNIT = vehicleOf("class1");
const OTHER = vehicleOf("class1", "XY34 ZZZ", 220_000);
const TR23: TrailerDetails = { trailerNumber: "TR23", trailerType: TRAILER_TYPE.standard };
const FRIDGE: TrailerDetails = { trailerNumber: "RF77", trailerType: TRAILER_TYPE.refrigerated };

const live = () => new File(Paths.document, OPEN_SHIFT_FILE);
const completedFile = (id: string) => new File(Paths.document, `${COMPLETED_SHIFT_FILE_PREFIX}${id}.json`);
const dayWith = (vehicle: VehicleDetails | null = UNIT) =>
  startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle });

/** The finish the flow would send for the day as it now stands. */
async function finishOf(overrides: Partial<FinishShiftInput> = {}): Promise<Parameters<typeof finishDeclared>[0]> {
  const open = await readOpenShift();
  if (open === null) throw new Error("expected an open day");
  return {
    shiftId: open.id,
    vehicleUseId: open.vehicle?.useId ?? null,
    trailerUseId: open.trailer?.useId ?? null,
    finalMileage: open.vehicle === null ? null : open.vehicle.startMileage + 150,
    endedAt: at(17),
    nightOut: false,
    notes: "",
    ...overrides,
  };
}

const answersFor = (keys: readonly { key: string; defaultResult: CheckAnswer["result"] }[], defect?: string): CheckAnswer[] =>
  keys.map(entry => (entry.key === defect
    ? { key: entry.key, result: CHECK_RESULT.defect, note: "Cut in the sidewall" }
    : { key: entry.key, result: entry.defaultResult, note: "" }));

beforeEach(async () => {
  await clearOpenShift();
  for (const entry of new (jest.requireActual<typeof import("expo-file-system")>("expo-file-system").Directory)(Paths.document).list()) {
    if (entry instanceof File && entry.uri.includes(COMPLETED_SHIFT_FILE_PREFIX)) entry.delete();
  }
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

/** The device's clock reads `when` — the clock only; timers and promises run as usual. */
function clockAt(when: Date): void {
  jest.useFakeTimers({
    now: when,
    doNotFake: [
      "hrtime", "nextTick", "performance", "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
      "requestIdleCallback", "cancelIdleCallback", "setImmediate", "clearImmediate", "setInterval",
      "clearInterval", "setTimeout", "clearTimeout",
    ],
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Finishing with each kind of current vehicle, and with none
// ═══════════════════════════════════════════════════════════════════════════

test.each(["class1", "class2", "van"] as const)("finishing with a current %s ends its use at the finish, with the final mileage", async vehicleClass => {
  const shift = await dayWith(vehicleOf(vehicleClass));

  const done = await finishDeclared(await finishOf({ finalMileage: 100_240, endedAt: at(16, 30) }));

  expect(done).toMatchObject({
    id: shift.id, status: "completed", startedAt: STARTED_AT.toISOString(), endedAt: at(16, 30).toISOString(),
    previousVehicles: [{ vehicleClass, numberPlate: "AB12 CDE", startMileage: 100_000, endMileage: 100_240, startedAt: STARTED_AT.toISOString(), endedAt: at(16, 30).toISOString(), endedBy: "finish" }],
    previousTrailers: [],
  });
  expect(done).not.toHaveProperty("vehicle");
  expect(done).not.toHaveProperty("trailer");
});

test("a day that NEVER had a vehicle finishes with no vehicle, no mileage and no invented use", async () => {
  await dayWith(null);

  const done = await finishDeclared(await finishOf());

  expect(done?.previousVehicles).toEqual([]);
  expect(done?.previousTrailers).toEqual([]);
});

test("a day that handed its vehicles back (No vehicle) finishes with exactly the uses it had — none invented, none changed", async () => {
  const shift = await dayWith();
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_100, next: OTHER, changedAt: at(9) });
  await endVehicleUse({ shiftId: shift.id, endingUseId: vehicleUseAt(at(9).toISOString()), endMileage: 220_080, endedAt: at(12) });
  const before = (await readOpenShift())?.previousVehicles;

  const done = await finishDeclared(await finishOf({ endedAt: at(15) }));

  expect(done?.previousVehicles).toEqual(before);
});

test("a final mileage with NO current vehicle is refused — there is nothing for it to belong to", async () => {
  await dayWith(null);

  await expect(finishDeclared(await finishOf({ finalMileage: 100 }))).rejects.toThrow(Error);
  expect(await readOpenShift()).not.toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// Trailers end with the shift
// ═══════════════════════════════════════════════════════════════════════════

test("a CURRENT trailer ends at the finish with the shift — no No trailer first, no mileage invented", async () => {
  const shift = await dayWith();
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(6) });

  const done = await finishDeclared(await finishOf({ endedAt: at(17) }));

  expect(done?.previousTrailers).toEqual([{ ...TR23, useId: ANY_USE_ID, startedAt: at(6).toISOString(), endedAt: at(17).toISOString(), endedBy: "finish", reeferDiesel: [], checks: [] }]);
  expect(JSON.stringify(done?.previousTrailers)).not.toMatch(/ileage/);
});

test("no current trailer: the day's trailers are exactly the ones already ended", async () => {
  const shift = await dayWith();
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(6) });
  await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(at(6).toISOString()), next: null, changedAt: at(8) });
  const before = (await readOpenShift())?.previousTrailers;

  const done = await finishDeclared(await finishOf());

  expect(done?.previousTrailers).toEqual(before);
});

test("a refrigerated trailer keeps its Fridge Diesel exactly", async () => {
  const shift = await dayWith();
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: FRIDGE, startedAt: at(6) });
  await recordReeferDiesel({ shiftId: shift.id, trailerUseId: trailerUseAt(at(6).toISOString()), usageState: USAGE_STATE.inUse, fillId: "rd1", recordedAt: at(7), litres: 40, note: "" });
  await recordReeferDiesel({ shiftId: shift.id, trailerUseId: trailerUseAt(at(6).toISOString()), usageState: USAGE_STATE.inUse, fillId: "rd2", recordedAt: at(11), litres: null, note: "Gauge broken" });
  const diesel = (await readOpenShift())?.trailer?.reeferDiesel;

  const done = await finishDeclared(await finishOf());

  expect(done?.previousTrailers[0]?.reeferDiesel).toEqual(diesel);
  expect(diesel).toHaveLength(2);
});

// ═══════════════════════════════════════════════════════════════════════════
// Validation: mileage and chronology — refused, never clamped
// ═══════════════════════════════════════════════════════════════════════════

test("a final mileage BELOW the start is refused, and the day is untouched", async () => {
  await dayWith();
  const before = live().textSync();

  await expect(finishDeclared(await finishOf({ finalMileage: 99_999 }))).rejects.toThrow(Error);

  expect(live().textSync()).toBe(before);
});

test("completedFrom itself refuses a final mileage below the start — the Review never previews an impossible day", async () => {
  const open = await dayWith();

  expect(() => completedFrom(open, { finalMileage: 99_999, endedAt: at(17), nightOut: false, notes: "" })).toThrow("Refusing an invalid final mileage");
});

test("a final mileage EQUAL to the start is a real finish", async () => {
  await dayWith();

  const done = await finishDeclared(await finishOf({ finalMileage: 100_000 }));

  expect(done?.previousVehicles[0]?.endMileage).toBe(100_000);
});

test.each([["missing", null], ["fractional", 100_100.5], ["negative", -1]] as const)("a %s final mileage for the current vehicle is refused", async (_why, finalMileage) => {
  await dayWith();

  await expect(finishDeclared(await finishOf({ finalMileage }))).rejects.toThrow(Error);
  expect(await readOpenShift()).not.toBeNull();
});

test("a finish BEFORE the shift started is refused with FinishTooEarlyError — never clamped", async () => {
  await dayWith(null);
  const before = live().textSync();

  await expect(finishDeclared(await finishOf({ endedAt: at(4, 59) }))).rejects.toThrow(FinishTooEarlyError);

  expect(live().textSync()).toBe(before);
});

test("a finish before the CURRENT VEHICLE started is refused", async () => {
  const shift = await dayWith();
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_100, next: OTHER, changedAt: at(9) });

  await expect(finishDeclared(await finishOf({ endedAt: at(8, 59) }))).rejects.toThrow(FinishTooEarlyError);
});

test("a finish before the CURRENT TRAILER started is refused", async () => {
  const shift = await dayWith();
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(10) });

  await expect(finishDeclared(await finishOf({ endedAt: at(9, 59) }))).rejects.toThrow(FinishTooEarlyError);
});

test("a finish before an EARLIER use was handed back is refused — the shift cannot end before its own history", async () => {
  const shift = await dayWith();
  await endVehicleUse({ shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_100, endedAt: at(14) });

  await expect(finishDeclared(await finishOf({ endedAt: at(13) }))).rejects.toThrow(FinishTooEarlyError);
});

test("a finish AT the latest start is allowed", async () => {
  const shift = await dayWith();
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(10) });

  const done = await finishDeclared(await finishOf({ endedAt: at(10) }));

  expect(done?.previousTrailers[0]?.endedAt).toBe(at(10).toISOString());
});

test("earliestFinish names what the finish cannot precede — the latest of the day's starts and ends", async () => {
  const shift = await dayWith();
  expect(earliestFinish(shift)).toEqual({ at: STARTED_AT.toISOString(), because: { kind: "vehicle", numberPlate: "AB12 CDE" } });
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(6) });
  const withTrailer = await readOpenShift();
  expect(withTrailer && earliestFinish(withTrailer)).toEqual({ at: at(6).toISOString(), because: { kind: "trailer", trailerNumber: "TR23" } });

  await clearOpenShift();
  const bare = await dayWith(null);
  expect(earliestFinish(bare)).toEqual({ at: STARTED_AT.toISOString(), because: { kind: "shift" } });
});

// ═══════════════════════════════════════════════════════════════════════════
// Checks, corrections, fills and history — carried exactly
// ═══════════════════════════════════════════════════════════════════════════

test("an INCOMPLETE vehicle check does not block finishing — and is not marked completed", async () => {
  const shift = await dayWith();
  await saveVehicleCheckDraft({ shiftId: shift.id, vehicleUseId: vehicleUseAt(STARTED_AT.toISOString()), usageState: USAGE_STATE.inUse, checkId: "c1", startedAt: at(5, 5), answers: [{ key: "horn", result: CHECK_RESULT.notApplicable, note: "" }] });

  const done = await finishDeclared(await finishOf());

  expect(done?.previousVehicles[0]?.checks).toEqual([expect.objectContaining({ id: "c1", status: "draft", completedAt: null })]);
});

test("an INCOMPLETE trailer check does not block finishing — and is not marked completed", async () => {
  const shift = await dayWith();
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(6) });
  const [first] = checklistItems(trailerChecklistFor(TRAILER_TYPE.standard));
  await saveTrailerCheckDraft({ shiftId: shift.id, trailerUseId: trailerUseAt(at(6).toISOString()), usageState: USAGE_STATE.inUse, checkId: "t1", startedAt: at(6, 5), answers: first ? [{ key: first.key, result: CHECK_RESULT.notApplicable, note: "" }] : [] });

  const done = await finishDeclared(await finishOf());

  expect(done?.previousTrailers[0]?.checks).toEqual([expect.objectContaining({ id: "t1", status: "draft", completedAt: null })]);
});

test("completed checks, their defects and their corrections are carried byte-for-byte; fuel and AdBlue too", async () => {
  const shift = await dayWith();
  const use = { shiftId: shift.id, vehicleUseId: vehicleUseAt(STARTED_AT.toISOString()), usageState: USAGE_STATE.inUse };
  const items = checklistItems(checklistFor("class1"));
  const tyre = items.find(entry => entry.key.includes("tyre"))?.key ?? items[0]?.key;
  await completeVehicleCheck({ ...use, checkId: "morning", startedAt: at(5, 5), answers: answersFor(items, tyre), completedAt: at(5, 20), completedBy: DRIVER });
  await reviseVehicleCheck({ shiftId: shift.id, useId: vehicleUseAt(STARTED_AT.toISOString()), usageState: USAGE_STATE.inUse, checkId: "morning", revisionId: "r1", answers: answersFor(items), revisedAt: at(6), revisedBy: DRIVER });
  await recordVehicleFill({ ...use, fillId: "f1", type: FILL_TYPE.fuel, recordedAt: at(7), litres: 300, note: "" });
  await recordVehicleFill({ ...use, fillId: "f2", type: FILL_TYPE.adblue, recordedAt: at(8), litres: null, note: "" });
  const current = (await readOpenShift())?.vehicle;

  const done = await finishDeclared(await finishOf());

  expect(done?.previousVehicles[0]?.checks).toEqual(current?.checks);
  expect(done?.previousVehicles[0]?.fills).toEqual(current?.fills);
  expect(current?.checks[0]?.revisions).toHaveLength(1);
  expect(current?.fills).toHaveLength(2);
});

test("a trailer's completed check and its defects are carried exactly", async () => {
  const shift = await dayWith();
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(6) });
  const items = checklistItems(trailerChecklistFor(TRAILER_TYPE.standard));
  await completeTrailerCheck({ shiftId: shift.id, trailerUseId: trailerUseAt(at(6).toISOString()), usageState: USAGE_STATE.inUse, checkId: "tc", startedAt: at(6, 5), answers: answersFor(items, items[0]?.key), completedAt: at(6, 20), completedBy: DRIVER });
  const checks = (await readOpenShift())?.trailer?.checks;

  const done = await finishDeclared(await finishOf());

  expect(done?.previousTrailers[0]?.checks).toEqual(checks);
});

test("earlier ended uses are untouched, and a plate or trailer used twice stays two separate uses", async () => {
  const shift = await dayWith();
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_100, next: OTHER, changedAt: at(9) });
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(at(9).toISOString()), endMileage: 220_050, next: { ...UNIT, startMileage: 100_100 }, changedAt: at(11) });
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(11, 30) });
  await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(at(11, 30).toISOString()), next: { trailerNumber: "GFD", trailerType: TRAILER_TYPE.standard }, changedAt: at(12) });
  await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(at(12).toISOString()), next: TR23, changedAt: at(13) });
  const before = await readOpenShift();

  const done = await finishDeclared(await finishOf({ finalMileage: 100_300 }));

  expect(done?.previousVehicles.slice(0, 2)).toEqual(before?.previousVehicles);
  expect(done?.previousVehicles.map(use => use.numberPlate)).toEqual(["AB12 CDE", "XY34 ZZZ", "AB12 CDE"]);
  expect(done?.previousTrailers.slice(0, 2)).toEqual(before?.previousTrailers);
  expect(done?.previousTrailers.map(use => use.trailerNumber)).toEqual(["TR23", "GFD", "TR23"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Night Out and notes
// ═══════════════════════════════════════════════════════════════════════════

test.each([true, false])("Night Out %s is recorded as the driver said", async nightOut => {
  await dayWith();

  const done = await finishDeclared(await finishOf({ nightOut }));

  expect(done?.nightOut).toBe(nightOut);
});

test("notes are trimmed; empty notes are stored as null, never as an empty string", async () => {
  await dayWith();
  expect((await finishDeclared(await finishOf({ notes: "   " })))?.notes).toBeNull();

  await clearOpenShift();
  await dayWith();
  expect((await finishDeclared(await finishOf({ notes: "  Tipped at Tilbury, waited 2h  " })))?.notes).toBe("Tipped at Tilbury, waited 2h");
});

test("over-long notes are refused, never cut", async () => {
  await dayWith();

  await expect(finishDeclared(await finishOf({ notes: "x".repeat(SHIFT_NOTES_MAX_LENGTH + 1) }))).rejects.toThrow(Error);
  expect(await readOpenShift()).not.toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// The Review's preview writes nothing
// ═══════════════════════════════════════════════════════════════════════════

test("completedFrom is a pure preview: it builds the record the store will save, and touches nothing", async () => {
  const shift = await dayWith();
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(6) });
  const open = await readOpenShift();
  if (open === null) throw new Error("expected an open day");
  const before = live().textSync();
  const finish = { finalMileage: 100_150, endedAt: at(17), nightOut: true, notes: "ok" };

  const preview = completedFrom(open, finish);

  expect(live().textSync()).toBe(before);
  expect(completedFile(shift.id).exists).toBe(false);
  expect(await finishDeclared(await finishOf(finish))).toEqual(preview);
});

// ═══════════════════════════════════════════════════════════════════════════
// Exact shift, once — serialised, idempotent, fail-closed
// ═══════════════════════════════════════════════════════════════════════════

test("a DOUBLE confirmation finishes once: both presses see the same completed record", async () => {
  await dayWith();
  const finish = await finishOf();

  const [first, second] = await Promise.all([finishDeclared(finish), finishDeclared(finish)]);

  expect(first).not.toBeNull();
  expect(second).toEqual(first);
  expect(await readOpenShift()).toBeNull();
});

test("a stale Finish for a day that is no longer open finishes NOTHING — not the new day", async () => {
  await dayWith();
  const stale = await finishOf();
  await clearOpenShift();
  const next = await dayWith(OTHER);

  expect(await finishDeclared(stale)).toBeNull();

  expect((await readOpenShift())?.id).toBe(next.id);
  expect(completedFile(next.id).exists).toBe(false);
});

test("a stale Finish whose current VEHICLE changed since it opened finishes nothing — its mileage belongs to another vehicle", async () => {
  const shift = await dayWith();
  const stale = await finishOf();
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_100, next: OTHER, changedAt: at(9) });
  const before = live().textSync();

  expect(await finishDeclared(stale)).toBeNull();

  expect(live().textSync()).toBe(before);
});

test("a stale Finish whose current TRAILER changed since it opened finishes nothing", async () => {
  const shift = await dayWith();
  const stale = await finishOf();
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(9) });

  expect(await finishDeclared(stale)).toBeNull();
  expect((await readOpenShift())?.trailer?.trailerNumber).toBe("TR23");
});

test("a write queued behind the finish cannot touch the finished day", async () => {
  const shift = await dayWith();

  // Declared before the race: the finish is queued first, as the press would queue it.
  const finish = await declaredFinish(await finishOf());
  const [done, late] = await Promise.all([
    finishOpenShift(finish),
    addVehicleToOpenShift({ vehicle: OTHER, startedAt: at(18) }),
    recordVehicleFill({ shiftId: shift.id, vehicleUseId: vehicleUseAt(STARTED_AT.toISOString()), usageState: USAGE_STATE.inUse, fillId: "late", type: FILL_TYPE.fuel, recordedAt: at(16), litres: 5, note: "" }),
  ]);

  expect(done).not.toBeNull();
  expect(late).toBeNull();
  expect(await readCompletedShift(shift.id)).toEqual(done);
});

// ═══════════════════════════════════════════════════════════════════════════
// Persistence: never reported as done until it is saved
// ═══════════════════════════════════════════════════════════════════════════

test("a FAILED save of the completed record is a SafeSaveFailedError: the open day stays, nothing is filed", async () => {
  const shift = await dayWith();
  const before = live().textSync();
  jest.spyOn(File.prototype, "write").mockImplementation(() => { throw new Error("disk full"); });

  await expect(finishDeclared(await finishOf())).rejects.toThrow(SafeSaveFailedError);

  jest.restoreAllMocks();
  expect(live().textSync()).toBe(before);
  expect(completedFile(shift.id).exists).toBe(false);
  expect(new File(Paths.document, OPEN_SHIFT_TEMP_FILE).exists).toBe(false);
});

test("a completed record that cannot be moved into place is a failure too, and the open day still reads", async () => {
  const shift = await dayWith();
  jest.spyOn(File.prototype, "moveSync").mockImplementation(() => { throw new Error("rename failed"); });

  await expect(finishDeclared(await finishOf())).rejects.toThrow(SafeSaveFailedError);

  jest.restoreAllMocks();
  expect(completedFile(shift.id).exists).toBe(false);
  expect((await readOpenShift())?.id).toBe(shift.id);
});

test("once the record is filed, a failure to remove the open file is NOT a failure: the day reads as finished", async () => {
  const shift = await dayWith();
  jest.spyOn(File.prototype, "delete").mockImplementation(() => { throw new Error("busy"); });

  const done = await finishDeclared(await finishOf());

  jest.restoreAllMocks();
  expect(done?.id).toBe(shift.id);
  expect(live().exists).toBe(true);
  expect(await readOpenShift()).toBeNull();
  expect(await readCompletedShift(shift.id)).toEqual(done);
});

test("the next Start Shift clears a finished day's leftover open file — it is not kept as 'unreadable', and a new day starts", async () => {
  const shift = await dayWith();
  jest.spyOn(File.prototype, "delete").mockImplementation(() => { throw new Error("busy"); });
  await finishDeclared(await finishOf());
  jest.restoreAllMocks();

  const next = await dayWith(OTHER);

  expect(next.id).not.toBe(shift.id);
  expect((await readOpenShift())?.id).toBe(next.id);
  const names = new (jest.requireActual<typeof import("expo-file-system")>("expo-file-system").Directory)(Paths.document).list().map(entry => entry.uri);
  expect(names.some(uri => uri.includes("recovery-unreadable"))).toBe(false);
  expect(await readCompletedShift(shift.id)).not.toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// Restart
// ═══════════════════════════════════════════════════════════════════════════

test("after a finish, a restart finds NO open shift and loads the completed record exactly as returned", async () => {
  const shift = await dayWith();
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: FRIDGE, startedAt: at(6) });

  const done = await finishDeclared(await finishOf({ nightOut: true, notes: "Parked at Dover" }));

  expect(live().exists).toBe(false);
  expect(await readOpenShift()).toBeNull();
  expect(await readCompletedShift(shift.id)).toEqual(done);
  expect(done).toMatchObject({ nightOut: true, notes: "Parked at Dover", workingFor: { kind: "personal" } });
});

test("a completed record that is not what this app writes reads as none — fail closed", async () => {
  const shift = await dayWith();
  const done = await finishDeclared(await finishOf());
  const file = completedFile(shift.id);
  const record = JSON.parse(file.textSync()) as Record<string, unknown>;

  for (const broken of [
    { ...record, endedAt: at(4).toISOString() },
    { ...record, nightOut: "yes" },
    { ...record, notes: "" },
    { ...record, status: "open" },
    { ...record, previousVehicles: undefined },
  ]) {
    file.write(JSON.stringify(broken));
    expect(await readCompletedShift(shift.id)).toBeNull();
  }
  file.write(JSON.stringify(done));
  expect(await readCompletedShift(shift.id)).toEqual(done);
});

test("readCompletedShift for a day that never finished is null", async () => {
  const shift = await dayWith();

  expect(await readCompletedShift(shift.id)).toBeNull();
  expect(await readCompletedShift("../escape")).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// The finish DATE and time, and never later than now (owner corrections)
// ═══════════════════════════════════════════════════════════════════════════

const onDay = (day: number, hours: number, minutes = 0) => new Date(2026, 8, day, hours, minutes);

test("a same-day finish is exactly the date and time given", async () => {
  clockAt(onDay(19, 17, 30));
  await dayWith();

  const done = await finishDeclared(await finishOf({ endedAt: onDay(19, 17, 0) }));

  expect(done?.endedAt).toBe(onDay(19, 17, 0).toISOString());
});

test("a shift CROSSING MIDNIGHT finishes on the next day it was given", async () => {
  clockAt(onDay(20, 6, 30));
  await startLocalShift({ workingFor: { kind: "personal" }, startedAt: onDay(19, 22, 0), vehicle: null });

  const done = await finishDeclared(await finishOf({ endedAt: onDay(20, 6, 0) }));

  expect(done).toMatchObject({ startedAt: onDay(19, 22, 0).toISOString(), endedAt: onDay(20, 6, 0).toISOString() });
});

test("an explicit PREVIOUS-DAY finish, confirmed after midnight, is kept on the day given — never moved to today", async () => {
  clockAt(onDay(20, 0, 10));
  await dayWith();

  const done = await finishDeclared(await finishOf({ endedAt: onDay(19, 23, 50) }));

  expect(done?.endedAt).toBe(onDay(19, 23, 50).toISOString());
});

test("a MULTI-DAY shift finishes days after it began, with every use it had", async () => {
  clockAt(onDay(21, 18, 5));
  const shift = await startLocalShift({ workingFor: { kind: "personal" }, startedAt: onDay(19, 6, 0), vehicle: UNIT });
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(onDay(19, 6, 0).toISOString()), endMileage: 100_300, next: OTHER, changedAt: onDay(20, 7, 0) });

  const done = await finishDeclared(await finishOf({ endedAt: onDay(21, 18, 0), finalMileage: 220_400 }));

  expect(done?.endedAt).toBe(onDay(21, 18, 0).toISOString());
  expect(done?.previousVehicles.map(use => [use.startedAt, use.endedAt])).toEqual([
    [onDay(19, 6, 0).toISOString(), onDay(20, 7, 0).toISOString()],
    [onDay(20, 7, 0).toISOString(), onDay(21, 18, 0).toISOString()],
  ]);
});

test.each([
  ["exactly now", onDay(19, 17, 0)],
  ["a minute ahead", onDay(19, 17, 1)],
  ["an hour ahead — a declared finish (a guaranteed day)", onDay(19, 18, 0)],
  ["a future DATE", onDay(20, 16, 0)],
])("a finish %s is saved exactly as declared — the store never compares it with the clock (D40)", async (_what, endedAt) => {
  clockAt(onDay(19, 17, 0));
  await dayWith();

  const done = await finishDeclared(await finishOf({ endedAt }));

  expect(done?.endedAt).toBe(endedAt.toISOString());
  expect(done?.previousVehicles[0]?.endedAt).toBe(endedAt.toISOString());
});

test("a future finish still keeps the day's chronology — never before a start", async () => {
  clockAt(onDay(19, 17, 0));
  const shift = await dayWith();
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: onDay(19, 10, 0) });

  await expect(finishDeclared(await finishOf({ endedAt: onDay(19, 9, 59) }))).rejects.toThrow(FinishTooEarlyError);
  await expect(finishDeclared(await finishOf({ endedAt: onDay(19, 4, 0) }))).rejects.toThrow(FinishTooEarlyError);
  expect((await finishDeclared(await finishOf({ endedAt: onDay(19, 10, 0) })))?.endedAt).toBe(onDay(19, 10, 0).toISOString());
});

// ═══════════════════════════════════════════════════════════════════════════
// A finished day keeps what later check work needs (owner correction 3)
//
// Nothing here completes or corrects a check on a finished day — that is a
// later History increment. These prove the finished record has not flattened
// or lost what it will need: each use's exact identity, and every check as
// stored — drafts, certified originals and their revisions.
// ═══════════════════════════════════════════════════════════════════════════

test("every use keeps its exact identity: addressable by its start, never by plate or number, and never merged", async () => {
  const shift = await dayWith();
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_100, next: OTHER, changedAt: at(9) });
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(at(9).toISOString()), endMileage: 220_050, next: { ...UNIT, startMileage: 100_100 }, changedAt: at(11) });
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(11, 30) });
  await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(at(11, 30).toISOString()), next: TR23, changedAt: at(13) });
  await finishDeclared(await finishOf({ finalMileage: 100_200 }));

  const day = await readCompletedShift(shift.id);

  const vehicleStarts = day?.previousVehicles.map(use => use.startedAt) ?? [];
  expect(vehicleStarts).toEqual([STARTED_AT.toISOString(), at(9).toISOString(), at(11).toISOString()]);
  expect(new Set(vehicleStarts).size).toBe(3);
  // The same plate twice is two uses, each found by its own start.
  const unitUses = day?.previousVehicles.filter(use => use.numberPlate === "AB12 CDE") ?? [];
  expect(unitUses.map(use => [use.startMileage, use.endMileage])).toEqual([[100_000, 100_100], [100_100, 100_200]]);
  expect(day?.previousVehicles.filter(use => use.startedAt === at(11).toISOString())).toHaveLength(1);
  const trailerStarts = day?.previousTrailers.map(use => use.startedAt) ?? [];
  expect(trailerStarts).toEqual([at(11, 30).toISOString(), at(13).toISOString()]);
  expect(day?.previousTrailers.every(use => use.trailerNumber === "TR23")).toBe(true);
  // Class and type survive with each use: the checklist a later check needs.
  expect(day?.previousVehicles.map(use => use.vehicleClass)).toEqual(["class1", "class1", "class1"]);
  expect(day?.previousTrailers.map(use => use.trailerType)).toEqual([TRAILER_TYPE.standard, TRAILER_TYPE.standard]);
});

test("an INCOMPLETE vehicle check and an INCOMPLETE trailer check survive the finish and a restart as the drafts they were", async () => {
  const shift = await dayWith();
  await saveVehicleCheckDraft({ shiftId: shift.id, vehicleUseId: vehicleUseAt(STARTED_AT.toISOString()), usageState: USAGE_STATE.inUse, checkId: "vd", startedAt: at(5, 5), answers: [{ key: "horn", result: CHECK_RESULT.defect, note: "Weak" }] });
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: FRIDGE, startedAt: at(6) });
  const [first] = checklistItems(trailerChecklistFor(TRAILER_TYPE.refrigerated));
  await saveTrailerCheckDraft({ shiftId: shift.id, trailerUseId: trailerUseAt(at(6).toISOString()), usageState: USAGE_STATE.inUse, checkId: "td", startedAt: at(6, 5), answers: first ? [{ key: first.key, result: CHECK_RESULT.notApplicable, note: "" }] : [] });
  const open = await readOpenShift();
  await finishDeclared(await finishOf());

  const day = await readCompletedShift(shift.id);

  expect(day?.previousVehicles[0]?.checks).toEqual(open?.vehicle?.checks);
  expect(day?.previousTrailers[0]?.checks).toEqual(open?.trailer?.checks);
  expect(day?.previousVehicles[0]?.checks[0]).toMatchObject({ id: "vd", status: "draft", completedAt: null, checklist: "hgv-unit", checklistVersion: 1 });
  expect(day?.previousTrailers[0]?.checks[0]).toMatchObject({ id: "td", status: "draft", completedAt: null, checklist: "trailer-refrigerated" });
});

test("a use with NO check at all stays with none — ready to be checked later, with nothing invented", async () => {
  const shift = await dayWith();
  await endVehicleUse({ shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_100, endedAt: at(9) });
  await finishDeclared(await finishOf());

  const day = await readCompletedShift(shift.id);

  expect(day?.previousVehicles[0]?.checks).toEqual([]);
});

test("completed vehicle and trailer checks keep the certified original, who and when, and EVERY revision in order", async () => {
  const shift = await dayWith();
  const vehicleItems = checklistItems(checklistFor("class1"));
  const vehicleUse = { shiftId: shift.id, vehicleUseId: vehicleUseAt(STARTED_AT.toISOString()), usageState: USAGE_STATE.inUse };
  await completeVehicleCheck({ ...vehicleUse, checkId: "vc", startedAt: at(5, 5), answers: answersFor(vehicleItems, vehicleItems[0]?.key), completedAt: at(5, 20), completedBy: DRIVER });
  await reviseVehicleCheck({ shiftId: shift.id, useId: vehicleUseAt(STARTED_AT.toISOString()), usageState: USAGE_STATE.inUse, checkId: "vc", revisionId: "v-r1", answers: answersFor(vehicleItems), revisedAt: at(6), revisedBy: DRIVER });
  await reviseVehicleCheck({ shiftId: shift.id, useId: vehicleUseAt(STARTED_AT.toISOString()), usageState: USAGE_STATE.inUse, checkId: "vc", revisionId: "v-r2", answers: answersFor(vehicleItems, vehicleItems[1]?.key), revisedAt: at(7), revisedBy: DRIVER });
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(8) });
  const trailerItems = checklistItems(trailerChecklistFor(TRAILER_TYPE.standard));
  await completeTrailerCheck({ shiftId: shift.id, trailerUseId: trailerUseAt(at(8).toISOString()), usageState: USAGE_STATE.inUse, checkId: "tc", startedAt: at(8, 5), answers: answersFor(trailerItems, trailerItems[0]?.key), completedAt: at(8, 20), completedBy: DRIVER });
  await reviseTrailerCheck({ shiftId: shift.id, useId: trailerUseAt(at(8).toISOString()), usageState: USAGE_STATE.inUse, checkId: "tc", revisionId: "t-r1", answers: answersFor(trailerItems), revisedAt: at(9), revisedBy: DRIVER });
  const open = await readOpenShift();
  await finishDeclared(await finishOf());

  const day = await readCompletedShift(shift.id);
  const vehicleCheck = day?.previousVehicles[0]?.checks[0];
  const trailerCheck = day?.previousTrailers[0]?.checks[0];

  expect(vehicleCheck).toEqual(open?.vehicle?.checks[0]);
  expect(trailerCheck).toEqual(open?.trailer?.checks[0]);
  expect(vehicleCheck).toMatchObject({ status: "completed", completedAt: at(5, 20).toISOString(), completedBy: DRIVER });
  expect(vehicleCheck?.revisions?.map(revision => revision.id)).toEqual(["v-r1", "v-r2"]);
  expect(trailerCheck?.revisions?.map(revision => revision.id)).toEqual(["t-r1"]);
  // The original certificate is still the original: its defect is still there.
  expect(vehicleCheck?.items.some(item => item.result === CHECK_RESULT.defect)).toBe(true);
  // And what it says NOW is the latest revision, as before the finish.
  if (vehicleCheck === undefined) throw new Error("expected the check");
  expect(effectiveItems(vehicleCheck)).toEqual(vehicleCheck.revisions?.[1]?.items);
});
