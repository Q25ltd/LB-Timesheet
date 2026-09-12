/**
 * Home — the authenticated landing screen.
 *
 * Every case below drives the REAL route (`app/(app)/today.tsx`) inside a REAL
 * `AuthProvider`, because the properties that matter are about what Home reads
 * and what Home refuses to claim, and a mocked provider would hide both.
 *
 * THE TWO PROPERTIES THIS FILE EXISTS FOR:
 *
 *   1. Home shows the REAL authenticated driver. Proven with two different
 *      accounts in the same file — a hard-coded name cannot satisfy both, so
 *      replacing the provider read with a literal turns this red.
 *
 *   2. Home INVENTS NOTHING. It makes no network request at all, so it cannot
 *      know whether a shift is open, what was submitted, or how far anyone
 *      drove — and it therefore must not say. The zero-request assertion is
 *      the load-bearing half; the absent-wording assertions are the readable
 *      half, and neither stands alone.
 *
 * Company neutrality gets its own case with a membership deliberately present:
 * asserting "no company appears" against an account that HAS one is the only
 * version of that test that can fail.
 */
import { render, fireEvent, act, waitFor, within } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { ReactElement } from "react";
import { Text, Pressable } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AuthenticatedAccount } from "../api/account";
import Today from "../../app/(app)/today";

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
  };
});

/** Two DIFFERENT drivers. One hard-coded name cannot satisfy both. */
const NERIJUS: AuthenticatedAccount = {
  user: { id: "user_1", firstName: "Nerijus", lastName: "Kuizinas", email: "nerijus@example.com" },
  identityToken: "identity.token.one",
  refreshToken:  "refresh-secret-one",
  memberships:   [],
};

const AISHA: AuthenticatedAccount = {
  user: { id: "user_2", firstName: "Aisha", lastName: "Okonkwo", email: "aisha@example.com" },
  identityToken: "identity.token.two",
  refreshToken:  "refresh-secret-two",
  memberships:   [],
};

