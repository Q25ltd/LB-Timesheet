/**
 * The registration call, and the exact contract the API freezes for it
 * (AUTH.md, "Registration"). Typed here so a screen never assembles a body
 * by hand and never guesses at a response shape.
 */
import { postJson, type ApiResult } from "./client";

/** Exactly the four fields the server accepts. Anything else is REFUSED. */
export interface RegistrationRequest {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

export interface AccountUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface AccountMembership {
  membershipId: string;
  companyId: string;
  companyName: string;
  role: "driver" | "admin";
}

export interface RegistrationResponse {
  user: AccountUser;
  /** Short-lived. Memory only — never written to storage (D25). */
  identityToken: string;
  /** Long-lived. SecureStore only (D25). */
  refreshToken: string;
  /** Empty for every new account. Zero companies is normal (D21). */
  memberships: AccountMembership[];
}

/** The server's stable code for a taken email (D24). */
export const EMAIL_IN_USE = "EMAIL_IN_USE";

export function registerAccount(request: RegistrationRequest): Promise<ApiResult<RegistrationResponse>> {
  return postJson<RegistrationResponse>("/auth/register", request);
}
