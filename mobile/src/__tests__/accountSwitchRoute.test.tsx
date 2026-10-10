/**
 * F-31 through the app's own route: driver A signs in, starts a day, signs
 * out; driver B signs in on the SAME phone.
 *
 * Deliberately written against nothing but the UI — the real AuthProvider,
 * the real Start Shift route, the real store underneath — so the SAME test
 * reproduces the defect on the code before F-31 and proves the fix after it.
 * Before F-31, B's Start Shift found A's open day and sent B straight into
 * it ("a day is already open"); A's working day was B's to change, finish or
 * discard.
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Pressable, Text } from "react-native";
import { Directory, Paths } from "expo-file-system";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AuthenticatedAccount } from "../api/account";
import StartShift from "../../app/(app)/start-shift";
import { useAccountScope } from "../shift/useAccountScope";
import { AccountScopeError, type AccountScope } from "../shift/accountScope";
import { readOpenShift } from "../shift/localShift";

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
    Redirect: ({ href }: { href: string }) => react.createElement(rn.Text, { testID: "redirect" }, String(href)),
  };
});

const METRICS = {
  frame:  { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function account(id: string, firstName: string): AuthenticatedAccount {
  return {
    user: { id, firstName, lastName: "Driver", email: `${id}@example.com` },
    identityToken: `identity.${id}`,
    refreshToken: `refresh-${id}`,
    memberships: [],
  };
}
const DRIVER_A = account("user_route_a", "Ada");
const DRIVER_B = account("user_route_b", "Ben");

type View = Awaited<ReturnType<typeof render>>;

/** Every scope the app handed a screen, in order — as a screen would hold one. */
const handedOut: AccountScope[] = [];
function ScopeProbe() {
  const scope = useAccountScope();
  if (scope !== null && !handedOut.includes(scope)) handedOut.push(scope);
  return null;
}

function Phone() {
  const { signIn, signOut, status, account: who } = useAuth();
  return (
    <>
      <Text testID="status">{status}</Text>
      <Pressable testID="sign-in-a" onPress={() => { void signIn(DRIVER_A); }}><Text>A</Text></Pressable>
      <Pressable testID="sign-in-b" onPress={() => { void signIn(DRIVER_B); }}><Text>B</Text></Pressable>
      <Pressable testID="sign-out" onPress={() => { void signOut(); }}><Text>out</Text></Pressable>
      <ScopeProbe />
      {/* Remounted per account, as the app's gate remounts the stack. */}
      {status === "authenticated" && who !== null ? <StartShift key={who.user.id} /> : null}
    </>
  );
}

async function press(view: View, testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(view.getByTestId(testID)); });
}

async function signInAs(view: View, who: "a" | "b"): Promise<void> {
  mockRouter.replace.mockClear();
  await press(view, `sign-in-${who}`);
  await waitFor(() => { expect(String(view.getByTestId("status").props.children)).toBe("authenticated"); });
}

async function signOutOn(view: View): Promise<void> {
  await press(view, "sign-out");
  await waitFor(() => { expect(String(view.getByTestId("status").props.children)).toBe("unauthenticated"); });
}

/** What the Start Shift route decided: the form, or "a day is already open". */
async function startShiftShows(view: View): Promise<"form" | "open-day"> {
  await waitFor(() => {
    expect(view.queryByTestId("working-for") !== null || mockRouter.replace.mock.calls.length > 0).toBe(true);
  });
  return mockRouter.replace.mock.calls.some(([href]) => href === "/active-shift") ? "open-day" : "form";
}

beforeEach(() => {
  for (const entry of new Directory(Paths.document).list()) entry.delete();
  mockRouter.replace.mockClear();
  handedOut.length = 0;
  // Sign-out tells the server when it can; here there is no network at all.
  jest.spyOn(global, "fetch").mockRejectedValue(new TypeError("Network request failed"));
});
afterEach(() => { jest.restoreAllMocks(); });

test("RED-ROUTE. B, signing in after A, gets B's OWN Start Shift form — not A's open day; A gets A's day back", async () => {
  const view = await render(<SafeAreaProvider initialMetrics={METRICS}><AuthProvider><Phone /></AuthProvider></SafeAreaProvider>);
  await waitFor(() => { expect(String(view.getByTestId("status").props.children)).toBe("unauthenticated"); });

  // A starts a day.
  await signInAs(view, "a");
  expect(await startShiftShows(view)).toBe("form");
  await press(view, "vehicle-not-yet");
  await press(view, "start-shift-submit");
  await waitFor(() => { expect(mockRouter.replace).toHaveBeenCalledWith("/active-shift"); });
  await signOutOn(view);

  // B signs in on the same phone: no day of B's is open.
  await signInAs(view, "b");
  expect(await startShiftShows(view)).toBe("form");
  await signOutOn(view);

  // A comes back: A's day is still open and still A's.
  await signInAs(view, "a");
  expect(await startShiftShows(view)).toBe("open-day");
});

test("a scope a screen still holds stops working the moment its driver signs out, and is never handed to the next driver", async () => {
  const view = await render(<SafeAreaProvider initialMetrics={METRICS}><AuthProvider><Phone /></AuthProvider></SafeAreaProvider>);
  await waitFor(() => { expect(String(view.getByTestId("status").props.children)).toBe("unauthenticated"); });

  await signInAs(view, "a");
  await waitFor(() => { expect(handedOut).toHaveLength(1); });
  const heldByA = handedOut[0];
  if (heldByA === undefined) throw new Error("expected A's scope");
  expect(heldByA.userId).toBe(DRIVER_A.user.id);
  await expect(readOpenShift(heldByA)).resolves.toBeNull();

  await signOutOn(view);
  // A screen that kept A's scope after sign-out can do nothing with it.
  await expect(readOpenShift(heldByA)).rejects.toBeInstanceOf(AccountScopeError);

  await signInAs(view, "b");
  await waitFor(() => { expect(handedOut).toHaveLength(2); });
  expect(handedOut[1]?.userId).toBe(DRIVER_B.user.id);
  await expect(readOpenShift(heldByA)).rejects.toBeInstanceOf(AccountScopeError);
});
