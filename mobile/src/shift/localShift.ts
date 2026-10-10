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
 * A FINISHED DAY LEAVES THIS FILE. Finish Shift files it as its own
 * completed record and only then removes the open day (`finishOpenShift`):
 * the open file only ever holds the day being worked.
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
 * (`previousVehicles`). A use is identified by its `useId` — given once,
 * when the use is created, and never changed (D42) — never by its plate, and
 * never by when it began: `startedAt` is a business time the driver may
 * correct, not a name. Returning to a truck used this morning is a NEW use,
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
import { Directory, File, Paths } from "expo-file-system";
import { AccountScope, AccountScopeError, assertLiveScope, accountDirectory } from "./accountScope";
import { USE_ENDED_BY, asUseEndedBy, type UseEndedBy } from "./useEnd";
import { readUseId } from "./useIdentity";
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

/**
 * The vehicle classes a driver may book on with. The ids are what is stored
 * and never change; the labels are what the driver reads, in words used
 * worldwide (D52) rather than the UK licence categories the ids come from.
 */
export type VehicleClass = "class1" | "class2" | "van";

export const VEHICLE_CLASSES: readonly { id: VehicleClass; label: string }[] = [
  { id: "class1", label: "Articulated truck" },
  { id: "class2", label: "Rigid truck" },
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
  /** This use's identity — immutable, never its start or plate (`useIdentity.ts`, D42). */
  useId: string;
  /**
   * When this vehicle's use in the day BEGAN — business time, correctable
   * under the day's chronology (D42); NOT its identity. One meaning, whichever way the
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
  /** Present only when the day's Finish Shift ended it (`useEnd.ts`). */
  endedBy?: UseEndedBy;
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

/**
 * Every status a local day can have: OPEN while it is being worked, and
 * COMPLETED once the driver has finished it (`finishOpenShift`). Nothing here
 * is a server status — a completed day has been sent nowhere (D28).
 */
export const LOCAL_SHIFT_STATUS = { open: "open", completed: "completed" } as const;

export interface LocalShift {
  /** Explicitly recovered from an interrupted, unacknowledged save (F-37). */
  recoveredAt?: string;
  /**
   * The account this day belongs to — the server-confirmed `user.id` of the
   * driver who started it (F-31). Written once, when the day starts, and
   * checked against the account's scope on every read and every write: a day
   * naming anyone else is never served or written over.
   */
  ownerUserId: string;
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
  status: typeof LOCAL_SHIFT_STATUS.open;
  createdAt: string;
}

export interface StartLocalShiftInput {
  workingFor: WorkingContext;
  startedAt: Date;
  /** As entered. Its use is recorded as starting at `startedAt` above. */
  vehicle: VehicleDetails | null;
}

/**
 * The open day's file name — inside the account's own directory,
 * `accounts/<user.id>/` (F-31), never in the shared document directory.
 * Exported so a test can assert the record reaches a real file.
 */
export const OPEN_SHIFT_FILE = "logisticbay-open-shift.json";

function openShiftFile(scope: AccountScope): File {
  return new File(accountDirectory(scope), OPEN_SHIFT_FILE);
}

/** The interrupted-write copy of THIS account's day — see `persist`. */
function openShiftTempFile(scope: AccountScope): File {
  return new File(accountDirectory(scope), OPEN_SHIFT_TEMP_FILE);
}

/**
 * Where the NEXT state of the day is written in full before it replaces the
 * live file. Never read as the day — see `persist`.
 */
export const OPEN_SHIFT_TEMP_FILE = "logisticbay-open-shift.next.json";

/**
 * Every file kept for recovery starts with this, followed by why it was kept
 * (`unreadable-` or `unfinished-`), the time and a random id. Unfinished copies may be offered for explicit owner-confirmed recovery
 * under D62; no copy is silently accepted. Other recovery bytes are retained.
 */
export const RECOVERY_FILE_PREFIX = "logisticbay-open-shift.recovery-";

/**
 * Move a file the app cannot use aside, byte for byte, under a name no other
 * file has. Throws — and leaves the file exactly where it was — if that cannot
 * be done: the caller must then write nothing over it.
 */
function preserveForRecovery(scope: AccountScope, file: File, reason: "unreadable" | "unfinished"): void {
  // Kept in the account the file belonged to — never anywhere another
  // account's scope can reach.
  const recovery = new File(accountDirectory(scope), `${RECOVERY_FILE_PREFIX}${reason}-${Date.now()}-${newLocalId()}.json`);
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
function writeVerified(scope: AccountScope, serialised: string): File {
  const written = openShiftTempFile(scope);
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
 * (`preserveForRecovery`), so it is kept and never mistaken for the day. D62 permits explicit
 * owner-confirmed recovery only while the destination is missing.
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
function persist(scope: AccountScope, next: LocalShift): LocalShift {
  // Only ever this account's own day, in this account's own directory.
  if (next.ownerUserId !== scope.userId) throw new AccountScopeError("Refusing to store another account's day");
  const serialised = JSON.stringify(next);
  if (asLocalShift(JSON.parse(serialised)) === null) {
    throw new Error("Refusing to store a day the reader would refuse");
  }

  storeSafely(scope, serialised, openShiftFile(scope), { overwrite: true });
  return next;
}

/**
 * Steps 2 and 3 of `persist`, for any file the day is saved to: the live
 * day, or a finished day's record (`finishOpenShift`), which never overwrites.
 * Every failure is a `SafeSaveFailedError`.
 */
function storeSafely(scope: AccountScope, serialised: string, target: File, options: { overwrite: boolean }): void {
  try {
    const temp = openShiftTempFile(scope);
    // Left by an interrupted write: kept, never promoted, never overwritten.
    if (temp.exists) preserveForRecovery(scope, temp, "unfinished");
    writeVerified(scope, serialised).moveSync(target, options);
  } catch (error: unknown) {
    throw new SafeSaveFailedError(error);
  }
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
  const owner = ownerOf(value);
  if (owner === null) return null;
  const day = asLocalShiftContent(value);
  return day === null ? null : { ownerUserId: owner, ...day };
}

/**
 * The record's owner, or `null` when it names none that could be an account:
 * a record with no valid owner is never served as anyone's (F-31). Only a
 * record written before accounts existed lacks the field, and those are
 * quarantined, never read as a day (`quarantineLegacyRecords`).
 */
function ownerOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const owner = (value as Record<string, unknown>)["ownerUserId"];
  return typeof owner === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(owner) ? owner : null;
}

/** Everything about an open day except whose it is. */
function asLocalShiftContent(value: unknown): Omit<LocalShift, "ownerUserId"> | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  const { id, startedAt, createdAt, status, workingFor, vehicle } = record;
  const recoveredAt = record["recoveredAt"];
  if (recoveredAt !== undefined && !isInstant(recoveredAt)) return null;
  if (typeof id !== "string" || id === "") return null;
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) return null;
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) return null;
  if (status !== LOCAL_SHIFT_STATUS.open) return null;

  const context = asWorkingContext(workingFor);
  if (context === null) return null;

  const asVehicle = vehicle === null ? null : asLocalVehicle(vehicle, startedAt);
  if (vehicle !== null && asVehicle === null) return null;
  // The vehicle in use carries no end: an ended use belongs to the history.
  if (vehicle !== null && hasEnd(vehicle)) return null;

  const previous = asPreviousVehicles(record["previousVehicles"]);
  if (previous === null) return null;
  // Nothing on a day still being worked was ended by its finish.
  if (previous.some(use => use.endedBy !== undefined)) return null;
  // One vehicle at a time, so no two uses share a start; and each use its own id.
  const vehicleUses = [...previous, ...(asVehicle === null ? [] : [asVehicle])];
  if (!distinct(vehicleUses.map(use => use.startedAt)) || !distinct(vehicleUses.map(use => use.useId))) return null;

  const trailers = asTrailers(record["trailer"], record["previousTrailers"]);
  if (trailers === null) return null;
  if (trailers.previousTrailers.some(use => use.endedBy !== undefined)) return null;
  // A trailer in use requires a vehicle in use that tows it (D34). A day that
  // says otherwise was not written by this app, and is not guessed at.
  if (trailers.trailer !== null && (asVehicle === null || !towsTrailers(asVehicle.vehicleClass))) return null;

  return { id, workingFor: context, startedAt, vehicle: asVehicle, previousVehicles: previous, ...trailers, status: LOCAL_SHIFT_STATUS.open, createdAt, ...(typeof recoveredAt === "string" ? { recoveredAt } : {}) };
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

  const trailerUses = [...previousTrailers, ...(trailer === null ? [] : [trailer])];
  if (!distinct(trailerUses.map(use => use.startedAt)) || !distinct(trailerUses.map(use => use.useId))) return null;
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
  const endedBy = asUseEndedBy(record["endedBy"]);
  if (endedBy === null) return null;
  return endedBy === undefined ? { ...use, endMileage, endedAt } : { ...use, endMileage, endedAt, endedBy };
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

  const useId = readUseId(record["useId"], "vehicle", usageStartedAt);
  if (useId === null) return null;
  return { ...vehicle, useId, startedAt: usageStartedAt, checks: readChecks(record["checks"], vehicle.vehicleClass), fills };
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

/**
 * The day THIS ACCOUNT has open, or null. Rejects only for a scope that is
 * not live (`AccountScopeError`) — otherwise never throws.
 */
