/**
 * The Registration screen's BEHAVIOUR against a stubbed network.
 *
 * Deliberately not pixel assertions. What is proven here is what a driver
 * would notice going wrong: a field that is silently accepted empty, a
 * duplicate email reported as a connection problem, a double-submitted
 * registration, a password written to disk.
 *
 * The backend remains the security authority — these cases prove the CLIENT
 * behaves, not that the server is safe.
 */
import { render, fireEvent, act } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import type { ReactElement } from "react";
import { RegisterScreen } from "../screens/RegisterScreen";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { Text } from "react-native";
import type { RegistrationResponse } from "../api/registration";

const SUCCESS: RegistrationResponse = {
  user: { id: "user_1", firstName: "Nerijus", lastName: "Kuizinas", email: "driver@example.com" },
  identityToken: "identity.token.value",
  refreshToken:  "refresh-secret-value",
  memberships:   [],
};

const METRICS = {
  frame:   { x: 0, y: 0, width: 390, height: 844 },
  insets:  { top: 47, left: 0, right: 0, bottom: 34 },
};

/**
 * RNTL v14's `render` is ASYNCHRONOUS — React 19's concurrent root means the
 * tree is not mounted when the call returns. Every case awaits it and uses
 * the RETURNED queries rather than the global `screen`, so one case can
 * never read another's tree.
 */
type View = Awaited<ReturnType<typeof render>>;

function wrap(node: ReactElement): Promise<View> {
  return render(<SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>);
}

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

async function fillValidForm(view: View) {
  await fireEvent.changeText(view.getByPlaceholderText("First name"), "Nerijus");
  await fireEvent.changeText(view.getByPlaceholderText("Last name"), "Kuizinas");
  await fireEvent.changeText(view.getByPlaceholderText("Email address"), "driver@example.com");
  await fireEvent.changeText(view.getByPlaceholderText("Password"), "correct-horse-battery");
}

const noop = () => { /* navigation is not under test here */ };

/**
 * Press "Create account" and let React settle.
 *
 * RNTL v14's `fireEvent` is ASYNCHRONOUS and returns a promise: it wraps the
 * event in React 19's act scope and resolves once the resulting state update
 * has settled. Not awaiting it leaks the update into the NEXT test, whose
 * render then comes back empty — which reads as a missing element rather
 * than as the leaked update it actually is.
 */
async function pressSubmit(view: View) {
  await fireEvent.press(view.getByTestId("create-account"));
}

afterEach(() => { jest.restoreAllMocks(); });

test("the screen shows the frozen password rule and NOT the superseded mockup rules", async () => {
  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);

  expect(view.getByText("At least 10 characters")).toBeTruthy();
  // D23 replaced the reference design's three-rule checklist.
  expect(view.queryByText(/uppercase/i)).toBeNull();
  expect(view.queryByText(/include a number/i)).toBeNull();
  expect(view.queryByText(/8 characters/i)).toBeNull();
});

test("the screen collects exactly four fields — no company, no phone, no invite code", async () => {
  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);

  expect(view.getByPlaceholderText("First name")).toBeTruthy();
  expect(view.getByPlaceholderText("Last name")).toBeTruthy();
  expect(view.getByPlaceholderText("Email address")).toBeTruthy();
  expect(view.getByPlaceholderText("Password")).toBeTruthy();
  for (const forbidden of [/company/i, /phone/i, /invite/i, /licence/i, /payroll/i]) {
    expect(view.queryByPlaceholderText(forbidden)).toBeNull();
  }
});

test("submitting an empty form reports every missing field and never calls the API", async () => {
  const fetchSpy = jest.spyOn(globalThis, "fetch");
  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);

  await pressSubmit(view);

  expect(view.getByText("Enter your first name")).toBeTruthy();
  expect(view.getByText("Enter your last name")).toBeTruthy();
  expect(view.getByText("Enter your email address")).toBeTruthy();
  expect(view.getByText("At least 10 characters")).toBeTruthy();
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("a short password is refused on the client, before any request", async () => {
  const fetchSpy = jest.spyOn(globalThis, "fetch");
  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);

  await fillValidForm(view);
  await fireEvent.changeText(view.getByPlaceholderText("Password"), "short");
  await pressSubmit(view);

  expect(view.getAllByText("At least 10 characters").length).toBeGreaterThan(0);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("the password can be revealed and hidden", async () => {
  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);
  // Re-queried each time: a captured node carries the props of the render it
  // came from, so holding one across a state change asserts stale values.
  const secure = () => view.getByPlaceholderText("Password").props.secureTextEntry as boolean;

  expect(secure()).toBe(true);
  await fireEvent.press(view.getByTestId("toggle-password-visibility"));
  expect(secure()).toBe(false);
  await fireEvent.press(view.getByTestId("toggle-password-visibility"));
  expect(secure()).toBe(true);
});

test("a server validation error is rendered against the field it names", async () => {
  jest.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse(400, {
      error: "Invalid request",
      code: "VALIDATION",
      details: [{ path: "email", message: "Enter a valid email address" }],
    }));

  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);
  await fillValidForm(view);
  await pressSubmit(view);

  expect(view.getByText("Enter a valid email address")).toBeTruthy();
});

