/**
 * The company's driver invitations (D63) — the four calls the Drivers page
 * makes, each as the COMPANY (`withCompany`: its tenant token, in memory).
 * Every answer is shape-checked; one that is not the API's shape is a
 * refusal, never a guess.
 */
import type { ApiResult } from "../../auth/http";
import { apiRequest } from "../../auth/http";

export type InvitationStatus = "pending" | "accepted" | "declined" | "expired" | "cancelled";

/** An invitation as the company sees it: what it typed, and where it stands. */
export interface DriverInvitation {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  payrollRef: string | null;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
}

export interface NewDriver {
  firstName: string;
  lastName: string;
  email: string;
  /** Omitted when the company has none — never an empty string. */
  payrollRef?: string;
}

export interface InvitationCorrection {
  firstName: string;
  lastName: string;
  payrollRef: string | null;
}

type CompanyCall = <T>(call: (tenantToken: string) => Promise<ApiResult<T>>) => Promise<ApiResult<T>>;

const STATUSES: readonly InvitationStatus[] = ["pending", "accepted", "declined", "expired", "cancelled"];

function isStatus(value: unknown): value is InvitationStatus {
  return STATUSES.some(status => status === value);
}
const BASE = "/company/driver-invitations";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asInvitation(value: unknown): DriverInvitation | null {
  if (!isRecord(value)) return null;
  const { id, firstName, lastName, email, payrollRef, status, createdAt, expiresAt } = value;
  if (typeof id !== "string" || typeof firstName !== "string" || typeof lastName !== "string" || typeof email !== "string") return null;
  if (payrollRef !== null && typeof payrollRef !== "string") return null;
  if (!isStatus(status)) return null;
  if (typeof createdAt !== "string" || typeof expiresAt !== "string") return null;
  return { id, firstName, lastName, email, payrollRef, status, createdAt, expiresAt };
}

function parseList(value: unknown): DriverInvitation[] | null {
  if (!isRecord(value) || !Array.isArray(value["invitations"])) return null;
  const parsed = value["invitations"].map(asInvitation);
  return parsed.every((item): item is DriverInvitation => item !== null) ? parsed : null;
}

function parseOne(value: unknown): DriverInvitation | null {
  return isRecord(value) ? asInvitation(value["invitation"]) : null;
}

export function listInvitations(withCompany: CompanyCall): Promise<ApiResult<DriverInvitation[]>> {
  return withCompany(token => apiRequest(BASE, { method: "GET", token }, parseList));
}

export function addDriver(withCompany: CompanyCall, driver: NewDriver): Promise<ApiResult<DriverInvitation>> {
  return withCompany(token => apiRequest(BASE, { token, body: driver }, parseOne));
}

export function correctInvitation(withCompany: CompanyCall, id: string, correction: InvitationCorrection): Promise<ApiResult<DriverInvitation>> {
  return withCompany(token => apiRequest(`${BASE}/${encodeURIComponent(id)}`, { method: "PATCH", token, body: correction }, parseOne));
}

export function cancelInvitation(withCompany: CompanyCall, id: string): Promise<ApiResult<DriverInvitation>> {
  return withCompany(token => apiRequest(`${BASE}/${encodeURIComponent(id)}/cancel`, { token }, parseOne));
}
