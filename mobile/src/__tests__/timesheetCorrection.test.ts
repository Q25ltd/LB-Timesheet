/**
 * A finished day, corrected and deleted — the store (D39, 2026-09-28).
 *
 *   FACTS     Working For, start, finish, Night Out and notes are corrected by
 *             APPENDING a correction; the day as finished and every earlier
 *             correction stay exactly as they were
 *   USES      fills, end mileage and checks of a finished day's uses are
 *             corrected by the same operations as on an open day, by exact use
 *   DELETE    one finished day, by its id, and nothing else
 *   IN USE    the plate or trailer number typed wrong on the open day
 */
import { Directory, File, Paths } from "expo-file-system";
import { checklistFor, checklistItems, trailerChecklistFor } from "../shift/checklists";
import {
  COMPLETED_SHIFT_FILE_PREFIX,
  DeleteUncertainError,
  OPEN_SHIFT_FILE,
  RECOVERY_FILE_PREFIX,
  SafeSaveFailedError,
  TimesheetBoundsError,
  USAGE_STATE,
  addTrailerToOpenShift,
  changeTrailer,
  changeVehicle,
  clearOpenShift,
  completeTrailerCheck,
  completeVehicleCheck,
  correctEndMileage,
  correctNumberPlate,
  correctTrailerNumber,
  deleteCompletedShift,
  effectiveFacts,
  effectiveUses,
  endVehicleUse,
  listCompletedShifts,
  readCompletedShift,
  readFinishedDayOfUses,
  readOpenShift,
  recordReeferDiesel,
  recordVehicleFill,
  removeReeferDiesel,
  removeVehicleFill,
  reviseTrailerCheck,
  reviseVehicleCheck,
  saveTrailerCheckDraft,
  saveVehicleCheckDraft,
  startLocalShift,
  type CompletedShift,
  type CorrectCompletedShiftInput,
  type VehicleDetails,
  type WorkingContext,
} from "../shift/localShift";
import { TRAILER_TYPE } from "../shift/trailer";
import { CHECK_RESULT, effectiveItems, type CheckAnswer } from "../shift/vehicleCheck";
import { FILL_TYPE } from "../shift/vehicleFill";
import { trailerUseAt, vehicleUseAt } from "./useIdAt";
import { finishDeclared, correctDeclared } from "./declared";

const day = (date: number, hours: number, minutes = 0) => new Date(2026, 8, date, hours, minutes);
const at = (hours: number, minutes = 0) => day(19, hours, minutes);
const DRIVER = "user_correct_1";
const PERSONAL: WorkingContext = { kind: "personal" };
const NORTHGATE: WorkingContext = { kind: "company", membershipId: "m1", companyId: "c1", companyName: "Northgate Haulage" };
const EASTWAY: WorkingContext = { kind: "company", membershipId: "m2", companyId: "c2", companyName: "Eastway Freight" };
const UNIT: VehicleDetails = { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 };
const RIGID: VehicleDetails = { vehicleClass: "class2", numberPlate: "XY34 ZZZ", startMileage: 220_000 };
const TR23 = { trailerNumber: "TR23", trailerType: TRAILER_TYPE.standard };
const RF77 = { trailerNumber: "RF77", trailerType: TRAILER_TYPE.refrigerated };

const recordFile = (id: string) => new File(Paths.document, `${COMPLETED_SHIFT_FILE_PREFIX}${id}.json`);
const bytesOf = (id: string) => recordFile(id).textSync();
const answers = (keys: readonly { key: string; defaultResult: CheckAnswer["result"] }[], defect?: string): CheckAnswer[] =>
  keys.map(entry => (entry.key === defect
    ? { key: entry.key, result: CHECK_RESULT.defect, note: "Cut in the sidewall" }
    : { key: entry.key, result: entry.defaultResult, note: "" }));

/** A plain finished day: 05:00–17:00 on the 19th, no vehicle. */
async function plainDay(workingFor: WorkingContext = PERSONAL): Promise<CompletedShift> {
  const shift = await startLocalShift({ workingFor, startedAt: at(5), vehicle: null });
  const done = await finishDeclared({ shiftId: shift.id, vehicleUseId: null, trailerUseId: null, finalMileage: null, endedAt: at(17), nightOut: false, notes: "" });
  if (done === null) throw new Error("expected the day to finish");
  return done;
}

/**
 * A finished day with uses: AB12 CDE 05:00–09:00, XY34 ZZZ 09:00–11:00, AB12
 * CDE again 11:00–17:00; TR23 06:00–08:00, RF77 08:00–12:00, TR23 again
 * 12:00–17:00. Nothing checked.
 */
async function busyDay(): Promise<CompletedShift> {
  const shift = await startLocalShift({ workingFor: NORTHGATE, startedAt: at(5), vehicle: UNIT });
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(at(5).toISOString()), endMileage: 100_100, next: RIGID, changedAt: at(9) });
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(6) }).catch(() => null);
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(at(9).toISOString()), endMileage: 220_040, next: { ...UNIT, startMileage: 100_100 }, changedAt: at(11) });
  const open = await readOpenShift();
  if (open?.trailer === null) await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(11, 15) });
  await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt((await readOpenShift())?.trailer?.startedAt ?? ""), next: RF77, changedAt: at(12) });
  await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(at(12).toISOString()), next: TR23, changedAt: at(13) });
  const done = await finishDeclared({
    shiftId: shift.id, vehicleUseId: vehicleUseAt(at(11).toISOString()), trailerUseId: trailerUseAt(at(13).toISOString()),
    finalMileage: 100_250, endedAt: at(17), nightOut: false, notes: "",
  });
  if (done === null) throw new Error("expected the day to finish");
  return done;
}

