/**
 * The two destinations whose features are not built yet — Timesheets and My
 * Records — and Settings, whose features are.
 *
 * THE RULE THESE CASES ENFORCE. An unfinished destination is allowed to be a
 * designed page that says the feature is being built. It is NOT allowed to
 * show a specimen of the thing it will one day show. The difference is the
 * whole point: a driver who sees three plausible timesheet rows will believe
 * they exist, and no amount of "demo data" labelling survives a glance at
 * 5am.
 *
 * So each landing page is asserted twice — once that it renders real,
 * intentional content, and once that it contains none of the data it is a
 * placeholder FOR. The second half is the load-bearing one.
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import * as LocalAuthentication from "expo-local-authentication";
import type { ReactElement } from "react";
import { Text, Pressable } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AuthenticatedAccount } from "../api/account";
import Timesheets from "../../app/(app)/(tabs)/timesheets";
import Records from "../../app/(app)/(tabs)/records";
import Settings from "../../app/(app)/(tabs)/settings";
import manifest from "../../package.json";

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

const DRIVER: AuthenticatedAccount = {
  user: { id: "user_1", firstName: "Nerijus", lastName: "Kuizinas", email: "nerijus@example.com" },
  identityToken: "identity.token.one",
  refreshToken:  "refresh-secret-one",
  memberships:   [],
};

const OTHER: AuthenticatedAccount = {
  user: { id: "user_2", firstName: "Aisha", lastName: "Okonkwo", email: "aisha@example.com" },
  identityToken: "identity.token.two",
  refreshToken:  "refresh-secret-two",
  memberships:   [],
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

function text(view: View, testID: string): string {
  return String(view.getByTestId(testID).props.children);
}

/** The whole rendered tree, lower-cased — copy, testIDs and labels alike. */
function allText(view: View): string {
  return JSON.stringify(view.toJSON()).toLowerCase();
}

/**
 * Every rendered NUMBER on the page.
 *
 * Matched against rendered text rather than the serialised tree: a tree's JSON
 * is full of style values, so a digit found there would prove nothing. A
 * specimen timesheet row or a fabricated statistic has to put a date, a time,
 * a distance or a total on screen — so "no number is rendered" is the
 * assertion that an invented record cannot survive.
 */
function renderedNumbers(view: View) {
  return view.queryAllByText(/\d/);
}

async function signedIn(node: ReactElement, account: AuthenticatedAccount = DRIVER): Promise<View> {
  function Harness() {
    const { signIn, status } = useAuth();
    return (
      <>
        <Text testID="status">{status}</Text>
        <Pressable testID="authenticate" onPress={() => { void signIn(account); }}>
          <Text>authenticate</Text>
        </Pressable>
        {node}
      </>
    );
  }

  const view = await wrap(<Harness />);
  await waitFor(() => { expect(text(view, "status")).toBe("unauthenticated"); });
  await act(async () => { await fireEvent.press(view.getByTestId("authenticate")); });
  await waitFor(() => { expect(text(view, "status")).toBe("authenticated"); });
  return view;
}

function faceIdCapable() {
  jest.mocked(LocalAuthentication.hasHardwareAsync).mockResolvedValue(true);
  jest.mocked(LocalAuthentication.isEnrolledAsync).mockResolvedValue(true);
  jest.mocked(LocalAuthentication.supportedAuthenticationTypesAsync)
    .mockResolvedValue([LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION]);
}

afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// Timesheets — a real page, and provably no specimen history
// ═══════════════════════════════════════════════════════════════════════════

test("Timesheets renders a real, titled page rather than an error or a blank", async () => {
  const view = await signedIn(<Timesheets />);

  expect(text(view, "screen-title")).toBe("Timesheets");
  expect(view.getByTestId("timesheets-empty")).toBeTruthy();
});