test("EMAIL_IN_USE is shown against the email field in the driver's language", async () => {
  jest.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse(409, { error: "Email already registered", code: "EMAIL_IN_USE" }));

  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);
  await fillValidForm(view);
  await pressSubmit(view);

  expect(view.getByText("That email address is already registered")).toBeTruthy();
});

test("a network failure is reported as a connection problem, never as a server answer", async () => {
  jest.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("Network request failed")));

  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);
  await fillValidForm(view);
  await pressSubmit(view);

  expect(view.getByText("No connection. Check your signal and try again.")).toBeTruthy();
  // The failure mode this guards: a request that never arrived must not be
  // dressed up as "email already registered".
  expect(view.queryByText(/already registered/i)).toBeNull();
});

test("the button shows a submitting state and a second tap does not register twice", async () => {
  let release: (value: Response) => void = () => { /* replaced below */ };
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(() => pending);

  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);
  await fillValidForm(view);
  await pressSubmit(view);

  expect(view.getByTestId("submitting-indicator")).toBeTruthy();
  expect(view.getByTestId("create-account").props.accessibilityState).toMatchObject({ disabled: true, busy: true });

  await pressSubmit(view);
  await pressSubmit(view);
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  await act(async () => {
    release({ ok: true, status: 201, json: () => Promise.resolve(SUCCESS) } as Response);
    await pending;
  });
});

test("a successful registration hands the response on and stores ONLY the refresh secret", async () => {
  jest.spyOn(globalThis, "fetch").mockImplementation(() => jsonResponse(201, SUCCESS));

  // The real provider, so this exercises the app's actual storage path.
  function Probe() {
    const { account, identityToken, isAuthenticated, signInFromRegistration } = useAuth();
    return (
      <>
        <RegisterScreen onRegistered={signInFromRegistration} onSignIn={noop} />
        <Text testID="probe-authenticated">{String(isAuthenticated)}</Text>
        <Text testID="probe-memberships">{String(account?.memberships.length ?? -1)}</Text>
        <Text testID="probe-token">{identityToken ?? "none"}</Text>
      </>
    );
  }

  const view = await wrap(<AuthProvider><Probe /></AuthProvider>);
  await fillValidForm(view);
  await pressSubmit(view);

  expect(view.getByTestId("probe-authenticated").props.children).toBe("true");

  // ZERO memberships is a successful, authenticated state (D21).
  expect(view.getByTestId("probe-memberships").props.children).toBe("0");
  // The access token is held in memory and is reachable for API calls.
  expect(view.getByTestId("probe-token").props.children).toBe("identity.token.value");

  // D25: the refresh secret is the ONLY thing written to the device.
  const setItem = jest.mocked(SecureStore.setItemAsync);
  const written = setItem.mock.calls as unknown as [string, string][];
  expect(written).toEqual([["logisticbay.refreshToken", "refresh-secret-value"]]);

  const storedValues = written.map(([, value]) => value);
  expect(storedValues).not.toContain("identity.token.value");
  expect(storedValues).not.toContain("correct-horse-battery");
  // And the password never reaches persistence under any key.
  expect(JSON.stringify(written)).not.toContain("correct-horse-battery");
});

test("the request body carries exactly the four fields, with the password untrimmed", async () => {
  const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(() => jsonResponse(201, SUCCESS));

  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);
  await fireEvent.changeText(view.getByPlaceholderText("First name"), "  Nerijus  ");
  await fireEvent.changeText(view.getByPlaceholderText("Last name"), "  Kuizinas  ");
  await fireEvent.changeText(view.getByPlaceholderText("Email address"), "  Driver@Example.COM  ");
  await fireEvent.changeText(view.getByPlaceholderText("Password"), " padded password ");
  await pressSubmit(view);

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const call = fetchSpy.mock.calls[0] as [string, RequestInit];
  const rawBody = call[1].body;
  expect(typeof rawBody).toBe("string");
  const body: unknown = JSON.parse(typeof rawBody === "string" ? rawBody : "{}");

  expect(body).toEqual({
    firstName: "Nerijus",
    lastName:  "Kuizinas",
    // Sent as typed apart from trimming; the SERVER owns canonicalisation.
    email:     "Driver@Example.COM",
    // NOT trimmed — trimming would change the driver's secret.
    password:  " padded password ",
  });
});