function correction(shift: CompletedShift, overrides: Partial<CorrectCompletedShiftInput> = {}): Parameters<typeof correctDeclared>[0] {
  const facts = effectiveFacts(shift);
  return {
    shiftId: shift.id,
    basedOn: shift.corrections?.[shift.corrections.length - 1]?.id ?? null,
    correctionId: `c-${String(Math.random()).slice(2)}`,
    workingFor: facts.workingFor,
    startedAt: new Date(facts.startedAt),
    endedAt: new Date(facts.endedAt),
    nightOut: facts.nightOut,
    notes: facts.notes ?? "",
    correctedAt: new Date(),
    correctedBy: DRIVER,
    ...overrides,
  };
}

beforeEach(async () => {
  await clearOpenShift();
  for (const entry of new Directory(Paths.document).list()) {
    if (entry instanceof File) entry.delete();
  }
});
afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// Correcting the day's own facts
// ═══════════════════════════════════════════════════════════════════════════

test.each([
  ["Personal → company", PERSONAL, NORTHGATE],
  ["company → Personal", NORTHGATE, PERSONAL],
  ["company A → company B", NORTHGATE, EASTWAY],
])("Working For %s is corrected — the day as finished still says what it said", async (_what, from, to) => {
  const done = await plainDay(from);

  const corrected = await correctDeclared(correction(done, { workingFor: to }));

  expect(corrected && effectiveFacts(corrected).workingFor).toEqual(to);
  expect(corrected?.workingFor).toEqual(from);
  expect(corrected?.corrections).toHaveLength(1);
});

test("start, finish, Night Out and notes are corrected together, and recorded with who and when", async () => {
  const done = await plainDay();
  const correctedAt = new Date();

  const corrected = await correctDeclared(correction(done, {
    startedAt: at(4, 30), endedAt: at(16, 45), nightOut: true, notes: "  Parked at Dover  ", correctedAt, correctionId: "c1",
  }));

  expect(corrected?.corrections).toEqual([{
    id: "c1", correctedAt: correctedAt.toISOString(), correctedBy: DRIVER,
    workingFor: PERSONAL, startedAt: at(4, 30).toISOString(), endedAt: at(16, 45).toISOString(), nightOut: true, notes: "Parked at Dover",
  }]);
  expect(corrected).toMatchObject({ startedAt: at(5).toISOString(), endedAt: at(17).toISOString(), nightOut: false, notes: null });
});

test("notes are added, edited and removed — removed is stored as null", async () => {
  let current: CompletedShift | null = await plainDay();
  for (const [typed, stored] of [["First note", "First note"], ["Edited note", "Edited note"], ["   ", null]] as const) {
    if (current === null) throw new Error("expected the day");
    current = await correctDeclared(correction(current, { notes: typed }));
    expect(current && effectiveFacts(current).notes).toBe(stored);
  }
  expect(current?.corrections).toHaveLength(3);
});

test("a correction CROSSING MIDNIGHT: started the evening before, finished the next morning", async () => {
  const done = await plainDay();

  const corrected = await correctDeclared(correction(done, { startedAt: day(18, 22), endedAt: at(6) }));

  expect(corrected && effectiveFacts(corrected)).toMatchObject({ startedAt: day(18, 22).toISOString(), endedAt: at(6).toISOString() });
});

test("a FUTURE finish is a declared finish — saved exactly as given, never refused (D40)", async () => {
  const done = await plainDay();
  const declared = new Date(Date.now() + 3_600_000);
  declared.setSeconds(0, 0);

  const corrected = await correctDeclared(correction(done, { endedAt: declared }));

  expect(corrected && effectiveFacts(corrected).endedAt).toBe(declared.toISOString());
});

test.each([
  ["a finish before the start", { startedAt: at(12), endedAt: at(11) }, { kind: "finish-before-start" }],
  ["a start AFTER a use began", { startedAt: at(5, 30) }, { kind: "start-after-use", name: "AB12 CDE", at: at(5).toISOString() }],
  // The trailer in use at the finish moves with it — but never to before it began.
  ["a finish before a finish-ended use BEGAN", { endedAt: at(12, 30) }, { kind: "finish-before-use-start", name: "trailer TR23", at: at(13).toISOString() }],
])("%s is refused with the rule it breaks — no use is moved, nothing is written", async (_what, overrides, problem) => {
  const done = await busyDay();
  const before = bytesOf(done.id);

  const failure = correctDeclared(correction(done, overrides));

  await expect(failure).rejects.toThrow(TimesheetBoundsError);
  await expect(failure).rejects.toMatchObject({ problem });
  expect(bytesOf(done.id)).toBe(before);
});

