/**
 * A trailer — a SEPARATE ASSET from whatever tows it (D30, D34).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ITS OWN USES, NEVER PART OF THE VEHICLE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The day holds the trailer in use (`LocalShift.trailer`) and every earlier
 * trailer use (`LocalShift.previousTrailers`), beside — never inside — the
 * vehicle's. A driver may change unit and keep the trailer, or drop the
 * trailer and keep the unit; each change touches one asset only. A trailer
 * use is identified by when it began, `startedAt`, never by its number:
 * collecting TR1234 again after lunch is a NEW use with nothing carried over.
 *
 * NO MILEAGE. A trailer has no odometer the driver reads, so a trailer use
 * records which trailer, what kind, when, its own walkaround checks, and — if
 * refrigerated — its fridge diesel.
 *
 * ITS OWN CHECKS (D35). A trailer use carries its own Trailer Check, on its
 * own checklist (`checklists.ts`), exactly as a vehicle use carries its own
 * Vehicle Check: never the unit's, never another trailer's, and never an
 * earlier use of the same trailer's. A new use starts with none.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * TWO KINDS, AND ONLY TWO
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Standard or Refrigerated. The one distinction the app needs is whether the
 * trailer carries a fridge unit with its own diesel tank, because that diesel
 * is recorded — on the trailer use, never as the unit's Fuel. Curtainsider,
 * box, flatbed and the rest change nothing the app records.
 *
 * WHICH VEHICLES MAY TOW ONE: Class 1 and Class 2 (a rigid may pull a drawbar),
 * never a van (D30). The day never holds a trailer while a van is in use.
 */
import type { VehicleClass } from "./localShift";
import { trailerChecklistFor } from "./checklists";
import { readChecksFor, type VehicleCheck } from "./vehicleCheck";
import { asFillRecord, type FillRecord } from "./vehicleFill";

/** The two kinds of trailer. One registry, no magic strings. */
export const TRAILER_TYPE = {
  standard:     "standard",
  refrigerated: "refrigerated",
} as const;

export type TrailerType = (typeof TRAILER_TYPE)[keyof typeof TRAILER_TYPE];

export const TRAILER_TYPES: readonly { id: TrailerType; label: string }[] = [
  { id: TRAILER_TYPE.standard,     label: "Standard" },
  { id: TRAILER_TYPE.refrigerated, label: "Refrigerated" },
] as const;

export function trailerTypeLabel(type: TrailerType): string {
  return TRAILER_TYPES.find(entry => entry.id === type)?.label ?? type;
}

/** Whether a vehicle of this class may tow a trailer. Van: no (D30). */
export function towsTrailers(vehicleClass: VehicleClass): boolean {
  return vehicleClass === "class1" || vehicleClass === "class2";
}

/**
 * Trimmed and upper-cased. Never format-validated: trailers carry fleet
 * numbers as often as road registrations.
 */
export function normaliseTrailerNumber(raw: string): string {
  return raw.trim().toUpperCase();
}

/** What a driver enters about a trailer — the same two things wherever it is entered. */
export interface TrailerDetails {
  trailerNumber: string;
  trailerType: TrailerType;
}

export interface LocalTrailer extends TrailerDetails {
  /** When this trailer's use in the day began — the moment it was added or taken. */
  startedAt: string;
  /**
   * Diesel put into a REFRIGERATED trailer's fridge unit during THIS use,
   * in the order recorded. Always empty on a standard trailer. Never the
   * unit's Fuel, and never added to it.
   */
  reeferDiesel: FillRecord[];
  /**
   * The walkaround checks made on THIS trailer use, oldest first — the same
   * record as a vehicle's (`vehicleCheck.ts`), against this trailer type's
   * checklist. Empty until the driver answers a first item.
   */
  checks: VehicleCheck[];
}

/** A trailer use that has ENDED: changed for another, or handed back. */
export interface EndedTrailer extends LocalTrailer {
  endedAt: string;
}

/**
 * Narrow a stored value to a trailer in use, or reject it.
 *
 * Anything that is not exactly a trailer — an unknown type, an empty number,
 * a broken diesel entry, a repeated diesel id, or fridge diesel on a standard
 * trailer — is refused, and the caller fails the whole day closed: a day
 * quietly missing a trailer or a fill would read as complete when it is not.
 */
export function asLocalTrailer(value: unknown): LocalTrailer | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  const { trailerNumber, trailerType, startedAt, reeferDiesel } = record;
  if (typeof trailerNumber !== "string" || trailerNumber === "") return null;
  const type = TRAILER_TYPES.find(entry => entry.id === trailerType)?.id;
  if (type === undefined) return null;
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) return null;

  if (!Array.isArray(reeferDiesel)) return null;
  const fills: FillRecord[] = [];
  const seen = new Set<string>();
  for (const raw of reeferDiesel) {
    const fill = asFillRecord(raw);
    if (fill === null || seen.has(fill.id)) return null;
    seen.add(fill.id);
    fills.push(fill);
  }
  if (type === TRAILER_TYPE.standard && fills.length > 0) return null;

  // Checks are read as a vehicle's are: absent means none, and a check that
  // cannot be read against THIS trailer's checklist is dropped — it reads as
  // not done, never as a pass (`readChecksFor`).
  const checks = readChecksFor(record["checks"], trailerChecklistFor(type));

  return { trailerNumber, trailerType: type, startedAt, reeferDiesel: fills, checks };
}

export function asEndedTrailer(value: unknown): EndedTrailer | null {
  const trailer = asLocalTrailer(value);
  if (trailer === null || typeof value !== "object" || value === null) return null;
  const { endedAt } = value as Record<string, unknown>;
  if (typeof endedAt !== "string" || Number.isNaN(Date.parse(endedAt))) return null;
  // Never before it began — the vehicle's rule too (`asEndedVehicle`).
  if (Date.parse(endedAt) < Date.parse(trailer.startedAt)) return null;
  return { ...trailer, endedAt };
}
