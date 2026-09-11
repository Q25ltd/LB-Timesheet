/**
 * App-start session restoration, biometric unlock, and logout.
 *
 * These cases drive the REAL `AuthProvider` and the REAL `app/index.tsx`
 * against a stubbed network and a stubbed platform, because the property that
 * matters is the ORDER of events, and the order is what a mocked provider
 * would hide:
 *
 *     biometric gate → read SecureStore → POST /auth/refresh → GET /auth/me
 *       → authenticated
 *
 * The security boundary under test (D26) is that a biometric success is
 * PERMISSION TO USE a stored credential and never authentication. Several
 * cases below exist only to prove that the app cannot reach an authenticated
 * state without the server's answer, however well the biometric went.
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import * as LocalAuthentication from "expo-local-authentication";
import type { ReactElement } from "react";
import { Text, Pressable, AppState } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import Index from "../../app/index";

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn() };

jest.mock("expo-router", () => {
  const react = jest.requireActual<typeof import("react")>("react");
  const rn = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    __esModule: true,
    router: {
      replace: (href: string): void => { mockRouter.replace(href); },
      push:    (href: string): void => { mockRouter.push(href); },
      back:    (): void => { mockRouter.back(); },
    },
    Redirect: ({ href }: { href: string }) =>
      react.createElement(rn.Text, { testID: "redirect" }, String(href)),
  };
});

const REFRESH_KEY = "logisticbay.refreshToken";
const BIOMETRIC_KEY = "logisticbay.biometricUnlock";

const STORED_SECRET = "stored-refresh-secret";
const ROTATED_SECRET = "rotated-refresh-secret";

const CREDENTIALS = { identityToken: "fresh.identity.token", refreshToken: ROTATED_SECRET };
const ACCOUNT = {
  user: { id: "user_1", firstName: "Nerijus", lastName: "Kuizinas", email: "driver@example.com" },
  memberships: [],
};

const METRICS = {
  frame:  { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

type View = Awaited<ReturnType<typeof render>>;

function wrap(node: ReactElement): Promise<View> {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AuthProvider>{node}</AuthProvider>
    </SafeAreaProvider>,
  );
}

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

/**
 * A network where every auth endpoint answers successfully. Individual cases
 * override one route; the rest stay working, so a failure is attributable.
 */
function happyNetwork(overrides: { refresh?: () => Promise<Response>; me?: () => Promise<Response> } = {}) {
  return jest.spyOn(global, "fetch").mockImplementation(((input: string) => {
    const url = String(input);
    if (url.includes("/auth/refresh")) return (overrides.refresh ?? (() => jsonResponse(200, CREDENTIALS)))();
    if (url.includes("/auth/me")) return (overrides.me ?? (() => jsonResponse(200, ACCOUNT)))();
    if (url.includes("/auth/logout")) return jsonResponse(204, null);
    throw new Error(`unexpected request to ${url}`);
  }) as unknown as typeof fetch);
}

/** A device with Face ID hardware, enrolled. */
function faceIdCapable() {
  jest.mocked(LocalAuthentication.hasHardwareAsync).mockResolvedValue(true);
  jest.mocked(LocalAuthentication.isEnrolledAsync).mockResolvedValue(true);
  jest.mocked(LocalAuthentication.supportedAuthenticationTypesAsync)
    .mockResolvedValue([LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION]);
}

function touchIdCapable() {
  jest.mocked(LocalAuthentication.hasHardwareAsync).mockResolvedValue(true);
  jest.mocked(LocalAuthentication.isEnrolledAsync).mockResolvedValue(true);
  jest.mocked(LocalAuthentication.supportedAuthenticationTypesAsync)
    .mockResolvedValue([LocalAuthentication.AuthenticationType.FINGERPRINT]);
}

function biometricSucceeds() {
  jest.mocked(LocalAuthentication.authenticateAsync).mockResolvedValue({ success: true });
}

function biometricFails(error: "user_cancel" | "authentication_failed" | "lockout" | "not_enrolled") {
  jest.mocked(LocalAuthentication.authenticateAsync).mockResolvedValue({ success: false, error });
}

