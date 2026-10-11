/**
 * D65 — a company deactivates or removes the driver: what the phone does.
 *
 * The phone learns it from the account read Home already makes (`GET
 * /auth/me`, for the email confirmation): the same answer brings the
 * account's ACTIVE companies up to date, so Start Shift stops offering the
 * company with no request of its own — Start Shift still sends nothing
 * (startShiftStep1.test.tsx). Offline, the companies stay as last read.
 *
 * A day already started for that company is the driver's all the same
 * (Option A): Active Shift says the company no longer lists them, and the
 * day is finished like any other. Nothing is closed, moved or discarded.
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Pressable, Text } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AccountMembership, AuthenticatedAccount } from "../api/account";
import { EmailConfirmation } from "../components/EmailConfirmation";
import { StartShiftScreen } from "../screens/StartShiftScreen";
import ActiveShiftRoute from "../../app/(app)/active-shift";
import { clearOpenShift, readOpenShift, startLocalShift, type WorkingContext } from "../shift/localShift";
import { scopeFor } from "./testScope";

const SCOPE = scopeFor("user_withdrawn_1");
jest.mock("../shift/useAccountScope", () => ({ useAccountScope: () => mockScope }));
const mockScope = SCOPE;

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock("expo-router", () => {
  const react = jest.requireActual<typeof import("react")>("react");
  const rn = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    __esModule: true,
    router: {
      replace:  (href: unknown): void => { mockRouter.replace(href); },
      push:     (href: unknown): void => { mockRouter.push(href); },
      back:     (): void => { mockRouter.back(); },
      navigate: (href: unknown): void => { mockRouter.navigate(href); },
    },
    Redirect: ({ href }: { href: string }) => react.createElement(rn.Text, { testID: "redirect" }, String(href)),
    useFocusEffect: (effect: () => (() => void) | undefined) => { react.useEffect(effect, [effect]); },
  };
});

const METRICS = { frame: { x: 0, y: 0, width: 402, height: 874 }, insets: { top: 62, left: 0, right: 0, bottom: 34 } };
const NORTHGATE: AccountMembership = { membershipId: "m_north", companyId: "co_north", companyName: "Northgate Haulage", role: "driver" };
const CALEDONIAN: AccountMembership = { membershipId: "m_cal", companyId: "co_cal", companyName: "Caledonian Freight", role: "driver" };
const USER = { id: "user_withdrawn_1", firstName: "Dee", lastName: "River", email: "dee@example.com" };
const SIGNED_IN: AuthenticatedAccount = { user: USER, memberships: [NORTHGATE, CALEDONIAN], identityToken: "id.token", refreshToken: "secret-1" };
const FOR_NORTHGATE: WorkingContext = { kind: "company", membershipId: NORTHGATE.membershipId, companyId: NORTHGATE.companyId, companyName: NORTHGATE.companyName };

type View = Awaited<ReturnType<typeof render>>;

interface Server { meReads: number }

/** The server: `GET /auth/me` answers the companies it now lists — or there is no connection. */
function server(listed: AccountMembership[] | "offline"): Server {
  const state: Server = { meReads: 0 };
  jest.spyOn(global, "fetch").mockImplementation(((input: string) => {
    const path = new URL(String(input)).pathname;
    if (path === "/auth/me") {
      state.meReads += 1;
      if (listed === "offline") return Promise.reject(new TypeError("Network request failed"));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ user: USER, memberships: listed, emailVerified: true }) } as Response);
    }
    throw new Error(`unexpected request to ${path}`);
  }) as unknown as typeof fetch);
  return state;
}

function Companies() {
  const { account } = useAuth();
  return <Text testID="companies">{(account?.memberships ?? []).map(m => m.companyName).join(",")}</Text>;
}

/** Signed in with both companies, then `node` — Home's account read, Active Shift — mounted. */
async function signedIn(node: React.ReactElement): Promise<View> {
  function Phone() {
    const { signIn, status } = useAuth();
    return (
      <>
        <Pressable testID="sign-in" onPress={() => { void signIn(SIGNED_IN); }}><Text>{status}</Text></Pressable>
        <Companies />
        {status === "authenticated" ? node : null}
      </>
    );
  }
  const view = await render(<SafeAreaProvider initialMetrics={METRICS}><AuthProvider><Phone /></AuthProvider></SafeAreaProvider>);
  await act(async () => { await fireEvent.press(view.getByTestId("sign-in")); });
  await waitFor(() => { expect(view.queryByTestId("companies")).not.toBeNull(); });
  return view;
}

