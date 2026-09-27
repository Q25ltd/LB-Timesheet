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
 * no trailer, and no note field waiting for a later step to fill in
 * (CLAUDE.md — never invent a field nothing writes). Vehicle checks and their
 * defects ARE stored, inside the vehicle they check — see `vehicleCheck.ts` —
 * and so are the fuel and AdBlue put into it (`vehicleFill.ts`), inside the
 * same use, with an unknown quantity stored as ABSENT and never as zero.
 *
 * ONE VEHICLE AT A TIME, AND EVERY EARLIER ONE KEPT. A day holds the vehicle
 * in use (`vehicle`) and, once the driver has changed vehicle, each earlier
 * USE of a vehicle, closed with the mileage and time it ended at
 * (`previousVehicles`). A use is identified by when it began, `startedAt` —
 * never by its plate: returning to a truck used this morning is a NEW use,
 * with its own start mileage, its own checks and its own fills, and the
 * morning's record is left exactly as it was.
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
  FILL_NOTE_MAX_LENGTH,
  FILL_TYPES,
  asVehicleFill,
  isStorableLitres,
  type FillType,
  type VehicleFill,
} from "./vehicleFill";
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
  /**
   * The fuel and AdBlue put into THIS use of the vehicle, in the order the
   * driver recorded them. Empty until one is. Same containment as `checks`,
   * and for the same reason — see `vehicleFill.ts`.
   */
  fills: VehicleFill[];
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

/**
 * Whether a use is the vehicle IN USE or one that has ENDED. One registry, no
 * magic strings.
 *
 * A write that targets a use states which it expects, and is refused when the
 * day disagrees. A fuel entry begun under the vehicle in use must not land on
 * that same use after the driver has handed it back — and must never land on
 * whatever replaced it (D31).
 */
export const USAGE_STATE = {
  inUse: "in-use",
  ended: "ended",
} as const;

export type UsageState = (typeof USAGE_STATE)[keyof typeof USAGE_STATE];

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
   * The vehicle IN USE. `null` is a real state, whichever way the day
   * reached it: booked on without a vehicle (D29), or the driver ended one and
   * carried on without another (D32). Never carries an end: a use that has
   * ended is in `previousVehicles`.
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

  const fills = readFills(record["fills"]);
  if (fills === null) return null;

  return { ...vehicle, startedAt: usageStartedAt, checks: readChecks(record["checks"], vehicle.vehicleClass), fills };
}

/**
 * The fuel and AdBlue put into this use, or `null` if they cannot be read.
 *
 * ABSENT means none: every build before fills existed stored vehicles without
 * the field, and nothing was ever recorded on them.
 *
 * A PRESENT but malformed list fails the whole day closed — it does NOT drop
 * the bad record the way an unreadable check does. The two are different
 * kinds of thing: a lost check reads as "Not completed" and the driver simply
 * checks again, but a lost fill is a quantity nobody can reconstruct, and a
 * day quietly missing one would read as complete when it is not. Mileages are
 * treated the same way (`asPreviousVehicles`).
 */
function readFills(value: unknown): VehicleFill[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const fills: VehicleFill[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const fill = asVehicleFill(raw);
    if (fill === null || seen.has(fill.id)) return null;
    seen.add(fill.id);
    fills.push(fill);
  }
  return fills;
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
      fills:        [],
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
 * Put a vehicle into a day that has none — the first of the day, or the next
 * one after the driver ended a use and carried on without a vehicle (D32).
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

  const at = startedAt.toISOString();
  // ONE USE, ONE START, which `asLocalShift` enforces on the way back in. A
  // day may already hold ended uses — the driver gave a vehicle up and carried
  // on without one (D32) — so a vehicle added in the very millisecond one
  // ended would write a day the reader then refuses, and the driver's day
  // would vanish. Refused here instead, changing nothing.
  if (open.previousVehicles.some(use => use.startedAt === at)) {
    throw new Error("Refusing a vehicle use that starts at the same instant as another");
  }

  const updated: LocalShift = {
    ...open,
    vehicle: {
      vehicleClass: vehicle.vehicleClass,
      numberPlate,
      startMileage: vehicle.startMileage,
      startedAt: at,
      checks: [],
      fills: [],
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
      fills: [],
    },
    previousVehicles: [...open.previousVehicles, ended],
  };
  openShiftFile().write(JSON.stringify(updated));
  return updated;
}

