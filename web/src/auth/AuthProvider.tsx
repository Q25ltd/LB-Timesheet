import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { apiRequest, type ApiResult } from "./http";
import {
  parseAccount,
  parseCompanySelection,
  parseCreatedCompany,
  parseIdentityToken,
  parseNoContent,
  parseSignedIn,
  type Account,
  type CompanySelection,
  type Membership,
  type SignedIn,
} from "./responses";

/**
 * The browser's authentication state (D45, D46) — held in MEMORY and nowhere
 * else.
 *
 *   access tokens   a ref in this component. Never localStorage,
 *                   sessionStorage, IndexedDB or a cookie the page can read
 *                   (the lint rules forbid all four in web/).
 *   refresh secret  never seen by this code at all: it lives in an HttpOnly
 *                   cookie the API sets and reads (`/auth/web/*`).
 *
 * A page reload therefore forgets every token, and `restore()` gets a fresh
 * identity token through the cookie. Tenant authority (a selected company) is
 * not restored: like the phone, the person chooses again — the server
 * re-validates the membership every time (AUTH.md).
 *
 * Nothing here decides who may do what. A route guard built on this state is
 * presentation; the API refuses whatever this state might wrongly allow.
 */
export type AuthState =
  | { status: "unknown" }
  | { status: "restoring" }
  | { status: "unavailable" }
  /**
   * `ended` is set only by an explicit sign-out: `confirmed` when the server
   * revoked the session, `local-only` when it could not be reached and only
   * this browser forgot it (AUTH.md: logout always completes locally).
   */
  | { status: "signed-out"; ended?: "confirmed" | "local-only" }
  | { status: "signed-in"; account: Account; company: CompanySelection | null };

export type Failure =
  | "invalid"        // 400: the input was refused
  | "credentials"    // 401 at sign-in: wrong email or password
  | "email-in-use"   // 409 EMAIL_IN_USE at registration (D24)
  | "forbidden"      // 403: not allowed (D17 — deliberately unexplained)
  | "conflict"       // 409: e.g. an open shift elsewhere
  | "rate-limited"   // 429
  | "unavailable"    // 503: e.g. the email could not be sent
  | "offline"        // no answer
  | "signed-out"     // the session is gone
  | "unexpected";

export type Outcome = { ok: true } | { ok: false; failure: Failure };

function failureOf(result: Exclude<ApiResult<unknown>, { kind: "ok" }>): Failure {
  if (result.kind === "offline") return "offline";
  switch (result.status) {
    case 400: return "invalid";
    case 401: return "credentials";
    case 403: return "forbidden";
    case 409: return result.code === "EMAIL_IN_USE" ? "email-in-use" : "conflict";
    case 429: return "rate-limited";
    case 503: return "unavailable";
    default:  return "unexpected";
  }
}

export interface AuthApi {
  state: AuthState;
  /** Restore a session from the refresh cookie, once. Safe to call repeatedly. */
  restore(): Promise<void>;
  register(input: { firstName: string; lastName: string; email: string; password: string }): Promise<Outcome>;
  login(input: { email: string; password: string }): Promise<Outcome>;
  /** Revoke the server session and forget everything. `serverConfirmed` is false when only the local part could be done. */
  logout(): Promise<{ serverConfirmed: boolean }>;
  reloadAccount(): Promise<Outcome>;
  resendVerification(): Promise<Outcome>;
  createCompany(name: string): Promise<{ ok: true; membership: Membership } | { ok: false; failure: Failure }>;
  selectCompany(membershipId: string): Promise<Outcome>;
  changePassword(currentPassword: string, newPassword: string): Promise<Outcome>;
}

const AuthContext = createContext<AuthApi | null>(null);