export async function readOpenShift(scope: AccountScope): Promise<LocalShift | null> {
  quarantineLegacyRecords();
  const file = openShiftFile(scope);
  if (!file.exists) return null;

  try {
    const read = asLocalShift(JSON.parse(await file.text()));
    // Another account's day is not this account's open day, wherever it is
    // found (F-31): never served, and never the base of a write.
    const shift = read !== null && read.ownerUserId === scope.userId ? read : null;
    // Already filed as finished: the leftover of a finish that could not
    // remove the open file (`finishOpenShift`). Not open, and never finished
    // twice.
    if (shift !== null && readCompletedSync(scope, shift.id) !== null) return null;
    return shift;
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

function queued<T>(scope: AccountScope, work: () => Promise<T>): Promise<T> {
  // Checked when the work RUNS, not when it was asked for: a driver who
  // signed out while this waited behind another write must not complete it.
  const run = (): Promise<T> => {
    assertLiveScope(scope);
    quarantineLegacyRecords();
    return work();
  };
  const result = writing.then(run, run);
  writing = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Begin the working day, or hand back the one already in progress.
 *
 * Never rejects for want of a network, because it never uses one.
 */
export function startLocalShift(scope: AccountScope, input: StartLocalShiftInput): Promise<LocalShift> {
  return queued(scope, () => createIfNoneOpen(scope, input));
}

async function createIfNoneOpen(scope: AccountScope, input: StartLocalShiftInput): Promise<LocalShift> {
  // Refused before anything is read or written: the same rule every vehicle
  // write applies, so Start Shift cannot store a day the reader would refuse.
  const vehicle = input.vehicle === null ? null : checkedVehicle(input.vehicle, "Refusing to store an invalid vehicle");
  if (Number.isNaN(input.startedAt.getTime())) throw new Error("Refusing a shift with an invalid start");

  const alreadyOpen = await readOpenShift(scope);
  if (alreadyOpen !== null) return alreadyOpen;

  const startedAt = input.startedAt.toISOString();
  const shift: LocalShift = {
    // The account starting the day owns it, for good (F-31).
    ownerUserId: scope.userId,
    id:         newLocalId(),
    workingFor: input.workingFor,
    startedAt,
    // A vehicle given at the start began with the day: the same instant.
    vehicle:    vehicle === null ? null : { ...vehicle, useId: newLocalId(), startedAt, checks: [], fills: [] },
    previousVehicles: [],
    trailer:          null,
    previousTrailers: [],
    status:     LOCAL_SHIFT_STATUS.open,
    createdAt:  new Date().toISOString(),
  };

  // A day file is there but cannot be read — an older build, a damaged write.
  // It is never written over: its exact bytes are moved aside first, and if
  // that fails this throws and no new day is started.
  const live = openShiftFile(scope);
  if (live.exists) {
    // A finished day's leftover holds nothing its completed record does not.
    if (isFinishedLeftover(scope, live)) live.delete();
    // Another account's day in this account's place (F-31): out of every
    // account's reach, never adopted, never written over.
    else if (isForeign(scope, live)) moveToQuarantine(live, FOREIGN_PREFIX);
    else preserveForRecovery(scope, live, "unreadable");
  }

  return persist(scope, shift);
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
export function addVehicleToOpenShift(scope: AccountScope, input: AddVehicleInput): Promise<LocalShift | null> {
  return queued(scope, () => addIfNoVehicle(scope, input));
}

async function addIfNoVehicle(scope: AccountScope, { vehicle: entered, startedAt }: AddVehicleInput): Promise<LocalShift | null> {
  const vehicle = checkedVehicle(entered, "Refusing to store an invalid vehicle");
  if (Number.isNaN(startedAt.getTime())) throw new Error("Refusing to store an invalid vehicle");

  const open = await readOpenShift(scope);
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

  const updated: LocalShift = { ...open, vehicle: { ...vehicle, useId: newLocalId(), startedAt: at, checks: [], fills: [] } };
  return persist(scope, updated);
}

export interface ChangeVehicleInput {
  /** The day being changed. */
  shiftId: string;
  /** The use being ended, by its `useId` — the vehicle the driver saw on screen. */
  endingUseId: string;
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
 * is still the one named by `endingUseId`; a second press finds the new
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
export function changeVehicle(scope: AccountScope, input: ChangeVehicleInput): Promise<LocalShift | null> {
  return queued(scope, () => changeIfCurrent(scope, input));
}

async function changeIfCurrent(scope: AccountScope, { shiftId, endingUseId, endMileage, next: entered, changedAt }: ChangeVehicleInput): Promise<LocalShift | null> {
  const next = checkedVehicle(entered, "Refusing an invalid vehicle change");
  if (!Number.isSafeInteger(endMileage) || endMileage < 0 || Number.isNaN(changedAt.getTime())) {
    throw new Error("Refusing an invalid vehicle change");
  }

  const open = await readOpenShift(scope);
  if (open === null || open.id !== shiftId) return null;
  const current = open.vehicle;
  // Already changed — by an earlier press — or nothing to change from.
  if (current?.useId !== endingUseId) return open;

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
    vehicle: { ...next, useId: newLocalId(), startedAt: at, checks: [], fills: [] },
    previousVehicles: [...open.previousVehicles, ended],
  };
  return persist(scope, updated);
}

export interface EndVehicleUseInput {
  /** The day being changed. */
  shiftId: string;
  /** The use being ended, by its `useId` — the vehicle the driver saw on screen. */
  endingUseId: string;
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
 * while the vehicle in use is still the one named by `endingUseId`, so a
 * second press finds none there and returns the day unchanged. Resolves to the
 * day as it now stands, or `null` when that day is not the one open.
 *
 * REFUSES — rejects, writing nothing — an end mileage below the use's start
 * mileage, a reading or moment that is not real, and ANY end while a trailer
 * is in use (`TrailerStillInUseError`): no vehicle would leave it with nothing
 * to tow it (D34). The driver hands the trailer back first.
 */
export function endVehicleUse(scope: AccountScope, input: EndVehicleUseInput): Promise<LocalShift | null> {
  return queued(scope, () => endIfCurrent(scope, input));
}

async function endIfCurrent(scope: AccountScope, { shiftId, endingUseId, endMileage, endedAt }: EndVehicleUseInput): Promise<LocalShift | null> {
  if (!Number.isSafeInteger(endMileage) || endMileage < 0 || Number.isNaN(endedAt.getTime())) {
    throw new Error("Refusing an invalid end of a vehicle use");
  }

  const open = await readOpenShift(scope);
  if (open === null || open.id !== shiftId) return null;
  const current = open.vehicle;
  // Already ended — by an earlier press — or nothing to end.
  if (current?.useId !== endingUseId) return open;

  const at = endedAt.toISOString();
  assertEndsAfterStart(current.startedAt, at);
  if (endMileage < current.startMileage) throw new Error("Refusing an end mileage below the start mileage");
  // No vehicle would leave the trailer in use with nothing to tow it (D34).
  if (open.trailer !== null) throw new TrailerStillInUseError();

  const ended: EndedVehicle = { ...current, endMileage, endedAt: at };
  const updated: LocalShift = { ...open, vehicle: null, previousVehicles: [...open.previousVehicles, ended] };
  return persist(scope, updated);
}

export interface VehicleCheckWrite {
  /** The day the check belongs to. */
  shiftId: string;
  /** The vehicle use being checked, by its `useId`. */
  vehicleUseId: string;
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
export function saveVehicleCheckDraft(scope: AccountScope, input: VehicleCheckWrite): Promise<VehicleCheck | null> {
  return queued(scope, () => writeCheck(scope, input, null));
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
export function completeVehicleCheck(scope: AccountScope, input: CompleteVehicleCheckInput): Promise<VehicleCheck | null> {
  return queued(scope, () => writeCheck(scope, input, input));
}

export interface CompleteVehicleCheckInput extends VehicleCheckWrite {
  /** The driver's declared moment of certification — see `VehicleCheck`. */
  completedAt: Date;
  /** The authenticated driver's stable user id: who made the declaration. */
  completedBy: string;
}

async function writeCheck(scope: AccountScope, input: VehicleCheckWrite, certification: Certification | null): Promise<VehicleCheck | null> {
  const open = await readDayOfUses(scope, input.shiftId);
  if (open === null) return null;
  // Exactly the use named, in the state named — never by plate (`locateUsage`).
  const target = locateUsage(open, input.vehicleUseId, input.usageState);
  if (target === null) return null;
  const result = nextChecks(target.use.checks, checklistFor(target.use.vehicleClass), input, certification);
  if (result.checks === null) return result.check;

  writeVehicleUse(scope, open, target, { checks: result.checks });
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
  /** The vehicle USE it went into, by its `useId`. */
  vehicleUseId: string;
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
 * IT LANDS ON THE USE NAMED BY `vehicleUseId`, AND NOWHERE ELSE. A fill is
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
export function recordVehicleFill(scope: AccountScope, input: RecordVehicleFillInput): Promise<LocalShift | null> {
  return queued(scope, () => writeFill(scope, input));
}

async function writeFill(scope: AccountScope, { shiftId, vehicleUseId, usageState, fillId, type, recordedAt, litres, note }: RecordVehicleFillInput): Promise<LocalShift | null> {
  if (fillId === "") throw new Error("Refusing a fill with no id");
  if (!FILL_TYPES.some(entry => entry.id === type)) throw new Error("Refusing a fill of an unknown type");
  const described = checkedFillNote({ fillId, recordedAt, litres, note });

  const open = await readDayOfUses(scope, shiftId);
  if (open === null) return null;
  const target = locateUsage(open, vehicleUseId, usageState);
  if (target === null) return null;

  const fill: VehicleFill = { id: fillId, type, recordedAt: recordedAt.toISOString(), litres, note: described };
  return writeFills(scope, open, target, withFill(target.use.fills, fill));
}

/**
 * The one use a `useId` names, in the state the caller expects, or `null`.
 *
 * `useId` IS the identity of a use (see the module header, D42), and no two in
 * a day may share one, so this can never be ambiguous. An unknown name — an
 * empty string, a use from another day, a plate mistaken for a time — matches
 * nothing and the caller writes nothing, rather than falling back to the
 * vehicle in use and correcting the wrong truck. So does a use that exists but
 * is no longer in the expected state: the vehicle a screen was opened for has
 * been handed back since.
 */
function locateUsage(open: LocalShift, useId: string, state: UsageState): { use: LocalVehicle; ended: false } | { use: EndedVehicle; ended: true; index: number } | null {
  if (useId === "") return null;
  if (state === USAGE_STATE.inUse) {
    return open.vehicle !== null && open.vehicle.useId === useId ? { use: open.vehicle, ended: false } : null;
  }
  const index = open.previousVehicles.findIndex(use => use.useId === useId);
  const ended = open.previousVehicles[index];
  return ended === undefined ? null : { use: ended, ended: true, index };
}

/**
 * The day with one use's fills replaced, and NOTHING else touched — an ended
 * use keeps its class, plate, times, mileages and checks exactly as they are.
 */
function writeFills(scope: AccountScope, 
  open: LocalShift,
  target: { use: LocalVehicle; ended: false } | { use: EndedVehicle; ended: true; index: number },
  fills: VehicleFill[],
): LocalShift {
  return writeVehicleUse(scope, open, target, { fills });
}

/** The day with one vehicle use's fills, checks or plate replaced, and NOTHING else touched. */
function writeVehicleUse(scope: AccountScope, 
  open: LocalShift,
  target: { use: LocalVehicle; ended: false } | { use: EndedVehicle; ended: true; index: number },
  patch: Partial<Pick<LocalVehicle, "fills" | "checks" | "numberPlate" | "startMileage">>,
): LocalShift {
  const updated: LocalShift = target.ended
    ? { ...open, previousVehicles: open.previousVehicles.map((use, index) => (index === target.index ? { ...use, ...patch } : use)) }
    : { ...open, vehicle: { ...target.use, ...patch } };
  return saveDay(scope, open, updated);
}

export interface RemoveVehicleFillInput {
  shiftId: string;
  vehicleUseId: string;
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
 * with it, and a `vehicleUseId` naming no use — or a use no longer in the
 * expected state — removes nothing anywhere.
 */
export function removeVehicleFill(scope: AccountScope, input: RemoveVehicleFillInput): Promise<LocalShift | null> {
  return queued(scope, () => deleteFill(scope, input));
}

async function deleteFill(scope: AccountScope, { shiftId, vehicleUseId, usageState, fillId }: RemoveVehicleFillInput): Promise<LocalShift | null> {
  const open = await readDayOfUses(scope, shiftId);
  if (open === null) return null;
  const target = locateUsage(open, vehicleUseId, usageState);
  if (target === null) return null;
  if (!target.use.fills.some(stored => stored.id === fillId)) return open;

  return writeFills(scope, open, target, target.use.fills.filter(stored => stored.id !== fillId));
}

export interface CorrectEndMileageInput {
  shiftId: string;
  /** The ENDED use being corrected, by its `useId`. */
  vehicleUseId: string;
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
export function correctEndMileage(scope: AccountScope, input: CorrectEndMileageInput): Promise<LocalShift | null> {
  return queued(scope, () => rewriteEndMileage(scope, input));
}

async function rewriteEndMileage(scope: AccountScope, { shiftId, vehicleUseId, endMileage }: CorrectEndMileageInput): Promise<LocalShift | null> {
  if (!Number.isSafeInteger(endMileage) || endMileage < 0) throw new Error("Refusing an invalid end mileage");

  const open = await readDayOfUses(scope, shiftId);
  if (open === null) return null;
  const target = locateUsage(open, vehicleUseId, USAGE_STATE.ended);
  if (target === null || !target.ended) return null;
  if (endMileage < target.use.startMileage) throw new Error("Refusing an end mileage below the start mileage");

  const updated: LocalShift = {
    ...open,
    previousVehicles: open.previousVehicles.map((use, index) => (index === target.index ? { ...use, endMileage } : use)),
  };
  return saveDay(scope, open, updated);
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
export function addTrailerToOpenShift(scope: AccountScope, input: AddTrailerInput): Promise<LocalShift | null> {
  return queued(scope, () => addIfNoTrailer(scope, input));
}

async function addIfNoTrailer(scope: AccountScope, { shiftId, trailer, startedAt }: AddTrailerInput): Promise<LocalShift | null> {
  const details = checkedTrailer(trailer);
  if (Number.isNaN(startedAt.getTime())) throw new Error("Refusing to store an invalid trailer");

  const open = await readOpenShift(scope);
  if (open === null || open.id !== shiftId) return null;
  if (open.trailer !== null) return open;
  if (open.vehicle === null || !towsTrailers(open.vehicle.vehicleClass)) {
    throw new Error("Refusing a trailer with no vehicle that tows one");
  }
  const at = startedAt.toISOString();
  if (open.previousTrailers.some(use => use.startedAt === at)) {
    throw new Error("Refusing a trailer use that starts at the same instant as another");
  }

  const updated: LocalShift = { ...open, trailer: { ...details, useId: newLocalId(), startedAt: at, reeferDiesel: [], checks: [] } };
  return persist(scope, updated);
}

export interface ChangeTrailerInput {
  shiftId: string;
  /** The trailer use being ended, by its `useId` — the one the driver saw on screen. */
  endingUseId: string;
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
 * still the one named by `endingUseId`; otherwise the day is returned
 * unchanged. Resolves to `null` when that day is not the one open.
 */
export function changeTrailer(scope: AccountScope, input: ChangeTrailerInput): Promise<LocalShift | null> {
  return queued(scope, () => changeTrailerIfCurrent(scope, input));
}

async function changeTrailerIfCurrent(scope: AccountScope, { shiftId, endingUseId, next, changedAt }: ChangeTrailerInput): Promise<LocalShift | null> {
  const details = next === null ? null : checkedTrailer(next);
  if (Number.isNaN(changedAt.getTime())) throw new Error("Refusing an invalid trailer change");

  const open = await readOpenShift(scope);
  if (open === null || open.id !== shiftId) return null;
  const current = open.trailer;
  if (current?.useId !== endingUseId) return open;

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
    trailer: details === null ? null : { ...details, useId: newLocalId(), startedAt: at, reeferDiesel: [], checks: [] },
    previousTrailers: [...open.previousTrailers, ended],
  };
  return persist(scope, updated);
}

export interface TrailerCheckWrite {
  /** The day the check belongs to. */
  shiftId: string;
  /** The trailer use being checked, by its `useId`. */
  trailerUseId: string;
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
export function saveTrailerCheckDraft(scope: AccountScope, input: TrailerCheckWrite): Promise<VehicleCheck | null> {
  return queued(scope, () => writeTrailerCheck(scope, input, null));
}

/**
 * Complete a Trailer Check: every row materialised, with its section, into an
 * immutable certificate carrying `completedAt` and `completedBy`, in one write.
 * Same refusals as a vehicle's; same targeting rule as the draft. For an ENDED
 * use `completedAt` is still the moment the driver completes it — the caller
 * passes the device clock, never the use's own times: a check is not backdated.
 */
export function completeTrailerCheck(scope: AccountScope, input: CompleteTrailerCheckInput): Promise<VehicleCheck | null> {
  return queued(scope, () => writeTrailerCheck(scope, input, input));
}

async function writeTrailerCheck(scope: AccountScope, input: TrailerCheckWrite, certification: Certification | null): Promise<VehicleCheck | null> {
  const open = await readDayOfUses(scope, input.shiftId);
  const target = locateTrailer(open, input.shiftId, input.trailerUseId, input.usageState);
  if (open === null || target === null) return null;
  const result = nextChecks(target.use.checks, trailerChecklistFor(target.use.trailerType), input, certification);
  if (result.checks === null) return result.check;

  writeTrailerUse(scope, open, target, { checks: result.checks });
  return result.check;
}

type TrailerTarget = { use: LocalTrailer; ended: false } | { use: EndedTrailer; ended: true; index: number };

/**
 * The ONE trailer use a `startedAt` names, in the state the caller expects —
 * or `null`. Never by trailer number, never a fallback to the trailer in use,
 * and an ended use must match exactly once: anything ambiguous is refused.
 */
function locateTrailer(open: LocalShift | null, shiftId: string, useId: string, state: UsageState): TrailerTarget | null {
  if (open === null || open.id !== shiftId || useId === "") return null;
  if (state === USAGE_STATE.inUse) {
    return open.trailer !== null && open.trailer.useId === useId ? { use: open.trailer, ended: false } : null;
  }
  const matches = open.previousTrailers.flatMap((use, index) => (use.useId === useId ? [{ use, index }] : []));
  const [only] = matches;
  return matches.length === 1 && only !== undefined ? { use: only.use, ended: true, index: only.index } : null;
}

/** The day with one trailer use's checks, fridge diesel or number replaced, and NOTHING else touched. */
function writeTrailerUse(scope: AccountScope, open: LocalShift, target: TrailerTarget, patch: Partial<Pick<LocalTrailer, "checks" | "reeferDiesel" | "trailerNumber">>): LocalShift {
  const updated: LocalShift = target.ended
    ? { ...open, previousTrailers: open.previousTrailers.map((use, index) => (index === target.index ? { ...use, ...patch } : use)) }
    : { ...open, trailer: { ...target.use, ...patch } };
  return saveDay(scope, open, updated);
}

/** A correction of a COMPLETED walkaround check — a vehicle's or a trailer's. */
export interface CheckRevisionWrite {
  shiftId: string;
  /** The use the check is on, by its `useId` — never a plate or a trailer number. */
  useId: string;
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
export function reviseVehicleCheck(scope: AccountScope, input: CheckRevisionWrite): Promise<VehicleCheck | null> {
  return queued(scope, async () => {
    const open = await readDayOfUses(scope, input.shiftId);
    if (open === null) return null;
    const target = locateUsage(open, input.useId, input.usageState);
    if (target === null) return null;
    const result = reviseCheck(target.use.checks, checklistFor(target.use.vehicleClass), input);
    if (result.checks !== null) writeVehicleUse(scope, open, target, { checks: result.checks });
    return result.check;
  });
}

/**
 * Correct a completed Trailer Check (D36). See `reviseCheck`.
 */
export function reviseTrailerCheck(scope: AccountScope, input: CheckRevisionWrite): Promise<VehicleCheck | null> {
  return queued(scope, async () => {
    const open = await readDayOfUses(scope, input.shiftId);
    const target = locateTrailer(open, input.shiftId, input.useId, input.usageState);
    if (open === null || target === null) return null;
    const result = reviseCheck(target.use.checks, trailerChecklistFor(target.use.trailerType), input);
    if (result.checks !== null) writeTrailerUse(scope, open, target, { checks: result.checks });
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

  // A correction speaks in the words of the check it corrects — the words the
  // driver sees on screen while correcting it (`sectionsOf` shows a completed
  // check from itself) — not in a later rewording of the checklist. Keys are
  // permanent, so each row's own label is found by its key (owner decision,
  // 2026-10-03). This also keeps a rewording from making an unchanged save
  // look like a correction.
  const recorded = new Map(effectiveItems(existing).map(item => [item.key, item.label]));
  const items = materialise(checklist, input.answers, { completedAt: input.revisedAt, completedBy: input.revisedBy })
    .map(item => ({ ...item, label: recorded.get(item.key) ?? item.label }));
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
  /** The trailer use it went into, by its `useId`. */
  trailerUseId: string;
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
export function recordReeferDiesel(scope: AccountScope, input: RecordReeferDieselInput): Promise<LocalShift | null> {
  return queued(scope, () => writeReeferDiesel(scope, input));
}

async function writeReeferDiesel(scope: AccountScope, { shiftId, trailerUseId, usageState, fillId, recordedAt, litres, note }: RecordReeferDieselInput): Promise<LocalShift | null> {
  const described = checkedFillNote({ fillId, recordedAt, litres, note });

  const open = await readDayOfUses(scope, shiftId);
  const target = reefer(locateTrailer(open, shiftId, trailerUseId, usageState));
  if (open === null || target === null) return null;

  const fill: FillRecord = { id: fillId, recordedAt: recordedAt.toISOString(), litres, note: described };
  return writeTrailerUse(scope, open, target, { reeferDiesel: withFill(target.use.reeferDiesel, fill) });
}

export interface RemoveReeferDieselInput {
  shiftId: string;
  trailerUseId: string;
  /** Whether that use is expected to be the trailer in use, or one that has ended. */
  usageState: UsageState;
  fillId: string;
}

/** Remove one fridge-diesel entry from the refrigerated trailer use named — only that one. */
export function removeReeferDiesel(scope: AccountScope, input: RemoveReeferDieselInput): Promise<LocalShift | null> {
  return queued(scope, async () => {
    const open = await readDayOfUses(scope, input.shiftId);
    const target = reefer(locateTrailer(open, input.shiftId, input.trailerUseId, input.usageState));
    if (open === null || target === null) return null;
    if (!target.use.reeferDiesel.some(stored => stored.id === input.fillId)) return open;
    return writeTrailerUse(scope, open, target, { reeferDiesel: target.use.reeferDiesel.filter(stored => stored.id !== input.fillId) });
  });
}

/** The target, if it is a refrigerated trailer: a standard one has no fridge unit. */
function reefer(target: TrailerTarget | null): TrailerTarget | null {
  return target !== null && target.use.trailerType === TRAILER_TYPE.refrigerated ? target : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Correcting what was typed: a use's plate or trailer number (D39, D40)
// ═══════════════════════════════════════════════════════════════════════════

export interface CorrectUseNameInput {
  /** The day: the open one, or a finished one. */
  shiftId: string;
  /** The use being corrected, by its `useId` — never by the name being corrected. */
  useId: string;
  /** Whether that use is expected to be in use, or ended. Nothing on a finished day is in use. */
  usageState: UsageState;
  /** As typed; trimmed and upper-cased as every entry of it is. */
  value: string;
}

/**
 * Correct the number plate of ONE vehicle use — in use, ended earlier today,
 * or on a finished day — when it was typed wrong. Found by the use's
 * identity, never by its plate: another use of the same wrong plate is
 * untouched. ONLY the plate changes: the use keeps its identity, class,
 * mileage, times, fills and checks. Resolves to the day, or `null` —
 * writing nothing — when that use is not found in the state named. Refuses
 * an empty plate. Replaces the value, like a fill correction: an unsent day
 * is the driver's own record (D40).
 */
export function correctNumberPlate(scope: AccountScope, { shiftId, useId, usageState, value }: CorrectUseNameInput): Promise<LocalShift | null> {
  return queued(scope, async () => {
    const numberPlate = normalisePlate(value);
    if (numberPlate === "") throw new Error("Refusing an empty number plate");
    const open = await readDayOfUses(scope, shiftId);
    if (open === null) return null;
    const target = locateUsage(open, useId, usageState);
    if (target === null) return null;
    if (target.use.numberPlate === numberPlate) return open;
    return writeVehicleUse(scope, open, target, { numberPlate });
  });
}

/**
 * Correct the number of ONE trailer use — the same rule as the plate: only
 * the number changes, never its type, identity, times, fridge diesel or
 * checks, and never another use of the same number.
 */
export function correctTrailerNumber(scope: AccountScope, { shiftId, useId, usageState, value }: CorrectUseNameInput): Promise<LocalShift | null> {
  return queued(scope, async () => {
    const trailerNumber = normaliseTrailerNumber(value);
    if (trailerNumber === "") throw new Error("Refusing an empty trailer number");
    const open = await readDayOfUses(scope, shiftId);
    const target = locateTrailer(open, shiftId, useId, usageState);
    if (open === null || target === null) return null;
    if (target.use.trailerNumber === trailerNumber) return open;
    return writeTrailerUse(scope, open, target, { trailerNumber });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Correcting the open day before it is finished (D41)
// ═══════════════════════════════════════════════════════════════════════════

export interface CorrectStartMileageInput {
  /** The day: the open one, or a finished one. */
  shiftId: string;
  /** The use, by its `useId` — never by its plate. */
  vehicleUseId: string;
  usageState: UsageState;
  /** Whole miles, as the driver now reads it. */
  startMileage: number;
}

/**
 * Correct the start mileage of ONE vehicle use, typed wrong. ONLY that
 * mileage changes; an ended use's end mileage may not then be below it
 * (refused, never adjusted). Resolves to the day, or `null` — writing
 * nothing — when that use is not found in the state named.
 */
export function correctStartMileage(scope: AccountScope, { shiftId, vehicleUseId, usageState, startMileage }: CorrectStartMileageInput): Promise<LocalShift | null> {
  return queued(scope, async () => {
    if (!Number.isSafeInteger(startMileage) || startMileage < 0) throw new Error("Refusing an invalid start mileage");
    const open = await readDayOfUses(scope, shiftId);
    if (open === null) return null;
    const target = locateUsage(open, vehicleUseId, usageState);
    if (target === null) return null;
    if (target.ended && target.use.endMileage < startMileage) throw new Error("Refusing a start mileage above the end mileage");
    if (target.use.startMileage === startMileage) return open;
    return writeVehicleUse(scope, open, target, { startMileage });
  });
}

// ─── A use's own start and end (D42) ──────────────────────────────────────

export interface CorrectUseTimesInput {
  /** The day: the open one, or a finished one. */
  shiftId: string;
  /** The use, by its identity — never its start, plate or number. */
  useId: string;
  usageState: UsageState;
  startedAt: Date;
  /** The corrected end — `null` exactly when the use is still in use. */
  endedAt: Date | null;
}

/** Why a use's corrected times cannot stand. */
export type UseTimesProblem =
  | { kind: "end-before-start" }
  | { kind: "before-shift-start"; at: string }
  | { kind: "after-shift-finish"; at: string }
  | { kind: "overlaps"; name: string; startedAt: string; endedAt: string | null }
  | { kind: "trailer-untowed"; name: string };

/** Thrown — writing nothing — for use times the day cannot hold (`UseTimesProblem`). */
export class UseTimesError extends Error {
  readonly problem: UseTimesProblem;
  constructor(problem: UseTimesProblem) {
    super("Refusing use times the day cannot hold");
    this.name = "UseTimesError";
    this.problem = problem;
  }
}

/**
 * Correct when ONE vehicle use started and — once it has ended — when it
 * ended, found by its identity (D42). Resolves to the day, or `null` —
 * writing nothing — when that use is not found in the state named.
 *
 * INDEPENDENT BOUNDARIES. A change of vehicle stored the old use's end and
 * the next use's start as two values; they are two facts, and correcting one
 * never moves the other. The corrected day must still hold: the end not
 * before the start; not before the shift began, nor after it finished; no
 * two vehicle uses overlapping (a gap is a time with no vehicle — D32); and
 * no trailer left without a towing vehicle it had before. Anything else is
 * refused (`UseTimesError`) with the rule, and no other use moves.
 *
 * A use the day's FINISH ended (`endedBy: "finish"`) whose end is corrected
 * becomes a use with its own end — the mark is dropped, because it no longer
 * ends at the finish (D40). Its identity, plate, class, mileage, fills and
 * checks never change here.
 */
export function correctVehicleUseTimes(scope: AccountScope, input: CorrectUseTimesInput): Promise<LocalShift | null> {
  return queued(scope, async () => {
    const open = await readDayOfUses(scope, input.shiftId);
    if (open === null) return null;
    const target = locateUsage(open, input.useId, input.usageState);
    if (target === null) return null;
    const next = retimed(target.use, input);
    if (next === null) return open;
    const updated: LocalShift = target.ended
      ? { ...open, previousVehicles: open.previousVehicles.map((use, index) => (index === target.index ? next as EndedVehicle : use)) }
      : { ...open, vehicle: next };
    throwIfUnheld(open, updated, "vehicle", input.useId);
    return saveDay(scope, open, updated);
  });
}

/** Correct when ONE trailer use started and ended — the same rules as a vehicle's. */
export function correctTrailerUseTimes(scope: AccountScope, input: CorrectUseTimesInput): Promise<LocalShift | null> {
  return queued(scope, async () => {
    const open = await readDayOfUses(scope, input.shiftId);
    const target = locateTrailer(open, input.shiftId, input.useId, input.usageState);
    if (open === null || target === null) return null;
    const next = retimed(target.use, input);
    if (next === null) return open;
    const updated: LocalShift = target.ended
      ? { ...open, previousTrailers: open.previousTrailers.map((use, index) => (index === target.index ? next as EndedTrailer : use)) }
      : { ...open, trailer: next };
    throwIfUnheld(open, updated, "trailer", input.useId);
    return saveDay(scope, open, updated);
  });
}

/**
 * The use with its corrected times — or `null` when they change nothing.
 * Refuses an in-use use given an end, an ended one given none, and invalid times.
 */
function retimed<T extends { startedAt: string; endedAt?: string; endedBy?: UseEndedBy }>(use: T, { startedAt, endedAt }: CorrectUseTimesInput): T | null {
  if (Number.isNaN(startedAt.getTime()) || (endedAt !== null && Number.isNaN(endedAt.getTime()))) throw new Error("Refusing an invalid time");
  const ended = use.endedAt !== undefined;
  if (ended !== (endedAt !== null)) throw new Error(ended ? "Refusing to take the end from an ended use" : "Refusing an end for a use still in use");
  const start = startedAt.toISOString();
  const end = endedAt === null ? undefined : endedAt.toISOString();
  if (start === use.startedAt && end === use.endedAt) return null;
  if (end === undefined) return { ...use, startedAt: start };
  if (end === use.endedAt) return { ...use, startedAt: start };
  // Its own end now: no longer the finish's (D40).
  const { endedBy: _finish, ...own } = use;
  return { ...own, startedAt: start, endedAt: end } as T;
}

/** An interval of a use: an open end (still in use) runs on for ever. */
interface Span { useId: string; name: string; start: number; end: number; startedAt: string; endedAt: string | null; tows: boolean }

function spans(day: LocalShift, kind: "vehicle" | "trailer"): Span[] {
  const span = (use: { useId: string; startedAt: string; endedAt?: string }, name: string, tows: boolean): Span => ({
    useId: use.useId, name, tows,
    start: Date.parse(use.startedAt),
    end: use.endedAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(use.endedAt),
    startedAt: use.startedAt, endedAt: use.endedAt ?? null,
  });
  if (kind === "vehicle") {
    return [...day.previousVehicles, ...(day.vehicle === null ? [] : [day.vehicle])]
      .map(use => span(use, use.numberPlate, towsTrailers(use.vehicleClass)));
  }
  return [...day.previousTrailers, ...(day.trailer === null ? [] : [day.trailer])]
    .map(use => span(use, `trailer ${use.trailerNumber}`, false));
}

/** The trailer uses NOT covered, end to end, by uses of vehicles that tow. */
function untowedTrailers(day: LocalShift): string[] {
  const towing = spans(day, "vehicle").filter(span => span.tows).sort((a, b) => a.start - b.start);
  return spans(day, "trailer").filter(trailer => {
    let reached = trailer.start;
    for (const vehicle of towing) {
      if (vehicle.start > reached) break;
      reached = Math.max(reached, vehicle.end);
      if (reached >= trailer.end) return false;
    }
    return reached < trailer.end;
  }).map(trailer => trailer.useId);
}

/** Refuse the corrected day unless it holds (see `correctVehicleUseTimes`). */
function throwIfUnheld(before: LocalShift, after: LocalShift, kind: "vehicle" | "trailer", useId: string): void {
  const own = spans(after, kind).find(span => span.useId === useId);
  if (own === undefined) throw new Error("Refusing a correction that loses its use");
  if (own.end < own.start) throw new UseTimesError({ kind: "end-before-start" });
  if (own.start < Date.parse(after.startedAt)) throw new UseTimesError({ kind: "before-shift-start", at: after.startedAt });
  const finished = finishedBehind.get(before);
  if (finished !== undefined) {
    const finish = effectiveFacts(finished).endedAt;
    const byFinish = kind === "vehicle"
      ? after.previousVehicles.find(use => use.useId === useId)?.endedBy === USE_ENDED_BY.finish
      : after.previousTrailers.find(use => use.useId === useId)?.endedBy === USE_ENDED_BY.finish;
    if ((byFinish ? own.start : own.end) > Date.parse(finish)) throw new UseTimesError({ kind: "after-shift-finish", at: finish });
  }
  // One vehicle — one trailer — at a time: touching is a change, overlapping is
  // two at once — and so is starting at the same instant, even for no time at all.
  const clash = spans(after, kind).find(other => other.useId !== useId && (other.start === own.start || (other.start < own.end && own.start < other.end)));
  if (clash !== undefined) throw new UseTimesError({ kind: "overlaps", name: clash.name, startedAt: clash.startedAt, endedAt: clash.endedAt });
  // No trailer left without a towing vehicle it had before (D30, D34).
  const untowedBefore = new Set(untowedTrailers(before));
  const newlyUntowed = untowedTrailers(after).find(trailer => !untowedBefore.has(trailer));
  if (newlyUntowed !== undefined) {
    throw new UseTimesError({ kind: "trailer-untowed", name: spans(after, "trailer").find(span => span.useId === newlyUntowed)?.name ?? "the trailer" });
  }
}

export interface CorrectOpenShiftInput {
  shiftId: string;
  workingFor: WorkingContext;
  /** The declared start, as the driver now gives it. */
  startedAt: Date;
}

/**
 * Correct who the OPEN day is worked for and when it started — from the
 * Finish Review, before the day is finished (D41). Choosing a company sends
 * nothing (D28). The start may not be after any use of the day began
 * (`TimesheetBoundsError`): no use is moved to fit it — a use's start is its
 * own business time, corrected on its own page. An EARLIER start moves
 * nothing: a shift may start before its first use (D42). Resolves to the
 * day, or `null` when it is not the open one.
 */
export function correctOpenShift(scope: AccountScope, { shiftId, workingFor: entered, startedAt }: CorrectOpenShiftInput): Promise<LocalShift | null> {
  return queued(scope, async () => {
    const workingFor = asWorkingContext(entered);
    if (workingFor === null) throw new Error("Refusing an unknown working context");
    if (Number.isNaN(startedAt.getTime())) throw new Error("Refusing an invalid start");
    const open = await readOpenShift(scope);
    if (open === null || open.id !== shiftId) return null;
    const at = startedAt.toISOString();
    const uses = [
      ...open.previousVehicles.map(use => ({ name: use.numberPlate, startedAt: use.startedAt })),
      ...(open.vehicle === null ? [] : [{ name: open.vehicle.numberPlate, startedAt: open.vehicle.startedAt }]),
      ...open.previousTrailers.map(use => ({ name: `trailer ${use.trailerNumber}`, startedAt: use.startedAt })),
      ...(open.trailer === null ? [] : [{ name: `trailer ${open.trailer.trailerNumber}`, startedAt: open.trailer.startedAt }]),
    ];
    const first = uses.filter(use => Date.parse(use.startedAt) < Date.parse(at)).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0];
    if (first !== undefined) throw new TimesheetBoundsError({ kind: "start-after-use", name: first.name, at: first.startedAt });
    if (open.startedAt === at && JSON.stringify(open.workingFor) === JSON.stringify(workingFor)) return open;
    return persist(scope, { ...open, workingFor, startedAt: at });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Finishing the day
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Where a finished day is filed: one file per day, named by its local id,
 * beside the open day's file and never read as it. A finished day is still
 * the driver's own local record — nothing is sent when it is filed (D28).
 */
export const COMPLETED_SHIFT_FILE_PREFIX = "logisticbay-completed-shift-";

/** Driver notes on a finished day: the app's bound for a free-text note, as fills and defects use. */
export const SHIFT_NOTES_MAX_LENGTH = 500;

/**
 * A FINISHED working day, as the phone keeps it.
 *
 * The open day's own facts, carried unchanged, plus what finishing adds. At
 * the finish every use has ended, so there is no vehicle or trailer IN USE:
 * the one in use when the driver finished is the last entry of
 * `previousVehicles` / `previousTrailers`, ended at `endedAt` — the same
 * lists, the same shapes, the same meaning as on the open day.
 */
export interface CompletedShift {
  recoveredAt?: string;
  /** The account this day belongs to, carried from the open day (F-31). */
  ownerUserId: string;
  id: string;
  workingFor: WorkingContext;
  startedAt: string;
  /** The finish the driver DECLARED — named as the server's `Shift.endedAt`. */
  endedAt: string;
  /** Whether the driver had a night out. A fact on the timesheet, nothing more (D18). */
  nightOut: boolean;
  /** Trimmed; `null` when the driver wrote none — named as `Shift.notes`. */
  notes: string | null;
  previousVehicles: EndedVehicle[];
  previousTrailers: EndedTrailer[];
  status: typeof LOCAL_SHIFT_STATUS.completed;
  createdAt: string;
  /**
   * CORRECTIONS of the day's own facts after the finish, oldest first —
   * append-only (D39). The fields above stay exactly as the day was
   * finished; the latest correction is what the day says now
   * (`effectiveFacts`). Absent means none.
   */
  corrections?: ShiftCorrection[];
  /**
   * For a company's timesheet: the VERSION the driver last declared correct
   * (`timesheetVersion`), with when and by whom (D42). Any later change makes
   * the day's version differ, and the declaration no longer applies to it —
   * the driver reviews and declares again. Never set on a Personal day.
   */
  declaration?: TimesheetDeclaration;
}

export interface TimesheetDeclaration {
  version: string;
  declaredAt: string;
  declaredBy: string;
}

/**
 * The driver's "I confirm all details are correct", as pressed: when, and who.
 * `version` is the version the screen SHOWED (`timesheetVersion`); a save
 * that would store any other version stores nothing.
 */
export interface Declared {
  at: Date;
  by: string;
  version: string;
}

/**
 * A fingerprint of everything a finished day SAYS — its facts and its uses,
 * as they now read — so a declaration can be bound to exactly one version.
 * Not a security hash: it tells versions apart, nothing more.
 */
export function timesheetVersion(shift: CompletedShift): string {
  const said = JSON.stringify({ id: shift.id, facts: effectiveFacts(shift), uses: effectiveUses(shift) });
  // cyrb53: a small, well-spread 53-bit string hash.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < said.length; index += 1) {
    const code = said.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Where a finished day stands with its declaration (D42):
 *   not-required  a Personal day — it needs none
 *   confirmed     a company's day whose valid declaration is of this version
 *   unconfirmed   a company's day with NO valid declaration — never recorded
 *                 (a day finished before declarations were stored) or not
 *                 trusted (damaged); nothing says it was ever confirmed
 *   changed       a company's day with a valid declaration of ANOTHER version:
 *                 changed since the driver confirmed it
 */
export type DeclarationState = "not-required" | "confirmed" | "unconfirmed" | "changed";

export function declarationState(shift: CompletedShift): DeclarationState {
  if (effectiveFacts(shift).workingFor.kind !== "company") return "not-required";
  if (shift.declaration === undefined) return "unconfirmed";
  return shift.declaration.version === timesheetVersion(shift) ? "confirmed" : "changed";
}

/** Whether nothing more is to be declared: a Personal day, or a confirmed company's day. */
export function declarationHolds(shift: CompletedShift): boolean {
  const state = declarationState(shift);
  return state === "not-required" || state === "confirmed";
}

/** The facts of a finished day that a correction may change — and nothing else. */
export interface ShiftFacts {
  workingFor: WorkingContext;
  startedAt: string;
  endedAt: string;
  nightOut: boolean;
  notes: string | null;
}

/**
 * One confirmed correction of a finished day: a COMPLETE snapshot of its
 * facts as the driver now confirms them, and who made it, when. Never edited
 * once written; a later mistake is corrected by the next one.
 */
export interface ShiftCorrection extends ShiftFacts {
  /** Stable id: a repeated confirmation of one correction is one correction. */
  id: string;
  /** The device clock when the driver confirmed it — never backdated. */
  correctedAt: string;
  /** The signed-in driver who made it. */
  correctedBy: string;
}

/**
 * A finished day's uses as the day says them NOW (D40): a use its finish
 * ended (`endedBy: "finish"`) ends at the day's current finish; every other
 * use exactly as stored. The stored uses are never rewritten by a correction.
 */
export function effectiveUses(shift: Omit<CompletedShift, "ownerUserId">): Pick<CompletedShift, "previousVehicles" | "previousTrailers"> {
  const finish = effectiveFacts(shift).endedAt;
  return {
    previousVehicles: shift.previousVehicles.map(use => (use.endedBy === USE_ENDED_BY.finish ? { ...use, endedAt: finish } : use)),
    previousTrailers: shift.previousTrailers.map(use => (use.endedBy === USE_ENDED_BY.finish ? { ...use, endedAt: finish } : use)),
  };
}

/** What a finished day says NOW: its latest correction, or the day as finished. */
export function effectiveFacts(shift: Omit<CompletedShift, "ownerUserId">): ShiftFacts {
  const latest = shift.corrections?.[shift.corrections.length - 1];
  const source: ShiftFacts = latest ?? shift;
  return { workingFor: source.workingFor, startedAt: source.startedAt, endedAt: source.endedAt, nightOut: source.nightOut, notes: source.notes };
}

/** What the driver gives in the Finish flow. */
export interface ShiftFinish {
  /** The odometer as the vehicle in use is handed back; `null` exactly when none is in use. */
  finalMileage: number | null;
  endedAt: Date;
  nightOut: boolean;
  /** As typed. */
  notes: string;
}

export interface FinishShiftInput extends ShiftFinish {
  /** The day the Finish flow was opened for. */
  shiftId: string;
  /** The vehicle use the flow showed, by `useId` — `null` when it showed none. */
  vehicleUseId: string | null;
  /** The trailer use the flow showed, by `useId` — `null` when it showed none. */
  trailerUseId: string | null;
  /**
   * The declaration pressed on the Review — required for a company's day,
   * which is filed only with the version declared (D42). Ignored for Personal.
   */
  declared: Declared | null;
}

/** What a finish may not precede. */
export type FinishBoundary =
  | { kind: "shift" }
  | { kind: "vehicle"; numberPlate: string }
  | { kind: "trailer"; trailerNumber: string }
  | { kind: "ended-vehicle"; numberPlate: string }
  | { kind: "ended-trailer"; trailerNumber: string };

/**
 * The earliest finish the day allows, and why: the latest of the shift's
 * start, the current vehicle's and trailer's starts, and every earlier use's
 * end. A shift cannot end before something in it began or ended.
 */
export function earliestFinish(shift: LocalShift): { at: string; because: FinishBoundary } {
  const bounds: { at: string; because: FinishBoundary }[] = [
    { at: shift.startedAt, because: { kind: "shift" } },
    ...shift.previousVehicles.map(use => ({ at: use.endedAt, because: { kind: "ended-vehicle", numberPlate: use.numberPlate } as const })),
    ...shift.previousTrailers.map(use => ({ at: use.endedAt, because: { kind: "ended-trailer", trailerNumber: use.trailerNumber } as const })),
  ];
  if (shift.vehicle !== null) bounds.push({ at: shift.vehicle.startedAt, because: { kind: "vehicle", numberPlate: shift.vehicle.numberPlate } });
  if (shift.trailer !== null) bounds.push({ at: shift.trailer.startedAt, because: { kind: "trailer", trailerNumber: shift.trailer.trailerNumber } });
  // Later entries win a tie: the thing in use is the reason a driver recognises.
  return bounds.reduce((latest, bound) => (Date.parse(bound.at) >= Date.parse(latest.at) ? bound : latest));
}

/**
 * Thrown — writing nothing — for a finish earlier than `earliestFinish`. The
 * time is never clamped: the driver is told, and corrects it.
 */
export class FinishTooEarlyError extends Error {
  readonly earliest: { at: string; because: FinishBoundary };
  constructor(earliest: { at: string; because: FinishBoundary }) {
    super("Refusing a finish before the day's latest start or end");
    this.name = "FinishTooEarlyError";
    this.earliest = earliest;
  }
}

/**
 * The finished day an open day and the driver's finish make — or a refusal.
 *
 * The finish is DECLARED (D40): the official finish of the timesheet, which
 * may be later than now — a guaranteed day, say — and is never compared with
 * the clock here. A finish far ahead of now is confirmed on screen
 * (`finishAheadOf`), never refused.
 *
 * PURE: it reads and writes nothing, so the Review shows exactly what
 * `finishOpenShift` will save, before anything is saved. The vehicle in use
 * ends with `finalMileage`, the trailer in use ends with no mileage, both at
 * `endedAt`; their checks, fills and fridge diesel are carried exactly, and
 * every earlier use is left as it was.
 */
export function completedFrom(open: LocalShift, { finalMileage, endedAt, nightOut, notes }: ShiftFinish): CompletedShift {
  if (Number.isNaN(endedAt.getTime())) throw new Error("Refusing an invalid finish time");
  const at = endedAt.toISOString();
  const earliest = earliestFinish(open);
  if (Date.parse(at) < Date.parse(earliest.at)) throw new FinishTooEarlyError(earliest);
  if (typeof nightOut !== "boolean") throw new Error("Refusing a finish without a Night Out answer");
  const written = notes.trim();
  if (written.length > SHIFT_NOTES_MAX_LENGTH) throw new Error("Refusing over-long shift notes");

  let vehicles = open.previousVehicles;
  if (open.vehicle !== null) {
    if (finalMileage === null || !Number.isSafeInteger(finalMileage) || finalMileage < open.vehicle.startMileage) {
      throw new Error("Refusing an invalid final mileage");
    }
    // Ended BY the finish — so a correction of the finish moves it too (D40).
    vehicles = [...open.previousVehicles, { ...open.vehicle, endMileage: finalMileage, endedAt: at, endedBy: USE_ENDED_BY.finish }];
  } else if (finalMileage !== null) {
    throw new Error("Refusing a final mileage with no vehicle in use");
  }

  return {
    ownerUserId:      open.ownerUserId,
    id:               open.id,
    workingFor:       open.workingFor,
    startedAt:        open.startedAt,
    endedAt:          at,
    nightOut,
    notes:            written === "" ? null : written,
    previousVehicles: vehicles,
    previousTrailers: open.trailer === null
      ? open.previousTrailers
      : [...open.previousTrailers, { ...open.trailer, endedAt: at, endedBy: USE_ENDED_BY.finish }],
    status:           LOCAL_SHIFT_STATUS.completed,
    createdAt:        open.createdAt,
    ...(open.recoveredAt === undefined ? {} : { recoveredAt: open.recoveredAt }),
  };
}

/**
 * A company's day with its declaration bound to it, or `null` when what the
 * driver declared is not what would be stored. A Personal day carries none.
 */
function declaredAs(day: CompletedShift, declared: Declared | null): CompletedShift | null {
  const undeclared: CompletedShift = { ...day };
  delete undeclared.declaration;
  if (effectiveFacts(undeclared).workingFor.kind !== "company") return undeclared;
  if (declared === null) throw new Error("Refusing to save a company's timesheet without its declaration");
  if (declared.by === "" || Number.isNaN(declared.at.getTime())) throw new Error("Refusing an unattributed declaration");
  const version = timesheetVersion(undeclared);
  if (declared.version !== version) return null;
  return { ...undeclared, declaration: { version, declaredAt: declared.at.toISOString(), declaredBy: declared.by } };
}

/**
 * Finish the open day: file it as a `CompletedShift`, then remove the open
 * day. Resolves to the finished day, or `null` when nothing was finished.
 *
 * EXACTLY THE DAY ON SCREEN. It finishes only the day named, and only while
 * its vehicle and trailer in use are still the ones the flow showed — a
 * final mileage belongs to one vehicle. Otherwise it writes nothing and
 * resolves `null`. A repeated press, finding the day already finished,
 * resolves to that finished day: one finish, however many taps.
 *
 * SAVED BEFORE IT IS REPORTED. The record goes through the same verified
 * write as every change (`storeSafely`), moved into place WITHOUT overwrite,
 * and only then is the open file removed. Any failure before that is a
 * `SafeSaveFailedError` and the open day stays as it was. If the open file
 * then cannot be removed, the day is still finished: the reader hides an
 * open file whose day is filed, and the next Start Shift removes it.
 */
export function finishOpenShift(scope: AccountScope, input: FinishShiftInput): Promise<CompletedShift | null> {
  return queued(scope, () => finishIfCurrent(scope, input));
}

async function finishIfCurrent(scope: AccountScope, input: FinishShiftInput): Promise<CompletedShift | null> {
  const open = await readOpenShift(scope);
  if (open === null || open.id !== input.shiftId) return readCompletedShift(scope, input.shiftId);
  if ((open.vehicle?.useId ?? null) !== input.vehicleUseId) return null;
  if ((open.trailer?.useId ?? null) !== input.trailerUseId) return null;

  const completed = declaredAs(completedFrom(open, input), input.declared);
  if (completed === null) return null;
  const serialised = JSON.stringify(completed);
  if (asCompletedShift(JSON.parse(serialised)) === null) throw new Error("Refusing to file a day the reader would refuse");
  const target = completedShiftFile(scope, completed.id);
  if (target === null) throw new Error("Refusing to file a day under an id that cannot name a file");
  // Something already there is not a readable record of this day — the
  // reader would have hidden the open day otherwise. Kept, never overwritten.
  if (target.exists) preserveForRecovery(scope, target, "unreadable");

  storeSafely(scope, serialised, target, { overwrite: false });
  try {
    openShiftFile(scope).delete();
  } catch {
    // Filed and readable, so the day IS finished: saying otherwise would be
    // the untrue report. The leftover is hidden by `readOpenShift` and removed
    // by the next Start Shift (`isFinishedLeftover`).
  }
  return completed;
}

/** The finished day with this id, or `null`. Never throws. */
export function readCompletedShift(scope: AccountScope, id: string): Promise<CompletedShift | null> {
  return scopedRead(scope, () => readCompletedSync(scope, id));
}

/**
 * A read outside the write queue, for one account: refused — as a rejection,
 * never a silent empty answer — when the scope is not live (F-31).
 */
function scopedRead<T>(scope: AccountScope, read: () => T): Promise<T> {
  try {
    assertLiveScope(scope);
    quarantineLegacyRecords();
    return Promise.resolve(read());
  } catch (error: unknown) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

function readCompletedSync(scope: AccountScope, id: string): CompletedShift | null {
  const file = completedShiftFile(scope, id);
  if (file === null || !file.exists) return null;
  try {
    const shift = asCompletedShift(JSON.parse(file.textSync()));
    return shift?.id === id && shift.ownerUserId === scope.userId ? shift : null;
  } catch {
    return null;
  }
}

/**
 * Every finished day on this phone that can be read, newest first.
 *
 * Only files named exactly as a finished day's record are considered — never
 * the open day, its temporary file or a recovery file — and each is read
 * through the same strict reader as `readCompletedShift`, under the id its
 * name gives. A record that cannot be read is LEFT OUT, never guessed at, and
 * never takes the others with it — but it is COUNTED, so a screen can say
 * that not every saved day could be read. It is never deleted or repaired.
 *
 * Newest first by the day itself — its start, then its finish — with the id
 * as the last word, so the order is stable and never the order of the files.
 */
export function listCompletedShifts(scope: AccountScope): Promise<CompletedShiftListing> {
  return scopedRead(scope, () => listCompletedSync(scope));
}

function listCompletedSync(scope: AccountScope): CompletedShiftListing {
  const shifts: CompletedShift[] = [];
  let unreadable = 0;
  for (const entry of accountDirectory(scope).list()) {
    if (!(entry instanceof File)) continue;
    const id = completedShiftIdFrom(entry.uri);
    if (id === null) continue;
    const shift = readCompletedSync(scope, id);
    if (shift === null) unreadable += 1;
    else shifts.push(shift);
  }
  // By what each day says NOW — a corrected start moves it in the list.
  shifts.sort((a, b) => {
    const left = effectiveFacts(a);
    const right = effectiveFacts(b);
    return Date.parse(right.startedAt) - Date.parse(left.startedAt)
      || Date.parse(right.endedAt) - Date.parse(left.endedAt)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  return { timesheets: shifts, unreadable };
}

export interface CompletedShiftListing {
  /** Every readable finished day, newest first. */
  timesheets: CompletedShift[];
  /** How many files named as a finished day's record could not be read. */
  unreadable: number;
}

/** The day id a finished day's file name carries, or `null` for any other file. */
function completedShiftIdFrom(uri: string): string | null {
  const name = uri.split("/").pop() ?? "";
  if (!name.startsWith(COMPLETED_SHIFT_FILE_PREFIX) || !name.endsWith(".json")) return null;
  // Whether the id can name a file at all is `completedShiftFile`'s rule.
  return name.slice(COMPLETED_SHIFT_FILE_PREFIX.length, -".json".length);
}

/** A day's record file — or `null` for an id that is not safe to name a file with. */
function completedShiftFile(scope: AccountScope, id: string): File | null {
  return /^[0-9A-Za-z-]+$/.test(id) ? new File(accountDirectory(scope), `${COMPLETED_SHIFT_FILE_PREFIX}${id}.json`) : null;
}

/** An open-day file whose day already has a readable completed record. */
function isFinishedLeftover(scope: AccountScope, file: File): boolean {
  try {
    const shift = asLocalShift(JSON.parse(file.textSync()));
    return shift !== null && shift.ownerUserId === scope.userId && readCompletedSync(scope, shift.id) !== null;
  } catch {
    return false;
  }
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * Narrow a parsed record to a finished day, or reject it — the same rules as
 * an open day's uses, and nothing in the day ending after the day does.
 */
function asCompletedShift(value: unknown): CompletedShift | null {
  const owner = ownerOf(value);
  if (owner === null) return null;
  const day = asCompletedShiftContent(value);
  return day === null ? null : { ...day, ownerUserId: owner };
}

/** Everything about a finished day except whose it is. */
function asCompletedShiftContent(value: unknown): Omit<CompletedShift, "ownerUserId"> | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { id, startedAt, endedAt, createdAt, status, workingFor, nightOut, notes } = record;
  const recoveredAt = record["recoveredAt"];
  if (recoveredAt !== undefined && !isInstant(recoveredAt)) return null;
  if (typeof id !== "string" || id === "") return null;
  if (!isInstant(startedAt) || !isInstant(endedAt) || !isInstant(createdAt)) return null;
  if (status !== LOCAL_SHIFT_STATUS.completed) return null;
  if (Date.parse(endedAt) < Date.parse(startedAt)) return null;
  if (typeof nightOut !== "boolean") return null;
  if (notes !== null && (typeof notes !== "string" || notes === "" || notes !== notes.trim() || notes.length > SHIFT_NOTES_MAX_LENGTH)) return null;

  const context = asWorkingContext(workingFor);
  if (context === null) return null;

  // Both lists are always written for a finished day; absent is not "none".
  if (!Array.isArray(record["previousVehicles"]) || !Array.isArray(record["previousTrailers"])) return null;
  const vehicles = asPreviousVehicles(record["previousVehicles"]);
  if (vehicles === null) return null;
  if (!distinct(vehicles.map(use => use.startedAt)) || !distinct(vehicles.map(use => use.useId))) return null;
  const trailers = asTrailers(null, record["previousTrailers"]);
  if (trailers === null) return null;
  // A use the finish ended ended AT that finish — anything else was not written by it.
  if ([...vehicles, ...trailers.previousTrailers].some(use => use.endedBy === USE_ENDED_BY.finish && use.endedAt !== endedAt)) return null;

  const read: Omit<CompletedShift, "ownerUserId"> = {
    id, workingFor: context, startedAt, endedAt, nightOut, notes,
    previousVehicles: vehicles, previousTrailers: trailers.previousTrailers,
    status: LOCAL_SHIFT_STATUS.completed, createdAt,
    ...(typeof recoveredAt === "string" ? { recoveredAt } : {}),
  };
  // ABSENT means none — a day finished before corrections existed, never
  // rewritten by being read. PRESENT must be exactly a list of corrections.
  let day = read;
  if (record["corrections"] !== undefined) {
    const corrections = asCorrections(record["corrections"]);
    if (corrections === null) return null;
    day = { ...read, corrections };
  }
  // ABSENT means none was recorded. DAMAGED is not trusted, in whole or in
  // part, and does not cost the driver the timesheet: the day reads with no
  // declaration — to be reviewed and confirmed — and the file is left as it
  // is. Nothing is made up in its place.
  const declaration = asDeclaration(record["declaration"]);
  if (declaration !== null) day = { ...day, declaration };
  // Nothing in the day ends after the day as it NOW ends — its latest finish,
  // which a use's own corrected end must respect too (D42) — and a use the
  // finish ended does not begin after it.
  const finish = Date.parse(effectiveFacts(day).endedAt);
  if (finish < Date.parse(effectiveFacts(day).startedAt)) return null;
  const uses = [...vehicles, ...trailers.previousTrailers];
  if (uses.some(use => (use.endedBy === USE_ENDED_BY.finish ? Date.parse(use.startedAt) > finish : Date.parse(use.endedAt) > finish))) return null;
  return day;
}

function asDeclaration(value: unknown): TimesheetDeclaration | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { version, declaredAt, declaredBy } = value as Record<string, unknown>;
  if (typeof version !== "string" || version === "" || version.length > 64) return null;
  if (!isInstant(declaredAt)) return null;
  if (typeof declaredBy !== "string" || declaredBy === "" || declaredBy.length > 64) return null;
  return { version, declaredAt, declaredBy };
}

/**
 * A finished day's corrections, or `null`: each a complete, valid snapshot,
 * ids unique, in the order they were made. Whether the LATEST holds the
 * day's uses as they now are is checked with them (`asCompletedShift`); an
 * earlier snapshot is history, and its day has since been corrected. A malformed one fails the whole day closed — it is a record
 * of what the day says, and one quietly dropped would change it.
 */
function asCorrections(value: unknown): ShiftCorrection[] | null {
  if (!Array.isArray(value)) return null;
  const corrections: ShiftCorrection[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null;
    const record = raw as Record<string, unknown>;
    const { id, correctedAt, correctedBy, startedAt, endedAt, nightOut, notes } = record;
    if (typeof id !== "string" || id === "" || corrections.some(earlier => earlier.id === id)) return null;
    if (typeof correctedBy !== "string" || correctedBy === "") return null;
    if (!isInstant(correctedAt) || !isInstant(startedAt) || !isInstant(endedAt)) return null;
    if (typeof nightOut !== "boolean") return null;
    if (notes !== null && (typeof notes !== "string" || notes === "" || notes !== notes.trim() || notes.length > SHIFT_NOTES_MAX_LENGTH)) return null;
    const workingFor = asWorkingContext(record["workingFor"]);
    if (workingFor === null) return null;
    const previous = corrections[corrections.length - 1];
    if (previous !== undefined && Date.parse(correctedAt) < Date.parse(previous.correctedAt)) return null;
    if (Date.parse(endedAt) < Date.parse(startedAt)) return null;
    corrections.push({ id, correctedAt, correctedBy, workingFor, startedAt, endedAt, nightOut, notes });
  }
  return corrections;
}

/**
 * Why a day's facts cannot hold its uses, or `null` when they can: it may not
 * end before it starts, start after any use began, or end before any use
 * ended. A correction is refused on these — no use is ever moved to fit it.
 */
export type TimesheetBoundsProblem =
  | { kind: "finish-before-start" }
  | { kind: "start-after-use"; name: string; at: string }
  | { kind: "finish-before-use"; name: string; at: string }
  | { kind: "finish-before-use-start"; name: string; at: string };

export function boundsProblem(day: Pick<CompletedShift, "previousVehicles" | "previousTrailers">, facts: Pick<ShiftFacts, "startedAt" | "endedAt">): TimesheetBoundsProblem | null {
  const start = Date.parse(facts.startedAt);
  const end = Date.parse(facts.endedAt);
  if (end < start) return { kind: "finish-before-start" };
  const uses = [
    ...day.previousVehicles.map(use => ({ name: use.numberPlate, startedAt: use.startedAt, endedAt: use.endedAt, byFinish: use.endedBy === USE_ENDED_BY.finish })),
    ...day.previousTrailers.map(use => ({ name: `trailer ${use.trailerNumber}`, startedAt: use.startedAt, endedAt: use.endedAt, byFinish: use.endedBy === USE_ENDED_BY.finish })),
  ];
  const startsLater = uses.filter(use => Date.parse(use.startedAt) < start).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0];
  if (startsLater !== undefined) return { kind: "start-after-use", name: startsLater.name, at: startsLater.startedAt };
  // A use the finish ended moves with it — but never to before it began.
  const movedTooFar = uses.filter(use => use.byFinish && Date.parse(use.startedAt) > end).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  if (movedTooFar !== undefined) return { kind: "finish-before-use-start", name: movedTooFar.name, at: movedTooFar.startedAt };
  // Every other use keeps its own end: the finish may not come before it.
  const endsEarlier = uses.filter(use => !use.byFinish && Date.parse(use.endedAt) > end).sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt))[0];
  if (endsEarlier !== undefined) return { kind: "finish-before-use", name: endsEarlier.name, at: endsEarlier.endedAt };
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Correcting and deleting a finished day (D39)
// ═══════════════════════════════════════════════════════════════════════════

/** Store a finished day's record through the verified write, after the reader has accepted it. */
function saveCompleted(scope: AccountScope, shift: CompletedShift, options: { overwrite: boolean }): void {
  const serialised = JSON.stringify(shift);
  if (asCompletedShift(JSON.parse(serialised)) === null) throw new Error("Refusing to file a day the reader would refuse");
  const target = completedShiftFile(scope, shift.id);
  if (target === null) throw new Error("Refusing to file a day under an id that cannot name a file");
  storeSafely(scope, serialised, target, options);
}

/**
 * Thrown — writing nothing — when a correction's facts cannot hold the day's
 * uses (`TimesheetBoundsProblem`). No use is ever moved to make one fit.
 */
export class TimesheetBoundsError extends Error {
  readonly problem: TimesheetBoundsProblem;
  constructor(problem: TimesheetBoundsProblem) {
    super("Refusing a correction that does not hold the day's uses");
    this.name = "TimesheetBoundsError";
    this.problem = problem;
  }
}

export interface CorrectCompletedShiftInput {
  shiftId: string;
  /**
   * The correction the edit screen was opened on — `null` when it showed the
   * day as finished. If the day has been corrected since, nothing is written.
   */
  basedOn: string | null;
  /** This correction's own id: a repeated confirmation of it is one correction. */
  correctionId: string;
  workingFor: WorkingContext;
  startedAt: Date;
  endedAt: Date;
  nightOut: boolean;
  /** As typed. */
  notes: string;
  /** The device clock when the driver confirmed it. */
  correctedAt: Date;
  /** The signed-in driver. */
  correctedBy: string;
  /**
   * The declaration pressed on the Review. Every save of a company's day —
   * and every save of a day that WAS a company's — needs one (D42); a
   * Personal day's ordinary correction does not.
   */
  declared: Declared | null;
}

/**
 * Correct a finished day's own facts — who it was worked for, its start and
 * finish, Night Out and notes — by APPENDING a correction (D39). The day as
 * finished and every earlier correction stay exactly as they were; the new
 * one is what the day says from now on.
 *
 * Resolves to the day as it now stands, or `null` when nothing was written
 * because the day is not there, or was corrected by someone else since the
 * screen opened (`basedOn`). A correction already recorded, or one that
 * changes nothing, writes nothing and resolves to the day.
 *
 * A use the day's finish ended (`endedBy: "finish"`) ends at the corrected
 * finish from then on (`effectiveUses`); its stored end is left as finished,
 * like every other fact the day was finished with. No other use moves.
 *
 * The finish is declared and may be later than now (D40). REFUSES — throws,
 * writing nothing — facts that cannot hold the day's uses
 * (`TimesheetBoundsError`), over-long notes, and a correction with no id or
 * no driver. Fills, checks and mileages are never touched here.
 */
export function correctCompletedShift(scope: AccountScope, input: CorrectCompletedShiftInput): Promise<CompletedShift | null> {
  return queued(scope, () => {
    const day = readCompletedSync(scope, input.shiftId);
    if (day === null) return Promise.resolve(null);
    if ((day.corrections ?? []).some(correction => correction.id === input.correctionId)) return Promise.resolve(day);
    const latest = day.corrections?.[day.corrections.length - 1];
    if ((latest?.id ?? null) !== input.basedOn) return Promise.resolve(null);

    if (input.correctionId === "") throw new Error("Refusing a correction with no id");
    if (input.correctedBy === "") throw new Error("Refusing a correction with no driver");
    for (const at of [input.startedAt, input.endedAt, input.correctedAt]) {
      if (Number.isNaN(at.getTime())) throw new Error("Refusing a correction with an invalid time");
    }
    const workingFor = asWorkingContext(input.workingFor);
    if (workingFor === null) throw new Error("Refusing a correction for an unknown working context");
    const written = input.notes.trim();
    if (written.length > SHIFT_NOTES_MAX_LENGTH) throw new Error("Refusing over-long shift notes");

    const facts: ShiftFacts = {
      workingFor,
      startedAt: input.startedAt.toISOString(),
      endedAt: input.endedAt.toISOString(),
      nightOut: input.nightOut,
      notes: written === "" ? null : written,
    };
    const problem = boundsProblem(day, facts);
    if (problem !== null) throw new TimesheetBoundsError(problem);
    const wasCompany = effectiveFacts(day).workingFor.kind === "company";
    if (wasCompany && input.declared === null) throw new Error("Refusing to change a company's timesheet without its declaration");

    const sameFacts = JSON.stringify(facts) === JSON.stringify(effectiveFacts(day));
    // Nothing to change and nothing to declare again: the day as it is.
    if (sameFacts && declarationHolds(day)) return Promise.resolve(day);
    const corrected: CompletedShift = sameFacts ? day : {
      ...day,
      corrections: [...(day.corrections ?? []), { id: input.correctionId, correctedAt: input.correctedAt.toISOString(), correctedBy: input.correctedBy, ...facts }],
    };
    const declared = declaredAs(corrected, input.declared);
    if (declared === null) return Promise.resolve(null);
    saveCompleted(scope, declared, { overwrite: true });
    return Promise.resolve(declared);
  });
}

/**
 * Thrown when a finished day's record could not be deleted and whether it is
 * still there cannot be known. Never reported as deleted.
 */
export class DeleteUncertainError extends Error {
  constructor(cause: unknown) {
    super("The timesheet may or may not have been deleted", { cause });
    this.name = "DeleteUncertainError";
  }
}

/**
 * Delete ONE finished day from this phone, by its id — never by date,
 * employer or position (D39). For a timesheet created by accident; a real
 * day with a mistake in it is corrected instead.
 *
 * Resolves `true` once that day's record is gone, `false` when no readable
 * day has the id (nothing is touched). Only that day's record is removed —
 * never the open day, another day, a temporary or a recovery file. An open
 * file left behind by an interrupted finish OF THIS DAY goes first, or the
 * day would reappear as open once its record was gone.
 *
 * A delete that throws is a failure — rethrown, the record still there —
 * unless the record is provably gone; when that cannot be known, it is a
 * `DeleteUncertainError`.
 */
export function deleteCompletedShift(scope: AccountScope, id: string): Promise<boolean> {
  return queued(scope, () => {
    const target = completedShiftFile(scope, id);
    if (target === null || readCompletedSync(scope, id) === null) return Promise.resolve(false);

    const live = openShiftFile(scope);
    if (live.exists && isFinishedLeftover(scope, live)) {
      const leftover = asLocalShift(JSON.parse(live.textSync()));
      if (leftover?.id === id) live.delete();
    }

    try {
      target.delete();
    } catch (error: unknown) {
      let remains: boolean;
      try {
        remains = target.exists;
      } catch {
        throw new DeleteUncertainError(error);
      }
      if (remains) throw error;
    }
    return Promise.resolve(true);
  });
}

/**
 * A finished day, seen as the use screens and use writes see a day: nothing
 * in use, every use ended, its facts as they stand now. NOT an open day —
 * nothing reads it as one, and every write through it goes back to the
 * finished day's own record (`saveDay`), re-validated in full (D39).
 */
const finishedBehind = new WeakMap<LocalShift, CompletedShift>();

function viewOfFinished(done: CompletedShift): LocalShift {
  const facts = effectiveFacts(done);
  const uses = effectiveUses(done);
  const view: LocalShift = {
    ownerUserId: done.ownerUserId,
    id: done.id,
    workingFor: facts.workingFor,
    startedAt: facts.startedAt,
    vehicle: null,
    previousVehicles: uses.previousVehicles,
    trailer: null,
    previousTrailers: uses.previousTrailers,
    status: LOCAL_SHIFT_STATUS.open,
    createdAt: done.createdAt,
    ...(done.recoveredAt === undefined ? {} : { recoveredAt: done.recoveredAt }),
  };
  finishedBehind.set(view, done);
  return view;
}

function withStoredEnds<T extends { useId: string; endedAt: string; endedBy?: UseEndedBy }>(written: readonly T[], stored: readonly T[]): T[] {
  if (written.length !== stored.length) throw new Error("Refusing a use write that adds or removes a use");
  return written.map((use, index) => {
    const original = stored[index];
    if (original?.useId !== use.useId) throw new Error("Refusing a use write that reorders the day");
    // A use still ended BY the finish is shown at the day's current finish;
    // its stored end stays as finished. Any other end is exactly as written —
    // including one the driver has just corrected (D42).
    return use.endedBy === USE_ENDED_BY.finish ? { ...use, endedAt: original.endedAt } : use;
  });
}

/** No value appears twice. */
function distinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/** A finished day's uses, for the use screens: `null` when no readable day has the id. */
export function readFinishedDayOfUses(scope: AccountScope, id: string): Promise<LocalShift | null> {
  return scopedRead(scope, () => {
    const done = readCompletedSync(scope, id);
    return done === null ? null : viewOfFinished(done);
  });
}

/**
 * The day a use write names: the open day, or — when it is not the open one —
 * a finished day's uses (`viewOfFinished`). Either is found only by its id.
 */
async function readDayOfUses(scope: AccountScope, shiftId: string): Promise<LocalShift | null> {
  const open = await readOpenShift(scope);
  if (open !== null && open.id === shiftId) return open;
  const done = readCompletedSync(scope, shiftId);
  return done === null ? null : viewOfFinished(done);
}

/**
 * Save a use write: the open day through `persist`, a finished day through
 * its own record — only its uses change, never its facts or corrections.
 */
function saveDay(scope: AccountScope, day: LocalShift, updated: LocalShift): LocalShift {
  const done = finishedBehind.get(day);
  if (done === undefined) return persist(scope, updated);
  if (updated.vehicle !== null || updated.trailer !== null) throw new Error("Refusing to put a use back in use on a finished day");
  // The view shows ends as the day says them now; the record keeps a use the
  // finish ended at the end it was finished with (`effectiveUses`), so that
  // end goes back exactly as it was. A use with its own end keeps what was
  // written — corrected on its own page, if it was (D42).
  const next: CompletedShift = {
    ...done,
    previousVehicles: withStoredEnds(updated.previousVehicles, done.previousVehicles),
    previousTrailers: withStoredEnds(updated.previousTrailers, done.previousTrailers),
  };
  saveCompleted(scope, next, { overwrite: true });
  return viewOfFinished(next);
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
export function clearOpenShift(scope: AccountScope): Promise<void> {
  // Through the same queue as every write: a write already in flight finishes
  // first, and cannot then re-create the file after it was deleted — a
  // discarded day never comes back (hardening audit, 2026-09-28).
  // The day's unfinished next state goes with it, so a discarded day is not
  // later kept as recovery. Recovery files are left alone: they are not the
  // day being discarded.
  return queued(scope, () => {
    let removedAny = false;
    for (const file of [openShiftFile(scope), openShiftTempFile(scope)]) {
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

// ═══════════════════════════════════════════════════════════════════════════
// Interrupted writes: explicit, owner-confirmed recovery (F-37, D62)
// ═══════════════════════════════════════════════════════════════════════════

/** An offer, never an accepted record. Its exact bytes bind confirmation. */
export interface InterruptedWriteOffer {
  key: string;
  bytes: string;
  kind: "open" | "completed";
  shiftId: string;
  startedAt: string;
}

function interruptedCandidate(scope: AccountScope, key: string): { file: File; bytes: string; day: LocalShift | CompletedShift; target: File } | null {
  if (!/^[A-Za-z0-9._-]+$/.test(key)) return null;
  if (key !== OPEN_SHIFT_TEMP_FILE && !(key.startsWith(`${RECOVERY_FILE_PREFIX}unfinished-`) && key.endsWith(".json"))) return null;
  const file = new File(accountDirectory(scope), key);
  if (!file.exists) return null;
  try {
    const bytes = file.textSync();
    const parsed: unknown = JSON.parse(bytes);
    const day = asLocalShift(parsed) ?? asCompletedShift(parsed);
    if (day === null || day.ownerUserId !== scope.userId) return null;
    const target = day.status === LOCAL_SHIFT_STATUS.open ? openShiftFile(scope) : completedShiftFile(scope, day.id);
    // An existing destination, including an unreadable one, is never replaced.
    if (target === null || target.exists) return null;
    if (day.status === LOCAL_SHIFT_STATUS.open && readCompletedSync(scope, day.id) !== null) return null;
    return { file, bytes, day, target };
  } catch { return null; }
}

/** Only an authenticated account's live scope can inspect its own candidates. */
export function findInterruptedWrites(scope: AccountScope): Promise<InterruptedWriteOffer[]> {
  return scopedRead(scope, () => {
    const offers: InterruptedWriteOffer[] = [];
    for (const file of accountDirectory(scope).list()) {
      if (!(file instanceof File)) continue;
      const candidate = interruptedCandidate(scope, file.name);
      if (candidate === null) continue;
      offers.push({ key: file.name, bytes: candidate.bytes, kind: candidate.day.status, shiftId: candidate.day.id, startedAt: candidate.day.startedAt });
    }
    return offers;
  });
}

/** No overwrite; the original stays intact across failure, retry and Not now. */
export function recoverInterruptedWrite(scope: AccountScope, offer: InterruptedWriteOffer, confirmation: { confirmedByDriver: boolean }): Promise<"recovered" | "refused"> {
  return queued(scope, () => {
    if (confirmation.confirmedByDriver !== true) return Promise.resolve("refused" as const);
    const candidate = interruptedCandidate(scope, offer.key);
    if (candidate === null || candidate.bytes !== offer.bytes || candidate.day.id !== offer.shiftId || candidate.day.status !== offer.kind) return Promise.resolve("refused" as const);
    const recovered = { ...candidate.day, recoveredAt: new Date().toISOString() };
    // A recovered completed copy has no accepted declaration: review again.
    if ("declaration" in recovered) delete recovered.declaration;
    const serialised = JSON.stringify(recovered);
    // Installed only if the store's own reader accepts it, for this owner.
    const reread: unknown = JSON.parse(serialised);
    const readable = candidate.day.status === LOCAL_SHIFT_STATUS.open ? asLocalShift(reread) : asCompletedShift(reread);
    if (readable === null || readable.ownerUserId !== scope.userId) return Promise.resolve("refused" as const);
    const stage = new File(accountDirectory(scope), `${RECOVERY_FILE_PREFIX}install-${newLocalId()}.json`);
    try {
      stage.create();
      stage.write(serialised);
      if (stage.textSync() !== serialised) throw new Error("Recovery write was incomplete");
      assertLiveScope(scope);
      if (candidate.target.exists) return Promise.resolve("refused" as const);
      stage.moveSync(candidate.target, { overwrite: false });
      // Accepted source bytes remain as an archive, never a fresh offer
      // after the driver later deletes the recovered record.
      candidate.file.moveSync(new File(accountDirectory(scope), `${RECOVERY_FILE_PREFIX}accepted-${newLocalId()}.json`), { overwrite: false });
    } catch (error: unknown) { throw new SafeSaveFailedError(error); }
    return Promise.resolve("recovered" as const);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Records written before accounts existed (F-31)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Where records that belong to NO account are kept: under the document
 * directory, outside `accounts/`, so no account's scope reaches them and no
 * screen reads them. Nothing here is ever deleted.
 */
export const LEGACY_QUARANTINE_DIRECTORY = "quarantine";

/** A quarantined record written before accounts existed, still unclaimed. */
const LEGACY_PREFIX = "legacy-";
/** A record found inside an account's directory naming another owner. */
const FOREIGN_PREFIX = "foreign-";
/** A legacy record recovered into an account — its original bytes, kept. */
const RECOVERED_PREFIX = "recovered-";

function quarantineDirectory(): Directory {
  const directory = new Directory(Paths.document, LEGACY_QUARANTINE_DIRECTORY);
  directory.create({ intermediates: true, idempotent: true });
  return directory;
}

/** Is this a file name the app ever gave a day's record, in any form? */
function isDayRecordName(name: string): boolean {
  return name === OPEN_SHIFT_FILE
    || name === OPEN_SHIFT_TEMP_FILE
    || (name.startsWith(RECOVERY_FILE_PREFIX) && name.endsWith(".json"))
    || (name.startsWith(COMPLETED_SHIFT_FILE_PREFIX) && name.endsWith(".json"));
}

/** A record that names an owner — someone other than this account. */
function isForeign(scope: AccountScope, file: File): boolean {
  try {
    const owner = ownerOf(JSON.parse(file.textSync()));
    return owner !== null && owner !== scope.userId;
  } catch {
    return false;
  }
}

/** Move a file into quarantine, byte for byte, under a name no other file has. */
function moveToQuarantine(file: File, prefix: string): void {
  const target = new File(quarantineDirectory(), `${prefix}${Date.now()}-${newLocalId()}-${file.name}`);
  if (target.exists) throw new Error("Refusing to overwrite a quarantined record");
  file.moveSync(target, { overwrite: false });
}

/**
 * Move every day record still in the SHARED document directory — written by
 * a build before F-31, when records named no account — into quarantine.
 * They are never given to whoever signs in: nothing on the disk says whose
 * they are. Idempotent; run before every storage operation.
 */
export function quarantineLegacyRecords(): void {
  const root = new Directory(Paths.document);
  if (!root.exists) return;
  for (const entry of root.list()) {
    if (entry instanceof File && isDayRecordName(entry.name)) moveToQuarantine(entry, LEGACY_PREFIX);
  }
}

/** A quarantined legacy record the signed-in account can conclusively claim. */
export interface RecoverableLegacyRecord {
  /** Names the quarantined file; pass it back to `recoverLegacyRecord`. */
  key: string;
  kind: "open" | "completed";
  shiftId: string;
  workingFor: WorkingContext;
  startedAt: string;
}

/** What `recoverLegacyRecord` requires: the driver said yes, explicitly. */
export interface LegacyRecoveryConfirmation {
  confirmedByDriver: true;
}

type Claim =
  | { kind: "open"; day: Omit<LocalShift, "ownerUserId"> }
  | { kind: "completed"; day: Omit<CompletedShift, "ownerUserId"> };

/**
 * The claim the signed-in account has on one quarantined file, or `null`.
 *
 * CONCLUSIVE ONLY: a record written before accounts existed names no owner,
 * but a company day names the MEMBERSHIP it was worked under, and a
 * membership belongs to exactly one account. So the record is attributable
 * when EVERY company context it holds — the original and every correction —
 * is a membership the signed-in account holds now, as the server reported.
 * A Personal context names no one: the record stays quarantined. So does
 * anything unreadable, an interrupted write's copy, a recovery file, or a
 * record that already names an owner.
 */
function claimOn(file: File, memberships: readonly { membershipId: string }[]): Claim | null {
  if (!file.name.startsWith(LEGACY_PREFIX)) return null;
  const original = file.name.replace(/^legacy-\d+-[0-9a-f-]+-/, "");
  const isOpen = original === OPEN_SHIFT_FILE;
  const isCompleted = original.startsWith(COMPLETED_SHIFT_FILE_PREFIX);
  if (!isOpen && !isCompleted) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(file.textSync());
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || "ownerUserId" in parsed) return null;

  const held = new Set(memberships.map(membership => membership.membershipId));
  const attributable = (contexts: WorkingContext[]): boolean =>
    contexts.length > 0 && contexts.every(context => context.kind === "company" && held.has(context.membershipId));

  if (isOpen) {
    const day = asLocalShiftContent(parsed);
    return day !== null && attributable([day.workingFor]) ? { kind: "open", day } : null;
  }
  const day = asCompletedShiftContent(parsed);
  if (day === null || original !== `${COMPLETED_SHIFT_FILE_PREFIX}${day.id}.json`) return null;
  const contexts = [day.workingFor, ...(day.corrections ?? []).map(correction => correction.workingFor)];
  return attributable(contexts) ? { kind: "completed", day } : null;
}

/** The quarantined legacy records this account can conclusively claim. */
export async function findRecoverableLegacyRecords(
  scope: AccountScope,
  memberships: readonly { membershipId: string }[],
): Promise<RecoverableLegacyRecord[]> {
  assertLiveScope(scope);
  quarantineLegacyRecords();
  const found: RecoverableLegacyRecord[] = [];
  for (const entry of quarantineDirectory().list()) {
    if (!(entry instanceof File)) continue;
    const claim = claimOn(entry, memberships);
    if (claim === null) continue;
    found.push({ key: entry.name, kind: claim.kind, shiftId: claim.day.id, workingFor: claim.day.workingFor, startedAt: claim.day.startedAt });
  }
  return Promise.resolve(found);
}

/**
 * Recover one quarantined legacy record into THIS account, after the driver
 * explicitly confirmed it is theirs. Refused — leaving everything exactly
 * where it is — unless the claim is conclusive (`claimOn`) and the record
 * would not replace anything: a legacy open day never displaces the
 * account's open day, and a finished day never overwrites one with its id.
 * The quarantined bytes are kept, renamed as recovered.
 */
export function recoverLegacyRecord(
  scope: AccountScope,
  memberships: readonly { membershipId: string }[],
  key: string,
  confirmation: LegacyRecoveryConfirmation,
): Promise<"recovered" | "refused"> {
  if (confirmation.confirmedByDriver !== true) {
    return Promise.reject(new Error("Refusing to recover a record the driver has not confirmed"));
  }
  return queued(scope, () => {
    if (!/^[A-Za-z0-9._-]+$/.test(key)) return Promise.resolve("refused" as const);
    const file = new File(quarantineDirectory(), key);
    if (!file.exists) return Promise.resolve("refused" as const);
    const claim = claimOn(file, memberships);
    if (claim === null) return Promise.resolve("refused" as const);

    if (claim.kind === "open") {
      if (openShiftFile(scope).exists || openShiftTempFile(scope).exists) return Promise.resolve("refused" as const);
      persist(scope, { ownerUserId: scope.userId, ...claim.day });
    } else {
      const target = completedShiftFile(scope, claim.day.id);
      if (target === null || target.exists) return Promise.resolve("refused" as const);
      const serialised = JSON.stringify({ ...claim.day, ownerUserId: scope.userId });
      if (asCompletedShift(JSON.parse(serialised)) === null) return Promise.resolve("refused" as const);
      storeSafely(scope, serialised, target, { overwrite: false });
    }
    file.moveSync(new File(quarantineDirectory(), `${RECOVERED_PREFIX}${scope.userId}-${key}`), { overwrite: false });
    return Promise.resolve("recovered" as const);
  });
}
