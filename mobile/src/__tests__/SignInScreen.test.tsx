/**
 * The Sign-in screen's BEHAVIOUR against a stubbed network.
 *
 * Deliberately not pixel assertions and deliberately no snapshot — a snapshot
 * of a screen proves it did not change, which is not the same as proving it
 * is right, and it goes stale on every spacing tweak. What is proven here is
 * what a driver would notice going wrong: a request carrying more than their
 * credentials, a rejected password reported as a connection problem, a
 * password written to disk, a hero that behaves differently from
 * Registration's.
 *
 * The backend remains the security authority — these cases prove the CLIENT
 * behaves, not that the server is safe.
 */
import { render, fireEvent, act } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import type { ReactElement } from "react";
import { StyleSheet, Keyboard, Dimensions, Text } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { SignInScreen } from "../screens/SignInScreen";
import { RegisterScreen } from "../screens/RegisterScreen";
import { MIN_HEIGHT_FOR_HERO, authStyles } from "../screens/authLayout";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AuthenticatedAccount } from "../api/account";

const EMAIL    = "driver@example.com";
const PASSWORD = "correct-horse-battery";

/** The server's frozen success body for a driver with no company (D21). */
const SUCCESS: AuthenticatedAccount = {
  user: { id: "user_1", firstName: "Nerijus", lastName: "Kuizinas", email: EMAIL },
  identityToken: "identity.token.value",
  refreshToken:  "refresh-secret-value",
  memberships:   [],
};

/** The API's one authentication failure (D17). */
const CANONICAL_401 = { error: "Not authenticated", code: "UNAUTHENTICATED" };

const METRICS = {
  frame:  { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

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

async function fillCredentials(view: View, email = EMAIL, password = PASSWORD) {
  await fireEvent.changeText(view.getByPlaceholderText("Email address"), email);
  await fireEvent.changeText(view.getByPlaceholderText("Password"), password);
}

async function pressSignIn(view: View) {
  await fireEvent.press(view.getByTestId("sign-in"));
}

const noop = () => { /* navigation is not under test here */ };

/**
 * A rendered element's resolved style.
 *
 * A host element's `props` is untyped, so the style is narrowed HERE once
 * rather than at four call sites — and narrowed to `ViewStyle`, so a typo in
 * an asserted property name is a compile error rather than a silent pass.
 */
function resolvedStyle(view: View, testID: string): ViewStyle {
  const style: unknown = view.getByTestId(testID).props.style;
  return StyleSheet.flatten(style as StyleProp<ViewStyle>) ?? {};
}

afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// The form
// ═══════════════════════════════════════════════════════════════════════════

test("the screen collects exactly two fields — no company, no driver number, no PIN", async () => {
  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);

  expect(view.getByPlaceholderText("Email address")).toBeTruthy();
  expect(view.getByPlaceholderText("Password")).toBeTruthy();
  expect(view.getByTestId("sign-in")).toBeTruthy();

  // Which company the driver is working for is a SEPARATE security event
  // (AUTH.md). Nothing here may ask for it.
  for (const absent of ["Company", "Company code", "Join code", "PIN", "Driver number", "Repeat password"]) {
    expect(view.queryByPlaceholderText(absent)).toBeNull();
  }
});

test("the heading is Registration's sibling, and the footer offers registration", async () => {
  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);

  expect(view.getByText("Welcome back")).toBeTruthy();
  expect(view.getByText("Sign in to your account")).toBeTruthy();
  expect(view.getByTestId("go-to-register")).toBeTruthy();
  expect(view.getByText("Create account")).toBeTruthy();
});

test("the password can be revealed and hidden", async () => {
  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);
  const password = view.getByPlaceholderText("Password");
  const toggle   = view.getByTestId("toggle-password-visibility");

  expect(password.props.secureTextEntry).toBe(true);
  await fireEvent.press(toggle);
  expect(view.getByPlaceholderText("Password").props.secureTextEntry).toBe(false);
  await fireEvent.press(toggle);
  expect(view.getByPlaceholderText("Password").props.secureTextEntry).toBe(true);
});

test("Registration's password RULE is NOT shown on sign-in", async () => {
  // "At least 10 characters" is guidance for CHOOSING a password. A driver
  // signing in already has one — possibly created under an older policy —
  // and showing them a rule their working password may not satisfy is both
  // alarming and wrong. The server does not apply the policy here either.
  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);

  expect(view.queryByText("At least 10 characters")).toBeNull();
  expect(view.queryByText(/at least \d+ characters/i)).toBeNull();
});

