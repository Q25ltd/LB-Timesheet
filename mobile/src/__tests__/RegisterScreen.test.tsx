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
import { render, fireEvent, act, within } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import type { ReactElement } from "react";
import { RegisterScreen } from "../screens/RegisterScreen";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { Text, StyleSheet, Keyboard, Dimensions } from "react-native";
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
  await fireEvent.changeText(view.getByPlaceholderText("Repeat password"), "correct-horse-battery");
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
  expect(view.getByPlaceholderText("Repeat password")).toBeTruthy();
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

test("the two password fields reveal independently", async () => {
  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);
  const secureOf = (placeholder: string) =>
    view.getByPlaceholderText(placeholder).props.secureTextEntry as boolean;

  expect(secureOf("Password")).toBe(true);
  expect(secureOf("Repeat password")).toBe(true);

  // Revealing one must not reveal the other — they have distinct controls.
  await fireEvent.press(view.getByTestId("toggle-confirm-password-visibility"));
  expect(secureOf("Repeat password")).toBe(false);
  expect(secureOf("Password")).toBe(true);
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

  // The driver-facing sentence is unchanged and must always be present.
  expect(view.getByText(/No connection\. Check your signal and try again\./)).toBeTruthy();
  // The failure mode this guards: a request that never arrived must not be
  // dressed up as "email already registered".
  expect(view.queryByText(/already registered/i)).toBeNull();

  // Jest runs with __DEV__ true, so the development diagnostic must also be
  // shown — and must name the address that actually failed. Without this,
  // the single most common local failure (a phone told to reach `localhost`,
  // which on a phone is the phone) reads as bad signal and sends the reader
  // to inspect the network instead of the configuration.
  expect(view.getByText(/Could not reach http:\/\/\S+\/auth\/register/)).toBeTruthy();
});

test("the development diagnostic is suppressed in a production build", async () => {
  // The same failure, with __DEV__ false. The driver sees the plain sentence
  // and nothing else: an internal hostname on screen is of no use to them and
  // discloses the developer's or the deployment's network layout.
  // `__DEV__` is a React Native global, not a DOM one, so it is reached
  // through a narrow cast rather than by widening globalThis for the suite.
  const globals = globalThis as unknown as { __DEV__: boolean };
  const wasDev = globals.__DEV__;
  globals.__DEV__ = false;
  jest.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("Network request failed")));

  try {
    const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);
    await fillValidForm(view);
    await pressSubmit(view);

    expect(view.getByText(/No connection\. Check your signal and try again\./)).toBeTruthy();
    expect(view.queryByText(/Could not reach/)).toBeNull();
    expect(view.queryByText(/http:\/\//)).toBeNull();
  } finally {
    globals.__DEV__ = wasDev;
  }
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
  await fireEvent.changeText(view.getByPlaceholderText("Repeat password"), " padded password ");
  await pressSubmit(view);

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const call = fetchSpy.mock.calls[0] as [string, RequestInit];
  const rawBody = call[1].body;
  expect(typeof rawBody).toBe("string");
  const body: unknown = JSON.parse(typeof rawBody === "string" ? rawBody : "{}");

  // `toEqual` on the whole body is the guard that `confirmPassword` never
  // ships: the DTO is `.strict()`, so a fifth field would be refused by the
  // server and the driver would see a validation error they cannot act on.
  expect(body).toEqual({
    firstName: "Nerijus",
    lastName:  "Kuizinas",
    // Sent as typed apart from trimming; the SERVER owns canonicalisation.
    email:     "Driver@Example.COM",
    // NOT trimmed — trimming would change the driver's secret.
    password:  " padded password ",
  });
  expect(JSON.stringify(body)).not.toContain("confirmPassword");
});

// ═══════════════════════════════════════════════════════════════════════════
// Layout contract: no scrolling at rest, in either direction
// ═══════════════════════════════════════════════════════════════════════════
// The bug this guards is one a driver sees immediately and no unit test
// caught before: content taller than the screen, so the form drifts under a
// drag, and a full-bleed image that left a white strip down one edge.

test("at rest the screen does not scroll in either direction, and the hero is shown", async () => {
  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);
  const scroll = view.getByTestId("register-scroll");

  // Not "usually fits" — scrolling is switched off, so there is nothing to
  // drag even by a pixel.
  expect(scroll.props.scrollEnabled).toBe(false);
  // Bounce would let an edge be dragged past even with scrolling disabled.
  expect(scroll.props.bounces).toBe(false);
  expect(scroll.props.alwaysBounceVertical).toBe(false);
  expect(scroll.props.alwaysBounceHorizontal).toBe(false);
  // Never horizontal: a horizontally scrolling form is always a layout bug.
  expect(scroll.props.horizontal).toBeFalsy();

  // `flexGrow: 1` is what makes the content exactly fill the screen rather
  // than overflow it.
  expect(StyleSheet.flatten(scroll.props.contentContainerStyle)).toMatchObject({ flexGrow: 1 });

  expect(view.getByTestId("brand-hero")).toBeTruthy();
});

