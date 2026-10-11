/**
 * The app's identity token lives 15 minutes; until D63 nothing in the app
 * called the server mid-session, so it was only ever minted at sign-in or at
 * start-up. `withIdentity` (owner-approved, 2026-10-10) makes a call with the
 * current identity token and, when the server answers 401, renews it ONCE
 * through the existing `/auth/refresh` — rotating the stored secret exactly
 * as start-up restore does — and retries the call once.
 *
 *   - one renewal at a time, however many calls are waiting on it;
 *   - the server refusing the stored secret (401) signs the driver out, as
 *     restore does (F-34); any other failure keeps it and signs nobody out;
 *   - a sign-out while a renewal is in flight wins: nothing is restored;
 *   - only a 401 is renewed — never a 503, a 429 or a refusal of another kind.
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import { Pressable, Text } from "react-native";
import { useState } from "react";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { fetchAccount, type AuthenticatedAccount } from "../api/account";

const REFRESH_KEY = "logisticbay.refreshToken";
const OLD_IDENTITY = "old.identity.token";
const NEW_IDENTITY = "new.identity.token";
const ACCOUNT = {
  user: { id: "user_renew", firstName: "Rita", lastName: "Renew", email: "rita@example.com" },
  memberships: [],
  emailVerified: false,
};
const SIGNED_IN: AuthenticatedAccount = {
  user: ACCOUNT.user, memberships: [], identityToken: OLD_IDENTITY, refreshToken: "secret-1",
};
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

type View = Awaited<ReturnType<typeof render>>;
type Outcome = string;

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);
}

interface Server {
  refreshCalls: number;
  meTokens: string[];
  refresh: () => Promise<Response>;
  me: (token: string) => Promise<Response>;
}

function server(overrides: Partial<Pick<Server, "refresh" | "me">> = {}): Server {
  const state: Server = {
    refreshCalls: 0,
    meTokens: [],
    refresh: overrides.refresh ?? (() => jsonResponse(200, { identityToken: NEW_IDENTITY, refreshToken: "secret-2" })),
    me: overrides.me ?? (token => (token === NEW_IDENTITY ? jsonResponse(200, ACCOUNT) : jsonResponse(401, { error: "Not authenticated", code: "UNAUTHENTICATED" }))),
  };
  jest.spyOn(global, "fetch").mockImplementation(((input: string, init: RequestInit = {}) => {
    const url = String(input);
    if (url.includes("/auth/refresh")) { state.refreshCalls += 1; return state.refresh(); }
    if (url.includes("/auth/me")) {
      const token = new Headers(init.headers).get("authorization")?.replace("Bearer ", "") ?? "";
      state.meTokens.push(token);
      return state.me(token);
    }
    if (url.includes("/auth/logout")) return jsonResponse(204, null);
    throw new Error(`unexpected request to ${url}`);
  }) as unknown as typeof fetch);
  return state;
}

function Probe() {
  const { signIn, signOut, status, withIdentity } = useAuth();
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  function call() {
    void withIdentity(token => fetchAccount(token)).then(result => {
      setOutcomes(previous => [...previous, result.kind === "api" ? `api-${String(result.status)}` : result.kind]);
    });
  }
  return (
    <>
      <Text testID="status">{status}</Text>
      <Text testID="outcomes">{outcomes.join(",")}</Text>
      <Pressable testID="sign-in" onPress={() => { void signIn(SIGNED_IN); }}><Text>in</Text></Pressable>
      <Pressable testID="sign-out" onPress={() => { void signOut().catch(() => undefined); }}><Text>out</Text></Pressable>
      <Pressable testID="call" onPress={call}><Text>call</Text></Pressable>
      <Pressable testID="call-twice" onPress={() => { call(); call(); }}><Text>twice</Text></Pressable>
    </>
  );
}

async function signedIn(): Promise<View> {
  const view = await render(<SafeAreaProvider initialMetrics={METRICS}><AuthProvider><Probe /></AuthProvider></SafeAreaProvider>);
  await waitFor(() => { expect(String(view.getByTestId("status").props.children)).toBe("unauthenticated"); });
  await act(async () => { await fireEvent.press(view.getByTestId("sign-in")); });
  await waitFor(() => { expect(String(view.getByTestId("status").props.children)).toBe("authenticated"); });
  return view;
}

async function press(view: View, testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(view.getByTestId(testID)); });
}

const outcomes = (view: View): string => String(view.getByTestId("outcomes").props.children);

beforeEach(async () => {
  await SecureStore.deleteItemAsync(REFRESH_KEY);
  await SecureStore.deleteItemAsync("logisticbay.biometricUnlock");
});
afterEach(() => { jest.restoreAllMocks(); });

test("IR1. an expired identity token is renewed ONCE through /auth/refresh, the stored secret rotated, and the call retried with the new token", async () => {
  const api = server();
  const view = await signedIn();

  await press(view, "call");

  await waitFor(() => { expect(outcomes(view)).toBe("ok"); });
  expect(api.refreshCalls).toBe(1);
  expect(api.meTokens).toEqual([OLD_IDENTITY, NEW_IDENTITY]);
  expect(await SecureStore.getItemAsync(REFRESH_KEY)).toBe("secret-2");
  expect(String(view.getByTestId("status").props.children)).toBe("authenticated");
});

test("IR2. two calls meeting an expired token share ONE renewal — a second redemption of the same secret would be refused as reuse", async () => {
  const api = server();
  const view = await signedIn();

  await press(view, "call-twice");

  await waitFor(() => { expect(outcomes(view)).toBe("ok,ok"); });
  expect(api.refreshCalls).toBe(1);
});

test("IR3. the server REFUSING the stored secret (401) signs the driver out and removes it — exactly as start-up restore does", async () => {
  const api = server({ refresh: () => jsonResponse(401, { error: "Not authenticated", code: "UNAUTHENTICATED" }) });
  const view = await signedIn();

  await press(view, "call");

  await waitFor(() => { expect(String(view.getByTestId("status").props.children)).toBe("unauthenticated"); });
  expect(outcomes(view)).toBe("api-401");
  expect(api.refreshCalls).toBe(1);
  expect(await SecureStore.getItemAsync(REFRESH_KEY)).toBeNull();
});

test.each([
  ["cannot reach the server", () => Promise.reject(new TypeError("Network request failed"))],
  ["meets a 503", () => jsonResponse(503, { error: "Unavailable" })],
])("IR4. a renewal that %s keeps the driver signed in and the secret kept (F-34) — and says so", async (_why, refresh) => {
  server({ refresh });
  const view = await signedIn();

  await press(view, "call");

  await waitFor(() => { expect(outcomes(view)).not.toBe(""); });
  expect(outcomes(view)).toBe("network");
  expect(String(view.getByTestId("status").props.children)).toBe("authenticated");
  expect(await SecureStore.getItemAsync(REFRESH_KEY)).toBe("secret-1");
});

test.each([503, 429, 403])("IR5. only a 401 is renewed: a %d from the call itself is returned as it is, with no refresh", async status => {
  const api = server({ me: () => jsonResponse(status, { error: "No" }) });
  const view = await signedIn();

  await press(view, "call");

  await waitFor(() => { expect(outcomes(view)).toBe(`api-${String(status)}`); });
  expect(api.refreshCalls).toBe(0);
});

test("IR6. a sign-out while a renewal is in flight wins: the renewed secret is not kept and nobody is signed back in", async () => {
  let answer: (response: Response) => void = () => undefined;
  server({ refresh: () => new Promise<Response>(resolve => { answer = resolve; }) });
  const view = await signedIn();

  await press(view, "call");
  await press(view, "sign-out");
  await act(async () => {
    answer({ ok: true, status: 200, json: () => Promise.resolve({ identityToken: NEW_IDENTITY, refreshToken: "secret-2" }) } as Response);
    await Promise.resolve();
  });

  await waitFor(() => { expect(outcomes(view)).not.toBe(""); });
  expect(String(view.getByTestId("status").props.children)).toBe("unauthenticated");
  expect(await SecureStore.getItemAsync(REFRESH_KEY)).toBeNull();
});

test("IR7. with nobody signed in there is no token to use and nothing to renew", async () => {
  const api = server();
  const view = await render(<SafeAreaProvider initialMetrics={METRICS}><AuthProvider><Probe /></AuthProvider></SafeAreaProvider>);
  await waitFor(() => { expect(String(view.getByTestId("status").props.children)).toBe("unauthenticated"); });

  await press(view, "call");

  await waitFor(() => { expect(outcomes(view)).toBe("api-401"); });
  expect(api.refreshCalls).toBe(0);
  expect(api.meTokens).toEqual([]);
});
