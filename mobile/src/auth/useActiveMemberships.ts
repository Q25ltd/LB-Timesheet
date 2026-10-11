/**
 * The signed-in account's ACTIVE companies, as last read from the server —
 * or `null` when no account is signed in (D65).
 *
 * A company that deactivates or removes the driver leaves this list on the
 * next account read (Home's `GET /auth/me`); offline it stays as last read.
 * Its own module, as `useAccountScope` is, so a screen test can name the
 * companies without signing anyone in.
 */
import type { AccountMembership } from "../api/account";
import { useAuth } from "./AuthContext";

export function useActiveMemberships(): AccountMembership[] | null {
  return useAuth().account?.memberships ?? null;
}
