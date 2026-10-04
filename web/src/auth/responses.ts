/**
 * The API's response shapes, checked at runtime.
 *
 * A response is untrusted input like any other: each parser either returns a
 * fully checked value or null, and the caller treats null as a failure. No
 * cast stands in for a check (CLAUDE.md).
 */
interface AccountUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

/** A company the account is an ACTIVE member of. Never authority by itself. */
interface Membership {
  membershipId: string;
  companyId: string;
  companyName: string;
  role: "driver" | "admin";
}

export interface SignedIn {
  user: AccountUser;
  identityToken: string;
  memberships: Membership[];
  /** Present only when the server auto-selected the one active membership. */
  tenantToken?: string;
}

/** The account's own unfinished company registration (D51). */
interface PendingCompanyRegistration {
  companyName: string;
  timezone: string;
}

export interface Account {
  user: AccountUser;
  emailVerified: boolean;
  memberships: Membership[];
  /** Null once the company exists — and for any account that never registered one. */
  pendingCompanyRegistration: PendingCompanyRegistration | null;
}

export interface CompanySelection {
  tenantToken: string;
  membership: Membership;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function user(value: unknown): AccountUser | null {
  if (!isRecord(value)) return null;
  const id = text(value, "id");
  const firstName = text(value, "firstName");
  const lastName = text(value, "lastName");
  const email = text(value, "email");
  if (id === null || firstName === null || lastName === null || email === null) return null;
  return { id, firstName, lastName, email };
}

function membership(value: unknown): Membership | null {
  if (!isRecord(value)) return null;
  const membershipId = text(value, "membershipId");
  const companyId = text(value, "companyId");
  const companyName = text(value, "companyName");
  const role = value["role"];
  if (membershipId === null || companyId === null || companyName === null) return null;
  if (role !== "driver" && role !== "admin") return null;
  return { membershipId, companyId, companyName, role };
}

function memberships(value: unknown): Membership[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map(membership);
  return parsed.every((entry): entry is Membership => entry !== null) ? parsed : null;
}

export function parseSignedIn(value: unknown): SignedIn | null {
  if (!isRecord(value)) return null;
  const parsedUser = user(value["user"]);
  const identityToken = text(value, "identityToken");
  const parsedMemberships = memberships(value["memberships"]);
  if (parsedUser === null || identityToken === null || parsedMemberships === null) return null;
  const tenantToken = value["tenantToken"];
  if (tenantToken !== undefined && typeof tenantToken !== "string") return null;
  return {
    user: parsedUser,
    identityToken,
    memberships: parsedMemberships,
    ...(typeof tenantToken === "string" ? { tenantToken } : {}),
  };
}

export function parseIdentityToken(value: unknown): string | null {
  return isRecord(value) ? text(value, "identityToken") : null;
}

export function parseAccount(value: unknown): Account | null {
  if (!isRecord(value)) return null;
  const parsedUser = user(value["user"]);
  const parsedMemberships = memberships(value["memberships"]);
  const emailVerified = value["emailVerified"];
  if (parsedUser === null || parsedMemberships === null || typeof emailVerified !== "boolean") return null;
  const pending = value["pendingCompanyRegistration"];
  let pendingCompanyRegistration: PendingCompanyRegistration | null = null;
  if (pending !== null) {
    if (!isRecord(pending)) return null;
    const companyName = text(pending, "companyName");
    const timezone = text(pending, "timezone");
    if (companyName === null || timezone === null) return null;
    pendingCompanyRegistration = { companyName, timezone };
  }
  return { user: parsedUser, emailVerified, memberships: parsedMemberships, pendingCompanyRegistration };
}

/** What confirming an emailed link did (D51): whether it completed a company registration. */
export function parseConfirmation(value: unknown): { companyRegistered: boolean } | null {
  if (!isRecord(value)) return null;
  const companyRegistered = value["companyRegistered"];
  return typeof companyRegistered === "boolean" ? { companyRegistered } : null;
}

export function parseCompanySelection(value: unknown): CompanySelection | null {
  if (!isRecord(value)) return null;
  const tenantToken = text(value, "tenantToken");
  const parsed = membership(value["membership"]);
  return tenantToken === null || parsed === null ? null : { tenantToken, membership: parsed };
}

/** DEVELOPMENT ONLY: the outbox's verification link (`GET /dev/email-verification-link`). */
export function parseDevelopmentLink(value: unknown): string | null {
  return isRecord(value) ? text(value, "link") : null;
}

/** The `code` of the API's one error envelope, or null. */
export function parseErrorCode(value: unknown): string | null {
  return isRecord(value) ? text(value, "code") : null;
}

/** For a 204: the body must be empty. */
export function parseNoContent(value: unknown): true | null {
  return value === null ? true : null;
}
