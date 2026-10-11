/**
 * F-38 — a sign-out the SERVER did not confirm is never taken as one.
 *
 * Signing out on the phone always ends local access at once and deletes the
 * stored secret (D61) — nothing here waits on the network. The server is
 * then asked to revoke the session, with the token captured before access
 * ended. Until F-38 that request was refused (a bodyless POST sent as JSON)
 * and its outcome ignored, so no app sign-out ever revoked a server session
 * and nothing said so. Now the outcome is kept — confirmed or not — and an
 * unconfirmed one is said on the Sign-in screen, with what to do about it.
 * Nothing is kept to retry with: the token is not retained.
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import { Pressable, Text } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AuthenticatedAccount } from "../api/account";
import SignInRoute from "../../app/(auth)/sign-in";
import * as apiConfig from "../api/config";

jest.mock("expo-router", () => {
  const react = jest.requireActual<typeof import("react")>("react");
  const rn = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    __esModule: true,
    router: { replace: () => undefined, push: () => undefined, back: () => undefined, navigate: () => undefined },
    Link: ({ children }: { children: import("react").ReactNode }) => react.createElement(rn.Text, null, children),
    Redirect: ({ href }: { href: string }) => react.createElement(rn.Text, { testID: "redirect" }, String(href)),
  };
});

const REFRESH_KEY = "logisticbay.refreshToken";
const SIGNED_IN: AuthenticatedAccount = {
  user: { id: "user_out", firstName: "Otto", lastName: "Out", email: "otto@example.com" },
  memberships: [], identityToken: "id.token", refreshToken: "secret-1",
};
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

type View = Awaited<ReturnType<typeof render>>;

interface Revocation { requests: { contentType: string | null; authorization: string | null }[] }

function server(answer: () => Promise<Response>): Revocation {
  const state: Revocation = { requests: [] };
  jest.spyOn(global, "fetch").mockImplementation(((input: string, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    if (path === "/auth/logout") {
      const sent = new Headers(init.headers);
      state.requests.push({ contentType: sent.get("content-type"), authorization: sent.get("authorization") });
      return answer();
    }
    throw new Error(`unexpected request to ${path}`);
  }) as unknown as typeof fetch);
  return state;
}

const respond = (status: number) => () => Promise.resolve({ ok: status < 300, status, json: () => Promise.reject(new Error("no body")) } as Response);

function Phone() {
  const { signIn, signOut, status, serverSignOut } = useAuth();
  return (
    <>
      <Text testID="status">{status}</Text>
      <Text testID="server-sign-out">{String(serverSignOut)}</Text>
      <Pressable testID="probe-sign-in" onPress={() => { void signIn(SIGNED_IN); }}><Text>in</Text></Pressable>
      <Pressable testID="probe-sign-out" onPress={() => { void signOut(); }}><Text>out</Text></Pressable>
      {status === "unauthenticated" ? <SignInRoute /> : null}
    </>
  );
}

async function signedIn(): Promise<View> {
  const view = await render(<SafeAreaProvider initialMetrics={METRICS}><AuthProvider><Phone /></AuthProvider></SafeAreaProvider>);
  await waitFor(() => { expect(String(view.getByTestId("status").props.children)).toBe("unauthenticated"); });
  await act(async () => { await fireEvent.press(view.getByTestId("probe-sign-in")); });
  await waitFor(() => { expect(String(view.getByTestId("status").props.children)).toBe("authenticated"); });
  return view;
}

async function signOutOn(view: View): Promise<void> {
  await act(async () => { await fireEvent.press(view.getByTestId("probe-sign-out")); });
}

const reported = (view: View): string => String(view.getByTestId("server-sign-out").props.children);

beforeEach(async () => {
  await SecureStore.deleteItemAsync(REFRESH_KEY);
  await SecureStore.deleteItemAsync("logisticbay.biometricUnlock");
});
afterEach(() => { jest.restoreAllMocks(); });

test("SO1. a revocation the server CONFIRMS (204) is recorded as confirmed — and Sign-in says nothing about it", async () => {
  const api = server(respond(204));
  const view = await signedIn();

  await signOutOn(view);

  await waitFor(() => { expect(reported(view)).toBe("confirmed"); });
  expect(api.requests).toEqual([{ contentType: null, authorization: "Bearer id.token" }]);
  expect(view.queryByTestId("server-sign-out-unconfirmed")).toBeNull();
});

test.each([
  ["refused (400)", respond(400)],
  ["a server fault (503)", respond(503)],
  ["no connection", () => Promise.reject(new TypeError("Network request failed"))],
])("SO2. a revocation %s: signed out on the phone all the same, the secret deleted — and Sign-in says the server did not confirm it", async (_why, answer) => {
  server(answer);
  const view = await signedIn();

  await signOutOn(view);

  expect(String(view.getByTestId("status").props.children)).toBe("unauthenticated");
  expect(await SecureStore.getItemAsync(REFRESH_KEY)).toBeNull();
  await waitFor(() => { expect(reported(view)).toBe("unconfirmed"); });
  const notice = view.getByTestId("server-sign-out-unconfirmed");
  expect(String(notice.props.children)).toMatch(/signed out on this phone/i);
  expect(String(notice.props.children)).toMatch(/could not confirm/i);
  expect(String(notice.props.children)).toMatch(/change your password/i);
});

test("SO3. the phone is signed out at once — a slow server never delays it", async () => {
  let answer: (response: Response) => void = () => undefined;
  server(() => new Promise<Response>(resolve => { answer = resolve; }));
  const view = await signedIn();

  await signOutOn(view);

  expect(String(view.getByTestId("status").props.children)).toBe("unauthenticated");
  expect(reported(view)).toBe("pending");
  await act(async () => { answer({ ok: true, status: 204, json: () => Promise.reject(new Error("no body")) } as Response); await Promise.resolve(); });
  await waitFor(() => { expect(reported(view)).toBe("confirmed"); });
});

test("SO4. signing in again clears the notice — it was about the previous session", async () => {
  server(respond(503));
  const view = await signedIn();
  await signOutOn(view);
  await waitFor(() => { expect(reported(view)).toBe("unconfirmed"); });

  await act(async () => { await fireEvent.press(view.getByTestId("probe-sign-in")); });

  await waitFor(() => { expect(reported(view)).toBe("null"); });
});

test("SO5. a revocation request that could not even be made (it threw) is unconfirmed — never confirmed", async () => {
  server(respond(204));
  const view = await signedIn();
  jest.spyOn(apiConfig, "apiBaseUrl").mockImplementation(() => { throw new Error("no API address"); });

  await signOutOn(view);

  expect(String(view.getByTestId("status").props.children)).toBe("unauthenticated");
  await waitFor(() => { expect(reported(view)).toBe("unconfirmed"); });
});

test("SO6. a later sign-out with no session to revoke (a cleanup retry, D61) asks nothing and leaves the recorded outcome as it was", async () => {
  const api = server(respond(204));
  const view = await signedIn();
  await signOutOn(view);
  await waitFor(() => { expect(reported(view)).toBe("confirmed"); });

  await signOutOn(view);

  expect(reported(view)).toBe("confirmed");
  expect(api.requests).toHaveLength(1);
  expect(view.queryByTestId("server-sign-out-unconfirmed")).toBeNull();
});
