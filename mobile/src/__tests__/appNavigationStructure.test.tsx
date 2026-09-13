/**
 * The SHAPE of the authenticated navigation tree.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION. Start Shift must not show the tab
 * bar — not because a bar looks wrong on it, but because a driver halfway
 * through a part-filled shift form must not be able to leave it by tapping
 * Timesheets. "Don't put it in the tab navigator" is exactly the kind of rule
 * that gets forgotten the week after it is written, so the tree is asserted
 * instead: what is registered as a TAB, and what is registered as a STACK
 * screen beside the tabs.
 *
 * The expo-router navigators are replaced by mocks that RECORD the `name` of
 * every screen declared under them. That is what makes this structural rather
 * than cosmetic — it fails if Start Shift is moved back inside the tabs, even
 * if the bar happens to be hidden by some other means.
 *
 * Hiding the bar with a style, a route-name check, or a conditional render
 * would leave Start Shift a tab route and would pass no assertion here.
 */
import { render, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import type { ReactElement } from "react";
import { AuthProvider } from "../auth/AuthContext";
import { APP_TABS } from "../navigation/tabs";
import AppLayout from "../../app/(app)/_layout";
import TabsLayout from "../../app/(app)/(tabs)/_layout";

/** Every screen name declared under each navigator during a render. */
const registered = { tabs: [] as string[], stack: [] as string[] };

jest.mock("expo-router", () => {
  const react = jest.requireActual<typeof import("react")>("react");
  const rn = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    __esModule: true,
    router: { replace: (): void => { /* unused */ }, push: (): void => { /* unused */ }, back: (): void => { /* unused */ }, navigate: (): void => { /* unused */ } },
    Redirect: ({ href }: { href: string }) =>
      react.createElement(rn.Text, { testID: "redirect" }, String(href)),
    // Both navigators RENDER their children, so the `Screen` declarations
    // inside them actually execute and record themselves.
    Tabs: Object.assign(
      ({ children }: { children?: React.ReactNode }) =>
        react.createElement(rn.View, { testID: "app-tabs" }, children),
      { Screen: ({ name }: { name: string }) => { registered.tabs.push(name); return null; } },
    ),
    Stack: Object.assign(
      ({ children }: { children?: React.ReactNode }) =>
        react.createElement(rn.View, { testID: "app-stack" }, children),
      { Screen: ({ name }: { name: string }) => { registered.stack.push(name); return null; } },
    ),
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

function happyNetwork() {
  return jest.spyOn(global, "fetch").mockImplementation(((input: string) => {
    const url = String(input);
    if (url.includes("/auth/refresh")) return jsonResponse(200, CREDENTIALS);
    if (url.includes("/auth/me")) return jsonResponse(200, ACCOUNT);
    throw new Error(`unexpected request to ${url}`);
  }) as unknown as typeof fetch);
}

/** The gate only renders the tree once the session is restored. */
async function authenticated(node: ReactElement): Promise<View> {
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  happyNetwork();
  const view = await wrap(node);
  await waitFor(() => { expect(view.queryByTestId("redirect")).toBeNull(); });
  return view;
}

beforeEach(() => { registered.tabs = []; registered.stack = []; });
afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// The tab navigator holds the four everyday destinations — and only those
// ═══════════════════════════════════════════════════════════════════════════

test("EXACTLY the four app tabs are registered as tabs", async () => {
  await authenticated(<TabsLayout />);

  expect(registered.tabs).toEqual(APP_TABS.map(tab => tab.name));
  expect(registered.tabs).toHaveLength(4);
});

test("Start Shift is NOT a tab route — it cannot be reached from the bar", async () => {
  await authenticated(<TabsLayout />);

  // The load-bearing assertion. Registered as a tab, Start Shift would sit
  // inside the tab navigator and keep the bar, however it were styled.
  expect(registered.tabs).not.toContain("start-shift");
});

// ═══════════════════════════════════════════════════════════════════════════
// The workflow is a Stack sibling of the whole tab group
// ═══════════════════════════════════════════════════════════════════════════

test("the authenticated area is a STACK, with the tabs and Start Shift as siblings", async () => {
  const view = await authenticated(<AppLayout />);

  await waitFor(() => { expect(view.queryByTestId("app-stack")).not.toBeNull(); });
  // The tab group is one entry in the stack; the workflow is another beside
  // it, which is what puts it outside the tab navigator entirely.
  expect(registered.stack).toContain("(tabs)");
  expect(registered.stack).toContain("start-shift");
});

test("the authenticated area does NOT mount the tab navigator directly", async () => {
  const view = await authenticated(<AppLayout />);

  // Before this restructure the gate rendered `Tabs` itself, which is why
  // every route under it — Start Shift included — was a tab child.
  expect(view.queryByTestId("app-tabs")).toBeNull();
  expect(registered.tabs).toHaveLength(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// The gate still wraps everything — the restructure must not move it
// ═══════════════════════════════════════════════════════════════════════════

test("UNAUTHENTICATED: neither the stack nor any tab is mounted", async () => {
  happyNetwork();

  const view = await wrap(<AppLayout />);

  await waitFor(() => { expect(view.queryByTestId("redirect")).not.toBeNull(); });
  expect(String(view.getByTestId("redirect").props.children)).toBe("/sign-in");
  expect(view.queryByTestId("app-stack")).toBeNull();
  expect(registered.stack).toHaveLength(0);
});

test("RESTORING: the gate holds above the stack, so nothing flashes", async () => {
  await SecureStore.setItemAsync(REFRESH_KEY, STORED_SECRET);
  jest.spyOn(global, "fetch").mockImplementation(((input: string) => {
    if (String(input).includes("/auth/refresh")) return new Promise<Response>(() => { /* never resolves */ });
    throw new Error("unexpected request");
  }) as unknown as typeof fetch);

  const view = await wrap(<AppLayout />);

  expect(view.getByTestId("auth-restoring")).toBeTruthy();
  expect(view.queryByTestId("app-stack")).toBeNull();
  expect(view.queryByTestId("redirect")).toBeNull();
});
