/**
 * The driver's open working shift, as the PHONE holds it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LOCAL FIRST — the day does not depend on a network (D28)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A driver books on in a yard, a lay-by, a loading bay under a steel roof.
 * Starting a shift therefore writes a local record and does nothing else: no
 * request is made, none is awaited, and a dead network changes nothing. The
 * company is told when the driver later chooses to send a finished timesheet,
 * and the server decides everything company-facing at that point.
 *
 * ONE OPEN SHIFT AT A TIME, and `startLocalShift` is idempotent because of it.
 * A driver has one working day; a double press, a retry after a stutter, or a
 * relaunch mid-shift must never produce a second record. Asked to start while
 * one is open, this returns the OPEN one unchanged — it does not replace it,
 * re-time it, or swap its vehicle, because a stray tap must not rewrite a
 * working day.
 *
 * WHY A FILE, and not a database. This is one small document describing one
 * open day. `expo-sqlite` would be a persistence subsystem bought for a single
 * row (AGENT_WORKFLOW §25 — no infrastructure the requirements do not
 * justify), and `expo-secure-store` is the keychain, reserved for the one
 * secret this app stores and deliberately exposing no generic setter. A JSON
 * document in the app's own documents directory is durable across process
 * restarts, survives with no network, and costs nothing. D25's "no SQLite yet"
 * therefore still holds; when the shape outgrows a document — segments,
 * checks, defects — that is the moment to revisit it, with data in hand.
 *
 * NOT persisted here: anything the requirements have not asked for. There is
 * no trailer, no fuel and no note field waiting for a later step to fill in
 * (CLAUDE.md — never invent a field nothing writes). Vehicle checks and their
 * defects ARE stored, inside the vehicle they check — see `vehicleCheck.ts`.
 *
 * ONE VEHICLE AT A TIME, AND EVERY EARLIER ONE KEPT. A day holds the vehicle
 * in use (`vehicle`) and, once the driver has changed vehicle, each earlier
 * USE of a vehicle, closed with the mileage and time it ended at
 * (`previousVehicles`). A use is identified by when it began, `startedAt` —
 * never by its plate: returning to a truck used this morning is a NEW use,
 * with its own start mileage and its own checks, and the morning's record is
 * left exactly as it was.
 *
 * CLASS BELONGS TO THE USE, NOT TO THE DAY. Each use stores its own
 * `vehicleClass`, and a day may move between Class 1, Class 2 and a van in
 * any direction and any number of times (D30). Nothing
 * here — and nothing reading it — may treat the classes already used as a
 * constraint on the next one.
 */
import { File, Paths } from "expo-file-system";
import { checklistFor, checklistItems } from "./checklists";
import {
  CHECK_RESULT,
  CHECK_STATUS,
  DEFECT_NOTE_MAX_LENGTH,
  asVehicleCheck,
  type CheckAnswer,
  type CheckItem,
  type VehicleCheck,
} from "./vehicleCheck";

/** Who the day is being worked for. A local INTENTION, never authority (D28). */
export type WorkingContext =
  | { kind: "personal" }
  | { kind: "company"; membershipId: string; companyId: string; companyName: string };

/** The vehicle classes a driver may book on with. */
export type VehicleClass = "class1" | "class2" | "van";

export const VEHICLE_CLASSES: readonly { id: VehicleClass; label: string }[] = [
  { id: "class1", label: "Class 1" },
  { id: "class2", label: "Class 2" },
  { id: "van",    label: "Van" },
] as const;

/** What a driver enters about a vehicle — the same three things wherever it is entered. */
export interface VehicleDetails {
  vehicleClass: VehicleClass;
  /** Trimmed and upper-cased. Never format-validated — plates are international. */
  numberPlate: string;
  /** Whole miles, zero or more. Never defaulted or invented. */
  startMileage: number;
}

