/**
 * The app's authentication state — one state machine for registration, login,
 * restoration, biometric unlock, company selection and logout (D21, D25, D26).
 *
 * WHAT LIVES WHERE, and it is the whole storage contract:
 *
 *   identityToken  MEMORY (this provider's state). Short-lived; writing it to
 *                  disk would turn a 15-minute credential into a permanent one.
 *   tenantToken    MEMORY. Same reason, plus it is company authority.
 *   refreshToken   SecureStore, through `secureStore.ts`. The ONLY secret that
 *                  persists — and it is rotated on every redemption, so the
 *                  stored value must be replaced, not appended to.
 *   password       never persisted, anywhere, at any point.
 *
 * THE STATUS MACHINE, and why it has three states rather than a boolean:
 *
 *   "restoring"        a refresh credential may exist; we are finding out.
 *                      Routing must WAIT here. A boolean would force this
 *                      moment to be reported as "not authenticated", which
 *                      sends the driver to Sign-in and then bounces them to
 *                      Today — the flash this state exists to prevent.
 *   "unauthenticated"  no usable credential. Sign-in.
 *   "authenticated"    the SERVER validated a session and issued material.
 *
 * There is no fourth state for "biometrics failed": that is simply
 * unauthenticated with the password form in front of the driver.
 *
 * THE BIOMETRIC BOUNDARY (D26). A biometric success is permission to READ the
 * stored credential — nothing else. `authenticated` is only ever set from a
 * server response: from registration, from login, or from `/auth/refresh`
 * followed by `/auth/me`. There is no code path in this file that sets it
 * from a biometric result, and `biometrics.ts` holds no tokens with which it
 * could.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { Platform } from "react-native";
import { finishLogoutCleanup, logoutPending, markLogoutPending, LogoutCleanupError } from "./logoutIntent";
import {
  clearBiometricOptIn, clearRefreshToken, readBiometricOptIn, readRefreshToken,
  storeBiometricOptIn, storeRefreshToken,
} from "./secureStore";
import { authenticateLocally, biometricCapability, type BiometricCapability } from "./biometrics";
import {
  fetchAccount, logoutSession, refreshSession, switchCompany,
  type AccountMembership, type AccountUser, type AuthenticatedAccount,
} from "../api/account";

export interface AuthenticatedState {
  user: AccountUser;
  /** Zero memberships is normal and complete — not a missing prerequisite. */
  memberships: AccountMembership[];
}

export type AuthStatus = "restoring" | "authenticated" | "unauthenticated";

/** Why a restore attempt ended without authenticating — drives the Sign-in copy. */
export type RestoreOutcome =
  | "none"              // nothing stored; an ordinary first run
  | "biometric-locked"  // a credential exists, biometrics were not satisfied
  | "expired"           // the server refused the credential (401); it has been cleared
  | "offline";          // no usable answer — no signal, a timeout, a temporary
                        // server failure (5xx, 429, 408) or an unreadable body;
                        // the credential is KEPT

interface AuthValue {
  logoutCleanupError: string | null;
  registerAccessRevoker: (revoke: () => void) => () => void;
  status: AuthStatus;
  account: AuthenticatedState | null;
  /** Exposed for API calls. Never written to storage. */
  identityToken: string | null;
  /** Company authority, when one company has been selected. Memory only. */
  tenantToken: string | null;
  isAuthenticated: boolean;
  /** What the last restore attempt concluded, for the Sign-in screen. */
  restoreOutcome: RestoreOutcome;
  /** What this device can offer, re-read on mount. */
  biometrics: BiometricCapability;
  /** Whether the driver has opted in to biometric unlock. */
  biometricUnlockEnabled: boolean;
  // Declared as function PROPERTIES, not methods: these are destructured out
  // of the context at every call site, and method syntax makes that an
  // unbound-method lint error.
  signIn: (account: AuthenticatedAccount) => Promise<void>;
  signOut: () => Promise<void>;
  /** Retry restoration — the Sign-in screen's biometric action. */
  unlock: () => Promise<boolean>;
  enableBiometricUnlock: () => Promise<boolean>;
  disableBiometricUnlock: () => Promise<void>;
  chooseCompany: (membershipId: string) => Promise<boolean>;
}

const AuthContext = createContext<AuthValue | null>(null);