test("no Forgot password control exists, because password recovery does not", async () => {
  // A control that looks real and does nothing teaches a driver that sign-in
  // is broken rather than that recovery is unbuilt.
  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);

  expect(view.queryByText(/forgot/i)).toBeNull();
  expect(view.queryByText(/reset/i)).toBeNull();
  // Nor the reference mockup's uncontracted controls (D25).
  expect(view.queryByText(/keep me signed in/i)).toBeNull();
  expect(view.queryByText(/face id|touch id|biometric/i)).toBeNull();
});

test("an empty form is reported per field and never reaches the network", async () => {
  const fetchSpy = jest.spyOn(global, "fetch");
  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);

  await pressSignIn(view);

  expect(view.getByText("Enter your email address")).toBeTruthy();
  expect(view.getByText("Enter your password")).toBeTruthy();
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("a short password is NOT refused on the client — the policy governs new passwords only", async () => {
  // The client counterpart of the server decision. An account created before
  // D23's minimum must still be able to sign in, so this form must send a
  // six-character password rather than pre-empting the server with an error
  // the server would not have produced.
  const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(() => jsonResponse(401, CANONICAL_401));
  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);

  await fillCredentials(view, EMAIL, "short1");
  await pressSignIn(view);

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(view.queryByText("At least 10 characters")).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// What goes over the wire
// ═══════════════════════════════════════════════════════════════════════════

test("the request carries exactly email and password, with the password untrimmed", async () => {
  const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(() => jsonResponse(200, SUCCESS));
  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);

  await fillCredentials(view, "  Driver@Example.com  ", "  spaced password  ");
  await pressSignIn(view);

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  expect(url).toContain("/auth/login");
  const rawBody = init.body;
  expect(typeof rawBody).toBe("string");
  const body: unknown = JSON.parse(typeof rawBody === "string" ? rawBody : "{}");

  // `toEqual` on the WHOLE body is the guard: the server's DTO is `.strict()`,
  // so a third field would be refused outright, and building the body field by
  // field rather than spreading form state is what guarantees there is no third.
  expect(body).toEqual({
    // Trimmed here as a courtesy; the SERVER canonicalises (trim + lowercase)
    // and the database enforces it.
    email:    "Driver@Example.com",
    // NOT trimmed — whitespace is part of the credential (D23).
    password: "  spaced password  ",
  });
});

test("no company, membership or role authority is ever sent", async () => {
  const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(() => jsonResponse(200, SUCCESS));
  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);

  await fillCredentials(view);
  await pressSignIn(view);

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  const rawBody = init.body;
  expect(typeof rawBody).toBe("string");
  const raw = typeof rawBody === "string" ? rawBody : "";
  for (const forbidden of ["companyId", "membershipId", "company", "role", "userId", "sessionId", "memberships"]) {
    expect(raw).not.toContain(forbidden);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Failure
// ═══════════════════════════════════════════════════════════════════════════

test("a rejected credential produces ONE generic message that names neither half", async () => {
  jest.spyOn(global, "fetch").mockImplementation(() => jsonResponse(401, CANONICAL_401));
  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);

  await fillCredentials(view, EMAIL, "wrong-password");
  await pressSignIn(view);

  const error = view.getByTestId("form-error");
  expect(error).toBeTruthy();
  // The server answers an unknown email and a wrong password identically
  // (D17). The screen must not undo that by guessing which one it was.
  expect(view.queryByText(/no account|not registered|doesn't exist|does not exist/i)).toBeNull();
  expect(view.queryByText(/password is incorrect$/i)).toBeNull();
  expect(view.queryByText(/wrong password/i)).toBeNull();
  // And it must not surface the server's internal wording either.
  expect(view.queryByText("Not authenticated")).toBeNull();
  expect(view.queryByText("UNAUTHENTICATED")).toBeNull();
});

test("a network failure is reported as a connection problem, never as a rejected credential", async () => {
  // A driver in a yard with no signal must not be told their password is
  // wrong — the request never arrived.
  jest.spyOn(global, "fetch").mockImplementation(() => Promise.reject(new Error("Network request failed")));
  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);

  await fillCredentials(view);
  await pressSignIn(view);

  expect(view.getByTestId("form-error")).toBeTruthy();
  expect(view.getByText(/No connection/)).toBeTruthy();
  // Never dressed up as a server answer.
  expect(view.queryByText(/incorrect/i)).toBeNull();
});

test("the button shows a submitting state and a second tap does not sign in twice", async () => {
  let release: (value: Response) => void = () => { /* replaced below */ };
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(() => pending);
  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);

  await fillCredentials(view);
  await pressSignIn(view);

  expect(view.getByTestId("submitting-indicator")).toBeTruthy();
  expect(view.getByTestId("sign-in").props.accessibilityState).toMatchObject({ disabled: true, busy: true });

  await pressSignIn(view);
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  await act(async () => {
    release({ ok: true, status: 200, json: () => Promise.resolve(SUCCESS) } as Response);
    await pending;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Success, and what is persisted
// ═══════════════════════════════════════════════════════════════════════════

test("a successful ZERO-COMPANY sign-in enters authenticated state and stores ONLY the refresh secret", async () => {
  jest.spyOn(global, "fetch").mockImplementation(() => jsonResponse(200, SUCCESS));
  const setItem = jest.spyOn(SecureStore, "setItemAsync").mockResolvedValue(undefined);

  // The real provider, so this proves the SHARED transition registration
  // uses — not a login-only copy of it.
  function Probe() {
    const { signIn, isAuthenticated, account, identityToken } = useAuth();
    return (
      <>
        <SignInScreen onSignedIn={signIn} onCreateAccount={noop} />
        <Text testID="authenticated">{String(isAuthenticated)}</Text>
        <Text testID="companies">{String(account?.memberships.length ?? -1)}</Text>
        <Text testID="token-in-memory">{String(identityToken)}</Text>
      </>
    );
  }

  const view = await wrap(<AuthProvider><Probe /></AuthProvider>);
  await fillCredentials(view);
  await pressSignIn(view);

  expect(view.getByTestId("authenticated").props.children).toBe("true");
  // ZERO companies is a complete authenticated state, not an error (D21).
  expect(view.getByTestId("companies").props.children).toBe("0");
  // The identity token lives in memory, and is reachable for API calls.
  expect(view.getByTestId("token-in-memory").props.children).toBe(SUCCESS.identityToken);

  // Exactly ONE thing is persisted, and it is the refresh secret (D25).
  expect(setItem).toHaveBeenCalledTimes(1);
  const [key, value] = setItem.mock.calls[0] ?? [];
  expect(value).toBe(SUCCESS.refreshToken);
  expect(key).toBe("logisticbay.refreshToken");

  // Neither the short-lived token nor the password reaches storage.
  const persisted = setItem.mock.calls.map(call => String(call[1])).join("|");
  expect(persisted).not.toContain(SUCCESS.identityToken);
  expect(persisted).not.toContain(PASSWORD);
});

test("the Create account link is what navigates away — the screen does not route itself", async () => {
  const onCreateAccount = jest.fn();
  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={onCreateAccount} />);

  await fireEvent.press(view.getByTestId("go-to-register"));
  expect(onCreateAccount).toHaveBeenCalledTimes(1);
});

// ═══════════════════════════════════════════════════════════════════════════
// Layout — the same rules as Registration, from the same source
// ═══════════════════════════════════════════════════════════════════════════

test("the Login content block is VERTICALLY CENTRED in the white area above the hero", async () => {
  // The owner's correction, asserted as the layout MECHANIC responsible for
  // it rather than as a screen coordinate. The shared `form` container is
  // `flex: 1`, so it already owns every pixel of the white area above the
  // hero; a flex column defaults to `justifyContent: "flex-start"`, which is
  // why Login's three controls left all their slack UNDER the footer and the
  // form rode high. `justifyContent: "center"` splits that same slack above
  // and below the block.
  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);
  const form = resolvedStyle(view, "sign-in-form");

  expect(form).toMatchObject({
    // Owns the whole white area — this is what makes the centring relative to
    // the space above the hero rather than to the screen.
    flex: 1,
    // And distributes that area's free space evenly above and below.
    justifyContent: "center",
  });

  // Responsive by construction: NO absolute positioning, NO fixed offset, NO
  // transform, NO device-specific height. If any of these ever appeared, the
  // layout would stop adapting to screen height and this case would fail.
  expect(form).not.toHaveProperty("position", "absolute");
  expect(form).not.toHaveProperty("top");
  expect(form).not.toHaveProperty("bottom");
  expect(form).not.toHaveProperty("height");
  expect(form).not.toHaveProperty("minHeight");
  expect(form).not.toHaveProperty("marginTop");
  expect(form).not.toHaveProperty("transform");
});

test("REGISTRATION is NOT centred — the centring rule is Login-specific and did not leak into the shared layout", async () => {
  // The other half of the owner's constraint: Registration's approved layout
  // is authoritative and must keep its top-aligned block. Proven against the
  // SHARED style object as well as the rendered screen, so a future edit to
  // `authStyles.form` would fail here rather than silently re-centre the
  // approved screen.
  expect(StyleSheet.flatten(authStyles.form)).not.toHaveProperty("justifyContent");

  const view = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);
  const scroll = view.getByTestId("register-scroll");
  // Registration's form carries no testID, so the assertion above against the
  // shared style is what proves it; this confirms the screen still renders
  // under the unchanged scroll contract.
  expect(scroll.props.scrollEnabled).toBe(false);
  expect(StyleSheet.flatten(scroll.props.contentContainerStyle)).toMatchObject({ flexGrow: 1 });
});

test("with the keyboard up the centring is dropped and Login reverts to Registration's proven top-aligned layout", async () => {
  // Centring content that may be TALLER than its container inside a
  // ScrollView pushes the top of the form out of reach — worse than a high
  // form. With the keyboard up the hero is already gone and the space is
  // contested rather than spare, so the rule is switched off and the layout
  // is exactly the one Registration ships with.
  const listeners: Record<string, () => void> = {};
  jest.spyOn(Keyboard, "addListener").mockImplementation(((event: string, handler: () => void) => {
    listeners[event] = handler;
    return { remove: () => { /* nothing to detach in the stub */ } };
  }) as unknown as typeof Keyboard.addListener);

  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);
  expect(resolvedStyle(view, "sign-in-form")).toMatchObject({ justifyContent: "center" });

  const show = listeners["keyboardWillShow"] ?? listeners["keyboardDidShow"];
  expect(show).toBeDefined();
  await act(() => { show?.(); });

  const form = resolvedStyle(view, "sign-in-form");
  expect(form).not.toHaveProperty("justifyContent");
  // Identical to the shared layout, not merely similar.
  expect(form).toEqual(StyleSheet.flatten(authStyles.form));
  // And every control is still reachable through scrolling.
  expect(view.getByTestId("sign-in-scroll").props.scrollEnabled).toBe(true);
  expect(view.getByPlaceholderText("Email address")).toBeTruthy();
  expect(view.getByPlaceholderText("Password")).toBeTruthy();
  expect(view.getByTestId("sign-in")).toBeTruthy();
});

test("on a short screen the centring still applies and nothing is dropped from the form", async () => {
  jest.spyOn(Dimensions, "get").mockReturnValue({ width: 375, height: 667, scale: 2, fontScale: 1 });

  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);

  // The hero is gone (below the shared threshold), so the white area is the
  // whole screen — and the block is centred in it, by the same one rule.
  expect(view.queryByTestId("brand-hero")).toBeNull();
  expect(resolvedStyle(view, "sign-in-form")).toMatchObject({ justifyContent: "center" });
  expect(view.getByTestId("sign-in-scroll").props.scrollEnabled).toBe(false);
  expect(view.getByPlaceholderText("Email address")).toBeTruthy();
  expect(view.getByPlaceholderText("Password")).toBeTruthy();
  expect(view.getByTestId("sign-in")).toBeTruthy();
});

test("at rest the screen does not scroll in either direction, and the hero is shown", async () => {
  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);
  const scroll = view.getByTestId("sign-in-scroll");

  expect(scroll.props.scrollEnabled).toBe(false);
  expect(scroll.props.bounces).toBe(false);
  expect(scroll.props.alwaysBounceVertical).toBe(false);
  expect(scroll.props.alwaysBounceHorizontal).toBe(false);
  // Never horizontal: a horizontally scrolling form is always a layout bug.
  expect(scroll.props.horizontal).toBeFalsy();
  expect(StyleSheet.flatten(scroll.props.contentContainerStyle)).toMatchObject({ flexGrow: 1 });

  expect(view.getByTestId("brand-hero")).toBeTruthy();
});

