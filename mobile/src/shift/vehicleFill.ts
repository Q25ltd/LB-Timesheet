/**
 * A vehicle fill — diesel or AdBlue put INTO the vehicle during its use.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHERE A FILL BELONGS
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A fill is stored INSIDE the vehicle use it was put into — `vehicle.fills` in
 * the open shift — never in a list keyed by number plate. That containment is
 * its identity, exactly as it is for a check: which day is the document it
 * sits in, which USE is the vehicle entry it sits under (itself identified by
 * `vehicle.startedAt`), and the plate and class are that use's.
 *
 * So a driver who takes AB12 CDE in the morning, changes to XY34 ZZZ, and
 * comes back to AB12 CDE after lunch has THREE separate lists, even though two
 * of them are the same physical truck. The morning's 300 litres stay on the
 * morning's use; the afternoon's use starts empty and is filled on its own
 * terms. Nothing is inherited, moved or merged by plate.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UNKNOWN IS A REAL ANSWER, AND IT IS NOT ZERO
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Yard pumps have broken meters and bulk tanks have none at all. A driver
 * genuinely knows fuel went in and genuinely does not know how much, and that
 * is a complete record of what happened — not a half-filled form.
 *
 * `quantity` is therefore `number | null`, in the unit recorded with it (D66):
 *
 *   quantity: 320    the driver read 320 off the pump, in `volumeUnit`
 *   quantity: null   fuel went in; the quantity is not known
 *
 * A fill recorded before units holds `litres` instead — the form said LITRES
 * — and is read as litres, never rewritten (`fillAmount`).
 *
 * **NULL IS NEVER 0, AND 0 IS NEVER STORED FOR UNKNOWN.** Zero would be a
 * measurement — "nothing went in" — and would silently join every total it
 * touched. A quantity the app does not know is absent, and every screen that
 * shows a total must say so rather than adding a guess (CLAUDE.md: never
 * invent data). Unknown needs no reason, and the note is never required to
 * excuse it.
 *
 * Nothing about price, cost, supplier, station, payment, tank level or economy
 * is recorded. This is what went in, and when.
 */

import { UNIT_SOURCE, isVolumeUnit, type UnitSource, type VolumeUnit } from "./units";

/** The two things a driver puts in. One registry, no magic strings. */
export const FILL_TYPE = {
  fuel:   "fuel",
  adblue: "adblue",
} as const;

export type FillType = (typeof FILL_TYPE)[keyof typeof FILL_TYPE];

/**
 * What each type is called on screen, and the action that adds one. The
 * fluid is named both ways — AdBlue in Europe, DEF in North America (D52);
 * the stored id stays `adblue`.
 */
export const FILL_TYPES: readonly { id: FillType; label: string; action: string }[] = [
  { id: FILL_TYPE.fuel,   label: "Fuel",         action: "Add Fuel" },
  { id: FILL_TYPE.adblue, label: "AdBlue / DEF", action: "Add AdBlue / DEF" },
] as const;

export function fillTypeLabel(type: FillType): string {
  return FILL_TYPES.find(entry => entry.id === type)?.label ?? type;
}

/** The driver's own words about a fill, capped like a defect description. */
export const FILL_NOTE_MAX_LENGTH = 500;

/**
 * A refusal bound, not a product rule: no single fill is ten thousand litres,
 * so a value beyond it is a typed mistake rather than a reading. It exists to
 * keep a slipped keypress out of a payroll record, and is deliberately far
 * above any real tank.
 */
/** A refusal bound, not a product rule: no single fill is ten thousand of any unit. */
const MAX_QUANTITY = 9999.99;

/**
 * One thing put into one asset use: diesel or AdBlue into a vehicle, or diesel
 * into a refrigerated trailer's fridge unit (`trailer.ts`). The same record
 * and the same rules wherever it lands — a real positive reading or an honest
 * `null`, never 0 — but never the same LIST: a vehicle's fuel and a trailer's
 * fridge diesel are held on their own uses and never added together.
 */
