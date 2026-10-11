/**
 * The company's settings (D66) — each call as the COMPANY (`withCompany`:
 * its tenant token, in memory). Every answer is shape-checked; one that is
 * not the API's shape is a refusal, never a guess.
 */
import type { ApiResult } from "../../auth/http";
import { apiRequest } from "../../auth/http";
import { isDistanceUnit, isVolumeUnit, type DistanceUnit, type VolumeUnit } from "../../units";

/** The company's units — each chosen, or null where it has not chosen yet. */
export interface CompanyUnits {
  distanceUnit: DistanceUnit | null;
  volumeUnit: VolumeUnit | null;
}

type CompanyCall = <T>(call: (tenantToken: string) => Promise<ApiResult<T>>) => Promise<ApiResult<T>>;

const UNITS = "/company/settings/units";

function parseUnits(value: unknown): CompanyUnits | null {
  if (typeof value !== "object" || value === null || !("units" in value)) return null;
  const units: unknown = value.units;
  if (typeof units !== "object" || units === null || !("distanceUnit" in units) || !("volumeUnit" in units)) return null;
  const { distanceUnit, volumeUnit } = units;
  if (distanceUnit !== null && !isDistanceUnit(distanceUnit)) return null;
  if (volumeUnit !== null && !isVolumeUnit(volumeUnit)) return null;
  return { distanceUnit, volumeUnit };
}

export function readUnits(withCompany: CompanyCall): Promise<ApiResult<CompanyUnits>> {
  return withCompany(token => apiRequest(UNITS, { method: "GET", token }, parseUnits));
}

export function saveUnits(withCompany: CompanyCall, units: { distanceUnit: DistanceUnit; volumeUnit: VolumeUnit }): Promise<ApiResult<CompanyUnits>> {
  return withCompany(token => apiRequest(UNITS, { method: "PUT", token, body: units }, parseUnits));
}

/** Whether the company still has a unit to choose (D66: existing companies are prompted). */
export function unitsMissing(units: CompanyUnits): boolean {
  return units.distanceUnit === null || units.volumeUnit === null;
}
