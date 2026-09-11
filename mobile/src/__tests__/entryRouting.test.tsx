/**
 * The signed-out entry route, and the two auth screens' navigation.
 *
 * Owner decision, 2026-09-11: a signed-out launch resolves to SIGN-IN, not
 * registration. A person registers once and signs in every day after that, so
 * registration was the wrong default the moment login existed.
 *
 * WHY THESE CASES PROVE COLD START rather than navigation history:
 * `app/index.tsx` is what `/` resolves to, and it decides by reading
 * `isAuthenticated` during render. Each case below mounts a FRESH
 * `AuthProvider` — whose initial state is `account: null` — and renders
 * `Index` as the first and only screen. That is exactly the cold-start
 * condition: no prior screen, no history, no stored state (session
 * restoration does not exist yet, so a process start is always signed out).
 * The first case asserts the fresh-provider precondition explicitly, so the
 * others cannot pass by accident on a provider that was already populated.
 *
 * `expo-router` is mocked at the module boundary — it needs a real navigation
 * tree and native context that Jest has none of. `Redirect` is replaced by
 * something that RENDERS its `href`, so the destination is asserted from the
 * tree rather than from a side effect that a double render could duplicate.
 */
import { render, fireEvent } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { ReactElement } from "react";
import { Text, Pressable } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AuthenticatedAccount } from "../api/account";
// The three route files under test. `jest.mock("expo-router")` below is
// hoisted above these imports, so each one resolves the router to the mock.
import Index from "../../app/index";
import SignInRoute from "../../app/(auth)/sign-in";
import RegisterRoute from "../../app/(auth)/register";

// The `mock` prefix is required: Jest hoists mock factories above the file's
// own declarations and rejects out-of-scope references without it.
const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn() };

jest.mock("expo-router", () => {
  // `requireActual` INSIDE the factory: the hoisted factory runs before this
  // file's own imports are evaluated, so nothing imported above is available.
  const react = jest.requireActual<typeof import("react")>("react");
  const rn = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    __esModule: true,
    // The methods DELEGATE rather than being `mockRouter` itself. The factory
    // runs at first require — which is when the route files above are loaded,
    // before `const mockRouter` has been evaluated — so handing over the
    // object directly would freeze `router: undefined` into the registry.
    // These arrows only dereference it when a route actually navigates.
    // Statement bodies, not expression bodies: `jest.fn()` returns `any`, and
    // returning it would hand an untyped value back to production code.
    router: {
      replace: (href: string): void => { mockRouter.replace(href); },
      push:    (href: string): void => { mockRouter.push(href); },
      back:    (): void => { mockRouter.back(); },
    },
    Redirect: ({ href }: { href: string }) =>
      react.createElement(rn.Text, { testID: "redirect" }, String(href)),
  };
});


const SUCCESS: AuthenticatedAccount = {
  user: { id: "user_1", firstName: "Nerijus", lastName: "Kuizinas", email: "driver@example.com" },
  identityToken: "identity.token.value",
  refreshToken:  "refresh-secret-value",
  memberships:   [],
};