/** The server's one answer for a credential it will never accept again. */
const UNAUTHENTICATED_STATUS = 401;

const NO_BIOMETRICS: BiometricCapability = { available: false, label: "biometrics" };

/** F-30: an unconfirmed server revocation never undoes the local sign-out. */
function serverRevocationUnconfirmed(): undefined {
  return undefined;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("restoring");
  const [account, setAccount] = useState<AuthenticatedState | null>(null);
  const [identityToken, setIdentityToken] = useState<string | null>(null);
  const [tenantToken, setTenantToken] = useState<string | null>(null);
  const [restoreOutcome, setRestoreOutcome] = useState<RestoreOutcome>("none");
  const [biometrics, setBiometrics] = useState<BiometricCapability>(NO_BIOMETRICS);
  const [biometricUnlockEnabled, setBiometricUnlockEnabled] = useState(false);

  /**
   * One restore at a time. Without this a re-render during the round trip
   * could start a second redemption of the SAME secret — and because the
   * server rotates atomically, one of the two would lose and be refused,
   * turning a successful restore into a logout.
   */
  const restoring = useRef(false);
  const generation = useRef(0);
  const revokers = useRef(new Set<() => void>());
  const transitions = useRef<Promise<unknown>>(Promise.resolve());
  const [logoutCleanupError, setLogoutCleanupError] = useState<string | null>(null);
  const cleanupRequired = useRef(false);
  const renderedGeneration = generation.current;
  const registerAccessRevoker = useCallback((revoke: () => void) => {
    revokers.current.add(revoke);
    return () => { revokers.current.delete(revoke); };
  }, []);
  const endAccess = useCallback(() => {
    generation.current += 1;
    for (const revoke of revokers.current) revoke();
    setIdentityToken(null);
    setTenantToken(null);
    setAccount(null);
    setBiometricUnlockEnabled(false);
    setStatus("unauthenticated");
  }, []);
  const cleanup = useCallback(async () => {
    try {
      await finishLogoutCleanup();
      cleanupRequired.current = false;
      setLogoutCleanupError(null);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : new LogoutCleanupError(false).message;
      setLogoutCleanupError(message);
      throw error;
    }
  }, []);

  const signIn = useCallback(async (authenticated: AuthenticatedAccount) => {
    endAccess();
    const attempt = generation.current;
    const commit = async () => {
      if (cleanupRequired.current || logoutPending()) await cleanup();
      if (attempt !== generation.current) throw new Error("Sign-in was interrupted by sign-out");
      // Order matters in one direction: the durable secret is committed before
      // the app claims to be signed in, so a crash between the two leaves a
      // recoverable session rather than a lost one.
      await storeRefreshToken(authenticated.refreshToken);
      if (attempt !== generation.current) throw new Error("Sign-in was interrupted by sign-out");
      setIdentityToken(authenticated.identityToken);
      setTenantToken(authenticated.tenantToken ?? null);
      setAccount({ user: authenticated.user, memberships: authenticated.memberships });
      setRestoreOutcome("none");
      setStatus("authenticated");
    };
    const result = transitions.current.then(commit, commit);
    transitions.current = result.then(() => undefined, () => undefined);
    await result;
  }, [cleanup, endAccess]);

  /** Forget everything locally. Used by logout AND by a refused credential. */
  const clearLocalSession = useCallback(async (outcome: RestoreOutcome) => {
    endAccess();
    await clearRefreshToken();
    setIdentityToken(null);
    setTenantToken(null);
    setAccount(null);
    setRestoreOutcome(outcome);
    setStatus("unauthenticated");
  }, [endAccess]);

  /**
   * Redeem the stored credential, with the biometric gate in front when the
   * driver has opted in.
   *
   * The ORDER is the security property: gate → read secret → server refresh →
   * server account read → authenticated. Every step can only fail closed, and
   * the only thing that sets `authenticated` is the server's answer.
   */
  const performRestore = useCallback(async (options: { gateOnBiometrics: boolean }): Promise<boolean> => {
    if (restoring.current) return false;
    if (cleanupRequired.current || logoutPending()) {
      cleanupRequired.current = true;
      endAccess();
      try { await cleanup(); } catch { return false; }
      return false;
    }
    const attempt = generation.current;
    restoring.current = true;
    setStatus("restoring");
    try {
      // 1. Is there anything to restore? Checked BEFORE prompting, so a fresh
      //    install never shows a biometric dialog it cannot act on.
      const storedBefore = await readRefreshToken();
      if (attempt !== generation.current) return false;
      if (storedBefore === null) {
        endAccess();
        setRestoreOutcome("none");
        return false;
      }

      // 2. The biometric gate. Only reached when the driver opted in AND the
      //    device can still do it — an enrolment that has disappeared is not a
      //    reason to strand anyone, it is a reason to ask for a password.
      if (options.gateOnBiometrics) {
        const capability = await biometricCapability(Platform.OS === "ios");
        if (!capability.available) {
          // Fail CLOSED: no authenticated state, credential KEPT, password form.
          setRestoreOutcome("biometric-locked");
          setStatus("unauthenticated");
          return false;
        }
        if (!await authenticateLocally(capability.label)) {
          // Cancel, failure, lockout, enrolment change — all the same answer.
          // The credential is deliberately NOT deleted: a face that did not
          // match is not a reason to end a valid server session.
          setRestoreOutcome("biometric-locked");
          setStatus("unauthenticated");
          return false;
        }
      }

      // 3. Re-read AFTER the gate. The prompt can be on screen for a while,
      //    and another path may have rotated or cleared the secret meanwhile.
      const stored = await readRefreshToken();
      if (attempt !== generation.current) return false;
      if (stored === null) {
        endAccess();
        setRestoreOutcome("none");
        return false;
      }

      // 4. The SERVER decides. Nothing before this point authenticated anyone.
      const redeemed = await refreshSession(stored);
      if (attempt !== generation.current) return false;

      if (redeemed.kind === "network") {
        // The request never arrived. The credential is almost certainly still
        // valid, so it is KEPT — deleting it would log a driver out of a live
        // session because they were in a tunnel.
        setRestoreOutcome("offline");
        setStatus("unauthenticated");
        return false;
      }
      if (redeemed.kind === "api" && redeemed.status === UNAUTHENTICATED_STATUS) {
        // The server refused it: revoked, expired, reused or unknown. It will
        // never work again, so it is removed. This is the ONLY answer that
        // says so — the server's every refusal of a credential is this 401.
        await clearLocalSession("expired");
        return false;
      }
      if (redeemed.kind === "api") {
        // Any other status says nothing about the credential: a restarting
        // edge, a rate limit, a gateway timeout. Deleting it here would log a
        // driver out for good because the server had a bad minute.
        setRestoreOutcome("offline");
        setStatus("unauthenticated");
        return false;
      }

      // 5. Rotation happened server-side, so the stored secret MUST be
      //    replaced before anything else can use it.
      await storeRefreshToken(redeemed.value.refreshToken);
      if (attempt !== generation.current) { await cleanup(); return false; }

      // 6. Account state, with the token the server just issued.
      const state = await fetchAccount(redeemed.value.identityToken);
      if (attempt !== generation.current) return false;
      if (state.kind !== "ok") {
        // The credential rotated but the account read failed. The new secret is
        // already stored, so a retry is possible; the app just is not
        // authenticated yet.
        setRestoreOutcome(state.kind === "api" && state.status === UNAUTHENTICATED_STATUS ? "expired" : "offline");
        setStatus("unauthenticated");
        return false;
      }

      setIdentityToken(redeemed.value.identityToken);
      // Restoration yields ACCOUNT identity only. Company authority is a
      // separate security event and must be re-selected — a tenant token is
      // never restored from storage, because it was never stored.
      setTenantToken(null);
      setAccount({ user: state.value.user, memberships: state.value.memberships });
      setRestoreOutcome("none");
      setStatus("authenticated");
      return true;
    } finally {
      restoring.current = false;
    }
  }, [clearLocalSession, cleanup, endAccess]);

  const attemptRestore = useCallback((options: { gateOnBiometrics: boolean }) => {
    const run = () => performRestore(options);
    const result = transitions.current.then(run, run);
    transitions.current = result.then(() => undefined, () => undefined);
    return result;
  }, [performRestore]);

  /** App start: read the device's capability and preference, then restore. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [capability, optedIn] = await Promise.all([
        biometricCapability(Platform.OS === "ios"),
        readBiometricOptIn(),
      ]);
      if (cancelled) return;
      setBiometrics(capability);
      setBiometricUnlockEnabled(optedIn);
      await attemptRestore({ gateOnBiometrics: optedIn });
    })().catch(() => {
      if (cancelled) return;
      endAccess();
      cleanupRequired.current = true;
      setLogoutCleanupError(new LogoutCleanupError(false).message);
    });
    return () => { cancelled = true; };
  }, [attemptRestore, endAccess]);

  /**
   * The Sign-in screen's biometric action, and the retry after a cancel.
   * Always gates, because the driver pressed a biometric control.
   */
  const unlock = useCallback(() => attemptRestore({ gateOnBiometrics: true }), [attemptRestore]);

  const signOut = useCallback(async () => {
    const token = identityToken;
    endAccess();
    setRestoreOutcome("none");
    cleanupRequired.current = true;
    try { markLogoutPending(); } catch { /* Cleanup still attempts both native removals. */ }
    const result = transitions.current.then(cleanup, cleanup);
    transitions.current = result.then(() => undefined, () => undefined);
    // The captured token can revoke the server session after local access ends.
    // Its outcome is deliberately not acted on: local access has already ended,
    // and an unreachable server leaves the Session to expire (F-30, accepted).
    if (token !== null) void logoutSession(token).catch(serverRevocationUnconfirmed);
    await result;
  }, [identityToken, cleanup, endAccess]);

  /**
   * Turn biometric unlock on. Prompts once, so the driver proves the method
   * works before the app starts relying on it — an opt-in that silently fails
   * on the next launch is worse than no opt-in.
   */
  const enableBiometricUnlock = useCallback(async (): Promise<boolean> => {
    const attempt = renderedGeneration;
    if (attempt !== generation.current) return false;
    const capability = await biometricCapability(Platform.OS === "ios");
    setBiometrics(capability);
    if (!capability.available) return false;
    if (!await authenticateLocally(capability.label)) return false;
    const commit = async () => {
      if (attempt !== generation.current) return false;
      await storeBiometricOptIn();
      if (attempt !== generation.current) return false;
      setBiometricUnlockEnabled(true);
      return true;
    };
    const result = transitions.current.then(commit, commit);
    transitions.current = result.then(() => undefined, () => undefined);
    return result;
  }, [renderedGeneration]);

  const disableBiometricUnlock = useCallback(async () => {
    const attempt = renderedGeneration;
    const commit = async () => {
      if (attempt !== generation.current) return;
      await clearBiometricOptIn();
      if (attempt === generation.current) setBiometricUnlockEnabled(false);
    };
    const result = transitions.current.then(commit, commit);
    transitions.current = result.then(() => undefined, () => undefined);
    await result;
  }, [renderedGeneration]);

  /**
   * Ask the server for tenant authority in one company.
   *
   * The membership id is a REQUEST. The server reloads the row, proves it
   * belongs to this user and is active, and mints the token — so a token that
   * arrives here was authorised by the server, not chosen by this client.
   */
  const chooseCompany = useCallback(async (membershipId: string): Promise<boolean> => {
    if (identityToken === null || renderedGeneration !== generation.current) return false;
    const attempt = generation.current;
    const selected = await switchCompany(identityToken, membershipId);
    if (attempt !== generation.current) return false;
    if (selected.kind !== "ok") return false;
    setTenantToken(selected.value.tenantToken);
    return true;
  }, [identityToken, renderedGeneration]);

  const value = useMemo<AuthValue>(
    () => ({
      logoutCleanupError,
      registerAccessRevoker,
      status,
      account,
      identityToken,
      tenantToken,
      isAuthenticated: status === "authenticated",
      restoreOutcome,
      biometrics,
      biometricUnlockEnabled,
      signIn,
      signOut,
      unlock,
      enableBiometricUnlock,
      disableBiometricUnlock,
      chooseCompany,
    }),
    [
      logoutCleanupError, registerAccessRevoker, status, account, identityToken, tenantToken, restoreOutcome, biometrics,
      biometricUnlockEnabled, signIn, signOut, unlock, enableBiometricUnlock,
      disableBiometricUnlock, chooseCompany,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth must be used inside an AuthProvider");
  return value;
}
