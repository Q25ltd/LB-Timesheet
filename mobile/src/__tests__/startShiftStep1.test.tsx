/**
 * Start Shift, step one: the entry from Home, and the Working For choice.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS STEP IS, AND WHAT IT DELIBERATELY IS NOT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The driver's working timesheet is LOCAL and PERSONAL while the day is being
 * worked. Choosing a company here records an INTENDED DESTINATION for a record
 * that has not been created, is not owned by anyone else, and is shared only
 * when the driver later chooses to send it.
 *
 * So selection is not authority, and the cases below prove that by ABSENCE:
 * opening this screen and choosing a company must produce NO network call at
 * all. No `POST /auth/switch-company` — a tenant token is not minted because a
 * driver tapped a name. No `POST /shifts/start` — the server-backed Start Shift
 * route exists but belongs to the older ownership model and is deliberately not
 * connected. Nothing reaches the company.
 *
 * The zero-request assertion is the load-bearing one. Every "we did not send
 * anything" claim in this file rests on it rather than on wording.
 *
 * PERSONAL IS THE DEFAULT because it is the zero-friction path: a driver
 * working for themselves touches nothing. It is never pre-empted by having one
 * membership, by yesterday's choice, or by holding a tenant token.
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { ReactElement } from "react";
import { Text, Pressable } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AccountMembership, AuthenticatedAccount } from "../api/account";
import { APP_TABS } from "../navigation/tabs";
import Today from "../../app/(app)/today";
import StartShift from "../../app/(app)/start-shift";

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
  };
});

function membership(id: string, companyName: string): AccountMembership {
  return { membershipId: id, companyId: `co_${id}`, companyName, role: "driver" };
}

const NORTHGATE = membership("mem_1", "Northgate Logistics");
const CALEDONIAN = membership("mem_2", "Caledonian Freight");

function accountWith(memberships: AccountMembership[]): AuthenticatedAccount {
  return {
    user: { id: "user_1", firstName: "Nerijus", lastName: "Kuizinas", email: "driver@example.com" },
    identityToken: "identity.token.value",
    refreshToken:  "refresh-secret-value",
    memberships,
  };
}

const METRICS = {
  frame:  { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

type View = Awaited<ReturnType<typeof render>>;

function text(view: View, testID: string): string {
  return String(view.getByTestId(testID).props.children);
}

/** The whole rendered tree, lower-cased — copy, testIDs and labels alike. */
function allText(view: View): string {
  return JSON.stringify(view.toJSON()).toLowerCase();
}

/**
 * The screen, reached with a driver signed in exactly as login leaves them.
 *
 * The provider's startup restore is allowed to settle first: signing in while
 * it is still running would race its own `clearLocalSession`.
 */
async function signedIn(node: ReactElement, memberships: AccountMembership[]): Promise<View> {
  function Harness() {
    const { signIn, status } = useAuth();
    return (
      <>
        <Text testID="status">{status}</Text>
        <Pressable testID="authenticate" onPress={() => { void signIn(accountWith(memberships)); }}>
          <Text>authenticate</Text>
        </Pressable>
        {node}
      </>
    );
  }

  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AuthProvider><Harness /></AuthProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => { expect(text(view, "status")).toBe("unauthenticated"); });
  await act(async () => { await fireEvent.press(view.getByTestId("authenticate")); });
  await waitFor(() => { expect(text(view, "status")).toBe("authenticated"); });
  return view;
}

/** Which option the control reports as chosen, read from what a screen reader hears. */
function selectedOf(view: View, testID: string): boolean {
  const state: unknown = view.getByTestId(testID).props.accessibilityState;
  if (typeof state !== "object" || state === null) return false;
  return Reflect.get(state, "selected") === true;
}

afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// Entry from Home
// ═══════════════════════════════════════════════════════════════════════════

test("Home's Start Shift is now ENABLED — the workflow behind it exists", async () => {
  const view = await signedIn(<Today />, []);

  expect(view.getByTestId("start-shift").props.accessibilityState)
    .toMatchObject({ disabled: false, busy: false });
});

