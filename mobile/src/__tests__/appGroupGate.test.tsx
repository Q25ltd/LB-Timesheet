/**
 * The authenticated route group's gate — `app/(app)/_layout.tsx`.
 *
 * THE DEFECT THIS CLOSES. Before this layout existed, `app/index.tsx` was the
 * only place authentication decided anything, and it guards `/` alone. The
 * app declares `"scheme": "lbtimesheets"` (app.json), so `lbtimesheets://today`
 * opened while signed out mounted the authenticated screen directly. It had no
 * account to render, so it showed a "Signing you in…" placeholder that never
 * signed anyone in and never navigated — a dead end with no way forward and no
 * way back.
 *
 * The fix is structural rather than per-screen on purpose: every future screen
 * added under `(app)` inherits this gate without its author remembering
 * anything, which is the same polarity the API's default-deny route hook has
 * (F-10, D16 — prevention over instruction).
 *
 * WHY `restoring` GETS ITS OWN CASE. A refresh credential is redeemed over the
 * network at startup. Treating that moment as "not authenticated" would send a
 * signed-in driver to the password form and then bounce them to Home — the
 * exact flash `app/index.tsx` already holds for. A gate that got this wrong
 * would log people out for having slow signal.
 */
import { render, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import type { ReactElement } from "react";
import { AuthProvider } from "../auth/AuthContext";
import AppLayout from "../../app/(app)/_layout";

jest.mock("expo-router", () => {
  const react = jest.requireActual<typeof import("react")>("react");
  const rn = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    __esModule: true,
    router: { replace: (): void => { /* unused here */ }, push: (): void => { /* unused */ }, back: (): void => { /* unused */ } },
    // Both render their outcome into the tree, so every assertion below reads
    // the rendered result rather than a side effect a double render could
    // duplicate.
    Redirect: ({ href }: { href: string }) =>
      react.createElement(rn.Text, { testID: "redirect" }, String(href)),
    Stack: () => react.createElement(rn.Text, { testID: "app-stack" }, "stack"),
  };
});

const REFRESH_KEY = "logisticbay.refreshToken";
const STORED_SECRET = "stored-refresh-secret";

const CREDENTIALS = { identityToken: "fresh.identity.token", refreshToken: "rotated-refresh-secret" };
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

function happyNetwork(overrides: { refresh?: () => Promise<Response> } = {}) {
  return jest.spyOn(global, "fetch").mockImplementation(((input: string) => {
    const url = String(input);
    if (url.includes("/auth/refresh")) return (overrides.refresh ?? (() => jsonResponse(200, CREDENTIALS)))();
    if (url.includes("/auth/me")) return jsonResponse(200, ACCOUNT);
    throw new Error(`unexpected request to ${url}`);
  }) as unknown as typeof fetch);
}

afterEach(() => { jest.restoreAllMocks(); });

test("UNAUTHENTICATED: a direct hit on an authenticated route redirects to sign-in", async () => {
  // No stored credential — a signed-out phone opening `lbtimesheets://today`.
  happyNetwork();

  const view = await wrap(<AppLayout />);

  await waitFor(() => { expect(view.queryByTestId("redirect")).not.toBeNull(); });
  expect(String(view.getByTestId("redirect").props.children)).toBe("/sign-in");
  // And crucially the authenticated tree is NOT rendered behind the redirect.
  expect(view.queryByTestId("app-stack")).toBeNull();
});

test("UNAUTHENTICATED: the driver is never left on a placeholder that cannot proceed", async () => {
  // The precise shape of the old defect: a hold state with no exit. Whatever
  // the gate renders when signed out, it must be a redirect — not a spinner.
  happyNetwork();

  const view = await wrap(<AppLayout />);

  await waitFor(() => { expect(view.queryByTestId("redirect")).not.toBeNull(); });
  expect(view.queryByTestId("auth-restoring")).toBeNull();
});

test("RESTORING: the gate HOLDS — it does not redirect a driver whose session is still loading", async () => {
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  // A refresh that never settles, so the restoring frame can be observed.
  happyNetwork({ refresh: () => new Promise<Response>(() => { /* never resolves */ }) });

  const view = await wrap(<AppLayout />);

  expect(view.getByTestId("auth-restoring")).toBeTruthy();
  // No redirect AND no authenticated tree: the gate has not decided yet, and
  // deciding early in either direction is the bug.
  expect(view.queryByTestId("redirect")).toBeNull();
  expect(view.queryByTestId("app-stack")).toBeNull();
});

test("AUTHENTICATED: a restored session renders the authenticated routes, with no redirect", async () => {
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  happyNetwork();

  const view = await wrap(<AppLayout />);

  await waitFor(() => { expect(view.queryByTestId("app-stack")).not.toBeNull(); });
  expect(view.queryByTestId("redirect")).toBeNull();
  expect(view.queryByTestId("auth-restoring")).toBeNull();
});

test("a REFUSED credential ends at sign-in rather than inside the authenticated group", async () => {
  // The server rejects the stored secret: it is deleted and the driver must
  // sign in. The gate must follow the provider, not the stored credential.
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  jest.spyOn(global, "fetch").mockImplementation(((input: string) => {
    const url = String(input);
    if (url.includes("/auth/refresh")) return jsonResponse(401, { error: "Not authenticated", code: "UNAUTHENTICATED" });
    throw new Error(`unexpected request to ${url}`);
  }) as unknown as typeof fetch);

  const view = await wrap(<AppLayout />);

  await waitFor(() => { expect(view.queryByTestId("redirect")).not.toBeNull(); });
  expect(String(view.getByTestId("redirect").props.children)).toBe("/sign-in");
  expect(view.queryByTestId("app-stack")).toBeNull();
});