/** A driver who DOES hold a company — the only account that can prove neutrality. */
const EMPLOYED: AuthenticatedAccount = {
  user: { id: "user_3", firstName: "Tomas", lastName: "Petrauskas", email: "tomas@example.com" },
  identityToken: "identity.token.three",
  refreshToken:  "refresh-secret-three",
  memberships: [
    { membershipId: "mem_1", companyId: "co_1", companyName: "Northgate Haulage", role: "driver" },
  ],
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

/**
 * Home, with a driver signed in through the provider's real `signIn`.
 *
 * The button is rendered ALONGSIDE the route rather than driving the route's
 * own state, so authentication happens exactly as it does after a login: the
 * provider is the only thing that changes.
 */
async function homeSignedInAs(account: AuthenticatedAccount): Promise<View> {
  function Harness() {
    const { signIn, status } = useAuth();
    return (
      <>
        <Text testID="status">{status}</Text>
        <Pressable testID="authenticate" onPress={() => { void signIn(account); }}>
          <Text>authenticate</Text>
        </Pressable>
        <Today />
      </>
    );
  }

  const view = await wrap(<Harness />);
  // The provider's startup restore must finish first. Signing in while it is
  // still running would race its own `clearLocalSession` and could land on an
  // unauthenticated tree for reasons that have nothing to do with Home.
  await waitFor(() => { expect(text(view, "status")).toBe("unauthenticated"); });
  await act(async () => { await fireEvent.press(view.getByTestId("authenticate")); });
  await waitFor(() => { expect(view.queryByTestId("greeting-name")).not.toBeNull(); });
  return view;
}

function text(view: View, testID: string): string {
  return String(view.getByTestId(testID).props.children);
}


/**
 * The ENTIRE rendered tree as one lower-cased string — copy, testIDs and
 * accessibility labels alike.
 *
 * Deliberately broader than the visible text: a fabricated row would fail
 * these assertions even if it arrived as a testID or an accessible name
 * rather than as a caption.
 */
function allText(view: View): string {
  return JSON.stringify(view.toJSON()).toLowerCase();
}

afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// A. The real authenticated driver — proven with two of them
// ═══════════════════════════════════════════════════════════════════════════

test("the greeting names the REAL signed-in driver, not a fixed name", async () => {
  const first = await homeSignedInAs(NERIJUS);
  expect(text(first, "greeting-name")).toBe("Nerijus");

  const second = await homeSignedInAs(AISHA);
  expect(text(second, "greeting-name")).toBe("Aisha");

  // Stated as its own expectation: the point is that ONE literal cannot be
  // right in both cases, so a hard-coded greeting fails here.
  expect(text(first, "greeting-name")).not.toBe(text(second, "greeting-name"));
});

test("the identity badge shows the driver's own initials, from first AND last name", async () => {
  const first = await homeSignedInAs(NERIJUS);
  expect(text(first, "identity-badge")).toBe("NK");

  const second = await homeSignedInAs(AISHA);
  expect(text(second, "identity-badge")).toBe("AO");
});

test("the identity badge opens Settings — a real destination, not a menu", async () => {
  const view = await homeSignedInAs(NERIJUS);
  const badge = view.getByTestId("identity-badge-container");

  // It became a control only because Settings now exists. It is a button and
  // says so; it is not a dropdown, and it offers no choices that are not there.
  expect(badge.props.accessibilityRole).toBe("button");

  await act(async () => { await fireEvent.press(badge); });
  expect(mockRouter.navigate).toHaveBeenCalledWith("/settings");
});

test("the greeting carries one salutation, and it is one of exactly three", async () => {
  const view = await homeSignedInAs(NERIJUS);
  expect(["Good morning,", "Good afternoon,", "Good evening,"])
    .toContain(text(view, "greeting-salutation"));
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Home invents nothing
// ═══════════════════════════════════════════════════════════════════════════

test("Home makes NO network request — so it cannot know any shift or history state", async () => {
  const fetchSpy = jest.spyOn(global, "fetch");

  const view = await homeSignedInAs(NERIJUS);
  expect(view.getByTestId("greeting-name")).toBeTruthy();

  // The load-bearing assertion of this whole file. Anything Home displayed
  // about shifts, submissions or mileage would have to be fabricated,
  // because Home asked nobody.
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("Home does NOT claim there is no active shift — it cannot prove that", async () => {
  const view = await homeSignedInAs(NERIJUS);
  const rendered = allText(view);

  expect(rendered).not.toContain("no active shift");
  expect(rendered).not.toContain("active shift");
  // Nor the opposite claim, which would be equally invented.
  expect(rendered).not.toContain("shift in progress");

  // And no explanatory caption under the button either (owner decision): the
  // disabled control is sufficient while the workflow is being built, and a
  // line of apology under every unfinished action does not scale.
  expect(rendered).not.toContain("not available yet");
});

test("the Recent Timesheets region renders its FRAME and no row data whatsoever", async () => {
  const view = await homeSignedInAs(NERIJUS);

  // The section exists, because the approved composition calls for it.
  const section = within(view.getByTestId("recent-timesheets"));
  expect(view.getByTestId("recent-timesheets-empty")).toBeTruthy();

  // And it contains no NUMBER of any kind — a specimen row would need a date,
  // a time or a distance, and this is the assertion it could not survive.
  expect(section.queryAllByText(/\d/)).toEqual([]);
});

test("Home fabricates no timesheet status, no mileage and no drill-in", async () => {
  const view = await homeSignedInAs(NERIJUS);
  const rendered = allText(view);

  expect(rendered).not.toContain("submitted");
  expect(rendered).not.toContain("miles");
  expect(rendered).not.toContain("view all");
});

test("Home is COMPANY-NEUTRAL — a driver's employer is not named or selectable", async () => {
  // The account deliberately HAS a membership. Against a zero-membership
  // driver this assertion would pass no matter what Home rendered.
  const view = await homeSignedInAs(EMPLOYED);
  expect(text(view, "greeting-name")).toBe("Tomas");

  const rendered = allText(view);
  expect(rendered).not.toContain("northgate");
  expect(rendered).not.toContain("company");
  expect(rendered).not.toContain("employer");
});

test("Home adds no bottom navigation to destinations that do not exist", async () => {
  const view = await homeSignedInAs(NERIJUS);
  const rendered = allText(view);

  // Home does not draw navigation — the `(app)` shell owns the tab bar, so a
  // second one rendered by the screen would mean two bars on one page.
  expect(view.queryByTestId("app-tab-bar")).toBeNull();
  expect(rendered).not.toContain("my records");
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Start Shift — real, prominent, and honestly disabled
// ═══════════════════════════════════════════════════════════════════════════

test("Home uses the APPROVED brand lockup, and carries no second logo", async () => {
  const view = await homeSignedInAs(NERIJUS);

  // The lockup Login and Registration use, reused verbatim. A drawn truck mark
  // was tried beside it and removed — on device it read as two blue blocks,
  // and a second logo implementation is what must not exist.
  expect(view.getByText("LogisticBay")).toBeTruthy();
  expect(view.getByText("TIMESHEETS")).toBeTruthy();
});

test("the shift card reserves its image region — the pending asset is a SWAP, not a redesign", async () => {
  const view = await homeSignedInAs(NERIJUS);

  // The region exists and is sized by the card, so replacing the file behind
  // `homeCardImage.ts` changes no layout and no test.
  expect(view.getByTestId("shift-card-image")).toBeTruthy();
});

test("Start Shift is present and DISABLED, with its disabled state exposed", async () => {
  const view = await homeSignedInAs(NERIJUS);
  const button = view.getByTestId("start-shift");

  expect(String(button.props.accessibilityLabel)).toContain("Start Shift");

  // `accessibilityState` is the whole contract here, and it is asserted rather
  // than a host `disabled` prop because React Native's `Pressable` does not
  // forward one — it expresses the state exactly this way, which is also what
  // a screen reader announces. `busy: false` is asserted alongside because
  // PrimaryButton draws "disabled" and "submitting" differently on purpose,
  // and this button is the first, not the second.
  expect(button.props.accessibilityState).toMatchObject({ disabled: true, busy: false });
});

test("pressing Start Shift does nothing at all — no navigation, no request", async () => {
  const fetchSpy = jest.spyOn(global, "fetch");
  const view = await homeSignedInAs(NERIJUS);

  await act(async () => { await fireEvent.press(view.getByTestId("start-shift")); });

  expect(mockRouter.replace).not.toHaveBeenCalled();
  expect(mockRouter.push).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Behaviour that already existed on Today, and must survive
// ═══════════════════════════════════════════════════════════════════════════

test("Home no longer carries a Sign out control — Settings owns it, and only one screen may", async () => {
  const view = await homeSignedInAs(NERIJUS);

  // Two sign-out controls would be worse than either one. The behaviour did
  // not change; it moved, and `landingScreens.test.tsx` proves it there.
  expect(view.queryByTestId("sign-out")).toBeNull();
});

test("the biometric offer appears only on a device that can actually do it", async () => {
  // The default mocked device has no biometric hardware (jest.setup.js), so
  // the offer must be absent — asking a phone that cannot answer is how a
  // driver learns to distrust the app (D26).
  const view = await homeSignedInAs(NERIJUS);
  expect(view.queryByTestId("biometric-opt-in")).toBeNull();
});
