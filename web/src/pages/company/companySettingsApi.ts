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

/** The company's report address (D66): reports go only to a CONFIRMED one. */
export interface ReportEmail {
  address: string | null;
  verified: boolean;
}

const REPORT_EMAIL = "/company/settings/report-email";

function parseReportEmail(value: unknown): ReportEmail | null {
  if (typeof value !== "object" || value === null || !("reportEmail" in value)) return null;
  const report: unknown = value.reportEmail;
  if (typeof report !== "object" || report === null || !("address" in report) || !("verified" in report)) return null;
  const { address, verified } = report;
  if ((address !== null && typeof address !== "string") || typeof verified !== "boolean") return null;
  if (address === null && verified) return null;
  return { address, verified };
}

export function readReportEmail(withCompany: CompanyCall): Promise<ApiResult<ReportEmail>> {
  return withCompany(token => apiRequest(REPORT_EMAIL, { method: "GET", token }, parseReportEmail));
}

export function saveReportEmail(withCompany: CompanyCall, email: string): Promise<ApiResult<ReportEmail>> {
  return withCompany(token => apiRequest(REPORT_EMAIL, { method: "PUT", token, body: { email } }, parseReportEmail));
}

function parseConfirmed(value: unknown): { companyName: string } | null {
  if (typeof value !== "object" || value === null || !("companyName" in value) || typeof value.companyName !== "string") return null;
  return { companyName: value.companyName };
}

/** Public: the emailed link's token is the credential. */
export function confirmReportEmail(token: string): Promise<ApiResult<{ companyName: string }>> {
  return apiRequest(`${REPORT_EMAIL}/confirm`, { body: { token } }, parseConfirmed);
}