export interface LocalVehicle extends VehicleDetails {
  /**
   * When this vehicle's use in the day BEGAN. One meaning, whichever way the
   * vehicle arrived:
   *
   *   given at Start Shift   the shift's declared `startedAt` — the same
   *                          instant, because the vehicle began with the day
   *   added from Active Shift the moment the driver added it
   *
   * Named for `ShiftSegment.startedAt`, which is the same concept on the
   * server: a submitted day becomes segments, a segment requires its start,
   * and for a vehicle taken mid-shift that moment cannot be reconstructed
   * afterwards. How it maps onto a segment is the submission's decision.
   */
  startedAt: string;
  /**
   * The walkaround checks performed on THIS use of the vehicle, oldest first.
   * Empty until the driver answers a first item. See `vehicleCheck.ts` for why
   * they live here rather than keyed by number plate.
   */
  checks: VehicleCheck[];
}

/**
 * A use of a vehicle that has ENDED — the driver changed to another. The same
 * record as while it was in use, closed with the two facts only the change
 * knows: the odometer reading the driver handed it back at, and when.
 *
 * `endMileage` is never less than `startMileage`. It is never inferred: it is
 * what the driver read and entered at the change.
 */
export interface EndedVehicle extends LocalVehicle {
  endMileage: number;
  /** The device clock at the change — the same instant the next use began. */
  endedAt: string;
}

/** Trimmed and upper-cased — how a plate is stored and shown, wherever it is typed. */
export function normalisePlate(raw: string): string {
  return raw.trim().toUpperCase();
}

export interface LocalShift {
  /**
   * This device's identity for the day.
   *
   * UUID-shaped so it can become the server's `clientEventId` when submission
   * arrives, without migrating anything already written. It is generated from
   * `Math.random`, which is NOT a cryptographic source — it does not need to
   * be: it identifies one day on one phone, and the server scopes it per
   * membership.
   */
  id: string;
  workingFor: WorkingContext;
  /** The driver's declared start of work, as an instant. */
  startedAt: string;
  /**
   * The vehicle IN USE. `null` when the driver has booked on without a
   * vehicle — a real state (D29). Never carries an end: a use that has ended
   * is in `previousVehicles`.
   */
  vehicle: LocalVehicle | null;
  /**
   * Every earlier use of a vehicle in this day, in the order they ended —
   * oldest first. Appended to by a change, never rewritten: the same plate may
   * appear more than once, each a separate use.
   */
  previousVehicles: EndedVehicle[];
  status: "open";
  createdAt: string;
}

export interface StartLocalShiftInput {
  workingFor: WorkingContext;
  startedAt: Date;
  /** As entered. Its use is recorded as starting at `startedAt` above. */
  vehicle: VehicleDetails | null;
}

/** Exported so a test can assert the record reaches a real file. */
export const OPEN_SHIFT_FILE = "logisticbay-open-shift.json";

function openShiftFile(): File {
  return new File(Paths.document, OPEN_SHIFT_FILE);
}

/**
 * A fresh local identity — for a day, or a check within it. UUID-shaped so it
 * can travel to the server unchanged; see `LocalShift.id` on its source.
 */
export function newLocalId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, placeholder => {
    const random = Math.floor(Math.random() * 16);
    const value = placeholder === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/**
 * Narrow a parsed document to a shift, or reject it.
 *
 * The file is ours, but it may be from an older build or half-written by a
 * device that died mid-save. Anything that is not exactly a shift is reported
 * as NO open shift rather than repaired with defaults — inventing a start time
 * or a vehicle would be worse than admitting we do not know.
 */
function asLocalShift(value: unknown): LocalShift | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  const { id, startedAt, createdAt, status, workingFor, vehicle } = record;
  if (typeof id !== "string" || id === "") return null;
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) return null;
  if (typeof createdAt !== "string") return null;
  if (status !== "open") return null;

  const context = asWorkingContext(workingFor);
  if (context === null) return null;

  const asVehicle = vehicle === null ? null : asLocalVehicle(vehicle, startedAt);
  if (vehicle !== null && asVehicle === null) return null;
  // The vehicle in use carries no end: an ended use belongs to the history.
  if (vehicle !== null && hasEnd(vehicle)) return null;

  const previous = asPreviousVehicles(record["previousVehicles"]);
  if (previous === null) return null;
  // One use, one start: `startedAt` is what identifies a use, so no two share it.
  const starts = [...previous, ...(asVehicle === null ? [] : [asVehicle])].map(use => use.startedAt);
  if (new Set(starts).size !== starts.length) return null;

  return { id, workingFor: context, startedAt, vehicle: asVehicle, previousVehicles: previous, status: "open", createdAt };
}