const METRICS = {
  frame:  { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

type View = Awaited<ReturnType<typeof render>>;

/** A FRESH provider every time — this is what makes each case a cold start. */
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

function redirectHref(view: View): string {
  return String(view.getByTestId("redirect").props.children);
}

afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// The signed-out default route
// ═══════════════════════════════════════════════════════════════════════════

test("a fresh AuthProvider is unauthenticated — the precondition every cold-start case below depends on", async () => {
  // Asserted separately so the redirect cases cannot pass against a provider
  // that happened to be populated. Session restore does not exist, so this is
  // the real state of every process start.
  function Probe() {
    const { isAuthenticated, account, identityToken } = useAuth();
    return (
      <>
        <Text testID="authenticated">{String(isAuthenticated)}</Text>
        {/* The FACT, not a stringified object: an object's default
            stringification says nothing and lints as a mistake. */}
        <Text testID="account-is-null">{String(account === null)}</Text>
        <Text testID="token">{String(identityToken)}</Text>
      </>
    );
  }

  const view = await wrap(<Probe />);
  expect(view.getByTestId("authenticated").props.children).toBe("false");
  expect(view.getByTestId("account-is-null").props.children).toBe("true");
  expect(view.getByTestId("token").props.children).toBe("null");
});

test("COLD START, signed out: the app entry resolves to /sign-in, NOT /register", async () => {
  const view = await wrap(<Index />);

  expect(redirectHref(view)).toBe("/sign-in");
  // Stated as its own expectation because this is the behaviour the owner
  // rejected on the phone: registration must not be the first screen a
  // signed-out driver sees.
  expect(redirectHref(view)).not.toBe("/register");
});

test("COLD START, authenticated: the app entry resolves to /today and never renders sign-in on the way", async () => {
  // `isAuthenticated` is read synchronously during render, so an authenticated
  // provider redirects straight to the app — there is no intermediate sign-in
  // frame to flash.
  function Probe() {
    const { signIn } = useAuth();
    return (
      <>
        <Index />
        <Pressable testID="authenticate" onPress={() => { void signIn(SUCCESS); }}>
          <Text>authenticate</Text>
        </Pressable>
      </>
    );
  }

  const view = await wrap(<Probe />);
  expect(redirectHref(view)).toBe("/sign-in");

  await fireEvent.press(view.getByTestId("authenticate"));

  expect(redirectHref(view)).toBe("/today");
  // Zero memberships is a complete authenticated state — the entry must not
  // branch on having a company (D21).
  expect(SUCCESS.memberships).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Sign-in ↔ Registration
// ═══════════════════════════════════════════════════════════════════════════

test("Sign-in → Create account resolves to /register, by REPLACEMENT not a push", async () => {
  const view = await wrap(<SignInRoute />);

  await fireEvent.press(view.getByTestId("go-to-register"));

  expect(mockRouter.replace).toHaveBeenCalledWith("/register");
  // Replacement, so the stack never holds both auth screens and a back
  // gesture cannot cycle between them.
  expect(mockRouter.push).not.toHaveBeenCalled();
});

test("Registration → Sign in resolves to /sign-in, by REPLACEMENT not a push", async () => {
  const view = await wrap(<RegisterRoute />);

  await fireEvent.press(view.getByTestId("go-to-sign-in"));

  expect(mockRouter.replace).toHaveBeenCalledWith("/sign-in");
  expect(mockRouter.push).not.toHaveBeenCalled();
});

// ═══════════════════════════════════════════════════════════════════════════
// Both entry points land in the same authenticated place
// ═══════════════════════════════════════════════════════════════════════════

test("a successful sign-in navigates to /today", async () => {
  jest.spyOn(global, "fetch").mockImplementation(() => jsonResponse(200, SUCCESS));

  const view = await wrap(<SignInRoute />);
  await fireEvent.changeText(view.getByPlaceholderText("Email address"), "driver@example.com");
  await fireEvent.changeText(view.getByPlaceholderText("Password"), "correct-horse-battery");
  await fireEvent.press(view.getByTestId("sign-in"));

  expect(mockRouter.replace).toHaveBeenCalledWith("/today");
});

test("a successful registration still navigates to /today — unchanged by the new default route", async () => {
  jest.spyOn(global, "fetch").mockImplementation(() => jsonResponse(201, SUCCESS));

  const view = await wrap(<RegisterRoute />);
  await fireEvent.changeText(view.getByPlaceholderText("First name"), "Nerijus");
  await fireEvent.changeText(view.getByPlaceholderText("Last name"), "Kuizinas");
  await fireEvent.changeText(view.getByPlaceholderText("Email address"), "driver@example.com");
  await fireEvent.changeText(view.getByPlaceholderText("Password"), "correct-horse-battery");
  await fireEvent.changeText(view.getByPlaceholderText("Repeat password"), "correct-horse-battery");
  await fireEvent.press(view.getByTestId("create-account"));

  expect(mockRouter.replace).toHaveBeenCalledWith("/today");
});
