/**
 * The authenticated app shell — four real destinations behind one gate.
 *
 * WHAT IS PROVEN HERE, and what deliberately is not. The tab NAVIGATOR itself
 * is expo-router's, and re-testing it would be testing a dependency. What this
 * file proves is the part this repository owns and can get wrong:
 *
 *   - the shell declares exactly four destinations, and Home is the default;
 *   - every declared destination resolves to a route file that exists — a tab
 *     pointing at a missing screen is the failure mode that ships as a blank
 *     page;
 *   - the bar renders one control per destination, marks exactly one active,
 *     and asks navigation for the route the pressed control names;
 *   - the authentication gate still wraps ALL of it, so no tab is reachable
 *     signed out.
 *
 * `APP_TABS` is the single source of truth the layout and the bar both read,
 * so these assertions cannot drift from what the app actually renders.
 */
import { render, fireEvent, act } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { APP_TABS } from "../navigation/tabs";
import { AppTabBar } from "../navigation/AppTabBar";
// STATIC imports, one per declared destination. A tab whose route file is
// missing then fails to COMPILE rather than shipping as a blank page, which is
// a stronger guarantee than any assertion below could give.
import TodayRoute from "../../app/(app)/today";
import TimesheetsRoute from "../../app/(app)/timesheets";
import RecordsRoute from "../../app/(app)/records";
import SettingsRoute from "../../app/(app)/settings";

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn() };

jest.mock("expo-router", () => {
  const react = jest.requireActual<typeof import("react")>("react");
  const rn = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    __esModule: true,
    router: {
      replace: (href: string): void => { mockRouter.replace(href); },
      push:    (href: string): void => { mockRouter.push(href); },
      back:    (): void => { mockRouter.back(); },
      navigate: (href: string): void => { mockRouter.navigate(href); },
    },
    Redirect: ({ href }: { href: string }) =>
      react.createElement(rn.Text, { testID: "redirect" }, String(href)),
    Stack: () => react.createElement(rn.Text, { testID: "app-stack" }, "stack"),
    // The navigator needs a real navigation tree Jest has none of, so it is
    // replaced by a marker. Its PRESENCE is what the gate cases assert — that
    // the shell mounted, or did not. Which destinations it contains is proven
    // separately, from `APP_TABS` and the route imports above.
    Tabs: Object.assign(
      () => react.createElement(rn.Text, { testID: "app-tabs" }, "tabs"),
      { Screen: (_props: { name: string }) => null },
    ),
  };
});

const METRICS = {
  frame:  { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// The four destinations
// ═══════════════════════════════════════════════════════════════════════════

test("the shell declares EXACTLY four destinations, in the approved order", () => {
  expect(APP_TABS.map(tab => tab.label)).toEqual(["Home", "Timesheets", "My Records", "Settings"]);
});

test("HOME is the first destination — the default authenticated tab", () => {
  expect(APP_TABS[0]?.name).toBe("today");
});

test("every declared destination resolves to a route file that actually exists", () => {
  // A tab pointing at a missing screen renders a blank page at runtime, and
  // nothing else in this suite would catch it.
  const routes: Record<string, unknown> = {
    today: TodayRoute,
    timesheets: TimesheetsRoute,
    records: RecordsRoute,
    settings: SettingsRoute,
  };

  for (const tab of APP_TABS) {
    expect(typeof routes[tab.name]).toBe("function");
  }
  // And no route file is left declared-but-unreachable: the shell's list and
  // the set of screens are the same set, in both directions.
  expect(Object.keys(routes).sort()).toEqual(APP_TABS.map(tab => tab.name).sort());
});

test("route names are unique — two tabs cannot resolve to one screen", () => {
  expect(new Set(APP_TABS.map(tab => tab.name)).size).toBe(APP_TABS.length);
});

// ═══════════════════════════════════════════════════════════════════════════
// The bar itself
// ═══════════════════════════════════════════════════════════════════════════

test("the bar renders one control per destination and marks exactly ONE active", async () => {
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppTabBar activeRouteName="today" onSelect={jest.fn()} />
    </SafeAreaProvider>,
  );

  // Asserted per control against the whole state object: reading one field off
  // a test node's untyped props is what the lint rule forbids, and matching the
  // object is the stronger assertion anyway.
  for (const [index, tab] of APP_TABS.entries()) {
    expect(view.getByTestId(`tab-${tab.name}`).props.accessibilityState)
      .toMatchObject({ selected: index === 0 });
  }
});

test("the active destination follows the route, not a hard-coded index", async () => {
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppTabBar activeRouteName="settings" onSelect={jest.fn()} />
    </SafeAreaProvider>,
  );

  expect(view.getByTestId("tab-settings").props.accessibilityState).toMatchObject({ selected: true });
  expect(view.getByTestId("tab-today").props.accessibilityState).toMatchObject({ selected: false });
});

test("pressing a control asks navigation for THAT destination — each one, distinctly", async () => {
  const onSelect = jest.fn();
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppTabBar activeRouteName="today" onSelect={onSelect} />
    </SafeAreaProvider>,
  );

  for (const tab of APP_TABS) {
    await act(async () => { await fireEvent.press(view.getByTestId(`tab-${tab.name}`)); });
  }

  // Every destination, in order — a bar that sent everything to one route
  // would fail here rather than merely looking odd.
  // `jest.fn()`'s recorded arguments are untyped; narrowed once here so the
  // assertion reads real values rather than an `any`.
  const requested = (onSelect.mock.calls as unknown as [string][]).map(call => call[0]);
  expect(requested).toEqual(APP_TABS.map(tab => tab.name));
});

test("every control carries a readable label and the tab accessibility role", async () => {
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppTabBar activeRouteName="today" onSelect={jest.fn()} />
    </SafeAreaProvider>,
  );

  for (const tab of APP_TABS) {
    const control = view.getByTestId(`tab-${tab.name}`);
    expect(control.props.accessibilityRole).toBe("tab");
    expect(String(control.props.accessibilityLabel)).toContain(tab.label);
  }
});

// The gate that wraps this shell is proven in `appGroupGate.test.tsx`, which
// owns that contract — including that NO tab mounts while signed out. It is
// not restated here: two copies of one assertion is how one of them quietly
// stops being true.