/**
 * A quantity as it is recorded now (D66): the number the driver read, WITH the
 * unit the form showed. `quantity` is `null` when the driver does not know it
 * — never 0. `volumeUnit` is `null` only when no unit was set when it was
 * recorded (a company that had not chosen its units; a Personal day with no
 * preference) — never guessed afterwards.
 */
interface UnitQuantity {
  quantity: number | null;
  volumeUnit: VolumeUnit | null;
}

/**
 * A quantity recorded BEFORE units existed: the form labelled the field
 * LITRES, so it is litres (D66). Read exactly as stored — never rewritten —
 * so a timesheet declared before units keeps the version it was declared at.
 */
interface LegacyLitres {
  litres: number | null;
}

export type FillRecord = {
  /** Stable local id — `newLocalId()`, as a day and a check use. */
  id: string;
  /**
   * The driver's declared moment: the device clock when the screen opened,
   * or the time they corrected it to. Never a server time (D28).
   */
  recordedAt: string;
  /** Optional, and never required to explain an unknown quantity. */
  note: string | null;
} & (UnitQuantity | LegacyLitres);

/** What a fill says it holds: its quantity, the unit, and where that unit came from. */
export interface FillAmount {
  quantity: number | null;
  unit: VolumeUnit | null;
  source: UnitSource;
}

export function fillAmount(fill: FillRecord): FillAmount {
  if ("litres" in fill) return { quantity: fill.litres, unit: "litre", source: UNIT_SOURCE.legacyLitresLabel };
  return { quantity: fill.quantity, unit: fill.volumeUnit, source: UNIT_SOURCE.recorded };
}

/** Diesel or AdBlue put into a vehicle use. */
export type VehicleFill = FillRecord & {
  type: FillType;
};

/**
 * A quantity this app is willing to store: a real, positive reading, to the
 * two decimal places a pump displays. Zero and negatives are not quantities,
 * and `null` — not this function — is how "unknown" is said.
 */
function isStorableQuantity(value: number): boolean {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_QUANTITY) return false;
  const hundredths = value * 100;
  return Math.abs(hundredths - Math.round(hundredths)) < 1e-9;
}

/**
 * What the driver typed, as a quantity in the unit the form shows — or `null`
 * while it is not one.
 *
 * Digits, optionally to two decimal places, because that is what a pump
 * shows. A comma is read as a decimal point: a European keypad offers one,
 * and "12,5" plainly means twelve and a half. `0` is not a quantity — a fill
 * of nothing did not happen — and neither is a minus sign or an exponent.
 * Unknown is a separate answer, never an empty field.
 */
export function parseQuantity(raw: string): number | null {
  const typed = raw.trim().replace(",", ".");
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(typed)) return null;
  const value = Number(typed);
  return isStorableQuantity(value) ? value : null;
}

/**
 * Narrow a stored value to a fill, or reject it.
 *
 * A fill is a quantity record. A malformed one is refused rather than
 * repaired or dropped: the caller fails the whole day closed, as it does for
 * an unreadable vehicle use, because a day quietly missing a fill would read
 * as complete when it is not.
 */
export function asVehicleFill(value: unknown): VehicleFill | null {
  const fill = asFillRecord(value);
  if (fill === null || typeof value !== "object" || value === null) return null;
  const { type } = value as Record<string, unknown>;
  if (!FILL_TYPES.some(entry => entry.id === type)) return null;
  return { ...fill, type: type as FillType };
}

/** The fields every fill carries, or `null` if any is broken. */
export function asFillRecord(value: unknown): FillRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  const { id, recordedAt, note } = record;
  if (typeof id !== "string" || id === "") return null;
  if (typeof recordedAt !== "string" || Number.isNaN(Date.parse(recordedAt))) return null;
  if (note !== null && (typeof note !== "string" || note.length > FILL_NOTE_MAX_LENGTH)) return null;

  // Exactly one shape. Absent is not unknown: a fill has always been written
  // with its quantity field, so a missing one — or both shapes at once — is a
  // broken record rather than an older, valid one.
  const legacy = "litres" in record;
  const current = "quantity" in record || "volumeUnit" in record;
  if (legacy === current) return null;
  if (legacy) {
    const { litres } = record;
    if (!isQuantity(litres)) return null;
    return { id, recordedAt, litres, note };
  }
  const { quantity, volumeUnit } = record;
  if (!("quantity" in record) || !("volumeUnit" in record) || !isQuantity(quantity)) return null;
  if (volumeUnit !== null && !isVolumeUnit(volumeUnit)) return null;
  return { id, recordedAt, quantity, volumeUnit, note };
}

