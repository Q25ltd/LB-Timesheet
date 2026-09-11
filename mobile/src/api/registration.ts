/**
 * The registration call, and the exact contract the API freezes for it
 * (AUTH.md, "Registration"). Typed here so a screen never assembles a body
 * by hand and never guesses at a response shape.
 *
 * The RESPONSE shape lives in `./account`, because registration and login
 * return the same thing — an authenticated account — and two names for one
 * concept is exactly what CLAUDE.md forbids.
 */
import { postJson, type ApiResult } from "./client";
import type { AuthenticatedAccount } from "./account";

/** Exactly the four fields the server accepts. Anything else is REFUSED. */
export interface RegistrationRequest {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

/** The server's stable code for a taken email (D24). */
export const EMAIL_IN_USE = "EMAIL_IN_USE";

export function registerAccount(request: RegistrationRequest): Promise<ApiResult<AuthenticatedAccount>> {
  return postJson<AuthenticatedAccount>("/auth/register", request);
}
