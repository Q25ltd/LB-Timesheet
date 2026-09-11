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

export function signIn(request: SignInRequest): Promise<ApiResult<AuthenticatedAccount>> {
  return postJson<AuthenticatedAccount>("/auth/login", request);
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
  return postJson<RefreshedCredentials>("/auth/refresh", { refreshToken });
}

/** The authenticated account, for restoring state after a refresh. */
export function fetchAccount(identityToken: string): Promise<ApiResult<AccountState>> {
  return getJson<AccountState>("/auth/me", identityToken);
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
  return postJson<SwitchedCompany>("/auth/switch-company", { membershipId }, identityToken);
}
