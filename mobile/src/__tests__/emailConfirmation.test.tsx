/**
 * D63, stage 2 — the driver confirms their email address in the app.
 *
 * Companies add drivers by email, and a driver sees a company's invitation
 * only once that address is VERIFIED (D24, D63). Phone registration still
 * sends no email (D47); the app asks, through the existing identity-posture
 * `POST /auth/email-verification` ("send to MY address"), and the driver
 * opens the link. "I've confirmed it" re-reads `GET /auth/me`.
 *
 *   - Home shows the card only while the address is unconfirmed;
 *   - Settings always says where the address stands;
 *   - every failure is said plainly, and nothing claims an email was sent
 *     when it was not;
 *   - one tap is one request; an expired token is renewed (withIdentity).
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import { Pressable, Text } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { EmailConfirmation } from "../components/EmailConfirmation";
import { HomeScreen } from "../screens/HomeScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import type { AuthenticatedAccount } from "../api/account";

const USER = { id: "user_confirm", firstName: "Cara", lastName: "Confirm", email: "cara@example.com" };
const SIGNED_IN: AuthenticatedAccount = { user: USER, memberships: [], identityToken: "id.token", refreshToken: "secret-1" };
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

type View = Awaited<ReturnType<typeof render>>;

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);
}

interface Server {
  verified: boolean;
  sends: string[];
  meReads: number;
  send: () => Promise<Response>;
}

function server(options: { verified?: boolean; send?: () => Promise<Response> } = {}): Server {
  const state: Server = {
    verified: options.verified ?? false,
    sends: [],
    meReads: 0,
    send: options.send ?? (() => jsonResponse(204, null)),
  };
  jest.spyOn(global, "fetch").mockImplementation(((input: string, init: RequestInit = {}) => {
    const url = String(input);
    const token = new Headers(init.headers).get("authorization") ?? "";
    if (url.endsWith("/auth/me")) {
      state.meReads += 1;
      return jsonResponse(200, { user: USER, memberships: [], emailVerified: state.verified });
    }
    if (url.endsWith("/auth/email-verification")) { state.sends.push(token); return state.send(); }
    if (url.includes("/auth/refresh")) return jsonResponse(200, { identityToken: "renewed.token", refreshToken: "secret-2" });
    throw new Error(`unexpected request to ${url}`);
  }) as unknown as typeof fetch);
  return state;
}

function SignInFirst({ variant }: { variant: "home" | "settings" }) {
  const { signIn, status } = useAuth();
  return (
    <>
      <Pressable testID="sign-in" onPress={() => { void signIn(SIGNED_IN); }}><Text>{status}</Text></Pressable>
      {status === "authenticated" ? <EmailConfirmation variant={variant} /> : null}
    </>
  );
}

async function shown(variant: "home" | "settings"): Promise<View> {
  const view = await render(<SafeAreaProvider initialMetrics={METRICS}><AuthProvider><SignInFirst variant={variant} /></AuthProvider></SafeAreaProvider>);
  await waitFor(() => { expect(view.getByTestId("sign-in")).toBeTruthy(); });
  await act(async () => { await fireEvent.press(view.getByTestId("sign-in")); });
  return view;
}

async function press(view: View, testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(view.getByTestId(testID)); });
}

beforeEach(async () => { await SecureStore.deleteItemAsync("logisticbay.refreshToken"); });
afterEach(() => { jest.restoreAllMocks(); });

test("EC1. Home: an unconfirmed address shows the card — why it matters, and one button that asks for the email", async () => {
  const api = server();
  const view = await shown("home");

  await waitFor(() => { expect(view.getByTestId("email-confirmation")).toBeTruthy(); });
  expect(view.getByText("Confirm your email address")).toBeTruthy();
  expect(view.getByTestId("email-confirmation-why").props.children).toMatch(/compan(y|ies).*add you/i);
  expect(view.getByTestId("email-confirmation-address").props.children).toBe(USER.email);

  await press(view, "email-confirmation-send");

  await waitFor(() => { expect(view.getByTestId("email-confirmation-message").props.children).toMatch(/sent a link to cara@example\.com/i); });
  expect(api.sends).toEqual(["Bearer id.token"]);
  expect(view.getByTestId("email-confirmation-recheck")).toBeTruthy();
});

test("EC2. \"I've confirmed it\" re-reads the account: on Home the card goes; in Settings it says Confirmed", async () => {
  for (const variant of ["home", "settings"] as const) {
    jest.restoreAllMocks();
    const api = server();
    const view = await shown(variant);
    await waitFor(() => { expect(view.getByTestId("email-confirmation-send")).toBeTruthy(); });
    await press(view, "email-confirmation-send");
    api.verified = true;

    await press(view, "email-confirmation-recheck");

    if (variant === "home") await waitFor(() => { expect(view.queryByTestId("email-confirmation")).toBeNull(); });
    else await waitFor(() => { expect(view.getByTestId("email-confirmation-state").props.children).toBe("Confirmed"); });
    await view.unmount();
  }
});

test("EC3. a confirmed address: Home shows nothing at all; Settings says Confirmed, with no button", async () => {
  server({ verified: true });
  const home = await shown("home");
  await waitFor(() => { expect(home.getByText("authenticated")).toBeTruthy(); });
  await act(async () => { await Promise.resolve(); });
  expect(home.queryByTestId("email-confirmation")).toBeNull();
  await home.unmount();

  const settings = await shown("settings");
  await waitFor(() => { expect(settings.getByTestId("email-confirmation-state").props.children).toBe("Confirmed"); });
  expect(settings.queryByTestId("email-confirmation-send")).toBeNull();
});

test("EC4. every failure is said plainly — and none of them claims an email was sent", async () => {
  const cases: [() => Promise<Response>, RegExp][] = [
    [() => jsonResponse(429, { error: "Too many requests, try again shortly", code: "RATE_LIMITED" }), /wait a few minutes/i],
    [() => jsonResponse(409, { error: "Email cannot be delivered", code: "EMAIL_UNDELIVERABLE" }), /cannot be delivered/i],
    [() => jsonResponse(503, { error: "The email could not be sent", code: "EMAIL_UNAVAILABLE" }), /could not be sent/i],
    [() => Promise.reject(new TypeError("Network request failed")), /no connection/i],
  ];
  for (const [send, said] of cases) {
    jest.restoreAllMocks();
    server({ send });
    const view = await shown("home");
    await waitFor(() => { expect(view.getByTestId("email-confirmation-send")).toBeTruthy(); });

    await press(view, "email-confirmation-send");

    await waitFor(() => { expect(view.getByTestId("email-confirmation-message").props.children).toMatch(said); });
    expect(view.getByTestId("email-confirmation-message").props.children).not.toMatch(/sent a link/i);
    expect(view.getByTestId("email-confirmation-send")).toBeTruthy();
    await view.unmount();
  }
});

test("EC5. a double tap is ONE request", async () => {
  let answer: (response: Response) => void = () => undefined;
  const api = server({ send: () => new Promise<Response>(resolve => { answer = resolve; }) });
  const view = await shown("home");
  await waitFor(() => { expect(view.getByTestId("email-confirmation-send")).toBeTruthy(); });

  await act(async () => {
    // Two presses before either has been answered — not awaited one by one.
    await Promise.all([
      fireEvent.press(view.getByTestId("email-confirmation-send")),
      fireEvent.press(view.getByTestId("email-confirmation-send")),
    ]);
  });
  await act(async () => { answer({ ok: true, status: 204, json: () => Promise.reject(new Error("no body")) } as Response); await Promise.resolve(); });

  await waitFor(() => { expect(view.getByTestId("email-confirmation-message").props.children).toMatch(/sent a link/i); });
  expect(api.sends).toHaveLength(1);
});

test("EC6. an expired identity token is renewed and the request made once more — the driver just sees it sent", async () => {
  await SecureStore.setItemAsync("logisticbay.refreshToken", "secret-1");
  let first = true;
  const api = server({ send: () => {
    if (first) { first = false; return jsonResponse(401, { error: "Not authenticated", code: "UNAUTHENTICATED" }); }
    return jsonResponse(204, null);
  } });
  const view = await shown("home");
  await waitFor(() => { expect(view.getByTestId("email-confirmation-send")).toBeTruthy(); });

  await press(view, "email-confirmation-send");

  await waitFor(() => { expect(view.getByTestId("email-confirmation-message").props.children).toMatch(/sent a link/i); });
  expect(api.sends).toEqual(["Bearer id.token", "Bearer renewed.token"]);
});

test("EC7. the screens give the card its place: Home between the date and the shift card, Settings in Account", async () => {
  const noop = () => undefined;
  const home = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <HomeScreen
        user={USER} biometrics={{ available: false, label: "biometrics" }} biometricUnlockEnabled={false}
        onEnableBiometrics={() => Promise.resolve(false)} onOpenAccount={noop} onStartShift={noop}
        recent={[]} onOpenTimesheet={noop} notice={<Text testID="slot-home">notice</Text>}
      />
    </SafeAreaProvider>,
  );
  expect(home.getByTestId("slot-home")).toBeTruthy();
  await home.unmount();

  const settings = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <SettingsScreen
        user={USER} biometrics={{ available: false, label: "biometrics" }} biometricUnlockEnabled={false}
        onEnableBiometrics={() => Promise.resolve(false)} onDisableBiometrics={() => Promise.resolve()} onSignOut={noop}
        emailStatus={<Text testID="slot-settings">status</Text>}
      />
    </SafeAreaProvider>,
  );
  expect(settings.getByTestId("slot-settings")).toBeTruthy();
});
