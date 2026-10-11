/**
 * Measurement units (D52, D66) — the one registry on the phone.
 *
 * Every odometer reading and every fuel quantity is stored WITH the unit it
 * was recorded in, and never converted or relabelled. A reading recorded
 * before units existed has none (odometer) — the number is whatever the
 * vehicle's dashboard showed, so no unit is ever printed beside it. Fuel
 * recorded before units was entered under a field labelled LITRES, so it is
 * litres, and says why (`legacy-litres-label`).
 *
 * The ids are the API's (`api/src/lib/units.ts`); the workspaces share no code.
 */
export type DistanceUnit = "kilometre" | "mile";
export type VolumeUnit = "litre" | "us_gallon" | "imperial_gallon";

export const DISTANCE_UNITS: readonly { id: DistanceUnit; label: string; short: string }[] = [
  { id: "kilometre", label: "Kilometres", short: "km" },
  { id: "mile",      label: "Miles",      short: "mi" },
] as const;

export const VOLUME_UNITS: readonly { id: VolumeUnit; label: string; short: string }[] = [
  { id: "litre",           label: "Litres",           short: "L" },
  { id: "us_gallon",       label: "US gallons",       short: "US gal" },
  { id: "imperial_gallon", label: "Imperial gallons", short: "imp gal" },
] as const;

export function isDistanceUnit(value: unknown): value is DistanceUnit {
  return DISTANCE_UNITS.some(unit => unit.id === value);
}

export function isVolumeUnit(value: unknown): value is VolumeUnit {
  return VOLUME_UNITS.some(unit => unit.id === value);
}

export function distanceShort(unit: DistanceUnit): string {
  return DISTANCE_UNITS.find(entry => entry.id === unit)?.short ?? unit;
}

export function volumeShort(unit: VolumeUnit): string {
  return VOLUME_UNITS.find(entry => entry.id === unit)?.short ?? unit;
}

export function volumeLabel(unit: VolumeUnit): string {
  return VOLUME_UNITS.find(entry => entry.id === unit)?.label ?? unit;
}

/** Where a recorded unit came from. */
export const UNIT_SOURCE = {
  /** Recorded with the unit the form showed. */
  recorded: "recorded",
  /** Recorded before units existed, under a field labelled LITRES (D66). */
  legacyLitresLabel: "legacy-litres-label",
} as const;

export type UnitSource = (typeof UNIT_SOURCE)[keyof typeof UNIT_SOURCE];