test("Timesheets fabricates NO history — no rows, no statuses, no dates, no distances", async () => {
  const view = await signedIn(<Timesheets />);
  const rendered = allText(view);

  expect(rendered).not.toContain("submitted");
  expect(rendered).not.toContain("miles");
  expect(rendered).not.toContain("view all");
  // A specimen row would have to carry a number somewhere — a date, a time or
  // a distance. The honest page carries none.
  expect(renderedNumbers(view)).toEqual([]);
});

test("Timesheets makes no network request — there is no history endpoint to call", async () => {
  const fetchSpy = jest.spyOn(global, "fetch");
  await signedIn(<Timesheets />);
  expect(fetchSpy).not.toHaveBeenCalled();
});

// ═══════════════════════════════════════════════════════════════════════════
// My Records — the driver's private diary, equally unbuilt
// ═══════════════════════════════════════════════════════════════════════════

test("My Records renders a real, titled page", async () => {
  const view = await signedIn(<Records />);

  expect(text(view, "screen-title")).toBe("My Records");
  expect(view.getByTestId("records-empty")).toBeTruthy();
});

test("My Records fabricates NO statistics — no hours, no pay, no distance, no POA", async () => {
  const view = await signedIn(<Records />);
  const rendered = allText(view);

  for (const invented of ["hrs", "hours worked", "£", "poa", "miles", "earnings", "average"]) {
    expect(rendered).not.toContain(invented);
  }
  expect(renderedNumbers(view)).toEqual([]);
});

test("My Records reads nothing — there is no personal store to read (D25)", async () => {
  const fetchSpy = jest.spyOn(global, "fetch");

  await signedIn(<Records />);

  expect(fetchSpy).not.toHaveBeenCalled();
});