test("a finish BEFORE a use the driver handed back is refused — that end is the driver's own, and never moves", async () => {
  const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: at(5), vehicle: UNIT });
  await endVehicleUse({ shiftId: shift.id, endingUseId: vehicleUseAt(at(5).toISOString()), endMileage: 100_100, endedAt: at(16) });
  const done = await finishDeclared({ shiftId: shift.id, vehicleUseId: null, trailerUseId: null, finalMileage: null, endedAt: at(17), nightOut: false, notes: "" });
  if (done === null) throw new Error("expected the day to finish");
  const before = bytesOf(done.id);

  const failure = correctDeclared(correction(done, { endedAt: at(15, 30) }));

  await expect(failure).rejects.toMatchObject({ problem: { kind: "finish-before-use", name: "AB12 CDE", at: at(16).toISOString() } });
  expect(bytesOf(done.id)).toBe(before);
});

test("a SECOND correction keeps the first, and the day as finished, exactly", async () => {
  const done = await plainDay();
  const first = await correctDeclared(correction(done, { correctionId: "c1", nightOut: true }));
  if (first === null) throw new Error("expected the first correction");

  const second = await correctDeclared(correction(first, { correctionId: "c2", notes: "Late tip" }));

  expect(second?.corrections?.[0]).toEqual(first.corrections?.[0]);
  expect(second?.corrections?.map(entry => entry.id)).toEqual(["c1", "c2"]);
  expect(second && effectiveFacts(second)).toMatchObject({ nightOut: true, notes: "Late tip" });
  expect(second).toMatchObject({ nightOut: false, notes: null, startedAt: done.startedAt, endedAt: done.endedAt });
});

test("after a restart, the day reads back with its corrections and what it says now", async () => {
  const done = await plainDay();
  const corrected = await correctDeclared(correction(done, { workingFor: NORTHGATE, nightOut: true }));

  expect(await readCompletedShift(done.id)).toEqual(corrected);
  expect((await listCompletedShifts()).timesheets).toEqual([corrected]);
});

test("a correction confirmed TWICE is one correction; one that changes nothing writes nothing", async () => {
  const done = await plainDay();
  const input = correction(done, { correctionId: "once", nightOut: true });
  await Promise.all([correctDeclared(input), correctDeclared(input)]);
  expect((await readCompletedShift(done.id))?.corrections).toHaveLength(1);

  const now = await readCompletedShift(done.id);
  if (now === null) throw new Error("expected the day");
  const before = bytesOf(done.id);
  expect(await correctDeclared(correction(now))).toEqual(now);
  expect(bytesOf(done.id)).toBe(before);
});

test("a STALE edit — the day corrected since it opened — writes nothing; an unknown day finds nothing", async () => {
  const done = await plainDay();
  const stale = correction(done, { correctionId: "late", notes: "from a stale screen" });
  await correctDeclared(correction(done, { correctionId: "first", nightOut: true }));
  const before = bytesOf(done.id);

  expect(await correctDeclared(stale)).toBeNull();
  expect(bytesOf(done.id)).toBe(before);
  expect(await correctDeclared({ ...stale, shiftId: "no-such-day", basedOn: null })).toBeNull();
});

test("two days that look the same are corrected apart, by id", async () => {
  const first = await plainDay();
  const second = await plainDay();
  const untouched = bytesOf(second.id);

  await correctDeclared(correction(first, { nightOut: true }));

  expect(bytesOf(second.id)).toBe(untouched);
});

test("a correction that cannot be SAVED is a SafeSaveFailedError, and the day still reads as it was", async () => {
  const done = await plainDay();
  jest.spyOn(File.prototype, "moveSync").mockImplementation(() => { throw new Error("rename failed"); });

  await expect(correctDeclared(correction(done, { nightOut: true }))).rejects.toThrow(SafeSaveFailedError);

  jest.restoreAllMocks();
  expect(await readCompletedShift(done.id)).toEqual(done);
});

test("a record whose corrections are not what this app writes fails closed", async () => {
  const done = await plainDay();
  const corrected = await correctDeclared(correction(done, { correctionId: "c1", nightOut: true }));
  const record = JSON.parse(bytesOf(done.id)) as Record<string, unknown>;
  const valid = corrected?.corrections?.[0];

  for (const corrections of [
    "not a list",
    [{ ...valid, correctedBy: "" }],
    [{ ...valid, notes: "" }],
    [valid, valid],
    [{ ...valid, endedAt: at(4).toISOString() }],
  ]) {
    recordFile(done.id).write(JSON.stringify({ ...record, corrections }));
    expect(await readCompletedShift(done.id)).toBeNull();
  }
});

