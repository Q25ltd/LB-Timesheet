/**
 * The company's drivers (D65) — the list and the three actions the Drivers
 * page makes, each as the COMPANY (`withCompany`: its tenant token, in
 * memory). Every answer is shape-checked; one that is not the API's shape is
 * a refusal, never a guess.
 */
import type { ApiResult } from "../../auth/http";
import { apiRequest } from "../../auth/http";

type DriverStatus = "active" | "inactive";
export type DriverAction = "deactivate" | "reactivate" | "remove";

/** One of the company's drivers: the account's name and email, the company's payroll reference, where they stand. */
export interface CompanyDriver {
  membershipId: string;
  firstName: string;
  lastName: string;
  email: string;
  payrollRef: string | null;
  status: DriverStatus;
  joinedAt: string;
}

type CompanyCall = <T>(call: (tenantToken: string) => Promise<ApiResult<T>>) => Promise<ApiResult<T>>;

const BASE = "/company/drivers";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asDriver(value: unknown): CompanyDriver | null {
  if (!isRecord(value)) return null;
  const { membershipId, firstName, lastName, email, payrollRef, status, joinedAt } = value;
  if (typeof membershipId !== "string" || typeof firstName !== "string" || typeof lastName !== "string" || typeof email !== "string") return null;
  if (payrollRef !== null && typeof payrollRef !== "string") return null;
  if (status !== "active" && status !== "inactive") return null;
  if (typeof joinedAt !== "string") return null;
  return { membershipId, firstName, lastName, email, payrollRef, status, joinedAt };
}

function parseList(value: unknown): CompanyDriver[] | null {
  if (!isRecord(value) || !Array.isArray(value["drivers"])) return null;
  const parsed = value["drivers"].map(asDriver);
  return parsed.every((item): item is CompanyDriver => item !== null) ? parsed : null;
}

/** An action's answer: the driver as they now stand. A removed driver is `removed`, and leaves the list. */
function parseChanged(value: unknown): true | null {
  if (!isRecord(value) || !isRecord(value["driver"])) return null;
  return typeof value["driver"]["membershipId"] === "string" ? true : null;
}

export function listDrivers(withCompany: CompanyCall): Promise<ApiResult<CompanyDriver[]>> {
  return withCompany(token => apiRequest(BASE, { method: "GET", token }, parseList));
}

export function changeDriver(withCompany: CompanyCall, membershipId: string, action: DriverAction): Promise<ApiResult<true>> {
  return withCompany(token => apiRequest(`${BASE}/${encodeURIComponent(membershipId)}/${action}`, { token }, parseChanged));
}