export interface EndVehicleUseInput {
  /** The day being changed. */
  shiftId: string;
  /** The use being ended, by its `startedAt` — the vehicle the driver saw on screen. */
  endingStartedAt: string;
  /** The odometer reading as the driver hands that vehicle back. */
  endMileage: number;
  /**
   * The moment the driver gives the vehicle up, from the device clock. Passed
   * in, so it is the press rather than the write. NOTHING begins at it: a
   * vehicle taken later gets its own, later start.
   */
  endedAt: Date;
}

/**
 * End the vehicle in use and carry the shift on WITH NO VEHICLE (D32).
 *
 * A driver hands a truck back at 13:00 and spends two hours in the yard
 * waiting for the next one. That time is part of the working day and belongs
 * to no vehicle, so the day keeps running with `vehicle: null` — the same
 * state as a day that booked on without one (D29).
 *
 * THIS IS NOT FINISHING THE SHIFT. The status stays `open`, the declared
 * start, the working context and the whole history are untouched, and Finish
 * Shift remains a separate action this can never become.
 *
 * NO REPLACEMENT USE IS INVENTED. The gap is the ABSENCE of a use, not a use
 * of nothing: `previousVehicles` gains exactly the one record that just ended,
 * with the mileage and moment the driver gave it up, and a vehicle added later
 * begins its own use at its own later moment (`addVehicleToOpenShift`). This
 * `endedAt` is never rewritten to meet it, so the real gap survives.
 *
 * ONCE, however many presses — the same rule as a change: it applies only
 * while the vehicle in use is still the one named by `endingStartedAt`, so a
 * second press finds none there and returns the day unchanged. Resolves to the
 * day as it now stands, or `null` when that day is not the one open.
 *
 * REFUSES — rejects, writing nothing — an end mileage below the use's start
 * mileage, and a reading or moment that is not real.
 */
export function endVehicleUse(input: EndVehicleUseInput): Promise<LocalShift | null> {
  return queued(() => endIfCurrent(input));
}