function hasEnd(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record["endMileage"] !== undefined || record["endedAt"] !== undefined;
}

/**
 * The day's earlier vehicle uses, or `null` if they cannot be read.
 *
 * ABSENT means none: every build before vehicles could be changed stored a day
 * without the field, and such a day had only ever had the one vehicle.
 *
 * Anything else must be exactly a list of ended uses. A malformed entry makes
 * the whole day unreadable rather than being dropped, as a malformed vehicle
 * does: these are mileage records, and a day quietly missing one would read
 * as complete when it is not.
 */
function asPreviousVehicles(value: unknown): EndedVehicle[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const ended: EndedVehicle[] = [];
  for (const raw of value) {
    const use = asEndedVehicle(raw);
    if (use === null) return null;
    ended.push(use);
  }
  return ended;
}

function asEndedVehicle(value: unknown): EndedVehicle | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  // Written only by builds that record a start for every use, so it must be here.
  if (record["startedAt"] === undefined) return null;
  const use = asLocalVehicle(value, "");
  if (use === null) return null;
  const { endMileage, endedAt } = record;
  if (typeof endMileage !== "number" || !Number.isSafeInteger(endMileage) || endMileage < use.startMileage) return null;
  if (typeof endedAt !== "string" || Number.isNaN(Date.parse(endedAt))) return null;
  return { ...use, endMileage, endedAt };
}

function asWorkingContext(value: unknown): WorkingContext | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  if (record["kind"] === "personal") return { kind: "personal" };
  if (record["kind"] !== "company") return null;

  const { membershipId, companyId, companyName } = record;
  if (typeof membershipId !== "string" || typeof companyId !== "string" || typeof companyName !== "string") {
    return null;
  }
  return { kind: "company", membershipId, companyId, companyName };
}

/**
 * `shiftStartedAt` supplies the vehicle's start ONLY when the stored vehicle
 * has none. Builds before Add Vehicle wrote Start Shift vehicles without one,
 * and a phone may hold such a day now; rejecting it would make the day vanish.
 * The derivation is exact rather than a guess — until Add Vehicle existed,
 * Start Shift was the only way a day got a vehicle, and a Start Shift vehicle's
 * use began at the shift's start. A value that is PRESENT but not a real time
 * is not that case, and is refused like any other malformed field.
 */
function asLocalVehicle(value: unknown, shiftStartedAt: string): LocalVehicle | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  const { vehicleClass, numberPlate, startMileage, startedAt } = record;
  const known = VEHICLE_CLASSES.some(option => option.id === vehicleClass);
  if (!known || typeof vehicleClass !== "string") return null;
  if (typeof numberPlate !== "string" || numberPlate === "") return null;
  if (typeof startMileage !== "number" || !Number.isFinite(startMileage) || startMileage < 0) return null;

  const vehicle = { vehicleClass: vehicleClass as VehicleClass, numberPlate, startMileage };
  let usageStartedAt: string;
  if (startedAt === undefined) usageStartedAt = shiftStartedAt;
  else if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) return null;
  else usageStartedAt = startedAt;

  return { ...vehicle, startedAt: usageStartedAt, checks: readChecks(record["checks"], vehicle.vehicleClass) };
}