test("the Timesheets order follows a corrected start", async () => {
  const earlier = await plainDay();
  const later = await startLocalShift({ workingFor: PERSONAL, startedAt: day(20, 6), vehicle: null });
  await finishDeclared({ shiftId: later.id, vehicleUseId: null, trailerUseId: null, finalMileage: null, endedAt: day(20, 14), nightOut: false, notes: "" });

  await correctDeclared(correction(earlier, { startedAt: day(21, 5), endedAt: day(21, 13) }));

  expect((await listCompletedShifts()).timesheets.map(shift => shift.id)).toEqual([earlier.id, later.id]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Correcting a finished day's USES — by exact use, never by plate or number
// ═══════════════════════════════════════════════════════════════════════════

test("a finished day's uses open by exact use: nothing in use, every use ended", async () => {
  const done = await busyDay();

  const uses = await readFinishedDayOfUses(done.id);

  expect(uses).toMatchObject({ id: done.id, vehicle: null, trailer: null });
  expect(uses?.previousVehicles).toEqual(done.previousVehicles);
  expect(uses?.previousTrailers).toEqual(done.previousTrailers);
  expect(await readFinishedDayOfUses("no-such-day")).toBeNull();
});

test("Fuel and AdBlue are added, edited and removed on ONE use — the same plate's other use and every other use untouched", async () => {
  const done = await busyDay();
  const first = { shiftId: done.id, vehicleUseId: vehicleUseAt(at(5).toISOString()), usageState: USAGE_STATE.ended };

  await recordVehicleFill({ ...first, fillId: "f1", type: FILL_TYPE.fuel, recordedAt: at(6), litres: 200, note: "" });
  await recordVehicleFill({ ...first, fillId: "a1", type: FILL_TYPE.adblue, recordedAt: at(7), litres: null, note: "" });
  await recordVehicleFill({ ...first, fillId: "f1", type: FILL_TYPE.fuel, recordedAt: at(6), litres: 250, note: "Corrected" });
  await removeVehicleFill({ ...first, fillId: "a1" });

  const after = await readCompletedShift(done.id);
  expect(after?.previousVehicles[0]?.fills).toEqual([{ id: "f1", type: FILL_TYPE.fuel, recordedAt: at(6).toISOString(), litres: 250, note: "Corrected" }]);
  expect(after?.previousVehicles.slice(1)).toEqual(done.previousVehicles.slice(1));
  expect(after?.previousTrailers).toEqual(done.previousTrailers);
  expect(after && effectiveFacts(after)).toEqual(effectiveFacts(done));
  // Never an open day: the finished day stays finished.
  expect(new File(Paths.document, OPEN_SHIFT_FILE).exists).toBe(false);
});

test("an END MILEAGE is corrected on one use; below its start is refused", async () => {
  const done = await busyDay();

  await correctEndMileage({ shiftId: done.id, vehicleUseId: vehicleUseAt(at(11).toISOString()), endMileage: 100_260 });
  await expect(correctEndMileage({ shiftId: done.id, vehicleUseId: vehicleUseAt(at(11).toISOString()), endMileage: 99_000 })).rejects.toThrow(Error);

  const after = await readCompletedShift(done.id);
  expect(after?.previousVehicles.map(use => use.endMileage)).toEqual([100_100, 220_040, 100_260]);
});

test("a use named as IN USE on a finished day is not found — nothing is written", async () => {
  const done = await busyDay();
  const before = bytesOf(done.id);

  expect(await recordVehicleFill({ shiftId: done.id, vehicleUseId: vehicleUseAt(at(11).toISOString()), usageState: USAGE_STATE.inUse, fillId: "x", type: FILL_TYPE.fuel, recordedAt: at(12), litres: 5, note: "" })).toBeNull();
  expect(await recordVehicleFill({ shiftId: done.id, vehicleUseId: vehicleUseAt("AB12 CDE"), usageState: USAGE_STATE.ended, fillId: "x", type: FILL_TYPE.fuel, recordedAt: at(12), litres: 5, note: "" })).toBeNull();

  expect(bytesOf(done.id)).toBe(before);
});

test("Fridge Diesel is added, edited and removed on the REFRIGERATED use; a standard trailer refuses it", async () => {
  const done = await busyDay();
  const fridge = { shiftId: done.id, trailerUseId: trailerUseAt(at(12).toISOString()), usageState: USAGE_STATE.ended };

  await recordReeferDiesel({ ...fridge, fillId: "d1", recordedAt: at(12, 30), litres: 30, note: "" });
  await recordReeferDiesel({ ...fridge, fillId: "d2", recordedAt: at(13), litres: null, note: "" });
  await recordReeferDiesel({ ...fridge, fillId: "d1", recordedAt: at(12, 30), litres: 35, note: "" });
  await removeReeferDiesel({ ...fridge, fillId: "d2" });
  const standard = await recordReeferDiesel({ shiftId: done.id, trailerUseId: trailerUseAt(at(13).toISOString()), usageState: USAGE_STATE.ended, fillId: "no", recordedAt: at(14), litres: 10, note: "" });

  const after = await readCompletedShift(done.id);
  expect(standard).toBeNull();
  expect(after?.previousTrailers.map(use => use.reeferDiesel.map(fill => [fill.id, fill.litres]))).toEqual([[], [["d1", 35]], []]);
  expect(after?.previousVehicles).toEqual(done.previousVehicles);
});

test("a FORGOTTEN vehicle check is completed after the finish — on exactly that use, dated when it is done, by the driver", async () => {
  const done = await busyDay();
  const items = checklistItems(checklistFor("class1"));
  const target = { shiftId: done.id, vehicleUseId: vehicleUseAt(at(11).toISOString()), usageState: USAGE_STATE.ended, checkId: "late", startedAt: new Date() };
  await saveVehicleCheckDraft({ ...target, answers: [{ key: items[0]?.key ?? "", result: CHECK_RESULT.defect, note: "Worn" }] });
  const completedAt = new Date();

  await completeVehicleCheck({ ...target, answers: answers(items, items[0]?.key), completedAt, completedBy: DRIVER });

  const after = await readCompletedShift(done.id);
  expect(after?.previousVehicles[2]?.checks).toEqual([expect.objectContaining({ id: "late", status: "completed", completedAt: completedAt.toISOString(), completedBy: DRIVER })]);
  // The same plate's MORNING use is not the one checked.
  expect(after?.previousVehicles[0]?.checks).toEqual([]);
});

test("a FORGOTTEN trailer check is completed after the finish — on exactly that use", async () => {
  const done = await busyDay();
  const items = checklistItems(trailerChecklistFor(TRAILER_TYPE.standard));
  const target = { shiftId: done.id, trailerUseId: trailerUseAt(at(13).toISOString()), usageState: USAGE_STATE.ended, checkId: "late-t", startedAt: new Date() };

  await saveTrailerCheckDraft({ ...target, answers: [] });
  await completeTrailerCheck({ ...target, answers: answers(items), completedAt: new Date(), completedBy: DRIVER });

  const after = await readCompletedShift(done.id);
  expect(after?.previousTrailers[2]?.checks[0]).toMatchObject({ id: "late-t", status: "completed" });
  expect(after?.previousTrailers[0]?.checks).toEqual([]);
});

test("completed vehicle and trailer checks are CORRECTED after the finish by appended revisions — the certificate untouched", async () => {
  const done = await busyDay();
  const vItems = checklistItems(checklistFor("class2"));
  await completeVehicleCheck({ shiftId: done.id, vehicleUseId: vehicleUseAt(at(9).toISOString()), usageState: USAGE_STATE.ended, checkId: "vc", startedAt: new Date(), answers: answers(vItems, vItems[0]?.key), completedAt: new Date(), completedBy: DRIVER });
  const tItems = checklistItems(trailerChecklistFor(TRAILER_TYPE.refrigerated));
  await completeTrailerCheck({ shiftId: done.id, trailerUseId: trailerUseAt(at(12).toISOString()), usageState: USAGE_STATE.ended, checkId: "tc", startedAt: new Date(), answers: answers(tItems), completedAt: new Date(), completedBy: DRIVER });
  const certified = await readCompletedShift(done.id);

  await reviseVehicleCheck({ shiftId: done.id, useId: vehicleUseAt(at(9).toISOString()), usageState: USAGE_STATE.ended, checkId: "vc", revisionId: "vr", answers: answers(vItems), revisedAt: new Date(), revisedBy: DRIVER });
  await reviseTrailerCheck({ shiftId: done.id, useId: trailerUseAt(at(12).toISOString()), usageState: USAGE_STATE.ended, checkId: "tc", revisionId: "tr", answers: answers(tItems, tItems[0]?.key), revisedAt: new Date(), revisedBy: DRIVER });

  const after = await readCompletedShift(done.id);
  const vehicleCheck = after?.previousVehicles[1]?.checks[0];
  const trailerCheck = after?.previousTrailers[1]?.checks[0];
  expect(vehicleCheck?.items).toEqual(certified?.previousVehicles[1]?.checks[0]?.items);
  expect(vehicleCheck?.revisions?.map(revision => revision.id)).toEqual(["vr"]);
  expect(trailerCheck?.revisions?.map(revision => revision.id)).toEqual(["tr"]);
  if (vehicleCheck === undefined) throw new Error("expected the check");
  expect(effectiveItems(vehicleCheck).some(item => item.result === CHECK_RESULT.defect)).toBe(false);
});

test("a use correction that cannot be saved is a SafeSaveFailedError, and the finished day still reads as it was", async () => {
  const done = await busyDay();
  jest.spyOn(File.prototype, "write").mockImplementation(() => { throw new Error("disk full"); });

  await expect(recordVehicleFill({ shiftId: done.id, vehicleUseId: vehicleUseAt(at(5).toISOString()), usageState: USAGE_STATE.ended, fillId: "f", type: FILL_TYPE.fuel, recordedAt: at(6), litres: 10, note: "" }))
    .rejects.toThrow(SafeSaveFailedError);

  jest.restoreAllMocks();
  expect(await readCompletedShift(done.id)).toEqual(done);
});

// ═══════════════════════════════════════════════════════════════════════════
// Delete Timesheet — one day, by id, and nothing else
// ═══════════════════════════════════════════════════════════════════════════

test("delete removes EXACTLY that day — the other finished days, the open day and recovery files stay", async () => {
  // The day deleted is neither the first nor the last on the disk or in the list.
  const before = await plainDay();
  const gone = await plainDay();
  const kept = await plainDay();
  const keptBytes = bytesOf(kept.id);
  const beforeBytes = bytesOf(before.id);
  const open = await startLocalShift({ workingFor: PERSONAL, startedAt: day(20, 6), vehicle: UNIT });
  const openBytes = new File(Paths.document, OPEN_SHIFT_FILE).textSync();
  const recovery = new File(Paths.document, `${RECOVERY_FILE_PREFIX}unreadable-1-x.json`);
  recovery.create();
  recovery.write("kept");

  expect(await deleteCompletedShift(gone.id)).toBe(true);

  expect(await readCompletedShift(gone.id)).toBeNull();
  expect(bytesOf(kept.id)).toBe(keptBytes);
  expect(bytesOf(before.id)).toBe(beforeBytes);
  expect(new File(Paths.document, OPEN_SHIFT_FILE).textSync()).toBe(openBytes);
  expect((await readOpenShift())?.id).toBe(open.id);
  expect(recovery.textSync()).toBe("kept");
  expect((await listCompletedShifts()).timesheets.map(shift => shift.id).sort()).toEqual([before.id, kept.id].sort());
});

test("a missing, unsafe or open-day id deletes nothing", async () => {
  const kept = await plainDay();
  const open = await startLocalShift({ workingFor: PERSONAL, startedAt: day(20, 6), vehicle: null });

  for (const id of ["no-such-day", "", "../logisticbay-open-shift", `${kept.id}/..`, open.id]) {
    expect(await deleteCompletedShift(id)).toBe(false);
  }
  expect(await readCompletedShift(kept.id)).not.toBeNull();
  expect((await readOpenShift())?.id).toBe(open.id);
});

test("a DOUBLE delete removes one day — never another", async () => {
  const gone = await plainDay();
  const kept = await plainDay();

  const results = await Promise.all([deleteCompletedShift(gone.id), deleteCompletedShift(gone.id)]);

  expect(results.sort()).toEqual([false, true]);
  expect(await readCompletedShift(kept.id)).not.toBeNull();
});

test("a delete that FAILS with the record still there is reported as a failure — never as deleted", async () => {
  const done = await plainDay();
  jest.spyOn(File.prototype, "delete").mockImplementation(() => { throw new Error("busy"); });

  await expect(deleteCompletedShift(done.id)).rejects.toThrow("busy");

  jest.restoreAllMocks();
  expect(await readCompletedShift(done.id)).toEqual(done);
});

test("a delete whose outcome CANNOT BE KNOWN is a DeleteUncertainError", async () => {
  const done = await plainDay();
  const realExists = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(File.prototype) as object, "exists");
  let attempted = false;
  jest.spyOn(File.prototype, "delete").mockImplementation(() => { attempted = true; throw new Error("busy"); });
  jest.spyOn(File.prototype, "exists", "get").mockImplementation(function (this: File) {
    // Readable up to the delete; unknowable after it.
    if (attempted) throw new Error("io");
    return (realExists?.get?.call(this) as boolean | undefined) ?? false;
  });

  await expect(deleteCompletedShift(done.id)).rejects.toThrow(DeleteUncertainError);
});

test("an interrupted finish's leftover open file of THIS day goes with it — the day does not come back as open", async () => {
  const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: at(5), vehicle: null });
  const removeOnce = jest.spyOn(File.prototype, "delete").mockImplementationOnce(() => { throw new Error("busy"); });
  await finishDeclared({ shiftId: shift.id, vehicleUseId: null, trailerUseId: null, finalMileage: null, endedAt: at(17), nightOut: false, notes: "" });
  removeOnce.mockRestore();
  expect(new File(Paths.document, OPEN_SHIFT_FILE).exists).toBe(true);

  expect(await deleteCompletedShift(shift.id)).toBe(true);

  expect(new File(Paths.document, OPEN_SHIFT_FILE).exists).toBe(false);
  expect(await readOpenShift()).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// A plate or trailer number typed wrong — any use, by its identity (D40)
// ═══════════════════════════════════════════════════════════════════════════

test("the plate of the vehicle IN USE is corrected — normalised, and nothing else about the use changes", async () => {
  const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: at(5), vehicle: { ...UNIT, numberPlate: "AB12 CED" } });
  const before = await readOpenShift();

  const day19 = await correctNumberPlate({ shiftId: shift.id, useId: vehicleUseAt(at(5).toISOString()), usageState: USAGE_STATE.inUse, value: "  ab12 cde " });

  expect(day19?.vehicle).toEqual({ ...before?.vehicle, numberPlate: "AB12 CDE" });
  expect((await readOpenShift())?.vehicle?.numberPlate).toBe("AB12 CDE");
});