test("pressing Start Shift opens the workflow — one tap, no picker, no dialog", async () => {
  const view = await signedIn(<Today />, [NORTHGATE]);

  await act(async () => { await fireEvent.press(view.getByTestId("start-shift")); });

  expect(mockRouter.navigate).toHaveBeenCalledWith("/start-shift");
  // Nothing stands between Home and the workflow.
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

test("pressing Start Shift sends NOTHING to the server", async () => {
  const fetchSpy = jest.spyOn(global, "fetch");
  const view = await signedIn(<Today />, [NORTHGATE]);

  await act(async () => { await fireEvent.press(view.getByTestId("start-shift")); });

  expect(fetchSpy).not.toHaveBeenCalled();
});

test("Start Shift is NOT a fifth tab — the four destinations are unchanged", () => {
  expect(APP_TABS.map(tab => tab.name)).toEqual(["today", "timesheets", "records", "settings"]);
  expect(APP_TABS.map(tab => tab.name)).not.toContain("start-shift");
});

// ═══════════════════════════════════════════════════════════════════════════
// The screen, and Personal as the default
// ═══════════════════════════════════════════════════════════════════════════

test("the screen is titled Start Shift and asks who the day is worked for", async () => {
  const view = await signedIn(<StartShift />, []);

  expect(text(view, "screen-title")).toBe("Start Shift");
  expect(view.getByTestId("working-for")).toBeTruthy();
});

test("PERSONAL is selected by default — the common path costs zero taps", async () => {
  const view = await signedIn(<StartShift />, [NORTHGATE]);

  expect(selectedOf(view, "working-for-personal")).toBe(true);
  expect(selectedOf(view, `working-for-${NORTHGATE.membershipId}`)).toBe(false);
});

test("ONE membership does not pre-select that company", async () => {
  // The tempting shortcut, and the one the owner ruled out: a driver with a
  // single employer still starts Personal and opts IN to the company.
  const view = await signedIn(<StartShift />, [NORTHGATE]);

  expect(selectedOf(view, "working-for-personal")).toBe(true);
});

test("Personal is offered even with NO company at all", async () => {
  const view = await signedIn(<StartShift />, []);

  expect(selectedOf(view, "working-for-personal")).toBe(true);
  expect(view.queryByTestId(`working-for-${NORTHGATE.membershipId}`)).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// The list follows the driver's real memberships
// ═══════════════════════════════════════════════════════════════════════════

test("zero companies: Personal is the only choice", async () => {
  const view = await signedIn(<StartShift />, []);

  expect(view.getAllByTestId(/^working-for-/)).toHaveLength(1);
});

test("one company: Personal and exactly that company, named from the account", async () => {
  const view = await signedIn(<StartShift />, [NORTHGATE]);

  expect(view.getAllByTestId(/^working-for-/)).toHaveLength(2);
  expect(view.getByText("Northgate Logistics")).toBeTruthy();
});

test("several companies: Personal and every active one", async () => {
  const view = await signedIn(<StartShift />, [NORTHGATE, CALEDONIAN]);

  expect(view.getAllByTestId(/^working-for-/)).toHaveLength(3);
  expect(view.getByText("Northgate Logistics")).toBeTruthy();
  expect(view.getByText("Caledonian Freight")).toBeTruthy();
});

test("no company contact detail is rendered or carried — only the name", async () => {
  const view = await signedIn(<StartShift />, [NORTHGATE, CALEDONIAN]);
  const rendered = allText(view);

  // The company's destination address is the SERVER's to determine at
  // submission; the phone must never hold or show it.
  expect(rendered).not.toContain("@");
  expect(rendered).not.toContain("email");
});

// ═══════════════════════════════════════════════════════════════════════════
// Exactly one choice, always
// ═══════════════════════════════════════════════════════════════════════════

test("choosing a company deselects Personal", async () => {
  const view = await signedIn(<StartShift />, [NORTHGATE]);

  await act(async () => {
    await fireEvent.press(view.getByTestId(`working-for-${NORTHGATE.membershipId}`));
  });

  expect(selectedOf(view, `working-for-${NORTHGATE.membershipId}`)).toBe(true);
  expect(selectedOf(view, "working-for-personal")).toBe(false);
});

test("choosing a second company deselects the first", async () => {
  const view = await signedIn(<StartShift />, [NORTHGATE, CALEDONIAN]);

  await act(async () => {
    await fireEvent.press(view.getByTestId(`working-for-${NORTHGATE.membershipId}`));
  });
  await act(async () => {
    await fireEvent.press(view.getByTestId(`working-for-${CALEDONIAN.membershipId}`));
  });

  expect(selectedOf(view, `working-for-${CALEDONIAN.membershipId}`)).toBe(true);
  expect(selectedOf(view, `working-for-${NORTHGATE.membershipId}`)).toBe(false);
  expect(selectedOf(view, "working-for-personal")).toBe(false);
});

test("Personal can be chosen back again", async () => {
  const view = await signedIn(<StartShift />, [NORTHGATE]);

  await act(async () => {
    await fireEvent.press(view.getByTestId(`working-for-${NORTHGATE.membershipId}`));
  });
  await act(async () => { await fireEvent.press(view.getByTestId("working-for-personal")); });

  expect(selectedOf(view, "working-for-personal")).toBe(true);
  expect(selectedOf(view, `working-for-${NORTHGATE.membershipId}`)).toBe(false);
});

test("EXACTLY ONE option is ever selected, through a whole sequence of taps", async () => {
  const view = await signedIn(<StartShift />, [NORTHGATE, CALEDONIAN]);
  const ids = ["working-for-personal", `working-for-${NORTHGATE.membershipId}`, `working-for-${CALEDONIAN.membershipId}`];

  for (const id of [...ids, ...ids].reverse()) {
    await act(async () => { await fireEvent.press(view.getByTestId(id)); });
    expect(ids.filter(each => selectedOf(view, each))).toHaveLength(1);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Selection is not authority — the whole point of the local-first model
// ═══════════════════════════════════════════════════════════════════════════

test("opening the screen makes NO request of any kind", async () => {
  const fetchSpy = jest.spyOn(global, "fetch");

  const view = await signedIn(<StartShift />, [NORTHGATE, CALEDONIAN]);
  expect(view.getByTestId("working-for")).toBeTruthy();

  expect(fetchSpy).not.toHaveBeenCalled();
});

test("choosing a company mints NO tenant token and starts NO shift", async () => {
  const fetchSpy = jest.spyOn(global, "fetch");
  const view = await signedIn(<StartShift />, [NORTHGATE, CALEDONIAN]);

  await act(async () => {
    await fireEvent.press(view.getByTestId(`working-for-${NORTHGATE.membershipId}`));
  });
  await act(async () => {
    await fireEvent.press(view.getByTestId(`working-for-${CALEDONIAN.membershipId}`));
  });

  // The load-bearing assertion of this file: no `/auth/switch-company`, no
  // `/shifts/start`, nothing to the company — because nothing was sent at all.
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("the tenant token is untouched by a company choice", async () => {
  function Probe() {
    const { tenantToken } = useAuth();
    return <Text testID="tenant">{String(tenantToken)}</Text>;
  }

  const view = await signedIn(<><Probe /><StartShift /></>, [NORTHGATE]);
  expect(text(view, "tenant")).toBe("null");

  await act(async () => {
    await fireEvent.press(view.getByTestId(`working-for-${NORTHGATE.membershipId}`));
  });

  // Still null: company authority is a server decision made at submission,
  // not something a tap on this screen acquires.
  expect(text(view, "tenant")).toBe("null");
});

// ═══════════════════════════════════════════════════════════════════════════
// The shell of the form, and nothing of step two
// ═══════════════════════════════════════════════════════════════════════════

test("Continue exists and is DISABLED — the next stage is not built", async () => {
  const view = await signedIn(<StartShift />, [NORTHGATE]);

  expect(view.getByTestId("start-shift-continue").props.accessibilityState)
    .toMatchObject({ disabled: true, busy: false });
});

test("Continue goes nowhere, because there is nowhere honest to go", async () => {
  const view = await signedIn(<StartShift />, [NORTHGATE]);

  await act(async () => { await fireEvent.press(view.getByTestId("start-shift-continue")); });

  expect(mockRouter.navigate).not.toHaveBeenCalled();
  expect(mockRouter.push).not.toHaveBeenCalled();
});

test("no step-two field appears yet — not a time, a vehicle, a trailer or a check", async () => {
  const view = await signedIn(<StartShift />, [NORTHGATE]);
  const rendered = allText(view);

  for (const absent of [
    "start time", "odometer", "mileage", "registration", "number plate",
    "trailer", "class 1", "class 2", "adblue", "defect", "check",
  ]) {
    expect(rendered).not.toContain(absent);
  }
});

test("Back leaves the workflow and returns where the driver came from", async () => {
  const view = await signedIn(<StartShift />, [NORTHGATE]);

  await act(async () => { await fireEvent.press(view.getByTestId("start-shift-back")); });

  expect(mockRouter.back).toHaveBeenCalled();
});