async function endIfCurrent({ shiftId, endingStartedAt, endMileage, endedAt }: EndVehicleUseInput): Promise<LocalShift | null> {
  if (!Number.isSafeInteger(endMileage) || endMileage < 0 || Number.isNaN(endedAt.getTime())) {
    throw new Error("Refusing an invalid end of a vehicle use");
  }

  const open = await readOpenShift();
  if (open === null || open.id !== shiftId) return null;
  const current = open.vehicle;
  // Already ended — by an earlier press — or nothing to end.
  if (current?.startedAt !== endingStartedAt) return open;

  if (endMileage < current.startMileage) throw new Error("Refusing an end mileage below the start mileage");

  const ended: EndedVehicle = { ...current, endMileage, endedAt: endedAt.toISOString() };
  const updated: LocalShift = { ...open, vehicle: null, previousVehicles: [...open.previousVehicles, ended] };
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

export interface RecordVehicleFillInput {
  /** The day the fill belongs to. */
  shiftId: string;
  /** The vehicle USE it went into, by its `startedAt`. */
  vehicleStartedAt: string;
  /** Whether that use is expected to be the one in use, or one that has ended. */
  usageState: UsageState;
  /**
   * The fill's own id. A second write with the same id CORRECTS that fill
   * rather than adding another, so a double tap is one entry and an edit is
   * the same operation as an add.
   */
  fillId: string;
  type: FillType;
  /** The driver's declared moment — the device clock, or their correction of it. */
  recordedAt: Date;
  /** Litres, or `null` when the driver does not know. Never 0 for unknown. */
  litres: number | null;
  /** Optional; empty means none, and is stored as `null`. */
  note: string;
}

/**
 * Record fuel or AdBlue on a vehicle use, or correct one already recorded.
 *
 * IT LANDS ON THE USE NAMED BY `vehicleStartedAt`, AND NOWHERE ELSE. A fill is
 * never matched by number plate: a day may hold three uses of AB12 CDE, and
 * correcting the morning's fuel must not touch the afternoon's
 * (`locateUsage`). A name that matches no use writes nothing at all.
 *
 * ANY USE OF THE OPEN DAY MAY RECEIVE ONE — the one in use, from Fuel or
 * AdBlue on Active Shift, or one that has ended, from that use's own Edit
 * (D31). A driver who fuelled a truck just before handing it back corrects
 * THAT use afterwards, never whatever they are driving now. An ended use stays
 * historical in every other respect: its class, plate, times, start mileage
 * and completed check cannot be touched here, and only its `fills` change.
 *
 * THE USE MUST STILL BE IN THE STATE THE CALLER EXPECTS (`usageState`). A
 * fill begun under the vehicle in use is refused if that use has since ended
 * — it neither follows the plate nor moves to the replacement.
 *
 * Resolves to the day as it now stands, or `null` when that day is not the
 * one open, no use answers to that name, or the use is not in the expected
 * state — writing nothing in every one of those cases.
 *
 * REFUSES — rejects, writing nothing — an unknown type, an invalid moment, an
 * over-long note, and any `litres` that is not a real positive reading. An
 * UNKNOWN quantity is `null`, never 0: zero is a measurement.
 */
export function recordVehicleFill(input: RecordVehicleFillInput): Promise<LocalShift | null> {
  return queued(() => writeFill(input));
}

async function writeFill({ shiftId, vehicleStartedAt, usageState, fillId, type, recordedAt, litres, note }: RecordVehicleFillInput): Promise<LocalShift | null> {
  if (fillId === "") throw new Error("Refusing a fill with no id");
  if (!FILL_TYPES.some(entry => entry.id === type)) throw new Error("Refusing a fill of an unknown type");
  if (Number.isNaN(recordedAt.getTime())) throw new Error("Refusing a fill with an invalid time");
  if (litres !== null && !isStorableLitres(litres)) throw new Error("Refusing a fill quantity that is not a positive reading");
  const described = note.trim();
  if (described.length > FILL_NOTE_MAX_LENGTH) throw new Error("Refusing an over-long fill note");

  const open = await readOpenShift();
  if (open === null || open.id !== shiftId) return null;
  const target = locateUsage(open, vehicleStartedAt, usageState);
  if (target === null) return null;

  const held = target.use.fills.some(stored => stored.id === fillId);

  const fill: VehicleFill = {
    id: fillId,
    type,
    recordedAt: recordedAt.toISOString(),
    litres,
    note: described === "" ? null : described,
  };
  const fills = held
    ? target.use.fills.map(stored => (stored.id === fillId ? fill : stored))
    : [...target.use.fills, fill];

  return writeFills(open, target, fills);
}

/**
 * The one use a `startedAt` names, in the state the caller expects, or `null`.
 *
 * `startedAt` IS the identity of a use (see the module header), and no two in
 * a day may share one, so this can never be ambiguous. An unknown name — an
 * empty string, a use from another day, a plate mistaken for a time — matches
 * nothing and the caller writes nothing, rather than falling back to the
 * vehicle in use and correcting the wrong truck. So does a use that exists but
 * is no longer in the expected state: the vehicle a screen was opened for has
 * been handed back since.
 */
function locateUsage(open: LocalShift, startedAt: string, state: UsageState): { use: LocalVehicle; ended: false } | { use: EndedVehicle; ended: true; index: number } | null {
  if (startedAt === "") return null;
  if (state === USAGE_STATE.inUse) {
    return open.vehicle !== null && open.vehicle.startedAt === startedAt ? { use: open.vehicle, ended: false } : null;
  }
  const index = open.previousVehicles.findIndex(use => use.startedAt === startedAt);
  const ended = open.previousVehicles[index];
  return ended === undefined ? null : { use: ended, ended: true, index };
}

/**
 * The day with one use's fills replaced, and NOTHING else touched — an ended
 * use keeps its class, plate, times, mileages and checks exactly as they are.
 */
function writeFills(
  open: LocalShift,
  target: { use: LocalVehicle; ended: false } | { use: EndedVehicle; ended: true; index: number },
  fills: VehicleFill[],
): LocalShift {
  const updated: LocalShift = target.ended
    ? { ...open, previousVehicles: open.previousVehicles.map((use, index) => (index === target.index ? { ...use, fills } : use)) }
    : { ...open, vehicle: { ...target.use, fills } };
  openShiftFile().write(JSON.stringify(updated));
  return updated;
}

export interface RemoveVehicleFillInput {
  shiftId: string;
  vehicleStartedAt: string;
  /** Whether that use is expected to be the one in use, or one that has ended. */
  usageState: UsageState;
  fillId: string;
}

/**
 * Remove a fill the driver recorded by mistake, from the use that holds it —
 * the one in use, or one that has ended (D31).
 *
 * Only that one goes: every other fill, the checks, the mileages, the times
 * and the day's other uses are untouched. Removing one that is not there
 * returns the day unchanged, so a repeated press cannot take a second entry
 * with it, and a `vehicleStartedAt` naming no use — or a use no longer in the
 * expected state — removes nothing anywhere.
 */
export function removeVehicleFill(input: RemoveVehicleFillInput): Promise<LocalShift | null> {
  return queued(() => deleteFill(input));
}

async function deleteFill({ shiftId, vehicleStartedAt, usageState, fillId }: RemoveVehicleFillInput): Promise<LocalShift | null> {
  const open = await readOpenShift();
  if (open === null || open.id !== shiftId) return null;
  const target = locateUsage(open, vehicleStartedAt, usageState);
  if (target === null) return null;
  if (!target.use.fills.some(stored => stored.id === fillId)) return open;

  return writeFills(open, target, target.use.fills.filter(stored => stored.id !== fillId));
}

export interface CorrectEndMileageInput {
  shiftId: string;
  /** The ENDED use being corrected, by its `startedAt`. */
  vehicleStartedAt: string;
  /** The odometer reading the driver meant to enter when they handed it back. */
  endMileage: number;
}

/**
 * Correct the end mileage of a use that has ENDED, while the day is open (D31).
 *
 * A driver who typed 18 for 180 when they handed a truck back fixes it here.
 * ONLY `endMileage` changes: the use's plate, class, `startedAt`, `endedAt`,
 * start mileage, checks and fills stay exactly as they were, and so does every
 * other use — including the one that followed, whose start mileage was read
 * off a different odometer, or the same one at a different moment.
 *
 * ENDED USES ONLY. The vehicle in use has no end yet, so it is not found here.
 * A name that matches no ended use writes nothing and resolves to `null`, as
 * does a day that is not the one open. Never by plate.
 *
 * REFUSES — rejects, writing nothing — a reading that is not a whole number,
 * or one below the use's start mileage. Equal to it is a use that stood still.
 */
export function correctEndMileage(input: CorrectEndMileageInput): Promise<LocalShift | null> {
  return queued(() => rewriteEndMileage(input));
}

async function rewriteEndMileage({ shiftId, vehicleStartedAt, endMileage }: CorrectEndMileageInput): Promise<LocalShift | null> {
  if (!Number.isSafeInteger(endMileage) || endMileage < 0) throw new Error("Refusing an invalid end mileage");

  const open = await readOpenShift();
  if (open === null || open.id !== shiftId) return null;
  const target = locateUsage(open, vehicleStartedAt, USAGE_STATE.ended);
  if (target === null || !target.ended) return null;
  if (endMileage < target.use.startMileage) throw new Error("Refusing an end mileage below the start mileage");

  const updated: LocalShift = {
    ...open,
    previousVehicles: open.previousVehicles.map((use, index) => (index === target.index ? { ...use, endMileage } : use)),
  };
  openShiftFile().write(JSON.stringify(updated));
  return updated;
}

/** Forget the open shift. The end of a day, and the reset a test needs. */
export async function clearOpenShift(): Promise<void> {
  const file = openShiftFile();
  if (file.exists) file.delete();
  return Promise.resolve();
}