test("when the keyboard opens the hero yields its space and scrolling is enabled", async () => {
  // A five-field form plus a keyboard does not fit a small phone. The hero
  // goes first, and scrolling is turned on so the lower fields stay
  // reachable — unreachable fields are a worse bug than a scroll bar.
  const listeners: Record<string, () => void> = {};
  jest.spyOn(Keyboard, "addListener").mockImplementation(((event: string, handler: () => void) => {
    listeners[event] = handler;
    return { remove: () => { /* nothing to detach in the stub */ } };
  }) as unknown as typeof Keyboard.addListener);

  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);
  expect(view.getByTestId("brand-hero")).toBeTruthy();

  const show = listeners["keyboardWillShow"] ?? listeners["keyboardDidShow"];
  expect(show).toBeDefined();
  // `act` still flushes the resulting state update; the callback itself is
  // synchronous, so it is not declared async.
  await act(() => { show?.(); });

  expect(view.queryByTestId("brand-hero")).toBeNull();
  expect(view.getByTestId("register-scroll").props.scrollEnabled).toBe(true);
});

test("on a short screen the hero is dropped rather than squashed, and the form still does not scroll", async () => {
  // An iPhone SE is 667pt tall and the form alone is ~605pt. A hero squeezed
  // into what is left renders as a broken-looking band, so it is omitted —
  // the form fitting without scrolling is what matters.
  jest.spyOn(Dimensions, "get").mockReturnValue({ width: 375, height: 667, scale: 2, fontScale: 1 });

  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);

  expect(view.queryByTestId("brand-hero")).toBeNull();
  expect(view.getByTestId("register-scroll").props.scrollEnabled).toBe(false);
  // Every field is still present — nothing was dropped to make room.
  for (const placeholder of ["First name", "Last name", "Email address", "Password", "Repeat password"]) {
    expect(view.getByPlaceholderText(placeholder)).toBeTruthy();
  }
  expect(view.getByTestId("create-account")).toBeTruthy();
});

// ═══════════════════════════════════════════════════════════════════════════
// The password rule belongs INSIDE the password field
// ═══════════════════════════════════════════════════════════════════════════
// As a sibling line it sat between Password and Repeat password and read as
// a gap in the form rather than as part of the field it describes.

test("the password rule renders inside the password field, not as a line between the two password inputs", async () => {
  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);

  const passwordField = view.getByTestId("password-field");
  // Scoped to the bordered container: a match anywhere else on screen — the
  // old sibling line included — would not satisfy this.
  expect(within(passwordField).getByText("At least 10 characters")).toBeTruthy();

  // And it is the only one, so it cannot also be rendering below the field.
  expect(view.getAllByText("At least 10 characters")).toHaveLength(1);

  // The input and the reveal control share that container, so "Show" stays
  // vertically balanced against both lines rather than against one.
  expect(within(passwordField).getByPlaceholderText("Password")).toBeTruthy();
  expect(within(passwordField).getByTestId("toggle-password-visibility")).toBeTruthy();

  // Repeat password is untouched: no helper of its own.
  expect(within(passwordField).queryByPlaceholderText("Repeat password")).toBeNull();
});

test("the rule reaches a screen reader through the input's own name, and is not announced twice", async () => {
  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);

  // Folded into the accessible name, so the requirement is heard while
  // focused on the box it applies to.
  expect(view.getByPlaceholderText("Password").props.accessibilityLabel)
    .toBe("Password. At least 10 characters");
  // The visible copy is hidden from assistive technology to avoid a repeat.
  expect(within(view.getByTestId("password-field")).getByText("At least 10 characters").props.accessible)
    .toBe(false);
});

test("a password error replaces the rule rather than stacking with it", async () => {
  const fetchSpy = jest.spyOn(globalThis, "fetch");
  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);

  await fillValidForm(view);
  await fireEvent.changeText(view.getByPlaceholderText("Password"), "short");
  await fireEvent.changeText(view.getByPlaceholderText("Repeat password"), "short");
  await pressSubmit(view);

  // The error text IS the rule, so exactly one copy must be on screen — the
  // inline helper steps aside rather than doubling it up.
  expect(view.getAllByText("At least 10 characters")).toHaveLength(1);
  expect(within(view.getByTestId("password-field")).queryByText("At least 10 characters")).toBeNull();
  expect(fetchSpy).not.toHaveBeenCalled();
});