test("the number of the trailer IN USE is corrected; its type, identity and fridge diesel stay", async () => {
  const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: at(5), vehicle: UNIT });
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: { ...RF77, trailerNumber: "RF7" }, startedAt: at(6) });
  await recordReeferDiesel({ shiftId: shift.id, trailerUseId: trailerUseAt(at(6).toISOString()), usageState: USAGE_STATE.inUse, fillId: "d", recordedAt: at(7), litres: 20, note: "" });
  const before = (await readOpenShift())?.trailer;

  await correctTrailerNumber({ shiftId: shift.id, useId: trailerUseAt(at(6).toISOString()), usageState: USAGE_STATE.inUse, value: "rf77" });

  expect((await readOpenShift())?.trailer).toEqual({ ...before, trailerNumber: "RF77" });
});

test("a correction naming a use in the WRONG STATE writes nothing; an empty plate or number is refused", async () => {
  const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: at(5), vehicle: UNIT });
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(at(5).toISOString()), endMileage: 100_100, next: RIGID, changedAt: at(9) });
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(10) });
  const before = new File(Paths.document, OPEN_SHIFT_FILE).textSync();

  expect(await correctNumberPlate({ shiftId: shift.id, useId: vehicleUseAt(at(5).toISOString()), usageState: USAGE_STATE.inUse, value: "ZZ" })).toBeNull();
  expect(await correctNumberPlate({ shiftId: shift.id, useId: vehicleUseAt("AB12 CDE"), usageState: USAGE_STATE.ended, value: "ZZ" })).toBeNull();
  await expect(correctNumberPlate({ shiftId: shift.id, useId: vehicleUseAt(at(9).toISOString()), usageState: USAGE_STATE.inUse, value: "   " })).rejects.toThrow(Error);
  await expect(correctTrailerNumber({ shiftId: shift.id, useId: trailerUseAt(at(10).toISOString()), usageState: USAGE_STATE.inUse, value: "" })).rejects.toThrow(Error);

  expect(new File(Paths.document, OPEN_SHIFT_FILE).textSync()).toBe(before);
});

