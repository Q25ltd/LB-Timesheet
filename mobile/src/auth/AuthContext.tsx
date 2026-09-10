/**
 * The app's authentication state (D21, D25).
 *
 * Two halves, stored deliberately differently:
 *
 *   identityToken  IN MEMORY, in this provider's state. Short-lived, and it
 *                  must not survive the process — writing it to disk would
 *                  turn a 15-minute credential into a permanent one.
 *   refreshToken   SecureStore, through `secureStore.ts`. The only secret
 *                  that persists.
 *
 * `memberships` is part of the authenticated state and an EMPTY ARRAY is a
 * valid one. Nothing here treats zero companies as an error, a pending
 * state, or something to be resolved before the driver may continue (D21).
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { storeRefreshToken, clearRefreshToken } from "./secureStore";
import type { AccountMembership, AccountUser, RegistrationResponse } from "../api/registration";

export interface AuthenticatedState {
  user: AccountUser;
  /** Zero memberships is normal and complete — not a missing prerequisite. */
  memberships: AccountMembership[];
}

interface AuthValue {
  account: AuthenticatedState | null;
  /** Exposed for API calls. Never written to storage. */
  identityToken: string | null;
  isAuthenticated: boolean;
  // Declared as function PROPERTIES, not methods: these are destructured out
  // of the context at every call site, and method syntax makes that an
  // unbound-method lint error (rightly — a method separated from its object
  // is a `this` bug waiting to happen).
  signInFromRegistration: (response: RegistrationResponse) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<AuthenticatedState | null>(null);
  const [identityToken, setIdentityToken] = useState<string | null>(null);

  const signInFromRegistration = useCallback(async (response: RegistrationResponse) => {
    // Order matters only in one direction: the durable secret is committed
    // before the app claims to be signed in, so a crash between the two
    // leaves a recoverable session rather than a lost one.
    await storeRefreshToken(response.refreshToken);
    setIdentityToken(response.identityToken);
    setAccount({ user: response.user, memberships: response.memberships });
  }, []);

  const signOut = useCallback(async () => {
    await clearRefreshToken();
    setIdentityToken(null);
    setAccount(null);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      account,
      identityToken,
      isAuthenticated: account !== null,
      signInFromRegistration,
      signOut,
    }),
    [account, identityToken, signInFromRegistration, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth must be used inside an AuthProvider");
  return value;
}
