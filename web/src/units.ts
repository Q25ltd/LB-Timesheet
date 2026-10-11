/**
 * Measurement units a company records in (D52, D66) — the values the API
 * accepts and the words the website shows for them. No default: a company
 * chooses, and an unknown value is never shown as one of these.
 */
export type DistanceUnit = "kilometre" | "mile";
export type VolumeUnit = "litre" | "us_gallon" | "imperial_gallon";

export const DISTANCE_UNITS: readonly { value: DistanceUnit; label: string }[] = [
  { value: "kilometre", label: "Kilometres (km)" },
  { value: "mile",      label: "Miles (mi)" },
];

export const VOLUME_UNITS: readonly { value: VolumeUnit; label: string }[] = [
  { value: "litre",           label: "Litres (L)" },
  { value: "us_gallon",       label: "US gallons (US gal)" },
  { value: "imperial_gallon", label: "Imperial gallons (imp gal)" },
];

export function isDistanceUnit(value: unknown): value is DistanceUnit {
  return DISTANCE_UNITS.some(unit => unit.value === value);
}

export function isVolumeUnit(value: unknown): value is VolumeUnit {
  return VOLUME_UNITS.some(unit => unit.value === value);
}