test("an EARLIER use's plate on the open day is corrected by identity — the same plate's other use untouched", async () => {
  const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: at(5), vehicle: { ...UNIT, numberPlate: "AB12 CDE" } });
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(at(5).toISOString()), endMileage: 100_100, next: RIGID, changedAt: at(9) });
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(at(9).toISOString()), endMileage: 220_040, next: { ...UNIT, startMileage: 100_100 }, changedAt: at(11) });
  const before = await readOpenShift();

  await correctNumberPlate({ shiftId: shift.id, useId: vehicleUseAt(at(5).toISOString()), usageState: USAGE_STATE.ended, value: "AB12 CDF" });

  const after = await readOpenShift();
  expect(after?.previousVehicles[0]).toEqual({ ...before?.previousVehicles[0], numberPlate: "AB12 CDF" });
  expect(after?.previousVehicles[1]).toEqual(before?.previousVehicles[1]);
  // The same wrong plate, used again later, is another use and keeps it.
  expect(after?.vehicle).toEqual(before?.vehicle);
});

test("an EARLIER trailer use's number on the open day is corrected by identity only", async () => {
  const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: at(5), vehicle: UNIT });
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(6) });
  await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(at(6).toISOString()), next: TR23, changedAt: at(8) });
  const before = await readOpenShift();

  await correctTrailerNumber({ shiftId: shift.id, useId: trailerUseAt(at(6).toISOString()), usageState: USAGE_STATE.ended, value: "tr24" });

  const after = await readOpenShift();
  expect(after?.previousTrailers[0]).toEqual({ ...before?.previousTrailers[0], trailerNumber: "TR24" });
  expect(after?.trailer).toEqual(before?.trailer);
});