const companies = (view: View): string => String(view.getByTestId("companies").props.children);

beforeEach(async () => {
  await clearOpenShift(SCOPE);
  for (const fn of Object.values(mockRouter)) fn.mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

test("MW1. Home's ONE account read brings the companies up to date: a company that withdrew the driver is no longer theirs to choose", async () => {
  const api = server([CALEDONIAN]);

  const view = await signedIn(<EmailConfirmation variant="home" />);

  await waitFor(() => { expect(companies(view)).toBe("Caledonian Freight"); });
  expect(api.meReads).toBe(1);
});

test("MW2. offline: the companies stay as last read — nothing is dropped for want of a connection", async () => {
  const api = server("offline");

  const view = await signedIn(<EmailConfirmation variant="home" />);

  await waitFor(() => { expect(api.meReads).toBeGreaterThan(0); });
  expect(companies(view)).toBe("Northgate Haulage,Caledonian Freight");
});

test("MW3. Start Shift: a company chosen and then withdrawn while the screen is open is no longer the choice — the day starts as Personal, never for it", async () => {
  const started: WorkingContext[] = [];
  const onStart = (input: { workingFor: WorkingContext }) => { started.push(input.workingFor); };
  const screen = (memberships: AccountMembership[]) => (
    <SafeAreaProvider initialMetrics={METRICS}>
      <StartShiftScreen memberships={memberships} onBack={() => undefined} onStart={onStart} />
    </SafeAreaProvider>
  );
  const view = await render(screen([NORTHGATE, CALEDONIAN]));
  await act(async () => { await fireEvent.press(view.getByTestId(`working-for-${NORTHGATE.membershipId}`)); });
  expect(view.getByTestId(`working-for-${NORTHGATE.membershipId}`).props.accessibilityState).toMatchObject({ selected: true });

  await act(async () => { await view.rerender(screen([CALEDONIAN])); });

  expect(view.queryByTestId(`working-for-${NORTHGATE.membershipId}`)).toBeNull();
  expect(view.getByTestId("working-for-personal").props.accessibilityState).toMatchObject({ selected: true });
  await act(async () => { await fireEvent.press(view.getByTestId("vehicle-not-yet")); });
  await act(async () => { await fireEvent.press(view.getByTestId("start-shift-submit")); });
  expect(started).toEqual([{ kind: "personal" }]);
});

test("MW4. a day already started for a company that then withdrew the driver: Active Shift says so plainly — and the day is still finished as any other, unchanged", async () => {
  server([CALEDONIAN]);
  await startLocalShift(SCOPE, { workingFor: FOR_NORTHGATE, startedAt: new Date(2026, 9, 11, 6, 0), vehicle: null });
  const before = await readOpenShift(SCOPE);

  const view = await signedIn(<><EmailConfirmation variant="home" /><ActiveShiftRoute /></>);

  await waitFor(() => { expect(view.queryByTestId("shift-company-withdrawn")).not.toBeNull(); });
  const notice = String(view.getByTestId("shift-company-withdrawn").props.children);
  expect(notice).toMatch(/Northgate Haulage no longer lists you as an active driver/);
  expect(notice).toMatch(/still finish this day/i);
  expect(String(view.getByTestId("shift-working-for").props.children)).toBe("Northgate Haulage");
  expect(await readOpenShift(SCOPE)).toEqual(before);

  await act(async () => { await fireEvent.press(view.getByTestId("finish-shift")); });
  expect(mockRouter.push).toHaveBeenCalledWith("/finish-shift");
});

test.each([
  ["the company still lists the driver", [NORTHGATE, CALEDONIAN], FOR_NORTHGATE],
  ["a Personal day", [], { kind: "personal" }],
] as const)("MW5. no notice when %s", async (_why, listed, workingFor) => {
  server([...listed]);
  await startLocalShift(SCOPE, { workingFor, startedAt: new Date(2026, 9, 11, 6, 0), vehicle: null });

  const view = await signedIn(<><EmailConfirmation variant="home" /><ActiveShiftRoute /></>);

  await waitFor(() => { expect(view.queryByTestId("finish-shift")).not.toBeNull(); });
  await waitFor(() => { expect(companies(view)).toBe(listed.map(m => m.companyName).join(",")); });
  expect(view.queryByTestId("shift-company-withdrawn")).toBeNull();
});