/** One refresh at a time across every tab of this site, where the browser can coordinate tabs. */
async function serialised<T>(task: () => Promise<T>): Promise<T> {
  if ("locks" in navigator && typeof navigator.locks.request === "function") {
    return navigator.locks.request("lbts-refresh", task);
  }
  return task();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "unknown" });
  const identityToken = useRef<string | null>(null);
  const restoring = useRef<Promise<void> | null>(null);
  const refreshing = useRef<Promise<string | null> | null>(null);

  const signOutLocally = useCallback(() => {
    identityToken.current = null;
    setState({ status: "signed-out" });
  }, []);

  /** A fresh identity token from the cookie, or null. One request in flight at a time. */
  const refreshIdentity = useCallback((): Promise<string | null> => {
    if (refreshing.current !== null) return refreshing.current;
    const pending = serialised(async () => {
      const result = await apiRequest("/auth/web/refresh", { cookie: true }, parseIdentityToken);
      identityToken.current = result.kind === "ok" ? result.value : null;
      return identityToken.current;
    }).finally(() => {
      refreshing.current = null;
    });
    refreshing.current = pending;
    return pending;
  }, []);

  /**
   * Run an identity-token request. An expired token (401) gets ONE refresh and
   * ONE retry; if the session itself is gone, the browser is signed out.
   */
  const withIdentity = useCallback(async <T,>(call: (token: string) => Promise<ApiResult<T>>): Promise<ApiResult<T>> => {
    const token = identityToken.current ?? await refreshIdentity();
    if (token === null) {
      signOutLocally();
      return { kind: "refused", status: 401, code: "UNAUTHENTICATED" };
    }
    const first = await call(token);
    if (first.kind !== "refused" || first.status !== 401) return first;

    const renewed = await refreshIdentity();
    if (renewed === null) {
      signOutLocally();
      return first;
    }
    return call(renewed);
  }, [refreshIdentity, signOutLocally]);

  const loadAccount = useCallback(async (company: CompanySelection | null): Promise<Outcome> => {
    const result = await withIdentity(token => apiRequest("/auth/me", { method: "GET", token }, parseAccount));
    if (result.kind !== "ok") {
      if (result.kind === "refused" && result.status === 401) return { ok: false, failure: "signed-out" };
      return { ok: false, failure: failureOf(result) };
    }
    setState({ status: "signed-in", account: result.value, company });
    return { ok: true };
  }, [withIdentity]);

  const restore = useCallback((): Promise<void> => {
    if (restoring.current !== null) return restoring.current;
    const pending = (async () => {
      setState({ status: "restoring" });
      const result = await serialised(() => apiRequest("/auth/web/refresh", { cookie: true }, parseIdentityToken));
      if (result.kind === "offline") {
        setState({ status: "unavailable" });
        restoring.current = null;   // a later attempt may succeed
        return;
      }
      if (result.kind !== "ok") {
        signOutLocally();
        return;
      }
      identityToken.current = result.value;
      const loaded = await loadAccount(null);
      if (!loaded.ok) signOutLocally();
    })();
    restoring.current = pending;
    return pending;
  }, [loadAccount, signOutLocally]);

  const enter = useCallback((signedIn: SignedIn) => {
    identityToken.current = signedIn.identityToken;
    restoring.current = Promise.resolve();
    const only = signedIn.memberships.length === 1 ? signedIn.memberships[0] : undefined;
    const company = signedIn.tenantToken !== undefined && only !== undefined
      ? { tenantToken: signedIn.tenantToken, membership: only }
      : null;
    return company;
  }, []);

  const register = useCallback<AuthApi["register"]>(async input => {
    const result = await apiRequest("/auth/web/register", { body: input, cookie: true }, parseSignedIn);
    if (result.kind !== "ok") return { ok: false, failure: failureOf(result) };
    return loadAccount(enter(result.value));
  }, [enter, loadAccount]);

  const login = useCallback<AuthApi["login"]>(async input => {
    const result = await apiRequest("/auth/web/login", { body: input, cookie: true }, parseSignedIn);
    if (result.kind !== "ok") return { ok: false, failure: failureOf(result) };
    return loadAccount(enter(result.value));
  }, [enter, loadAccount]);

  const logout = useCallback<AuthApi["logout"]>(async () => {
    // The server first, while the cookie still names the session; the local
    // part happens whatever the answer (AUTH.md "Logout").
    const result = await apiRequest("/auth/web/logout", { cookie: true }, parseNoContent);
    restoring.current = Promise.resolve();
    identityToken.current = null;
    const serverConfirmed = result.kind === "ok";
    setState({ status: "signed-out", ended: serverConfirmed ? "confirmed" : "local-only" });
    return { serverConfirmed };
  }, [signOutLocally]);

  const currentCompany = state.status === "signed-in" ? state.company : null;

  const reloadAccount = useCallback(() => loadAccount(currentCompany), [currentCompany, loadAccount]);

  const resendVerification = useCallback<AuthApi["resendVerification"]>(async () => {
    const result = await withIdentity(token => apiRequest("/auth/email-verification", { token }, parseNoContent));
    return result.kind === "ok" ? { ok: true } : { ok: false, failure: failureOf(result) };
  }, [withIdentity]);

  const createCompany = useCallback<AuthApi["createCompany"]>(async name => {
    const result = await withIdentity(token => apiRequest("/companies", { token, body: { name } }, parseCreatedCompany));
    if (result.kind !== "ok") return { ok: false, failure: failureOf(result) };
    await loadAccount(currentCompany);
    return { ok: true, membership: result.value };
  }, [currentCompany, loadAccount, withIdentity]);

  const selectCompany = useCallback<AuthApi["selectCompany"]>(async membershipId => {
    // The membership is a REQUEST; the server decides, from its own rows.
    const result = await withIdentity(token => apiRequest("/auth/switch-company", { token, body: { membershipId } }, parseCompanySelection));
    if (result.kind !== "ok") return { ok: false, failure: failureOf(result) };
    return loadAccount(result.value);
  }, [loadAccount, withIdentity]);

  const changePassword = useCallback<AuthApi["changePassword"]>(async (currentPassword, newPassword) => {
    const result = await withIdentity(token => apiRequest("/auth/password/change", { token, body: { currentPassword, newPassword } }, parseNoContent));
    return result.kind === "ok" ? { ok: true } : { ok: false, failure: failureOf(result) };
  }, [withIdentity]);

  const api = useMemo<AuthApi>(() => ({
    state, restore, register, login, logout, reloadAccount, resendVerification, createCompany, selectCompany, changePassword,
  }), [state, restore, register, login, logout, reloadAccount, resendVerification, createCompany, selectCompany, changePassword]);

  return <AuthContext.Provider value={api}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const api = useContext(AuthContext);
  if (api === null) throw new Error("useAuth used outside <AuthProvider>");
  return api;
}
