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
 * `litres` is therefore `number | null`:
 *
 *   litres: 320      the driver read 320 litres off the pump
 *   litres: null     fuel went in; the quantity is not known
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

/** The two things a driver puts in. One registry, no magic strings. */
export const FILL_TYPE = {
  fuel:   "fuel",
  adblue: "adblue",
} as const;

export type FillType = (typeof FILL_TYPE)[keyof typeof FILL_TYPE];

/** What each type is called on screen, and the action that adds one. */
export const FILL_TYPES: readonly { id: FillType; label: string; action: string }[] = [
  { id: FILL_TYPE.fuel,   label: "Fuel",   action: "Add Fuel" },
  { id: FILL_TYPE.adblue, label: "AdBlue", action: "Add AdBlue" },
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
const MAX_LITRES = 9999.99;

/**
 * One thing put into one asset use: diesel or AdBlue into a vehicle, or diesel
 * into a refrigerated trailer's fridge unit (`trailer.ts`). The same record
 * and the same rules wherever it lands — a real positive reading or an honest
 * `null`, never 0 — but never the same LIST: a vehicle's fuel and a trailer's
 * fridge diesel are held on their own uses and never added together.
 */
export interface FillRecord {
  /** Stable local id — `newLocalId()`, as a day and a check use. */
  id: string;
  /**
   * The driver's declared moment: the device clock when the screen opened,
   * or the time they corrected it to. Never a server time (D28).
   */
  recordedAt: string;
  /** Litres added, or `null` when the quantity is not known. NEVER 0 for unknown. */
  litres: number | null;
  /** Optional, and never required to explain an unknown quantity. */
  note: string | null;
}

/** Diesel or AdBlue put into a vehicle use. */
export interface VehicleFill extends FillRecord {
  type: FillType;
}

/**
 * A quantity this app is willing to store: a real, positive reading, to the
 * two decimal places a pump displays. Zero and negatives are not quantities,
 * and `null` — not this function — is how "unknown" is said.
 */
function isStorableLitres(value: number): boolean {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_LITRES) return false;
  const hundredths = value * 100;
  return Math.abs(hundredths - Math.round(hundredths)) < 1e-9;
}

/**
 * What the driver typed, as litres — or `null` while it is not a quantity.
 *
 * Digits, optionally to two decimal places, because that is what a pump
 * shows. A comma is read as a decimal point: a European keypad offers one,
 * and "12,5" plainly means twelve and a half litres. `0` is not a quantity —
 * a fill of nothing did not happen — and neither is a minus sign or an
 * exponent. Unknown is a separate answer, never an empty field.
 */
export function parseLitres(raw: string): number | null {
  const typed = raw.trim().replace(",", ".");
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(typed)) return null;
  const value = Number(typed);
  return isStorableLitres(value) ? value : null;
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

  const { id, recordedAt, litres, note } = record;
  if (typeof id !== "string" || id === "") return null;
  if (typeof recordedAt !== "string" || Number.isNaN(Date.parse(recordedAt))) return null;

  // Absent is not unknown: a fill has always been written with the field, so
  // a missing one is a broken record rather than an older, valid shape.
  if (litres !== null && (typeof litres !== "number" || !isStorableLitres(litres))) return null;
  if (note !== null && (typeof note !== "string" || note.length > FILL_NOTE_MAX_LENGTH)) return null;

  return { id, recordedAt, litres, note };
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
 * REFUSES — throws — an invalid moment, an over-long note, and any `litres`
 * that is not a real positive reading. Unknown is `null`, never 0.
 */
export function checkedFillNote(input: { fillId: string; recordedAt: Date; litres: number | null; note: string }): string | null {
  if (input.fillId === "") throw new Error("Refusing a fill with no id");
  if (Number.isNaN(input.recordedAt.getTime())) throw new Error("Refusing a fill with an invalid time");
  if (input.litres !== null && !isStorableLitres(input.litres)) throw new Error("Refusing a fill quantity that is not a positive reading");
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
  /** Litres across the fills whose quantity IS known — never padded with a guess. */
  knownLitres: number;
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
  let knownLitres = 0;
  let unknownCount = 0;
  for (const fill of mine) {
    if (fill.litres === null) unknownCount += 1;
    else knownLitres += fill.litres;
  }
  // Two decimal places in, two decimal places out: adding 0.1 and 0.2 in
  // binary floating point must not surface as 0.30000000000000004 litres.
  return { count: mine.length, knownLitres: Math.round(knownLitres * 100) / 100, unknownCount };
}