test("Sign-in and Registration render the SAME hero component and the same asset", async () => {
  // Not "a hero that looks similar" — literally the same element, so the
  // asset, aspect ratio, resizeMode and edge treatment cannot diverge.
  const signIn   = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);
  const register = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);

  const signInHero   = signIn.getByTestId("brand-hero");
  const registerHero = register.getByTestId("brand-hero");

  expect(StyleSheet.flatten(signInHero.props.style)).toEqual(StyleSheet.flatten(registerHero.props.style));

  // The hero container holds exactly one child — the photograph — so these
  // cannot be comparing two different pictures by accident.
  expect(signInHero.children).toHaveLength(1);
  expect(registerHero.children).toHaveLength(1);

  const signInImage   = signInHero.children[0];
  const registerImage = registerHero.children[0];
  // A host element, not a text node — narrowed so the assertions below read
  // the element's props rather than a string.
  if (signInImage === undefined || typeof signInImage === "string") throw new Error("the sign-in hero must contain the photograph");
  if (registerImage === undefined || typeof registerImage === "string") throw new Error("the registration hero must contain the photograph");

  expect(signInImage.type).toBe("Image");
  expect(registerImage.type).toBe("Image");
  // The same asset, the same crop behaviour, the same absolute fill.
  expect(signInImage.props.source).toEqual(registerImage.props.source);
  expect(signInImage.props.resizeMode).toBe("cover");
  expect(registerImage.props.resizeMode).toBe("cover");
  expect(StyleSheet.flatten(signInImage.props.style)).toEqual(StyleSheet.flatten(registerImage.props.style));
});