/**
 * The vehicle's checks, keeping only those that can be read as what they are.
 *
 * A DRAFT holds only the rows the driver CHANGED from the checklist's
 * defaults, so it is read against the version it was written for: its items
 * must be items of that checklist. A COMPLETED check holds every row with its
 * own label and result and is read as it stands, whatever the checklist says
 * now — a finished record is evidence, and a later change to a default must
 * never reinterpret it.
 *
 * ABSENT means none — every build before Vehicle Checks stored vehicles
 * without the field, and no check was ever made on them.
 *
 * A check that cannot be read is DROPPED, not repaired and not allowed to
 * take the day with it. The safe direction is unambiguous: a lost check reads
 * as "Not completed" and the driver checks again; a guessed one could read as
 * a vehicle that passed. And unlike a broken vehicle, a broken check is no
 * reason to report that the driver has no open day at all — that would let a
 * new day overwrite this one, start time and all.
 *
 * Readable means: structurally a check (`asVehicleCheck`) for THIS vehicle's
 * checklist. A draft must be for the current version, every item a real item
 * of it; a completed check must carry rows of its own — all of them, if it
 * claims the current version. A second check with an id already seen is
 * dropped too.
 */
function readChecks(value: unknown, vehicleClass: VehicleClass): VehicleCheck[] {
  if (!Array.isArray(value)) return [];
  const checklist = checklistFor(vehicleClass);
  const keys = new Set(checklistItems(checklist).map(entry => entry.key));
  const ids = new Set<string>();
  const checks: VehicleCheck[] = [];
  for (const raw of value) {
    const check = asVehicleCheck(raw);
    if (check === null || ids.has(check.id)) continue;
    if (check.checklist !== checklist.id) continue;
    if (check.status === CHECK_STATUS.completed) {
      // Self-describing: every row, with the label and result recorded then.
      if (check.items.length === 0) continue;
      if (check.checklistVersion === checklist.version && check.items.length !== keys.size) continue;
    } else {
      // Overrides, which only mean anything against the version they were
      // written for.
      if (check.checklistVersion !== checklist.version) continue;
      if (!check.items.every(entry => keys.has(entry.key))) continue;
    }
    ids.add(check.id);
    checks.push(check);
  }
  return checks;
}

/** The shift this device has open, or null. Never throws. */
export async function readOpenShift(): Promise<LocalShift | null> {
  const file = openShiftFile();
  if (!file.exists) return null;

  try {
    return asLocalShift(JSON.parse(await file.text()));
  } catch {
    // Unreadable. Reported as "no open shift" — the safe direction, since the
    // alternative is an app that cannot open. The file is left in place rather
    // than destroyed, so nothing recoverable is thrown away.
    return null;
  }
}

/**
 * One change to the open shift at a time.
 *
 * Read-then-write is not atomic, and two presses landing together would both
 * read the same state and both write — two ids for one working day, or two
 * vehicles arriving into a day that should hold one. A driver double-tapping
 * a big button at 5am is not an edge case, so every write — starting a day,
 * adding or changing a vehicle, saving a check — queues behind the last, and
 * each finds what the one before it wrote.
 *
 * Failures do not poison the queue: the chain continues on either outcome, and
 * the caller still sees its own rejection.
 */
let writing: Promise<unknown> = Promise.resolve();