/** Reports the provider's state, so assertions read the machine, not the UI. */
function Probe() {
  const {
    status, isAuthenticated, identityToken, tenantToken, account, restoreOutcome,
    biometrics, biometricUnlockEnabled, signOut, unlock, enableBiometricUnlock,
  } = useAuth();
  return (
    <>
      <Text testID="status">{status}</Text>
      <Text testID="authenticated">{String(isAuthenticated)}</Text>
      <Text testID="identity">{String(identityToken)}</Text>
      <Text testID="tenant">{String(tenantToken)}</Text>
      <Text testID="email">{String(account?.user.email ?? "none")}</Text>
      <Text testID="outcome">{restoreOutcome}</Text>
      <Text testID="bio-available">{String(biometrics.available)}</Text>
      <Text testID="bio-label">{biometrics.label}</Text>
      <Text testID="bio-enabled">{String(biometricUnlockEnabled)}</Text>
      <Pressable testID="do-logout" onPress={() => { void signOut(); }}><Text>out</Text></Pressable>
      <Pressable testID="do-unlock" onPress={() => { void unlock(); }}><Text>unlock</Text></Pressable>
      <Pressable testID="do-enable" onPress={() => { void enableBiometricUnlock(); }}><Text>enable</Text></Pressable>
    </>
  );
}

function text(view: View, testID: string): string {
  return String(view.getByTestId(testID).props.children);
}

async function settled(view: View, testID = "status"): Promise<void> {
  await waitFor(() => { expect(text(view, testID)).not.toBe("restoring"); });
}

/**
 * The URL and body a recorded `fetch` call carried, as strings.
 *
 * `fetch`'s first parameter is `RequestInfo | URL` and its body is `BodyInit`,
 * so stringifying either directly can produce "[object Object]". Narrowed
 * here once — the app only ever passes strings — so every assertion below
 * reads a real value or an empty one, never a coerced object.
 */
type FetchCall = [unknown, RequestInit | undefined] | undefined;

function callUrl(call: FetchCall): string {
  return typeof call?.[0] === "string" ? call[0] : "";
}

function callBody(call: FetchCall): string {
  const body = call?.[1]?.body;
  return typeof body === "string" ? body : "";
}

function callHeader(call: FetchCall, name: string): string {
  const headers = call?.[1]?.headers;
  if (typeof headers !== "object" || headers === null) return "";
  const value: unknown = Reflect.get(headers, name);
  return typeof value === "string" ? value : "";
}

afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// Restoration without biometrics
// ═══════════════════════════════════════════════════════════════════════════