test("the short-screen threshold is ONE source shared by both screens", async () => {
  // Just below the shared threshold: BOTH screens must drop the hero. If
  // either screen ever grew its own literal, this case would fail on that
  // screen alone.
  jest.spyOn(Dimensions, "get").mockReturnValue({
    width: 375, height: MIN_HEIGHT_FOR_HERO - 1, scale: 2, fontScale: 1,
  });

  const signIn   = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);
  const register = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);

  expect(signIn.queryByTestId("brand-hero")).toBeNull();
  expect(register.queryByTestId("brand-hero")).toBeNull();

  // The form still fits without scrolling — which is what actually matters.
  expect(signIn.getByTestId("sign-in-scroll").props.scrollEnabled).toBe(false);
  expect(signIn.getByPlaceholderText("Email address")).toBeTruthy();
  expect(signIn.getByPlaceholderText("Password")).toBeTruthy();
  expect(signIn.getByTestId("sign-in")).toBeTruthy();
});

test("on a concrete short phone (iPhone SE, 667pt) BOTH screens drop the hero", async () => {
  // Anchored to a REAL device height rather than to the constant, so this
  // case would fail if the shared threshold were ever changed — the cases
  // above are relative to `MIN_HEIGHT_FOR_HERO` and therefore prove the two
  // screens AGREE, not that the value itself is still right.
  jest.spyOn(Dimensions, "get").mockReturnValue({ width: 375, height: 667, scale: 2, fontScale: 1 });

  const signIn   = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);
  const register = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);

  expect(signIn.queryByTestId("brand-hero")).toBeNull();
  expect(register.queryByTestId("brand-hero")).toBeNull();
});