function isQuantity(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && isStorableQuantity(value));
}

/**
 * The list a fill lands in, after a write: a correction (the same id) replaces
 * the entry where it stands; anything else is appended.
 */
export function withFill<T extends FillRecord>(fills: readonly T[], fill: T): T[] {
  return fills.some(stored => stored.id === fill.id)
    ? fills.map(stored => (stored.id === fill.id ? fill : stored))
    : [...fills, fill];
}

/**
 * A fill as the driver entered it, checked before anything is written — the
 * rules every fill shares. Returns the note as stored (`null` when empty).
 * REFUSES — throws — an invalid moment, an over-long note, any `quantity`
 * that is not a real positive reading, and a unit that is not one. Unknown is
 * `null`, never 0.
 */
export function checkedFillNote(input: { fillId: string; recordedAt: Date; quantity: number | null; volumeUnit: VolumeUnit | null; note: string }): string | null {
  if (input.fillId === "") throw new Error("Refusing a fill with no id");
  if (Number.isNaN(input.recordedAt.getTime())) throw new Error("Refusing a fill with an invalid time");
  if (input.quantity !== null && !isStorableQuantity(input.quantity)) throw new Error("Refusing a fill quantity that is not a positive reading");
  if (input.volumeUnit !== null && !isVolumeUnit(input.volumeUnit)) throw new Error("Refusing a fill in an unknown unit");
  const described = input.note.trim();
  if (described.length > FILL_NOTE_MAX_LENGTH) throw new Error("Refusing an over-long fill note");
  return described === "" ? null : described;
}

/** One type's fills, in the order the driver recorded them. */
export function fillsOfType(fills: readonly VehicleFill[], type: FillType): VehicleFill[] {
  return fills.filter(fill => fill.type === type);
}

export interface FillSummary {
  /** How many fills of this type the use holds. */
  count: number;
  /**
   * The total of the fills whose quantity IS known, PER UNIT, in the order
   * each unit first appears — never converted, never padded with a guess. One
   * entry in the ordinary case; a day whose units changed holds more. `unit`
   * is null for quantities recorded with no unit set.
   */
  known: { unit: VolumeUnit | null; total: number }[];
  /** How many of them have no quantity at all. */
  unknownCount: number;
}

/**
 * What one type adds up to on this vehicle use.
 *
 * The unknown ones are COUNTED, never valued: a total that quietly absorbed
 * them would be a number the driver never gave. Screens report both halves.
 */
export function summariseFills(fills: readonly VehicleFill[], type: FillType): FillSummary {
  return summariseRecords(fillsOfType(fills, type));
}

/** The same arithmetic over a list that is already one kind — a trailer's fridge diesel. */
export function summariseRecords(mine: readonly FillRecord[]): FillSummary {
  const known: { unit: VolumeUnit | null; total: number }[] = [];
  let unknownCount = 0;
  for (const fill of mine) {
    const { quantity, unit } = fillAmount(fill);
    if (quantity === null) {
      unknownCount += 1;
      continue;
    }
    const entry = known.find(sum => sum.unit === unit);
    if (entry === undefined) known.push({ unit, total: quantity });
    else entry.total += quantity;
  }
  // Two decimal places in, two decimal places out: adding 0.1 and 0.2 in
  // binary floating point must not surface as 0.30000000000000004.
  return { count: mine.length, known: known.map(sum => ({ unit: sum.unit, total: Math.round(sum.total * 100) / 100 })), unknownCount };
}