test("no local database dependency was added to reach My Records", () => {
  // D25: "No SQLite yet. It arrives with local Personal Timesheets / offline
  // operational data and not before." A landing page must not be the reason a
  // persistence engine enters the bundle.
  const declared = Object.keys(manifest.dependencies);

  expect(declared.filter(name => name.toLowerCase().includes("sqlite"))).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Settings — real account data, real controls
// ═══════════════════════════════════════════════════════════════════════════

test("Settings shows the REAL authenticated account, not a fixed one", async () => {
  const first = await signedIn(<Settings />, DRIVER);
  expect(text(first, "account-name")).toBe("Nerijus Kuizinas");
  expect(text(first, "account-email")).toBe("nerijus@example.com");

  const second = await signedIn(<Settings />, OTHER);
  expect(text(second, "account-name")).toBe("Aisha Okonkwo");
  expect(text(second, "account-email")).toBe("aisha@example.com");
});

test("Settings states honestly that a device without biometrics has none", async () => {
  // The default mocked device has no biometric hardware (jest.setup.js).
  const view = await signedIn(<Settings />);

  expect(view.getByTestId("biometric-unavailable")).toBeTruthy();
  expect(view.queryByTestId("biometric-toggle")).toBeNull();
});

test("on a capable device Settings offers the real toggle, named for the enrolled method", async () => {
  faceIdCapable();
  const view = await signedIn(<Settings />);

  await waitFor(() => { expect(view.queryByTestId("biometric-toggle")).not.toBeNull(); });
  expect(allText(view)).toContain("face id");
});

test("turning biometric unlock ON goes through the provider, which prompts and persists", async () => {
  faceIdCapable();
  jest.mocked(LocalAuthentication.authenticateAsync).mockResolvedValue({ success: true });

  const view = await signedIn(<Settings />);
  await waitFor(() => { expect(view.queryByTestId("biometric-toggle")).not.toBeNull(); });

  await act(async () => { await fireEvent.press(view.getByTestId("biometric-toggle")); });

  // The OS was asked, and the preference reached SecureStore — the existing
  // contract, reached through the existing provider method (D26).
  await waitFor(async () => {
    await expect(SecureStore.getItemAsync(BIOMETRIC_KEY)).resolves.toBe("enabled");
  });
  expect(LocalAuthentication.authenticateAsync).toHaveBeenCalled();
});

test("a REFUSED prompt leaves biometric unlock off — the toggle does not lie", async () => {
  faceIdCapable();
  jest.mocked(LocalAuthentication.authenticateAsync).mockResolvedValue({ success: false, error: "user_cancel" });

  const view = await signedIn(<Settings />);
  await waitFor(() => { expect(view.queryByTestId("biometric-toggle")).not.toBeNull(); });

  await act(async () => { await fireEvent.press(view.getByTestId("biometric-toggle")); });

  await expect(SecureStore.getItemAsync(BIOMETRIC_KEY)).resolves.toBeNull();
  expect(view.getByTestId("biometric-toggle").props.accessibilityState).toMatchObject({ checked: false });
});

test("turning it OFF clears the stored preference", async () => {
  faceIdCapable();
  jest.mocked(LocalAuthentication.authenticateAsync).mockResolvedValue({ success: true });

  const view = await signedIn(<Settings />);
  await waitFor(() => { expect(view.queryByTestId("biometric-toggle")).not.toBeNull(); });

  await act(async () => { await fireEvent.press(view.getByTestId("biometric-toggle")); });
  await waitFor(async () => {
    await expect(SecureStore.getItemAsync(BIOMETRIC_KEY)).resolves.toBe("enabled");
  });

  await act(async () => { await fireEvent.press(view.getByTestId("biometric-toggle")); });
  await waitFor(async () => {
    await expect(SecureStore.getItemAsync(BIOMETRIC_KEY)).resolves.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sign out now lives in Settings — with its semantics unchanged
// ═══════════════════════════════════════════════════════════════════════════

test("sign out revokes the session SERVER-side, clears the device, and returns to sign-in", async () => {
  const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(() =>
    Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) } as Response));

  const view = await signedIn(<Settings />);
  await expect(SecureStore.getItemAsync(REFRESH_KEY)).resolves.toBe(DRIVER.refreshToken);

  await act(async () => { await fireEvent.press(view.getByTestId("sign-out")); });

  await waitFor(() => { expect(mockRouter.replace).toHaveBeenCalledWith("/sign-in"); });
  const urls = (fetchSpy.mock.calls as unknown as ([unknown, RequestInit | undefined] | undefined)[])
    .map(call => (typeof call?.[0] === "string" ? call[0] : ""));
  expect(urls.some(url => url.includes("/auth/logout"))).toBe(true);
  await expect(SecureStore.getItemAsync(REFRESH_KEY)).resolves.toBeNull();
});

test("sign out with NO NETWORK still clears the device and returns to sign-in", async () => {
  const view = await signedIn(<Settings />);
  jest.spyOn(global, "fetch").mockImplementation(() => Promise.reject(new Error("Network request failed")));

  await act(async () => { await fireEvent.press(view.getByTestId("sign-out")); });

  await waitFor(() => { expect(mockRouter.replace).toHaveBeenCalledWith("/sign-in"); });
  await expect(SecureStore.getItemAsync(REFRESH_KEY)).resolves.toBeNull();
});

test("sign out also clears the biometric opt-in, so a relaunch cannot unlock by face", async () => {
  await SecureStore.setItemAsync(BIOMETRIC_KEY, "enabled");
  jest.spyOn(global, "fetch").mockImplementation(() =>
    Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) } as Response));

  const view = await signedIn(<Settings />);
  await act(async () => { await fireEvent.press(view.getByTestId("sign-out")); });

  await waitFor(async () => {
    await expect(SecureStore.getItemAsync(BIOMETRIC_KEY)).resolves.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// None of these pages is an employer selector
// ═══════════════════════════════════════════════════════════════════════════

test("no landing page names or offers a company", async () => {
  for (const screen of [<Timesheets key="t" />, <Records key="r" />, <Settings key="s" />]) {
    const view = await signedIn(screen);
    const rendered = allText(view);
    expect(rendered).not.toContain("employer");
    expect(rendered).not.toContain("switch company");
  }
});