test("on a concrete tall phone (iPhone 14, 844pt) BOTH screens show the hero", async () => {
  jest.spyOn(Dimensions, "get").mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1 });

  const signIn   = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);
  const register = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);

  expect(signIn.getByTestId("brand-hero")).toBeTruthy();
  expect(register.getByTestId("brand-hero")).toBeTruthy();
});

test("at exactly the shared threshold BOTH screens still show the hero", async () => {
  // The boundary itself, so the comparison cannot silently become `>` on one
  // screen and `>=` on the other.
  jest.spyOn(Dimensions, "get").mockReturnValue({
    width: 375, height: MIN_HEIGHT_FOR_HERO, scale: 2, fontScale: 1,
  });

  const signIn   = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);
  const register = await wrap(<RegisterScreen onRegistered={noop} onSignIn={noop} />);

  expect(signIn.getByTestId("brand-hero")).toBeTruthy();
  expect(register.getByTestId("brand-hero")).toBeTruthy();
});

test("when the keyboard opens the hero yields its space and scrolling is enabled", async () => {
  const listeners: Record<string, () => void> = {};
  jest.spyOn(Keyboard, "addListener").mockImplementation(((event: string, handler: () => void) => {
    listeners[event] = handler;
    return { remove: () => { /* nothing to detach in the stub */ } };
  }) as unknown as typeof Keyboard.addListener);

  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);
  expect(view.getByTestId("brand-hero")).toBeTruthy();

  const show = listeners["keyboardWillShow"] ?? listeners["keyboardDidShow"];
  expect(show).toBeDefined();
  await act(() => { show?.(); });

  expect(view.queryByTestId("brand-hero")).toBeNull();
  expect(view.getByTestId("sign-in-scroll").props.scrollEnabled).toBe(true);
  // Every control stays present and reachable — unreachable fields are a
  // worse bug than a scroll bar.
  expect(view.getByPlaceholderText("Email address")).toBeTruthy();
  expect(view.getByPlaceholderText("Password")).toBeTruthy();
  expect(view.getByTestId("sign-in")).toBeTruthy();
});