function queued<T>(work: () => Promise<T>): Promise<T> {
  const result = writing.then(work, work);
  writing = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Begin the working day, or hand back the one already in progress.
 *
 * Never rejects for want of a network, because it never uses one.
 */
export function startLocalShift(input: StartLocalShiftInput): Promise<LocalShift> {
  return queued(() => createIfNoneOpen(input));
}

async function createIfNoneOpen(input: StartLocalShiftInput): Promise<LocalShift> {
  const alreadyOpen = await readOpenShift();
  if (alreadyOpen !== null) return alreadyOpen;

  const startedAt = input.startedAt.toISOString();
  const shift: LocalShift = {
    id:         newLocalId(),
    workingFor: input.workingFor,
    startedAt,
    // A vehicle given at the start began with the day: the same instant.
    vehicle:    input.vehicle === null ? null : {
      vehicleClass: input.vehicle.vehicleClass,
      numberPlate:  input.vehicle.numberPlate,
      startMileage: input.vehicle.startMileage,
      startedAt,
      checks:       [],
    },
    previousVehicles: [],
    status:     "open",
    createdAt:  new Date().toISOString(),
  };

  const file = openShiftFile();
  file.create({ overwrite: true });
  file.write(JSON.stringify(shift));
  return shift;
}

export interface AddVehicleInput {
  vehicle: VehicleDetails;
  /**
   * When its use began: the moment the driver added it. Passed in, so it is
   * the press rather than the write.
   */
  startedAt: Date;
}

/**
 * Put the first vehicle into a day that started without one.
 *
 * Resolves to the open shift as it now stands, or `null` when there is no
 * open shift to add to — it never creates one.
 *
 * ADD IS NOT CHANGE. A day that already has a vehicle is returned untouched:
 * replacing a vehicle means an end mileage for the old one, which belongs to
 * the Change flow, and a stray or repeated Add must never quietly do it. That
 * is also what makes a double press harmless — the second finds the vehicle
 * the first wrote and does nothing.
 *
 * Only the vehicle changes. The id, the declared start, who the day is for,
 * the status and the creation time are carried across as they were.
 *
 * Never rejects for want of a network, because it never uses one. It DOES
 * reject a vehicle that is not valid, rather than writing it: the reader
 * treats a malformed vehicle as no open shift at all, so writing one would
 * make the driver's day disappear.
 */
export function addVehicleToOpenShift(input: AddVehicleInput): Promise<LocalShift | null> {
  return queued(() => addIfNoVehicle(input));
}

async function addIfNoVehicle({ vehicle, startedAt }: AddVehicleInput): Promise<LocalShift | null> {
  const numberPlate = normalisePlate(vehicle.numberPlate);
  const known = VEHICLE_CLASSES.some(option => option.id === vehicle.vehicleClass);
  if (!known || numberPlate === "" || !Number.isSafeInteger(vehicle.startMileage) || vehicle.startMileage < 0
    || Number.isNaN(startedAt.getTime())) {
    throw new Error("Refusing to store an invalid vehicle");
  }

  const open = await readOpenShift();
  if (open === null) return null;
  if (open.vehicle !== null) return open;

  const updated: LocalShift = {
    ...open,
    vehicle: {
      vehicleClass: vehicle.vehicleClass,
      numberPlate,
      startMileage: vehicle.startMileage,
      startedAt: startedAt.toISOString(),
      checks: [],
    },
  };
  const file = openShiftFile();
  file.write(JSON.stringify(updated));
  return updated;
}

export interface ChangeVehicleInput {
  /** The day being changed. */
  shiftId: string;
  /** The use being ended, by its `startedAt` — the vehicle the driver saw on screen. */
  endingStartedAt: string;
  /** The odometer reading as the driver hands that vehicle back. */
  endMileage: number;
  /** The vehicle taken next, as entered or chosen. */
  next: VehicleDetails;
  /**
   * The moment of the change, from the device clock: the old use ends and the
   * new one begins at this same instant. Passed in, so it is the press rather
   * than the write.
   */
  changedAt: Date;
}

/**
 * End the vehicle in use and begin the next, in ONE write.
 *
 * The ended use is appended to `previousVehicles` with its end mileage and
 * time, and nothing else about it changes — not its start, not its checks.
 * The next vehicle becomes a NEW use: its own start mileage, `startedAt` =
 * the change, and no checks, whatever was done on an earlier use of the same
 * plate. Earlier uses are never read back into it.
 *
 * ATOMIC as far as the day is concerned: the whole day is written once, so
 * there is no moment at which the old use has ended and the new has not
 * begun. A failed write leaves the file as it was.
 *
 * ONCE, however many presses. A change applies only while the vehicle in use
 * is still the one named by `endingStartedAt`; a second press finds the new
 * vehicle there and returns the day unchanged. Resolves to the day as it now
 * stands, or `null` when that day is no longer the one open.
 *
 * ANY CLASS MAY FOLLOW ANY CLASS. Class belongs to the use, not to the day: a
 * driver may drop a unit for a rigid at lunchtime and take a van at four, in
 * any order (D30). Each use stores its own
 * `vehicleClass`, and the classes already used constrain nothing.
 *
 * REFUSES — rejects, writing nothing — an end mileage below the use's start
 * mileage, an invalid next vehicle, and a next use that would share a start
 * with another.
 */
export function changeVehicle(input: ChangeVehicleInput): Promise<LocalShift | null> {
  return queued(() => changeIfCurrent(input));
}

async function changeIfCurrent({ shiftId, endingStartedAt, endMileage, next, changedAt }: ChangeVehicleInput): Promise<LocalShift | null> {
  const numberPlate = normalisePlate(next.numberPlate);
  const known = VEHICLE_CLASSES.some(option => option.id === next.vehicleClass);
  if (!known || numberPlate === "" || !Number.isSafeInteger(next.startMileage) || next.startMileage < 0
    || !Number.isSafeInteger(endMileage) || endMileage < 0 || Number.isNaN(changedAt.getTime())) {
    throw new Error("Refusing an invalid vehicle change");
  }

  const open = await readOpenShift();
  if (open === null || open.id !== shiftId) return null;
  const current = open.vehicle;
  // Already changed — by an earlier press — or nothing to change from.
  if (current?.startedAt !== endingStartedAt) return open;

  if (endMileage < current.startMileage) throw new Error("Refusing an end mileage below the start mileage");
  const at = changedAt.toISOString();
  if ([...open.previousVehicles, current].some(use => use.startedAt === at)) {
    throw new Error("Refusing a vehicle use that starts at the same instant as another");
  }

  const ended: EndedVehicle = { ...current, endMileage, endedAt: at };
  const updated: LocalShift = {
    ...open,
    vehicle: {
      vehicleClass: next.vehicleClass,
      numberPlate,
      startMileage: next.startMileage,
      startedAt: at,
      checks: [],
    },
    previousVehicles: [...open.previousVehicles, ended],
  };
  openShiftFile().write(JSON.stringify(updated));
  return updated;
}

export interface VehicleCheckWrite {
  /** The day the check belongs to. */
  shiftId: string;
  /** The vehicle use being checked, by its `startedAt`. */
  vehicleStartedAt: string;
  checkId: string;
  /** When the driver began this check. Kept from the first write onwards. */
  startedAt: Date;
  answers: readonly CheckAnswer[];
}

/**
 * Save a check in progress. Called as the driver answers, so nothing given is
 * lost to a closed app, a flat battery or a missing signal.
 *
 * ONLY WHAT THE DRIVER CHANGED is stored. Every row starts at the checklist's
 * declared default, and those defaults are already on the phone — writing 42
 * of them back on every tap would be noise, and would freeze a copy of them
 * into a draft nobody has confirmed. A row set back to its default drops out
 * of the draft again.
 *
 * Resolves to the check as stored, or `null` when the day or the vehicle it
 * was begun on is no longer the one open — the check is not written into a
 * different day or onto a different vehicle.
 *
 * A COMPLETED check is not reopened by a late save: it is returned as it was.
 * And while this vehicle use already has a check, a second one is not started
 * beside it — repeat checks are a later, deliberate feature.
 */
export function saveVehicleCheckDraft(input: VehicleCheckWrite): Promise<VehicleCheck | null> {
  return queued(() => writeCheck(input, null));
}

/**
 * Complete a check: store the final answers and mark it done, in one write.
 *
 * THE COMPLETED RECORD IS WRITTEN IN FULL — every row, in order, with the
 * label, the section and the result as the driver confirmed them, defaults
 * included. A draft is shorthand against today's checklist; a completed check
 * is the driver's evidence, and must read the same whatever the checklist
 * later becomes — rows added, retired, renamed, moved or re-defaulted.
 *
 * REFUSES — rejects, writing nothing — unless every item of the vehicle's
 * checklist is answered and every defect is described. Completing a check
 * that is already complete returns it unchanged: a double press cannot make a
 * second completed check or move the completion time.
 */
export function completeVehicleCheck(input: CompleteVehicleCheckInput): Promise<VehicleCheck | null> {
  return queued(() => writeCheck(input, input));
}

export interface CompleteVehicleCheckInput extends VehicleCheckWrite {
  /** The driver's declared moment of certification — see `VehicleCheck`. */
  completedAt: Date;
  /** The authenticated driver's stable user id: who made the declaration. */
  completedBy: string;
}

async function writeCheck(input: VehicleCheckWrite, certification: { completedAt: Date; completedBy: string } | null): Promise<VehicleCheck | null> {
  const completedAt = certification?.completedAt ?? null;
  const open = await readOpenShift();
  const vehicle = open?.vehicle ?? null;
  if (open === null || vehicle === null || open.id !== input.shiftId || vehicle.startedAt !== input.vehicleStartedAt) {
    return null;
  }

  const existing = vehicle.checks.find(check => check.id === input.checkId);
  if (existing?.status === CHECK_STATUS.completed) return existing;
  if (existing === undefined && vehicle.checks.length > 0) return vehicle.checks[vehicle.checks.length - 1] ?? null;

  const checklist = checklistFor(vehicle.vehicleClass);
  const byKey = new Map(input.answers.map(answer => [answer.key, answer]));
  if (byKey.size !== input.answers.length) throw new Error("Refusing a check with a repeated item");
  const known = new Set(checklistItems(checklist).map(entry => entry.key));
  for (const key of byKey.keys()) {
    if (!known.has(key)) throw new Error("Refusing a check with an item not on this vehicle's checklist");
  }

  const items: CheckItem[] = [];
  for (const section of checklist.sections) {
    for (const entry of section.items) {
      const answer = byKey.get(entry.key);
      if (answer === undefined) continue;
      const isDefect = answer.result === CHECK_RESULT.defect;
      // A draft keeps only what differs from the declared default; a completed
      // record keeps every row, so it can never be re-read against new defaults.
      if (completedAt === null && !isDefect && answer.result === entry.defaultResult) continue;
      // The description travels only with a defect: switching an item back to
      // OK or N/A must not leave an old description attached to it.
      const typed = isDefect ? (completedAt === null ? answer.note : answer.note.trim()) : "";
      if (typed.length > DEFECT_NOTE_MAX_LENGTH) throw new Error("Refusing an over-long defect description");
      const item: CheckItem = { key: entry.key, label: entry.label, result: answer.result, note: isDefect && typed !== "" ? typed : null };
      // The certificate records where each row sat, so it can be shown again
      // exactly as confirmed whatever the checklist later becomes. A draft is
      // laid out by the checklist it is answered against, and records none.
      if (completedAt !== null) item.section = { id: section.id, title: section.title };
      items.push(item);
    }
  }

  if (certification !== null) {
    const complete = items.length === known.size && items.every(entry => entry.result !== CHECK_RESULT.defect || entry.note !== null);
    if (!complete || Number.isNaN(certification.completedAt.getTime())) throw new Error("Refusing to complete an unfinished check");
    // Unattributable certification is refused rather than stored anonymously.
    if (certification.completedBy === "") throw new Error("Refusing to complete a check with no driver");
  }

  const check: VehicleCheck = {
    id:               input.checkId,
    checklist:        checklist.id,
    checklistVersion: checklist.version,
    startedAt:        existing?.startedAt ?? input.startedAt.toISOString(),
    status:           certification === null ? CHECK_STATUS.draft : CHECK_STATUS.completed,
    completedAt:      certification === null ? null : certification.completedAt.toISOString(),
    completedBy:      certification?.completedBy ?? null,
    items,
  };
  const checks = existing === undefined
    ? [...vehicle.checks, check]
    : vehicle.checks.map(stored => (stored.id === check.id ? check : stored));

  const updated: LocalShift = { ...open, vehicle: { ...vehicle, checks } };
  openShiftFile().write(JSON.stringify(updated));
  return check;
}

/** Forget the open shift. The end of a day, and the reset a test needs. */
export async function clearOpenShift(): Promise<void> {
  const file = openShiftFile();
  if (file.exists) file.delete();
  return Promise.resolve();
}
