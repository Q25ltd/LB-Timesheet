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
 * EVERY WRITE REPLACES THE WHOLE DOCUMENT, through `persist`: written in full
 * to a temporary sibling, verified, then moved over the live file. Not
 * atomic — `persist` names the remaining crash window. A day file the app
 * cannot read is never written over: Start Shift moves it aside for recovery
 * first (`preserveForRecovery`).
 *
 * NOT persisted here: anything the requirements have not asked for — no note
 * field waiting for a later step to fill in (CLAUDE.md — never invent a field
 * nothing writes). Vehicle checks and their
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
 * A TRAILER IS ITS OWN ASSET (D34). The day holds the trailer in use
 * (`trailer`) and every earlier trailer use (`previousTrailers`) beside the
 * vehicle's, never inside it: changing one never ends, starts or resets the
 * other. ONE INVARIANT binds them: a trailer in use requires a vehicle in use
 * that tows one — Class 1 or Class 2 (D30). So while a trailer is in use the
 * vehicle may be changed to another towing vehicle, but never to a van and
 * never to no vehicle: those are refused, and the driver hands the trailer
 * back first. See `trailer.ts`.
 *
 * CLASS BELONGS TO THE USE, NOT TO THE DAY. Each use stores its own
 * `vehicleClass`, and a day may move between Class 1, Class 2 and a van in
 * any direction and any number of times (D30). Nothing
 * here — and nothing reading it — may treat the classes already used as a
 * constraint on the next one.
 */