test("a FINISHED day's plate and trailer number are corrected by identity — class, type, times, mileage, fills, checks and the other same-name uses untouched", async () => {
  const done = await busyDay();
  const items = checklistItems(checklistFor("class1"));
  await completeVehicleCheck({ shiftId: done.id, vehicleUseId: vehicleUseAt(at(11).toISOString()), usageState: USAGE_STATE.ended, checkId: "vc", startedAt: new Date(), answers: answers(items), completedAt: new Date(), completedBy: DRIVER });
  await recordVehicleFill({ shiftId: done.id, vehicleUseId: vehicleUseAt(at(11).toISOString()), usageState: USAGE_STATE.ended, fillId: "f", type: FILL_TYPE.fuel, recordedAt: at(12), litres: 50, note: "" });
  const before = await readCompletedShift(done.id);

  await correctNumberPlate({ shiftId: done.id, useId: vehicleUseAt(at(11).toISOString()), usageState: USAGE_STATE.ended, value: "ab12 cdf" });
  await correctTrailerNumber({ shiftId: done.id, useId: trailerUseAt(at(13).toISOString()), usageState: USAGE_STATE.ended, value: "TR24" });

  const after = await readCompletedShift(done.id);
  expect(after?.previousVehicles[2]).toEqual({ ...before?.previousVehicles[2], numberPlate: "AB12 CDF" });
  expect(after?.previousVehicles.slice(0, 2)).toEqual(before?.previousVehicles.slice(0, 2));
  expect(after?.previousTrailers[2]).toEqual({ ...before?.previousTrailers[2], trailerNumber: "TR24" });
  expect(after?.previousTrailers.slice(0, 2)).toEqual(before?.previousTrailers.slice(0, 2));
  expect(after && effectiveFacts(after)).toEqual(before && effectiveFacts(before));
  expect(after?.corrections).toEqual(before?.corrections);
});

// ═══════════════════════════════════════════════════════════════════════════
// A corrected finish moves ONLY what the finish ended (D40)
// ═══════════════════════════════════════════════════════════════════════════

test("Finish marks the vehicle and trailer IN USE as ended by the finish — and nothing ended earlier", async () => {
  const done = await busyDay();

  expect(done.previousVehicles.map(use => use.endedBy)).toEqual([undefined, undefined, "finish"]);
  expect(done.previousTrailers.map(use => use.endedBy)).toEqual([undefined, undefined, "finish"]);
  // It survives a restart.
  expect(await readCompletedShift(done.id)).toEqual(done);
});

test("correcting the finish moves the finish-ended vehicle AND trailer with it — the handed-back uses stay exactly", async () => {
  const done = await busyDay();

  const corrected = await correctDeclared(correction(done, { endedAt: at(16, 30) }));
  if (corrected === null) throw new Error("expected the correction");

  const uses = effectiveUses(corrected);
  expect(uses.previousVehicles.map(use => use.endedAt)).toEqual([at(9).toISOString(), at(11).toISOString(), at(16, 30).toISOString()]);
  expect(uses.previousTrailers.map(use => use.endedAt)).toEqual([done.previousTrailers[0]?.endedAt, at(13).toISOString(), at(16, 30).toISOString()]);
  // The same plate and the same trailer number used earlier are other uses, and did not move.
  expect(uses.previousVehicles[0]).toEqual(done.previousVehicles[0]);
  expect(uses.previousTrailers[0]).toEqual(done.previousTrailers[0]);
  // The day as finished is untouched; the correction carries the new finish.
  expect(corrected.previousVehicles).toEqual(done.previousVehicles);
  expect(corrected.previousTrailers).toEqual(done.previousTrailers);
  expect(corrected.corrections?.[0]?.endedAt).toBe(at(16, 30).toISOString());
});

