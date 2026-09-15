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
 * no trailer, no check, no defect, no fuel and no note field waiting for a
 * later step to fill in (CLAUDE.md — never invent a field nothing writes).
 *
 * ONE VEHICLE, for now. A day holds the vehicle it is using; a later increment
 * lets a driver change it and keeps the earlier ones. Nothing here builds that
 * history in advance — but every stored vehicle records when its use began,
 * in one field whatever route it arrived by, because that is the one fact the
 * later history needs that cannot be recovered afterwards.
 */
import { File, Paths } from "expo-file-system";

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
  /** `null` when the driver has booked on without a vehicle — a real state. */
  vehicle: LocalVehicle | null;
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

function newShiftId(): string {
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

  return { id, workingFor: context, startedAt, vehicle: asVehicle, status: "open", createdAt };
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
  if (startedAt === undefined) return { ...vehicle, startedAt: shiftStartedAt };
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) return null;
  return { ...vehicle, startedAt };
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
 * adding a vehicle — queues behind the last, and each finds what the one
 * before it wrote.
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
    id:         newShiftId(),
    workingFor: input.workingFor,
    startedAt,
    // A vehicle given at the start began with the day: the same instant.
    vehicle:    input.vehicle === null ? null : {
      vehicleClass: input.vehicle.vehicleClass,
      numberPlate:  input.vehicle.numberPlate,
      startMileage: input.vehicle.startMileage,
      startedAt,
    },
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
    },
  };
  const file = openShiftFile();
  file.write(JSON.stringify(updated));
  return updated;
}

/** Forget the open shift. The end of a day, and the reset a test needs. */
export async function clearOpenShift(): Promise<void> {
  const file = openShiftFile();
  if (file.exists) file.delete();
  return Promise.resolve();
}