import { File, Paths } from "expo-file-system";
import { checklistFor, checklistItems, trailerChecklistFor, type Checklist } from "./checklists";
import {
  FILL_TYPES,
  asVehicleFill,
  checkedFillNote,
  withFill,
  type FillRecord,
  type FillType,
  type VehicleFill,
} from "./vehicleFill";
import {
  TRAILER_TYPE,
  TRAILER_TYPES,
  asEndedTrailer,
  asLocalTrailer,
  normaliseTrailerNumber,
  towsTrailers,
  type EndedTrailer,
  type LocalTrailer,
  type TrailerDetails,
} from "./trailer";
import {
  CHECK_RESULT,
  CHECK_STATUS,
  DEFECT_NOTE_MAX_LENGTH,
  effectiveItems,
  readChecksFor,
  type CheckAnswer,
  type CheckRevision,
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

/**
 * Thrown — writing nothing — when a vehicle action would leave the trailer in
 * use without a vehicle that tows it: changing to a van, or ending the vehicle
 * into no vehicle (D34). One vehicle action never ends the trailer on the
 * driver's behalf: they hand the trailer back first.
 */
export class TrailerStillInUseError extends Error {
  constructor() {
    super("Refusing a vehicle action that would leave the trailer in use without a vehicle to tow it");
    this.name = "TrailerStillInUseError";
  }
}

/**
 * Thrown — writing nothing — when a vehicle or trailer use would end before
 * it began: the phone's clock is now earlier than the moment the use started,
 * because it was changed or corrected in between. The end is never clamped,
 * and no other use is touched: a working time that runs backwards would be
 * wrong on the driver's timesheet whichever way it was patched. The reader
 * refuses such a use too (`asPreviousVehicles`, `asEndedTrailer`).
 */
export class UseEndsBeforeItStartedError extends Error {
  constructor() {
    super("Refusing to end a use before it started");
    this.name = "UseEndsBeforeItStartedError";
  }
}

/**
 * Thrown when the disk work of a save fails — keeping a leftover temporary
 * file, writing or verifying the next state, or moving it into place
 * (`persist`). Not thrown for a refusal decided before the disk is touched.
 *
 * Screens must NOT say "nothing was changed" for this: a failed move may
 * already have removed the old day file. What is guaranteed is that the day
 * is preserved — the live file untouched, or the complete verified next state
 * kept in the temporary file — and that the change was not reported as saved.
 */
export class SafeSaveFailedError extends Error {
  constructor(cause: unknown) {
    super("The day could not be saved safely", { cause });
    this.name = "SafeSaveFailedError";
  }
}

/** Refuse an end earlier than the start. The same instant is allowed: a use of no length. */
function assertEndsAfterStart(startedAt: string, endedAt: string): void {
  if (Date.parse(endedAt) < Date.parse(startedAt)) throw new UseEndsBeforeItStartedError();
}

/**
 * A vehicle as entered, normalised — or a refusal. The ONE rule every vehicle
 * write applies (Start Shift, Add Vehicle, Change Vehicle), and exactly what
 * the reader accepts back, so no write can leave a day the reader would
 * refuse: a known class, a non-empty plate (trimmed and upper-cased), and a
 * whole, non-negative start mileage.
 */
function checkedVehicle(details: VehicleDetails, refusal: string): VehicleDetails {
  const numberPlate = normalisePlate(details.numberPlate);
  const known = VEHICLE_CLASSES.some(option => option.id === details.vehicleClass);
  if (!known || numberPlate === "" || !Number.isSafeInteger(details.startMileage) || details.startMileage < 0) {
    throw new Error(refusal);
  }
  return { vehicleClass: details.vehicleClass, numberPlate, startMileage: details.startMileage };
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
  /**
   * The trailer IN USE, or `null` — no trailer is a complete answer, never a
   * missing one. Independent of `vehicle` (D34). Never carries an end.
   */
  trailer: LocalTrailer | null;
  /**
   * Every earlier trailer use, in the order they ended — oldest first. The
   * same trailer may appear more than once, each a separate use.
   */
  previousTrailers: EndedTrailer[];
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
 * Where the NEXT state of the day is written in full before it replaces the
 * live file. Never read as the day — see `persist`.
 */
export const OPEN_SHIFT_TEMP_FILE = "logisticbay-open-shift.next.json";

/**
 * Every file kept for recovery starts with this, followed by why it was kept
 * (`unreadable-` or `unfinished-`), the time and a random id. Nothing in the
 * app reads these back; they exist so bytes the app could not use are never
 * destroyed. There is no recovery screen.
 */
export const RECOVERY_FILE_PREFIX = "logisticbay-open-shift.recovery-";

/**
 * Move a file the app cannot use aside, byte for byte, under a name no other
 * file has. Throws — and leaves the file exactly where it was — if that cannot
 * be done: the caller must then write nothing over it.
 */
function preserveForRecovery(file: File, reason: "unreadable" | "unfinished"): void {
  const recovery = new File(Paths.document, `${RECOVERY_FILE_PREFIX}${reason}-${Date.now()}-${newLocalId()}.json`);
  // Never overwrite: a taken name fails here rather than destroying the
  // earlier recovery file, and the move below would refuse it too.
  if (recovery.exists) throw new Error("Refusing to overwrite a recovery file");
  file.moveSync(recovery, { overwrite: false });
}

/**
 * Write the complete next state to `OPEN_SHIFT_TEMP_FILE` and read it back. A
 * failed or short write is removed — the live file is untouched, so an
 * incomplete copy is worth nothing — and rethrown.
 */
function writeVerified(serialised: string): File {
  const written = new File(Paths.document, OPEN_SHIFT_TEMP_FILE);
  try {
    written.create({ overwrite: true });
    written.write(serialised);
    if (written.textSync() !== serialised) throw new Error("The day was not written in full");
  } catch (error: unknown) {
    if (written.exists) written.delete();
    throw error;
  }
  return written;
}

/**
 * Store the complete next state of the day.
 *
 *   1. The state is serialised and read back through `asLocalShift` BEFORE
 *      anything touches the disk. A state the reader would refuse is never
 *      written: storing it would make the driver's day disappear.
 *   2. It is written in full to `OPEN_SHIFT_TEMP_FILE` and read back; a
 *      failed or short write is removed and reported, and the live file has
 *      not been touched.
 *   3. Only then is the verified temporary file moved over the live one.
 *
 * NOT ATOMIC. Expo's move with `overwrite` deletes the old live file and then
 * renames the new one into place, on both iOS and Android; there is no single
 * atomic replace to call. The remaining crash window is between those two
 * steps. What survives it is the complete, verified next state in
 * `OPEN_SHIFT_TEMP_FILE` and no live file, so the app shows no open day —
 * never a half-written one. That file is not promoted, because nothing can
 * prove from the disk alone that the write it belonged to was ever confirmed
 * to the driver; the next write moves it aside for recovery instead
 * (`preserveForRecovery`), so it is kept and never mistaken for the day.
 *
 * A failed move throws, so no caller reports the change as saved. The
 * temporary file is then left in place, because the move may have got as far
 * as deleting the live file, making it the only copy.
 *
 * Every failure of this disk work is thrown as `SafeSaveFailedError`, so a
 * screen never claims "nothing was changed" when that may be untrue. A state
 * the reader would refuse is refused before the disk is touched, with a plain
 * error: then nothing has changed.
 */
function persist(next: LocalShift): LocalShift {
  const serialised = JSON.stringify(next);
  if (asLocalShift(JSON.parse(serialised)) === null) {
    throw new Error("Refusing to store a day the reader would refuse");
  }

  try {
    const temp = new File(Paths.document, OPEN_SHIFT_TEMP_FILE);
    // Left by an interrupted write: kept, never promoted, never overwritten.
    if (temp.exists) preserveForRecovery(temp, "unfinished");
    writeVerified(serialised).moveSync(openShiftFile(), { overwrite: true });
  } catch (error: unknown) {
    throw new SafeSaveFailedError(error);
  }
  return next;
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
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) return null;
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

  const trailers = asTrailers(record["trailer"], record["previousTrailers"]);
  if (trailers === null) return null;
  // A trailer in use requires a vehicle in use that tows it (D34). A day that
  // says otherwise was not written by this app, and is not guessed at.
  if (trailers.trailer !== null && (asVehicle === null || !towsTrailers(asVehicle.vehicleClass))) return null;

  return { id, workingFor: context, startedAt, vehicle: asVehicle, previousVehicles: previous, ...trailers, status: "open", createdAt };
}

/**
 * The day's trailer uses, or `null` if they cannot be read.
 *
 * ABSENT means none — every build before trailers stored a day without either
 * field, and no trailer was ever recorded on it; such a day loads unchanged and
 * is not rewritten by being read. PRESENT but malformed fails the whole day
 * closed, as a malformed vehicle does. A trailer in use carries no end, and no
 * two trailer uses share a start.
 */
function asTrailers(current: unknown, previous: unknown): { trailer: LocalTrailer | null; previousTrailers: EndedTrailer[] } | null {
  let trailer: LocalTrailer | null = null;
  if (current !== undefined && current !== null) {
    if (hasTrailerEnd(current)) return null;
    trailer = asLocalTrailer(current);
    if (trailer === null) return null;
  }

  const previousTrailers: EndedTrailer[] = [];
  if (previous !== undefined) {
    if (!Array.isArray(previous)) return null;
    for (const raw of previous) {
      const ended = asEndedTrailer(raw);
      if (ended === null) return null;
      previousTrailers.push(ended);
    }
  }

  const starts = [...previousTrailers, ...(trailer === null ? [] : [trailer])].map(use => use.startedAt);
  if (new Set(starts).size !== starts.length) return null;
  return { trailer, previousTrailers };
}

function hasTrailerEnd(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>)["endedAt"] !== undefined;
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
  // A use cannot end before it began; the store refuses to write one
  // (`UseEndsBeforeItStartedError`), so a day claiming one fails closed.
  if (Date.parse(endedAt) < Date.parse(use.startedAt)) return null;
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
  // Whole miles, as every writer stores them (`checkedVehicle`).
  if (typeof startMileage !== "number" || !Number.isSafeInteger(startMileage) || startMileage < 0) return null;

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

/** The vehicle's checks, read against its class's checklist — see `readChecksFor`. */
function readChecks(value: unknown, vehicleClass: VehicleClass): VehicleCheck[] {
  return readChecksFor(value, checklistFor(vehicleClass));
}

/** The shift this device has open, or null. Never throws. */
export async function readOpenShift(): Promise<LocalShift | null> {
  const file = openShiftFile();
  if (!file.exists) return null;

  try {
    return asLocalShift(JSON.parse(await file.text()));
  } catch {
    // Unreadable. Reported as "no open shift" — the safe direction, since the
    // alternative is an app that cannot open. The file is left in place, and
    // Start Shift moves it aside for recovery before it writes a new day, so
    // nothing recoverable is thrown away.
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
  // Refused before anything is read or written: the same rule every vehicle
  // write applies, so Start Shift cannot store a day the reader would refuse.
  const vehicle = input.vehicle === null ? null : checkedVehicle(input.vehicle, "Refusing to store an invalid vehicle");
  if (Number.isNaN(input.startedAt.getTime())) throw new Error("Refusing a shift with an invalid start");

  const alreadyOpen = await readOpenShift();
  if (alreadyOpen !== null) return alreadyOpen;

  const startedAt = input.startedAt.toISOString();
  const shift: LocalShift = {
    id:         newLocalId(),
    workingFor: input.workingFor,
    startedAt,
    // A vehicle given at the start began with the day: the same instant.
    vehicle:    vehicle === null ? null : { ...vehicle, startedAt, checks: [], fills: [] },
    previousVehicles: [],
    trailer:          null,
    previousTrailers: [],
    status:     "open",
    createdAt:  new Date().toISOString(),
  };

  // A day file is there but cannot be read — an older build, a damaged write.
  // It is never written over: its exact bytes are moved aside first, and if
  // that fails this throws and no new day is started.
  const live = openShiftFile();
  if (live.exists) preserveForRecovery(live, "unreadable");

  return persist(shift);
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

async function addIfNoVehicle({ vehicle: entered, startedAt }: AddVehicleInput): Promise<LocalShift | null> {
  const vehicle = checkedVehicle(entered, "Refusing to store an invalid vehicle");
  if (Number.isNaN(startedAt.getTime())) throw new Error("Refusing to store an invalid vehicle");

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

  const updated: LocalShift = { ...open, vehicle: { ...vehicle, startedAt: at, checks: [], fills: [] } };
  return persist(updated);
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
 * mileage, an invalid next vehicle, a next use that would share a start with
 * another, and a van while a trailer is in use (`TrailerStillInUseError`).
 */
export function changeVehicle(input: ChangeVehicleInput): Promise<LocalShift | null> {
  return queued(() => changeIfCurrent(input));
}

async function changeIfCurrent({ shiftId, endingStartedAt, endMileage, next: entered, changedAt }: ChangeVehicleInput): Promise<LocalShift | null> {
  const next = checkedVehicle(entered, "Refusing an invalid vehicle change");
  if (!Number.isSafeInteger(endMileage) || endMileage < 0 || Number.isNaN(changedAt.getTime())) {
    throw new Error("Refusing an invalid vehicle change");
  }

  const open = await readOpenShift();
  if (open === null || open.id !== shiftId) return null;
  const current = open.vehicle;
  // Already changed — by an earlier press — or nothing to change from.
  if (current?.startedAt !== endingStartedAt) return open;

  const at = changedAt.toISOString();
  assertEndsAfterStart(current.startedAt, at);
  if (endMileage < current.startMileage) throw new Error("Refusing an end mileage below the start mileage");
  if (!towsTrailers(next.vehicleClass) && open.trailer !== null) throw new TrailerStillInUseError();
  if ([...open.previousVehicles, current].some(use => use.startedAt === at)) {
    throw new Error("Refusing a vehicle use that starts at the same instant as another");
  }

  const ended: EndedVehicle = { ...current, endMileage, endedAt: at };
  const updated: LocalShift = {
    ...open,
    vehicle: { ...next, startedAt: at, checks: [], fills: [] },
    previousVehicles: [...open.previousVehicles, ended],
  };
  return persist(updated);
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
 * mileage, a reading or moment that is not real, and ANY end while a trailer
 * is in use (`TrailerStillInUseError`): no vehicle would leave it with nothing
 * to tow it (D34). The driver hands the trailer back first.
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

  const at = endedAt.toISOString();
  assertEndsAfterStart(current.startedAt, at);
  if (endMileage < current.startMileage) throw new Error("Refusing an end mileage below the start mileage");
  // No vehicle would leave the trailer in use with nothing to tow it (D34).
  if (open.trailer !== null) throw new TrailerStillInUseError();

  const ended: EndedVehicle = { ...current, endMileage, endedAt: at };
  const updated: LocalShift = { ...open, vehicle: null, previousVehicles: [...open.previousVehicles, ended] };
  return persist(updated);
}

export interface VehicleCheckWrite {
  /** The day the check belongs to. */
  shiftId: string;
  /** The vehicle use being checked, by its `startedAt`. */
  vehicleStartedAt: string;
  /**
   * Whether that use is expected to be the vehicle IN USE, or one that has
   * ENDED — a check forgotten before the vehicle was handed back. The use must
   * still be in that state when the write lands, or nothing is written.
   */
  usageState: UsageState;
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

async function writeCheck(input: VehicleCheckWrite, certification: Certification | null): Promise<VehicleCheck | null> {
  const open = await readOpenShift();
  if (open === null || open.id !== input.shiftId) return null;
  // Exactly the use named, in the state named — never by plate (`locateUsage`).
  const target = locateUsage(open, input.vehicleStartedAt, input.usageState);
  if (target === null) return null;
  const result = nextChecks(target.use.checks, checklistFor(target.use.vehicleClass), input, certification);
  if (result.checks === null) return result.check;

  writeVehicleUse(open, target, { checks: result.checks });
  return result.check;
}

interface Certification { completedAt: Date; completedBy: string }

const CHECK_RESULTS: readonly string[] = Object.values(CHECK_RESULT);

/**
 * The rows the driver's answers make, against one checklist — the rules every
 * walkaround save, completion and correction shares. A draft (`certification`
 * null) keeps only what differs from the declared defaults; a completion or a
 * correction keeps EVERY row with its section, and is refused unless every row
 * is answered and every defect is described.
 */
function materialise(checklist: Checklist, answers: readonly CheckAnswer[], certification: Certification | null): CheckItem[] {
  const completedAt = certification?.completedAt ?? null;
  const byKey = new Map(answers.map(answer => [answer.key, answer]));
  if (byKey.size !== answers.length) throw new Error("Refusing a check with a repeated item");
  const known = new Set(checklistItems(checklist).map(entry => entry.key));
  for (const answer of byKey.values()) {
    if (!known.has(answer.key)) throw new Error("Refusing a check with an item not on this checklist");
    // Only what the reader accepts back: a result it would not read would make
    // the whole check vanish — a certificate silently lost.
    if (!CHECK_RESULTS.includes(answer.result)) throw new Error("Refusing a check answer that is not OK, N/A or DEFECT");
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

  return items;
}


/**
 * One asset use's checks after a save or a completion — the rules every
 * walkaround shares, whichever asset it is on: a completed check is returned
 * unchanged; a second check is not begun beside an existing one; a draft keeps
 * only what differs from the declared defaults; a completion materialises
 * every row with its section, and refuses an unanswered row or an undescribed
 * defect. `checks: null` means nothing is to be written.
 */
function nextChecks(
  stored: readonly VehicleCheck[],
  checklist: Checklist,
  input: { checkId: string; startedAt: Date; answers: readonly CheckAnswer[] },
  certification: Certification | null,
): { check: VehicleCheck | null; checks: VehicleCheck[] | null } {
  const existing = stored.find(check => check.id === input.checkId);
  if (existing?.status === CHECK_STATUS.completed) return { check: existing, checks: null };
  if (existing === undefined && stored.length > 0) return { check: stored[stored.length - 1] ?? null, checks: null };

  const items = materialise(checklist, input.answers, certification);

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
    ? [...stored, check]
    : stored.map(entry => (entry.id === check.id ? check : entry));
  return { check, checks };
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
  const described = checkedFillNote({ fillId, recordedAt, litres, note });

  const open = await readOpenShift();
  if (open === null || open.id !== shiftId) return null;
  const target = locateUsage(open, vehicleStartedAt, usageState);
  if (target === null) return null;

  const fill: VehicleFill = { id: fillId, type, recordedAt: recordedAt.toISOString(), litres, note: described };
  return writeFills(open, target, withFill(target.use.fills, fill));
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
  return writeVehicleUse(open, target, { fills });
}

/** The day with one vehicle use's fills or checks replaced, and NOTHING else touched. */
function writeVehicleUse(
  open: LocalShift,
  target: { use: LocalVehicle; ended: false } | { use: EndedVehicle; ended: true; index: number },
  patch: Partial<Pick<LocalVehicle, "fills" | "checks">>,
): LocalShift {
  const updated: LocalShift = target.ended
    ? { ...open, previousVehicles: open.previousVehicles.map((use, index) => (index === target.index ? { ...use, ...patch } : use)) }
    : { ...open, vehicle: { ...target.use, ...patch } };
  return persist(updated);
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
  return persist(updated);
}

/** A trailer as entered, normalised — or a refusal. */
function checkedTrailer(details: TrailerDetails): TrailerDetails {
  const trailerNumber = normaliseTrailerNumber(details.trailerNumber);
  if (trailerNumber === "" || !TRAILER_TYPES.some(entry => entry.id === details.trailerType)) {
    throw new Error("Refusing to store an invalid trailer");
  }
  return { trailerNumber, trailerType: details.trailerType };
}

export interface AddTrailerInput {
  shiftId: string;
  trailer: TrailerDetails;
  /** When its use began: the moment the driver added it. The press, not the write. */
  startedAt: Date;
}

/**
 * Put a trailer into a day that has none in use (D34).
 *
 * ONLY behind a vehicle that tows one — Class 1 or Class 2, never a van and
 * never with no vehicle at all (D30); refused otherwise, writing nothing. The
 * vehicle is not touched: its use, times and card are exactly as they were.
 *
 * ADD IS NOT CHANGE: a day that already has a trailer in use is returned
 * untouched, so a second press — or a stale form — can never replace it.
 * Resolves to the day as it now stands, or `null` when that day is not the
 * one open.
 */
export function addTrailerToOpenShift(input: AddTrailerInput): Promise<LocalShift | null> {
  return queued(() => addIfNoTrailer(input));
}

async function addIfNoTrailer({ shiftId, trailer, startedAt }: AddTrailerInput): Promise<LocalShift | null> {
  const details = checkedTrailer(trailer);
  if (Number.isNaN(startedAt.getTime())) throw new Error("Refusing to store an invalid trailer");

  const open = await readOpenShift();
  if (open === null || open.id !== shiftId) return null;
  if (open.trailer !== null) return open;
  if (open.vehicle === null || !towsTrailers(open.vehicle.vehicleClass)) {
    throw new Error("Refusing a trailer with no vehicle that tows one");
  }
  const at = startedAt.toISOString();
  if (open.previousTrailers.some(use => use.startedAt === at)) {
    throw new Error("Refusing a trailer use that starts at the same instant as another");
  }

  const updated: LocalShift = { ...open, trailer: { ...details, startedAt: at, reeferDiesel: [], checks: [] } };
  return persist(updated);
}

export interface ChangeTrailerInput {
  shiftId: string;
  /** The trailer use being ended, by its `startedAt` — the one the driver saw on screen. */
  endingStartedAt: string;
  /** The trailer taken next, or `null` to carry on with NO TRAILER. */
  next: TrailerDetails | null;
  /** The moment of the change, from the device clock. The press, not the write. */
  changedAt: Date;
}

/**
 * End the trailer in use and take the next one — or none (D34).
 *
 * The ended use keeps its number, kind and fridge diesel, and gains
 * `endedAt`; it joins `previousTrailers`. A next trailer begins a NEW use at
 * the same instant, with no diesel — even the same trailer taken again. With
 * no next trailer, `trailer` becomes `null` and nothing is created for the
 * gap: a trailer added later begins at its own later time.
 *
 * THE VEHICLE IS NOT TOUCHED. A next trailer may start only behind a vehicle
 * that tows one (D30); ending one is always allowed.
 *
 * ONCE, however many presses: it applies only while the trailer in use is
 * still the one named by `endingStartedAt`; otherwise the day is returned
 * unchanged. Resolves to `null` when that day is not the one open.
 */
export function changeTrailer(input: ChangeTrailerInput): Promise<LocalShift | null> {
  return queued(() => changeTrailerIfCurrent(input));
}

async function changeTrailerIfCurrent({ shiftId, endingStartedAt, next, changedAt }: ChangeTrailerInput): Promise<LocalShift | null> {
  const details = next === null ? null : checkedTrailer(next);
  if (Number.isNaN(changedAt.getTime())) throw new Error("Refusing an invalid trailer change");

  const open = await readOpenShift();
  if (open === null || open.id !== shiftId) return null;
  const current = open.trailer;
  if (current?.startedAt !== endingStartedAt) return open;

  assertEndsAfterStart(current.startedAt, changedAt.toISOString());
  if (details !== null && (open.vehicle === null || !towsTrailers(open.vehicle.vehicleClass))) {
    throw new Error("Refusing a trailer with no vehicle that tows one");
  }
  const at = changedAt.toISOString();
  if (details !== null && [...open.previousTrailers, current].some(use => use.startedAt === at)) {
    throw new Error("Refusing a trailer use that starts at the same instant as another");
  }

  const ended: EndedTrailer = { ...current, endedAt: at };
  const updated: LocalShift = {
    ...open,
    trailer: details === null ? null : { ...details, startedAt: at, reeferDiesel: [], checks: [] },
    previousTrailers: [...open.previousTrailers, ended],
  };
  return persist(updated);
}

export interface TrailerCheckWrite {
  /** The day the check belongs to. */
  shiftId: string;
  /** The trailer use being checked, by its `startedAt`. */
  trailerStartedAt: string;
  /**
   * Whether that use is expected to be the trailer IN USE, or one that has
   * ENDED — a check forgotten before the trailer was handed back (D35). The
   * use must still be in that state when the write lands, or nothing is written.
   */
  usageState: UsageState;
  checkId: string;
  /** When the driver began this check. Kept from the first write onwards. */
  startedAt: Date;
  answers: readonly CheckAnswer[];
}

export interface CompleteTrailerCheckInput extends TrailerCheckWrite {
  /** The driver's declared moment of certification — see `VehicleCheck`. */
  completedAt: Date;
  /** The authenticated driver's stable user id: who made the declaration. */
  completedBy: string;
}

/**
 * Save a Trailer Check in progress (D35) — exactly as a vehicle's draft is
 * saved: only what the driver changed from the declared defaults is stored.
 *
 * IT LANDS ON THE TRAILER USE NAMED, IN THE STATE NAMED, AND NOWHERE ELSE.
 * A check begun on the trailer IN USE is refused once that trailer has been
 * changed or handed back — never written to it, to its replacement, or by
 * trailer number. A check on an ENDED use (one forgotten before the trailer
 * went back) lands on exactly that one ended use and never on the trailer in
 * use or another use of the same number. `null`, writing nothing, otherwise.
 * The vehicle and its checks are never touched.
 */
export function saveTrailerCheckDraft(input: TrailerCheckWrite): Promise<VehicleCheck | null> {
  return queued(() => writeTrailerCheck(input, null));
}

/**
 * Complete a Trailer Check: every row materialised, with its section, into an
 * immutable certificate carrying `completedAt` and `completedBy`, in one write.
 * Same refusals as a vehicle's; same targeting rule as the draft. For an ENDED
 * use `completedAt` is still the moment the driver completes it — the caller
 * passes the device clock, never the use's own times: a check is not backdated.
 */
export function completeTrailerCheck(input: CompleteTrailerCheckInput): Promise<VehicleCheck | null> {
  return queued(() => writeTrailerCheck(input, input));
}

async function writeTrailerCheck(input: TrailerCheckWrite, certification: Certification | null): Promise<VehicleCheck | null> {
  const open = await readOpenShift();
  const target = locateTrailer(open, input.shiftId, input.trailerStartedAt, input.usageState);
  if (open === null || target === null) return null;
  const result = nextChecks(target.use.checks, trailerChecklistFor(target.use.trailerType), input, certification);
  if (result.checks === null) return result.check;

  writeTrailerUse(open, target, { checks: result.checks });
  return result.check;
}

type TrailerTarget = { use: LocalTrailer; ended: false } | { use: EndedTrailer; ended: true; index: number };

/**
 * The ONE trailer use a `startedAt` names, in the state the caller expects —
 * or `null`. Never by trailer number, never a fallback to the trailer in use,
 * and an ended use must match exactly once: anything ambiguous is refused.
 */
function locateTrailer(open: LocalShift | null, shiftId: string, startedAt: string, state: UsageState): TrailerTarget | null {
  if (open === null || open.id !== shiftId || startedAt === "") return null;
  if (state === USAGE_STATE.inUse) {
    return open.trailer !== null && open.trailer.startedAt === startedAt ? { use: open.trailer, ended: false } : null;
  }
  const matches = open.previousTrailers.flatMap((use, index) => (use.startedAt === startedAt ? [{ use, index }] : []));
  const [only] = matches;
  return matches.length === 1 && only !== undefined ? { use: only.use, ended: true, index: only.index } : null;
}

/** The day with one trailer use's checks or fridge diesel replaced, and NOTHING else touched. */
function writeTrailerUse(open: LocalShift, target: TrailerTarget, patch: Partial<Pick<LocalTrailer, "checks" | "reeferDiesel">>): LocalShift {
  const updated: LocalShift = target.ended
    ? { ...open, previousTrailers: open.previousTrailers.map((use, index) => (index === target.index ? { ...use, ...patch } : use)) }
    : { ...open, trailer: { ...target.use, ...patch } };
  return persist(updated);
}

/** A correction of a COMPLETED walkaround check — a vehicle's or a trailer's. */
export interface CheckRevisionWrite {
  shiftId: string;
  /** The use the check is on, by its `startedAt` — never a plate or a trailer number. */
  usageStartedAt: string;
  /** Whether that use is expected to be the one in use, or one that has ended. */
  usageState: UsageState;
  /** The completed check being corrected. */
  checkId: string;
  /** This correction's own id: a repeated confirmation of it is one revision. */
  revisionId: string;
  /** EVERY row, as the driver now confirms it. */
  answers: readonly CheckAnswer[];
  /** The device clock when the driver confirmed the correction — never backdated. */
  revisedAt: Date;
  /** The signed-in driver making the correction. */
  revisedBy: string;
}

/**
 * Correct a completed Vehicle / Unit Check (D36). See `reviseCheck`.
 */
export function reviseVehicleCheck(input: CheckRevisionWrite): Promise<VehicleCheck | null> {
  return queued(async () => {
    const open = await readOpenShift();
    if (open === null || open.id !== input.shiftId) return null;
    const target = locateUsage(open, input.usageStartedAt, input.usageState);
    if (target === null) return null;
    const result = reviseCheck(target.use.checks, checklistFor(target.use.vehicleClass), input);
    if (result.checks !== null) writeVehicleUse(open, target, { checks: result.checks });
    return result.check;
  });
}

/**
 * Correct a completed Trailer Check (D36). See `reviseCheck`.
 */
export function reviseTrailerCheck(input: CheckRevisionWrite): Promise<VehicleCheck | null> {
  return queued(async () => {
    const open = await readOpenShift();
    const target = locateTrailer(open, input.shiftId, input.usageStartedAt, input.usageState);
    if (open === null || target === null) return null;
    const result = reviseCheck(target.use.checks, trailerChecklistFor(target.use.trailerType), input);
    if (result.checks !== null) writeTrailerUse(open, target, { checks: result.checks });
    return result.check;
  });
}

/**
 * One asset use's checks after a CORRECTION — the rule every walkaround shares
 * (D36). The completed check is never edited: its original rows, `completedAt`
 * and `completedBy` stay exactly as certified, and every earlier correction
 * stays as it was. A NEW revision is appended — a complete snapshot, validated
 * as a completion is (every row answered, every defect described), with when
 * and by whom — and becomes the effective result.
 *
 * `checks: null` — nothing to write — when the check is not there or not yet
 * completed (nothing to correct), when this revision id is already recorded (a
 * repeated press), or when the correction changes nothing. REFUSES — throws —
 * a correction against a different checklist version than the one certified,
 * an incomplete answer set, and an undescribed defect.
 */
function reviseCheck(
  stored: readonly VehicleCheck[],
  checklist: Checklist,
  input: CheckRevisionWrite,
): { check: VehicleCheck | null; checks: VehicleCheck[] | null } {
  const existing = stored.find(check => check.id === input.checkId);
  if (existing?.status !== CHECK_STATUS.completed) return { check: existing ?? null, checks: null };
  if ((existing.revisions ?? []).some(revision => revision.id === input.revisionId)) return { check: existing, checks: null };
  if (input.revisionId === "") throw new Error("Refusing a correction with no id");
  // Corrected against the list it was certified on, or not at all.
  if (existing.checklist !== checklist.id || existing.checklistVersion !== checklist.version) {
    throw new Error("Refusing to correct a check against a different checklist");
  }

  const items = materialise(checklist, input.answers, { completedAt: input.revisedAt, completedBy: input.revisedBy });
  if (JSON.stringify(items) === JSON.stringify(effectiveItems(existing))) return { check: existing, checks: null };

  const revision: CheckRevision = {
    id: input.revisionId,
    revisedAt: input.revisedAt.toISOString(),
    revisedBy: input.revisedBy,
    items,
  };
  const check: VehicleCheck = { ...existing, revisions: [...(existing.revisions ?? []), revision] };
  return { check, checks: stored.map(entry => (entry.id === check.id ? check : entry)) };
}

export interface RecordReeferDieselInput {
  shiftId: string;
  /** The trailer use it went into, by its `startedAt`. */
  trailerStartedAt: string;
  /** Whether that use is expected to be the trailer in use, or one that has ended. */
  usageState: UsageState;
  /** A second write with the same id corrects that entry. */
  fillId: string;
  recordedAt: Date;
  /** Litres, or `null` when the driver does not know. Never 0 for unknown. */
  litres: number | null;
  note: string;
}

/**
 * Record — or correct — diesel put into the fridge unit of the REFRIGERATED
 * trailer in use (D34). It is not the unit's Fuel and never touches a vehicle.
 *
 * IT LANDS ON THE TRAILER USE NAMED, IN THE STATE NAMED, AND NOWHERE ELSE —
 * the trailer in use, from its card, or exactly one ENDED use, from its own
 * Edit. A fill begun under the trailer in use is refused once that trailer
 * has been handed back or changed; a correction to an ended use never reaches
 * the trailer in use or another use of the same number. Never by trailer
 * number. A standard trailer has no fridge unit and takes none. Resolves to
 * `null` in every one of those cases, or when the day is not the one open.
 *
 * REFUSES — rejects, writing nothing — what any fill refuses (`checkedFillNote`).
 */
export function recordReeferDiesel(input: RecordReeferDieselInput): Promise<LocalShift | null> {
  return queued(() => writeReeferDiesel(input));
}

async function writeReeferDiesel({ shiftId, trailerStartedAt, usageState, fillId, recordedAt, litres, note }: RecordReeferDieselInput): Promise<LocalShift | null> {
  const described = checkedFillNote({ fillId, recordedAt, litres, note });

  const open = await readOpenShift();
  const target = reefer(locateTrailer(open, shiftId, trailerStartedAt, usageState));
  if (open === null || target === null) return null;

  const fill: FillRecord = { id: fillId, recordedAt: recordedAt.toISOString(), litres, note: described };
  return writeTrailerUse(open, target, { reeferDiesel: withFill(target.use.reeferDiesel, fill) });
}

export interface RemoveReeferDieselInput {
  shiftId: string;
  trailerStartedAt: string;
  /** Whether that use is expected to be the trailer in use, or one that has ended. */
  usageState: UsageState;
  fillId: string;
}

/** Remove one fridge-diesel entry from the refrigerated trailer use named — only that one. */
export function removeReeferDiesel(input: RemoveReeferDieselInput): Promise<LocalShift | null> {
  return queued(async () => {
    const open = await readOpenShift();
    const target = reefer(locateTrailer(open, input.shiftId, input.trailerStartedAt, input.usageState));
    if (open === null || target === null) return null;
    if (!target.use.reeferDiesel.some(stored => stored.id === input.fillId)) return open;
    return writeTrailerUse(open, target, { reeferDiesel: target.use.reeferDiesel.filter(stored => stored.id !== input.fillId) });
  });
}

/** The target, if it is a refrigerated trailer: a standard one has no fridge unit. */
function reefer(target: TrailerTarget | null): TrailerTarget | null {
  return target !== null && target.use.trailerType === TRAILER_TYPE.refrigerated ? target : null;
}

/**
 * Thrown when Discard failed AFTER it had removed something — or when whether
 * it had cannot be known. The day may be gone while its temporary file is
 * still there, so the driver must never be told "nothing was changed". An
 * error thrown by Discard that is NOT this one left the files exactly as they
 * were.
 */
export class DiscardIncompleteError extends Error {
  constructor(cause: unknown) {
    super("The shift could not be discarded completely", { cause });
    this.name = "DiscardIncompleteError";
  }
}

/**
 * Forget the open shift. The end of a day, and the reset a test needs.
 *
 * The live day file is removed FIRST, then the temporary file; each only if
 * it is there. A failure before anything was removed is rethrown as it is —
 * the day is exactly as it was. A failure after the live file was removed, or
 * where a delete threw and the file is no longer there to prove otherwise,
 * is a `DiscardIncompleteError`. Nothing is put back: what is on the disk is
 * what the next read reports.
 */
export function clearOpenShift(): Promise<void> {
  // Through the same queue as every write: a write already in flight finishes
  // first, and cannot then re-create the file after it was deleted — a
  // discarded day never comes back (hardening audit, 2026-09-28).
  // The day's unfinished next state goes with it, so a discarded day is not
  // later kept as recovery. Recovery files are left alone: they are not the
  // day being discarded.
  return queued(() => {
    let removedAny = false;
    for (const file of [openShiftFile(), new File(Paths.document, OPEN_SHIFT_TEMP_FILE)]) {
      let deleting = false;
      try {
        if (file.exists) {
          deleting = true;
          file.delete();
          removedAny = true;
        }
      } catch (error: unknown) {
        if (!removedAny && (!deleting || stillThere(file))) throw error;
        throw new DiscardIncompleteError(error);
      }
    }
    return Promise.resolve();
  });
}

/** Whether a file whose delete just threw is provably still there. Unknown counts as gone. */
function stillThere(file: File): boolean {
  try {
    return file.exists;
  } catch {
    return false;
  }
}