test("a LATER corrected finish moves them later too — and a use's own start still bounds it", async () => {
  const done = await busyDay();

  const corrected = await correctDeclared(correction(done, { endedAt: at(18) }));
  if (corrected === null) throw new Error("expected the correction");

  expect(effectiveUses(corrected).previousVehicles[2]?.endedAt).toBe(at(18).toISOString());
  await expect(correctDeclared(correction(corrected, { endedAt: at(10, 59) }))).rejects.toMatchObject({ problem: { kind: "finish-before-use-start" } });
});

test("a use that ended by hand at the very minute of the finish is NOT taken as ended by it — equal times prove nothing", async () => {
  const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: at(5), vehicle: UNIT });
  await endVehicleUse({ shiftId: shift.id, endingUseId: vehicleUseAt(at(5).toISOString()), endMileage: 100_100, endedAt: at(17) });
  const done = await finishDeclared({ shiftId: shift.id, vehicleUseId: null, trailerUseId: null, finalMileage: null, endedAt: at(17), nightOut: false, notes: "" });
  if (done === null) throw new Error("expected the day to finish");

  expect(done.previousVehicles[0]?.endedBy).toBeUndefined();
  await expect(correctDeclared(correction(done, { endedAt: at(16, 30) }))).rejects.toMatchObject({ problem: { kind: "finish-before-use" } });
});

test("a day finished BEFORE this was recorded reads as it did, and its ends are never guessed to be the finish's", async () => {
  const done = await busyDay();
  const record = JSON.parse(bytesOf(done.id)) as { previousVehicles: Record<string, unknown>[]; previousTrailers: Record<string, unknown>[] };
  const legacy = {
    ...record,
    previousVehicles: record.previousVehicles.map(({ endedBy: _gone, ...use }) => use),
    previousTrailers: record.previousTrailers.map(({ endedBy: _gone, ...use }) => use),
  };
  recordFile(done.id).write(JSON.stringify(legacy));
  const read = await readCompletedShift(done.id);
  if (read === null) throw new Error("a legacy day must still read");
  const before = bytesOf(done.id);

  // Its last uses ended at the finish's very minute — still not moved.
  await expect(correctDeclared(correction(read, { endedAt: at(16, 30) }))).rejects.toMatchObject({ problem: { kind: "finish-before-use" } });
  expect(bytesOf(done.id)).toBe(before);
  // A later finish is fine: nothing needs to move for it.
  const later = await correctDeclared(correction(read, { endedAt: at(18) }));
  expect(later && effectiveUses(later).previousVehicles[2]?.endedAt).toBe(at(17).toISOString());
});

test("a stored end-reason this app never writes, or one on an ended-by-finish use not ending at the finish, fails closed", async () => {
  const done = await busyDay();
  const record = JSON.parse(bytesOf(done.id)) as { previousVehicles: Record<string, unknown>[] };

  for (const vehicles of [
    record.previousVehicles.map((use, index) => (index === 0 ? { ...use, endedBy: "change" } : use)),
    record.previousVehicles.map((use, index) => (index === 2 ? { ...use, endedAt: at(16).toISOString() } : use)),
  ]) {
    recordFile(done.id).write(JSON.stringify({ ...record, previousVehicles: vehicles }));
    expect(await readCompletedShift(done.id)).toBeNull();
  }
});

test("an open day never holds a use ended by a finish — a file claiming one fails closed", async () => {
  const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: at(5), vehicle: UNIT });
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(at(5).toISOString()), endMileage: 100_100, next: RIGID, changedAt: at(9) });
  const live = new File(Paths.document, OPEN_SHIFT_FILE);
  const record = JSON.parse(live.textSync()) as { previousVehicles: Record<string, unknown>[] };

  live.write(JSON.stringify({ ...record, previousVehicles: record.previousVehicles.map(use => ({ ...use, endedBy: "finish" })) }));

  expect(await readOpenShift()).toBeNull();
});

test("a use correction on a finished day leaves every stored end as it was — a moved end is never written back", async () => {
  const done = await busyDay();
  const corrected = await correctDeclared(correction(done, { endedAt: at(16, 30) }));
  if (corrected === null) throw new Error("expected the correction");

  await recordVehicleFill({ shiftId: done.id, vehicleUseId: vehicleUseAt(at(11).toISOString()), usageState: USAGE_STATE.ended, fillId: "f", type: FILL_TYPE.fuel, recordedAt: at(12), litres: 10, note: "" });

  const after = await readCompletedShift(done.id);
  expect(after?.previousVehicles[2]?.endedAt).toBe(at(17).toISOString());
  expect(after && effectiveUses(after).previousVehicles[2]?.endedAt).toBe(at(16, 30).toISOString());
});