test("no stored credential: the app settles UNAUTHENTICATED and never calls the API", async () => {
  const fetchSpy = happyNetwork();

  const view = await wrap(<Probe />);
  await settled(view);

  expect(text(view, "status")).toBe("unauthenticated");
  expect(text(view, "outcome")).toBe("none");
  // A fresh install must not make a network call to discover it is fresh.
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("a stored credential is redeemed at startup and the session is restored", async () => {
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  const fetchSpy = happyNetwork();

  const view = await wrap(<Probe />);
  await settled(view);

  expect(text(view, "status")).toBe("authenticated");
  expect(text(view, "email")).toBe(ACCOUNT.user.email);
  expect(text(view, "identity")).toBe(CREDENTIALS.identityToken);

  // The ORDER is the contract: refresh first, then the account read with the
  // token refresh issued.
  const calls = fetchSpy.mock.calls as unknown as FetchCall[];
  expect(callUrl(calls[0])).toContain("/auth/refresh");
  expect(callUrl(calls[1])).toContain("/auth/me");

  // The credential presented was the stored one...
  expect(JSON.parse(callBody(calls[0]))).toEqual({ refreshToken: STORED_SECRET });
  // ...and /auth/me carried the NEW identity token in the header, never a URL.
  expect(callHeader(calls[1], "authorization")).toBe(`Bearer ${CREDENTIALS.identityToken}`);
  expect(callUrl(calls[1])).not.toContain(CREDENTIALS.identityToken);
});

test("ROTATION is persisted: SecureStore holds the new secret, not the redeemed one", async () => {
  // The server rotates on every redemption, so failing to store the new value
  // would leave the device holding a credential that is now only valid for
  // the 60-second grace window.
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  happyNetwork();

  const view = await wrap(<Probe />);
  await settled(view);

  await expect(SecureStore.getItemAsync(REFRESH_KEY)).resolves.toBe(ROTATED_SECRET);
});

test("NO access token is ever persisted — only the refresh secret reaches storage", async () => {
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  happyNetwork();
  const setItem = jest.spyOn(SecureStore, "setItemAsync");

  const view = await wrap(<Probe />);
  await settled(view);
  expect(text(view, "status")).toBe("authenticated");

  const written = setItem.mock.calls.map(call => ({ key: String(call[0]), value: String(call[1]) }));
  for (const entry of written) {
    expect(entry.key).toBe(REFRESH_KEY);
    expect(entry.value).not.toBe(CREDENTIALS.identityToken);
  }
  expect(written.some(entry => entry.value === ROTATED_SECRET)).toBe(true);
});

test("a REFUSED credential is deleted and the driver is sent to sign in", async () => {
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  happyNetwork({ refresh: () => jsonResponse(401, { error: "Not authenticated", code: "UNAUTHENTICATED" }) });

  const view = await wrap(<Probe />);
  await settled(view);

  expect(text(view, "status")).toBe("unauthenticated");
  expect(text(view, "outcome")).toBe("expired");
  // It will never work again, so keeping it would only produce the same
  // failure on every launch.
  await expect(SecureStore.getItemAsync(REFRESH_KEY)).resolves.toBeNull();
});

test("an OFFLINE startup KEEPS the credential — a tunnel is not a logout", async () => {
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  jest.spyOn(global, "fetch").mockImplementation(() => Promise.reject(new Error("Network request failed")));

  const view = await wrap(<Probe />);
  await settled(view);

  expect(text(view, "status")).toBe("unauthenticated");
  expect(text(view, "outcome")).toBe("offline");
  // The session is almost certainly still valid server-side. Deleting the
  // secret here would log a driver out for being in a bad signal area.
  await expect(SecureStore.getItemAsync(REFRESH_KEY)).resolves.toBe(STORED_SECRET);
});

test("company authority is NOT restored — a tenant token is never stored, so never returned", async () => {
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  happyNetwork();

  const view = await wrap(<Probe />);
  await settled(view);

  expect(text(view, "status")).toBe("authenticated");
  // Restoration yields ACCOUNT identity. Selecting a company is a separate
  // security event and has to happen again.
  expect(text(view, "tenant")).toBe("null");
});

// ═══════════════════════════════════════════════════════════════════════════
// Routing: the restoring state is what prevents the flash
// ═══════════════════════════════════════════════════════════════════════════

test("while restoring, the entry route holds — it does NOT redirect anywhere", async () => {
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  // A refresh that never settles, so the restoring frame can be observed.
  happyNetwork({ refresh: () => new Promise<Response>(() => { /* never resolves */ }) });

  const view = await wrap(<Index />);

  // The placeholder, and crucially NO redirect element at all: with a boolean
  // `isAuthenticated` this frame would have rendered `/sign-in` and then
  // bounced to `/today`.
  expect(view.getByTestId("auth-restoring")).toBeTruthy();
  expect(view.queryByTestId("redirect")).toBeNull();
});

test("restored session routes to /today; no credential routes to /sign-in", async () => {
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  happyNetwork();

  const restored = await wrap(<Index />);
  await waitFor(() => { expect(restored.queryByTestId("redirect")).not.toBeNull(); });
  expect(String(restored.getByTestId("redirect").props.children)).toBe("/today");

  await SecureStore.deleteItemAsync(REFRESH_KEY);
  const fresh = await wrap(<Index />);
  await waitFor(() => { expect(fresh.queryByTestId("redirect")).not.toBeNull(); });
  expect(String(fresh.getByTestId("redirect").props.children)).toBe("/sign-in");
});

// ═══════════════════════════════════════════════════════════════════════════
// Biometric capability
// ═══════════════════════════════════════════════════════════════════════════

test("hardware absent: biometrics are unavailable and restoration proceeds WITHOUT a prompt", async () => {
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  await SecureStore.setItemAsync(BIOMETRIC_KEY, "enabled");
  jest.mocked(LocalAuthentication.hasHardwareAsync).mockResolvedValue(false);
  happyNetwork();

  const view = await wrap(<Probe />);
  await settled(view);

  expect(text(view, "bio-available")).toBe("false");
  // Opted in, but the device can no longer do it. FAIL CLOSED: no
  // authenticated state, and the password form instead.
  expect(text(view, "status")).toBe("unauthenticated");
  expect(text(view, "outcome")).toBe("biometric-locked");
  expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
  // And the valid session is NOT destroyed for it.
  await expect(SecureStore.getItemAsync(REFRESH_KEY)).resolves.toBe(STORED_SECRET);
});

test("hardware present but NOT enrolled is treated as unavailable", async () => {
  jest.mocked(LocalAuthentication.hasHardwareAsync).mockResolvedValue(true);
  jest.mocked(LocalAuthentication.isEnrolledAsync).mockResolvedValue(false);
  happyNetwork();

  const view = await wrap(<Probe />);
  await settled(view);

  // Prompting a phone with no enrolled biometric shows a dialog the driver
  // cannot satisfy.
  expect(text(view, "bio-available")).toBe("false");
  expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
});

test("the label follows the ENROLLED method — Face ID and Touch ID are not interchangeable", async () => {
  faceIdCapable();
  const face = await wrap(<Probe />);
  await settled(face);
  expect(text(face, "bio-available")).toBe("true");
  expect(text(face, "bio-label")).toBe("Face ID");

  touchIdCapable();
  const touch = await wrap(<Probe />);
  await settled(touch);
  expect(text(touch, "bio-label")).toBe("Touch ID");
});

// ═══════════════════════════════════════════════════════════════════════════
// Biometric unlock — and the boundary it must never cross
// ═══════════════════════════════════════════════════════════════════════════

test("opted in and successful: the prompt gates the restore, which the SERVER completes", async () => {
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  await SecureStore.setItemAsync(BIOMETRIC_KEY, "enabled");
  faceIdCapable();
  biometricSucceeds();
  const fetchSpy = happyNetwork();

  const view = await wrap(<Probe />);
  await settled(view);

  expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
  expect(text(view, "status")).toBe("authenticated");
  // The gate came FIRST and the server still had to answer.
  const calls = fetchSpy.mock.calls as unknown as FetchCall[];
  expect(callUrl(calls[0])).toContain("/auth/refresh");
});

test("BIOMETRIC SUCCESS ALONE CANNOT AUTHENTICATE — the server's refusal still wins", async () => {
  // The central case of D26. The OS said yes; the server said no; the app
  // must be unauthenticated. If this ever passes into `authenticated`, a
  // stolen phone with a revoked session is inside the app.
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  await SecureStore.setItemAsync(BIOMETRIC_KEY, "enabled");
  faceIdCapable();
  biometricSucceeds();
  happyNetwork({ refresh: () => jsonResponse(401, { error: "Not authenticated", code: "UNAUTHENTICATED" }) });

  const view = await wrap(<Probe />);
  await settled(view);

  expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
  expect(text(view, "status")).toBe("unauthenticated");
  expect(text(view, "authenticated")).toBe("false");
  expect(text(view, "identity")).toBe("null");
  expect(text(view, "tenant")).toBe("null");
  expect(text(view, "email")).toBe("none");
});

test("biometric success CANNOT bypass /auth/refresh — no server call means no session", async () => {
  // The other half of the boundary: if the network is unreachable, a perfect
  // Face ID scan still yields nothing, because nothing local can authenticate.
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  await SecureStore.setItemAsync(BIOMETRIC_KEY, "enabled");
  faceIdCapable();
  biometricSucceeds();
  const fetchSpy = jest.spyOn(global, "fetch")
    .mockImplementation(() => Promise.reject(new Error("Network request failed")));

  const view = await wrap(<Probe />);
  await settled(view);

  expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
  expect(fetchSpy).toHaveBeenCalled();
  expect(callUrl(fetchSpy.mock.calls[0] as unknown as FetchCall)).toContain("/auth/refresh");
  expect(text(view, "status")).toBe("unauthenticated");
  expect(text(view, "identity")).toBe("null");
});

test("cancel, failure, lockout and a lost enrolment all fall back to the password form", async () => {
  for (const error of ["user_cancel", "authentication_failed", "lockout", "not_enrolled"] as const) {
    await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
    await SecureStore.setItemAsync(BIOMETRIC_KEY, "enabled");
    faceIdCapable();
    biometricFails(error);
    const fetchSpy = happyNetwork();

    const view = await wrap(<Probe />);
    await settled(view);

    expect(text(view, "status")).toBe(`unauthenticated`);
    expect(text(view, "outcome")).toBe("biometric-locked");
    // No credential was even read against the server.
    expect(fetchSpy).not.toHaveBeenCalled();
    // And the session survives: a face that did not match is not a reason to
    // end a valid server session.
    await expect(SecureStore.getItemAsync(REFRESH_KEY)).resolves.toBe(STORED_SECRET);
    jest.restoreAllMocks();
  }
});

test("NO biometric data is ever sent to the API", async () => {
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  await SecureStore.setItemAsync(BIOMETRIC_KEY, "enabled");
  faceIdCapable();
  biometricSucceeds();
  const fetchSpy = happyNetwork();

  const view = await wrap(<Probe />);
  await settled(view);

  // Every request body and URL, checked for anything biometric. The OS
  // answers yes or no on the device, and that answer never leaves it.
  const traffic = (fetchSpy.mock.calls as unknown as FetchCall[])
    .map(call => `${callUrl(call)} ${callBody(call)}`)
    .join(" | ");
  for (const forbidden of ["biometric", "faceId", "face_id", "FACIAL", "fingerprint", "touchId", "template"]) {
    expect(traffic.toLowerCase()).not.toContain(forbidden.toLowerCase());
  }
  // The only credential that travelled was the refresh secret.
  expect(traffic).toContain(STORED_SECRET);
});

test("the retry action re-prompts and can succeed after an earlier cancel", async () => {
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  await SecureStore.setItemAsync(BIOMETRIC_KEY, "enabled");
  faceIdCapable();
  biometricFails("user_cancel");
  happyNetwork();

  const view = await wrap(<Probe />);
  await settled(view);
  expect(text(view, "status")).toBe("unauthenticated");

  biometricSucceeds();
  await act(async () => { await fireEvent.press(view.getByTestId("do-unlock")); });

  await waitFor(() => { expect(text(view, "status")).toBe("authenticated"); });
  expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(2);
});

// ═══════════════════════════════════════════════════════════════════════════
// Opt-in
// ═══════════════════════════════════════════════════════════════════════════

test("opting in prompts once, persists the flag, and is refused if the prompt fails", async () => {
  faceIdCapable();
  biometricFails("user_cancel");
  happyNetwork();

  const view = await wrap(<Probe />);
  await settled(view);
  expect(text(view, "bio-enabled")).toBe("false");

  // A cancelled confirmation must NOT enable it — an opt-in that silently
  // fails on the next launch is worse than no opt-in.
  await act(async () => { await fireEvent.press(view.getByTestId("do-enable")); });
  expect(text(view, "bio-enabled")).toBe("false");
  await expect(SecureStore.getItemAsync(BIOMETRIC_KEY)).resolves.toBeNull();

  biometricSucceeds();
  await act(async () => { await fireEvent.press(view.getByTestId("do-enable")); });
  await waitFor(() => { expect(text(view, "bio-enabled")).toBe("true"); });
  await expect(SecureStore.getItemAsync(BIOMETRIC_KEY)).resolves.toBe("enabled");
});

test("declining biometrics leaves authentication completely unaffected", async () => {
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  // Capable device, never opted in — so no prompt, and an ordinary restore.
  faceIdCapable();
  happyNetwork();

  const view = await wrap(<Probe />);
  await settled(view);

  expect(text(view, "bio-available")).toBe("true");
  expect(text(view, "bio-enabled")).toBe("false");
  expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
  expect(text(view, "status")).toBe("authenticated");
});

// ═══════════════════════════════════════════════════════════════════════════
// Logout
// ═══════════════════════════════════════════════════════════════════════════

test("logout revokes the session SERVER-side and clears every local trace", async () => {
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  await SecureStore.setItemAsync(BIOMETRIC_KEY, "enabled");
  faceIdCapable();
  biometricSucceeds();
  const fetchSpy = happyNetwork();

  const view = await wrap(<Probe />);
  await settled(view);
  expect(text(view, "status")).toBe("authenticated");

  await act(async () => { await fireEvent.press(view.getByTestId("do-logout")); });
  await waitFor(() => { expect(text(view, "status")).toBe("unauthenticated"); });

  // The server was asked, with the identity token — not merely local state.
  const logout = (fetchSpy.mock.calls as unknown as FetchCall[])
    .find(call => callUrl(call).includes("/auth/logout"));
  expect(logout).toBeDefined();
  expect(callHeader(logout, "authorization")).toBe(`Bearer ${CREDENTIALS.identityToken}`);

  // Nothing survives locally.
  expect(text(view, "identity")).toBe("null");
  expect(text(view, "tenant")).toBe("null");
  expect(text(view, "email")).toBe("none");
  await expect(SecureStore.getItemAsync(REFRESH_KEY)).resolves.toBeNull();
  await expect(SecureStore.getItemAsync(BIOMETRIC_KEY)).resolves.toBeNull();
  expect(text(view, "bio-enabled")).toBe("false");
});

test("logout with NO NETWORK still signs the driver out locally, immediately", async () => {
  // A driver who taps sign out in a yard must be signed out of the device.
  // Blocking on the server would leave a signed-in phone in their hand; the
  // report simply must not claim the server revocation happened.
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  let online = true;
  jest.spyOn(global, "fetch").mockImplementation(((input: string) => {
    const url = String(input);
    if (!online) return Promise.reject(new Error("Network request failed"));
    if (url.includes("/auth/refresh")) return jsonResponse(200, CREDENTIALS);
    if (url.includes("/auth/me")) return jsonResponse(200, ACCOUNT);
    return jsonResponse(204, null);
  }) as unknown as typeof fetch);

  const view = await wrap(<Probe />);
  await settled(view);
  expect(text(view, "status")).toBe("authenticated");

  online = false;
  await act(async () => { await fireEvent.press(view.getByTestId("do-logout")); });
  await waitFor(() => { expect(text(view, "status")).toBe("unauthenticated"); });

  expect(text(view, "identity")).toBe("null");
  await expect(SecureStore.getItemAsync(REFRESH_KEY)).resolves.toBeNull();
});

test("after logout a relaunch is a fresh start, with no credential to redeem", async () => {
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  happyNetwork();

  const first = await wrap(<Probe />);
  await settled(first);
  await act(async () => { await fireEvent.press(first.getByTestId("do-logout")); });
  await waitFor(() => { expect(text(first, "status")).toBe("unauthenticated"); });

  // A brand-new provider — the relaunch.
  const relaunched = await wrap(<Index />);
  await waitFor(() => { expect(relaunched.queryByTestId("redirect")).not.toBeNull(); });
  expect(String(relaunched.getByTestId("redirect").props.children)).toBe("/sign-in");
});

// ═══════════════════════════════════════════════════════════════════════════
// The OWNER'S sequence, end to end: login → enable → force-close → Face ID
// ═══════════════════════════════════════════════════════════════════════════
// Every case above SEEDS SecureStore directly. This one does not: it drives
// the real login call and the real opt-in, then throws the provider away and
// mounts a NEW one — which is what a force-close and relaunch is, because the
// only thing that survives a process death is SecureStore.

const LOGIN_RESPONSE = {
  user: ACCOUNT.user,
  identityToken: "login.identity.token",
  refreshToken: "login-refresh-secret",
  memberships: [],
};

test("FORCE-CLOSE then reopen: login → enable Face ID → new process → Face ID → refresh → authenticated", async () => {
  faceIdCapable();
  biometricSucceeds();
  const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(((input: string) => {
    const url = String(input);
    if (url.includes("/auth/login")) return jsonResponse(200, LOGIN_RESPONSE);
    if (url.includes("/auth/refresh")) return jsonResponse(200, CREDENTIALS);
    if (url.includes("/auth/me")) return jsonResponse(200, ACCOUNT);
    throw new Error(`unexpected request to ${url}`);
  }) as unknown as typeof fetch);

  // ── process 1: sign in with a password, then opt in ──────────────────
  function SignedInProbe() {
    const { signIn, enableBiometricUnlock, status } = useAuth();
    return (
      <>
        <Text testID="status">{status}</Text>
        <Pressable testID="do-login" onPress={() => { void signIn(LOGIN_RESPONSE); }}><Text>in</Text></Pressable>
        <Pressable testID="do-enable" onPress={() => { void enableBiometricUnlock(); }}><Text>enable</Text></Pressable>
      </>
    );
  }
  const first = await wrap(<SignedInProbe />);
  await settled(first);
  await act(async () => { await fireEvent.press(first.getByTestId("do-login")); });
  await waitFor(() => { expect(text(first, "status")).toBe("authenticated"); });
  await act(async () => { await fireEvent.press(first.getByTestId("do-enable")); });

  // What survived: the refresh secret and a non-secret preference. Nothing else.
  await expect(SecureStore.getItemAsync(REFRESH_KEY)).resolves.toBe(LOGIN_RESPONSE.refreshToken);
  await expect(SecureStore.getItemAsync(BIOMETRIC_KEY)).resolves.toBe("enabled");

  // ── the force-close: a brand-new provider, nothing carried in memory ──
  jest.mocked(LocalAuthentication.authenticateAsync).mockClear();
  const relaunched = await wrap(<Probe />);
  await settled(relaunched);

  expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
  expect(text(relaunched, "status")).toBe("authenticated");
  expect(text(relaunched, "email")).toBe(ACCOUNT.user.email);
  // The credential the new process presented was the one login stored, and the
  // SERVER is what authenticated it.
  const refreshCall = (fetchSpy.mock.calls as unknown as FetchCall[])
    .filter(call => callUrl(call).includes("/auth/refresh")).pop();
  expect(JSON.parse(callBody(refreshCall))).toEqual({ refreshToken: LOGIN_RESPONSE.refreshToken });
  // And the rotated secret replaced it.
  await expect(SecureStore.getItemAsync(REFRESH_KEY)).resolves.toBe(ROTATED_SECRET);
});

test("EXPLICIT LOGOUT still defeats Face ID on the next launch — the invariant is preserved", async () => {
  // The counterpart, and it must NOT be softened to make biometrics nicer.
  // Logout revokes the server Session and deletes the credential, so there is
  // nothing for a successful Face ID to unlock.
  faceIdCapable();
  biometricSucceeds();
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  await SecureStore.setItemAsync(BIOMETRIC_KEY, "enabled");
  happyNetwork();

  const first = await wrap(<Probe />);
  await settled(first);
  expect(text(first, "status")).toBe("authenticated");

  await act(async () => { await fireEvent.press(first.getByTestId("do-logout")); });
  await waitFor(() => { expect(text(first, "status")).toBe("unauthenticated"); });

  // The relaunch: no credential, so NO prompt is even shown — prompting for a
  // face we cannot act on would be theatre.
  jest.mocked(LocalAuthentication.authenticateAsync).mockClear();
  const relaunched = await wrap(<Probe />);
  await settled(relaunched);

  expect(text(relaunched, "status")).toBe("unauthenticated");
  expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
  expect(text(relaunched, "bio-enabled")).toBe("false");
  await expect(SecureStore.getItemAsync(REFRESH_KEY)).resolves.toBeNull();
});

test("the prompt is DEFERRED while the app is not frontmost, then proceeds", async () => {
  // The physical-device failure this guards: a cold-launch mount effect can
  // fire while iOS still reports `inactive`, and presenting LAContext then is
  // refused by the OS — the driver sees the sign-in form and no prompt at all.
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  await SecureStore.setItemAsync(BIOMETRIC_KEY, "enabled");
  faceIdCapable();
  biometricSucceeds();
  happyNetwork();

  const listeners: ((state: string) => void)[] = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation(((_event: string, handler: (s: string) => void) => {
    listeners.push(handler);
    return { remove: () => { /* nothing to detach in the stub */ } };
  }) as unknown as typeof AppState.addEventListener);
  // `currentState` is a plain property under jest-expo, so it is assigned.
  const original = AppState.currentState;
  Object.assign(AppState, { currentState: "inactive" });

  try {
    const view = await wrap(<Probe />);
    // Not prompted yet — the app is not frontmost.
    await waitFor(() => { expect(listeners.length).toBeGreaterThan(0); });
    expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();

    // The OS reports the app has come forward.
    Object.assign(AppState, { currentState: "active" });
    // Synchronous notification inside `act`, which still flushes the state
    // updates it causes; declaring it async without an await is a lint error.
    await act(() => { for (const notify of listeners) notify("active"); });

    await settled(view);
    expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(text(view, "status")).toBe("authenticated");
  } finally {
    Object.assign(AppState, { currentState: original });
  }
});