// ═══════════════════════════════════════════════════════════════════════════
// The biometric secondary action (D26)
// ═══════════════════════════════════════════════════════════════════════════

test("no biometric control is rendered when the device is not eligible", async () => {
  // The common case: a phone that has never been signed in, or a driver who
  // declined. A "Sign in with Face ID" button that cannot work teaches the
  // driver the app is broken.
  const view = await wrap(<SignInScreen onSignedIn={noop} onCreateAccount={noop} />);

  expect(view.queryByTestId("biometric-unlock")).toBeNull();
  expect(view.queryByText(/face id|touch id|biometric/i)).toBeNull();
});

test("an eligible device shows the action, labelled for the ENROLLED method", async () => {
  const faceId = await wrap(
    <SignInScreen onSignedIn={noop} onCreateAccount={noop}
      biometricUnlock={{ label: "Face ID", unlock: () => Promise.resolve(true) }} />,
  );
  expect(faceId.getByTestId("biometric-unlock")).toBeTruthy();
  expect(faceId.getByText("Sign in with Face ID")).toBeTruthy();

  // Never hard-coded: an Android phone must not be offered Face ID.
  const generic = await wrap(
    <SignInScreen onSignedIn={noop} onCreateAccount={noop}
      biometricUnlock={{ label: "biometrics", unlock: () => Promise.resolve(true) }} />,
  );
  expect(generic.getByText("Sign in with biometrics")).toBeTruthy();
  expect(generic.queryByText(/face id/i)).toBeNull();
});

test("the biometric action delegates — the screen never authenticates anyone itself", async () => {
  // The screen holds no token and reaches no API. It asks the provider, which
  // gates on the OS and lets the SERVER decide (D26).
  const unlock = jest.fn(() => Promise.resolve(true));
  const onSignedIn = jest.fn();
  const fetchSpy = jest.spyOn(global, "fetch");

  const view = await wrap(
    <SignInScreen onSignedIn={onSignedIn} onCreateAccount={noop}
      biometricUnlock={{ label: "Face ID", unlock }} />,
  );
  await fireEvent.press(view.getByTestId("biometric-unlock"));

  expect(unlock).toHaveBeenCalledTimes(1);
  // It does NOT call the login endpoint, and does NOT invent a session.
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(onSignedIn).not.toHaveBeenCalled();
  expect(view.queryByTestId("form-error")).toBeNull();
});

test("a failed biometric leaves email and password fully usable", async () => {
  const unlock = jest.fn(() => Promise.resolve(false));
  const view = await wrap(
    <SignInScreen onSignedIn={noop} onCreateAccount={noop}
      biometricUnlock={{ label: "Touch ID", unlock }} />,
  );

  await fireEvent.press(view.getByTestId("biometric-unlock"));

  // One honest sentence that points at the fallback, and no hint about which
  // of cancel / mismatch / refused credential it was.
  expect(view.getByTestId("form-error")).toBeTruthy();
  expect(view.getByText(/Touch ID didn't work/)).toBeTruthy();

  // And the form still works — biometrics failing must never disable the
  // password path.
  const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(() => jsonResponse(200, SUCCESS));
  await fillCredentials(view);
  await pressSignIn(view);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [target] = fetchSpy.mock.calls[0] ?? [];
  expect(typeof target === "string" ? target : "").toContain("/auth/login");
});

test("adding the biometric action does NOT disturb the approved layout", async () => {
  // The owner's centring and the shared hero must survive the extra control.
  const view = await wrap(
    <SignInScreen onSignedIn={noop} onCreateAccount={noop}
      biometricUnlock={{ label: "Face ID", unlock: () => Promise.resolve(true) }} />,
  );

  expect(resolvedStyle(view, "sign-in-form")).toMatchObject({ flex: 1, justifyContent: "center" });
  expect(view.getByTestId("brand-hero")).toBeTruthy();
  const scroll = view.getByTestId("sign-in-scroll");
  expect(scroll.props.scrollEnabled).toBe(false);
  expect(scroll.props.horizontal).toBeFalsy();
});
