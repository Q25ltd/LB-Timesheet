/**
 * The account API: the shapes the server freezes for an authenticated
 * account, and the sign-in call.
 *
 * Registration and login END IN THE SAME PLACE — "this driver is now
 * authenticated" — and the server returns the same body for both (AUTH.md,
 * "Registration" and "Login flow"). So there is ONE type for it here, not two
 * equivalent ones under different names (CLAUDE.md, "one concept, one name").
 * `registration.ts` owns the register call and uses these types; it does not
 * define its own copies.
 */
import { getJson, postEmpty, postJson, type ApiResult } from "./client";

export interface AccountUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

/**
 * A company the driver is ACTIVELY a member of. Never authority: holding one
 * of these grants nothing — tenant access requires a token whose membership
 * the server validates on every request.
 */
export interface AccountMembership {
  membershipId: string;
  companyId: string;
  companyName: string;
  role: "driver" | "admin";
}

/**
 * What the server returns when a driver becomes authenticated, by either
 * route.
 *
 * `memberships` is ALWAYS present and an empty array is a complete answer,
 * not a missing prerequisite: a driver with no company has a working account
 * (D21).
 */
export interface AuthenticatedAccount {
  user: AccountUser;
  /** Short-lived. Memory only — never written to storage (D25). */
  identityToken: string;
  /** Long-lived. SecureStore only (D25). */
  refreshToken: string;
  memberships: AccountMembership[];
  /**
   * Present ONLY when the server auto-selected a single active membership
   * (AUTH.md "Login flow"). Absent for a personal account and absent when
   * the driver must choose — there is no tenant authority in either case.
   * Memory only, like the identity token.
   */
  tenantToken?: string;
}

/** Exactly the two fields the server accepts. Anything else is REFUSED. */
export interface SignInRequest {
  email: string;
  password: string;
}

// ─── Runtime shape checks ─────────────────────────────────────────────────
//
// The client's `ok` value is whatever the body parsed to. Every answer below
// carries a credential or an identity the app goes on to STORE or ACT on, so
// each is checked before it leaves this file: a 2xx whose body is not the
// frozen shape — a proxy page, a truncated body, a future server bug — is
// treated as no usable answer (`network`), never as a success with holes in
// it. That keeps the stored refresh secret untouched, and keeps a value the
// server never issued from being stored or sent onward.

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAccountUser(value: unknown): value is AccountUser {
  const r = record(value);
  return r !== null && text(r["id"]) && typeof r["firstName"] === "string" && typeof r["lastName"] === "string" && text(r["email"]);
}

function isAccountMembership(value: unknown): value is AccountMembership {
  const r = record(value);
  return r !== null && text(r["membershipId"]) && text(r["companyId"]) && typeof r["companyName"] === "string"
    && (r["role"] === "driver" || r["role"] === "admin");
}

function isMemberships(value: unknown): value is AccountMembership[] {
  return Array.isArray(value) && value.every(isAccountMembership);
}

export function isAuthenticatedAccount(value: unknown): value is AuthenticatedAccount {
  const r = record(value);
  return r !== null && isAccountUser(r["user"]) && text(r["identityToken"]) && text(r["refreshToken"])
    && isMemberships(r["memberships"]) && (r["tenantToken"] === undefined || text(r["tenantToken"]));
}

function isRefreshedCredentials(value: unknown): value is RefreshedCredentials {
  const r = record(value);
  return r !== null && text(r["identityToken"]) && text(r["refreshToken"]);
}

function isAccountState(value: unknown): value is AccountState {
  const r = record(value);
  return r !== null && isAccountUser(r["user"]) && isMemberships(r["memberships"]);
}

function isSwitchedCompany(value: unknown): value is SwitchedCompany {
  const r = record(value);
  return r !== null && text(r["tenantToken"]) && isAccountMembership(r["membership"]);
}

/** An `ok` whose body fails `guard` becomes "no usable answer". */
export async function checked<T>(pending: Promise<ApiResult<unknown>>, guard: (value: unknown) => value is T): Promise<ApiResult<T>> {
  const result = await pending;
  if (result.kind !== "ok") return result;
  return guard(result.value)
    ? { kind: "ok", value: result.value }
    : { kind: "network", message: "The response could not be read", detail: null };
}

export function signIn(request: SignInRequest): Promise<ApiResult<AuthenticatedAccount>> {
  return checked(postJson<unknown>("/auth/login", request), isAuthenticatedAccount);
}

/**
 * What `/auth/refresh` returns: CREDENTIALS, not account state.
 *
 * The account is read separately from `/auth/me` with the token this yields,
 * so the two concerns have one owner each and the refresh response stays the
 * smallest thing that can restore a session.
 */
export interface RefreshedCredentials {
  identityToken: string;
  refreshToken: string;
}

/** The account behind an identity token — `GET /auth/me`. */
export interface AccountState {
  user: AccountUser;
  memberships: AccountMembership[];
}

/** Tenant material for one explicitly selected company. */
export interface SwitchedCompany {
  tenantToken: string;
  membership: AccountMembership;
}

/**
 * Redeem the stored refresh secret.
 *
 * The CREDENTIAL authenticates this call, so no access token is sent — the
 * whole point is that the identity token has expired. The server rotates the
 * secret, so the value returned here MUST replace the stored one.
 */
export function refreshSession(refreshToken: string): Promise<ApiResult<RefreshedCredentials>> {
  return checked(postJson<unknown>("/auth/refresh", { refreshToken }), isRefreshedCredentials);
}

/** The authenticated account, for restoring state after a refresh. */
export function fetchAccount(identityToken: string): Promise<ApiResult<AccountState>> {
  return checked(getJson<unknown>("/auth/me", identityToken), isAccountState);
}

/**
 * Revoke this device's Session server-side.
 *
 * No body: the session revoked is the one the token names. A logout that
 * could name its own session could log out somebody else's device.
 */
export function logoutSession(identityToken: string): Promise<ApiResult<unknown>> {
  return postEmpty("/auth/logout", identityToken);
}

/**
 * Ask for tenant authority in one company.
 *
 * `membershipId` is a REQUESTED choice, never authority: the server reloads
 * the membership, proves it belongs to the authenticated user and is active,
 * and mints the token from the row it loaded. The client never names a
 * company.
 */
export function switchCompany(identityToken: string, membershipId: string): Promise<ApiResult<SwitchedCompany>> {
  return checked(postJson<unknown>("/auth/switch-company", { membershipId }, identityToken), isSwitchedCompany);
}
