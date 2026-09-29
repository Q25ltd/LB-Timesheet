/**
 * Use times corrected on screen, and a company's timesheet declared again
 * after ANY change (D42) — the screens and routes.
 *
 *   USE TIMES   a Vehicle Use / Trailer Use page corrects its own start and
 *               end; a refusal says the rule and writes nothing; the id stays.
 *   REVIEW      corrected from the Finish Review, the day is read again and
 *               the declaration does not survive.
 *   COMPANY     every change to a company's timesheet goes through the Review
 *               and "I confirm all details are correct" — Notes, Night Out,
 *               times, Working For, even to Personal; a use changed elsewhere
 *               is declared again from the timesheet's page.
 *   PERSONAL    an ordinary correction stays an ordinary save.
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { Directory, File, Paths } from "expo-file-system";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Alert, Pressable, Text } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AuthenticatedAccount } from "../api/account";
import TimesheetRoute from "../../app/(app)/timesheet";
import EditTimesheetRoute from "../../app/(app)/edit-timesheet";
import FinishShiftRoute from "../../app/(app)/finish-shift";
import VehicleUsageRoute from "../../app/(app)/vehicle-usage";
import TrailerUsageRoute from "../../app/(app)/trailer-usage";
import { REVIEW_TO_DECLARE } from "../navigation/useScreenDay";
import {
  COMPLETED_SHIFT_FILE_PREFIX,
  OPEN_SHIFT_FILE,
  USAGE_STATE,
  addTrailerToOpenShift,
  changeTrailer,
  changeVehicle,
  clearOpenShift,
  correctVehicleUseTimes,
  declarationHolds,
  readCompletedShift,
  readOpenShift,
  recordVehicleFill,
  startLocalShift,
  timesheetVersion,
  type CompletedShift,
  type LocalShift,
  type VehicleDetails,
  type WorkingContext,
} from "../shift/localShift";
import { TRAILER_TYPE } from "../shift/trailer";
import { FILL_TYPE } from "../shift/vehicleFill";
import { finishDeclared } from "./declared";

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismissTo: jest.fn() };
const mockParams: Record<string, string | undefined> = {};
const mockFocus = new Set<() => void>();

jest.mock("expo-router", () => {
  const react = jest.requireActual<typeof import("react")>("react");
  const rn = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    __esModule: true,
    router: {
      replace:   (href: unknown): void => { mockRouter.replace(href); },
      push:      (href: unknown): void => { mockRouter.push(href); },
      back:      (): void => { mockRouter.back(); },
      navigate:  (href: unknown): void => { mockRouter.navigate(href); },
      dismissTo: (href: unknown): void => { mockRouter.dismissTo(href); },
    },
    Redirect: ({ href }: { href: unknown }) => react.createElement(rn.Text, { testID: "redirect" }, typeof href === "string" ? href : JSON.stringify(href)),
    useFocusEffect: (effect: () => (() => void) | undefined) => {
      react.useEffect(() => {
        let cleanup = effect();
        const again = () => { cleanup?.(); cleanup = effect(); };
        mockFocus.add(again);
        return () => { mockFocus.delete(again); cleanup?.(); };
      }, [effect]);
    },
    useLocalSearchParams: () => mockParams,
  };
});

const METRICS = { frame: { x: 0, y: 0, width: 402, height: 874 }, insets: { top: 62, left: 0, right: 0, bottom: 34 } };
const PERSONAL: WorkingContext = { kind: "personal" };
const NORTHGATE: WorkingContext = { kind: "company", membershipId: "m1", companyId: "c1", companyName: "Northgate Haulage" };
const DRIVER: AuthenticatedAccount = {
  user: { id: "user_redeclare_1", firstName: "Nerijus", lastName: "Kuizinas", email: "driver@example.com" },
  identityToken: "identity.token.value",
  refreshToken: "refresh-secret-value",
  memberships: [
    { membershipId: "m1", companyId: "c1", companyName: "Northgate Haulage", role: "driver" },
    { membershipId: "m2", companyId: "c2", companyName: "Eastway Freight", role: "driver" },
  ],
};
const at = (hours: number, minutes = 0) => new Date(2026, 8, 19, hours, minutes);
const iso = (hours: number, minutes = 0) => at(hours, minutes).toISOString();
const UNIT: VehicleDetails = { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 };
const RIGID: VehicleDetails = { vehicleClass: "class2", numberPlate: "XY34 ZZZ", startMileage: 220_000 };
const VAN: VehicleDetails = { vehicleClass: "van", numberPlate: "VN11 AAA", startMileage: 5_000 };

type View = Awaited<ReturnType<typeof render>>;
const text = (view: View, testID: string) => {
  const children = (view.getByTestId(testID).props as { children?: unknown }).children;
  return Array.isArray(children) ? children.join("") : String(children);
};
const stateOf = (view: View, testID: string) =>
  (view.getByTestId(testID).props as { accessibilityState?: { disabled?: boolean; checked?: boolean } }).accessibilityState ?? {};
async function press(view: View, testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(view.getByTestId(testID)); });
}
async function type(view: View, testID: string, value: string): Promise<void> {
  await act(async () => { await fireEvent.changeText(view.getByTestId(testID), value); });
}
async function refocus(): Promise<void> {
  await act(async () => { for (const again of [...mockFocus]) again(); await Promise.resolve(); });
}
const recordFile = (id: string) => new File(Paths.document, `${COMPLETED_SHIFT_FILE_PREFIX}${id}.json`);
const openBytes = () => new File(Paths.document, OPEN_SHIFT_FILE).textSync();
const alerts = () => jest.mocked(Alert.alert).mock.calls.map(([title, message]) => [title, message]);

function SignedIn({ children }: { children: React.ReactNode }) {
  const { signIn, status } = useAuth();
  return (
    <>
      <Text testID="status">{status}</Text>
      <Pressable testID="authenticate" onPress={() => { void signIn(DRIVER); }}><Text>authenticate</Text></Pressable>
      {status === "authenticated" ? children : null}
    </>
  );
}
async function mount(node: React.ReactElement, ready: string[]): Promise<View> {
  const view = await render(<SafeAreaProvider initialMetrics={METRICS}><AuthProvider><SignedIn>{node}</SignedIn></AuthProvider></SafeAreaProvider>);
  await waitFor(() => { expect(text(view, "status")).not.toBe("restoring"); });
  if (text(view, "status") !== "authenticated") await press(view, "authenticate");
  await waitFor(() => { expect(ready.some(id => view.queryByTestId(id) !== null)).toBe(true); });
  return view;
}
const detail = (id: string) => { mockParams.id = id; return mount(<TimesheetRoute />, ["timesheet-date", "timesheet-missing"]); };
const edit = (id: string, review?: string) => { mockParams.id = id; mockParams.review = review; return mount(<EditTimesheetRoute />, ["edit-timesheet-save", "edit-timesheet-final"]); };

beforeEach(async () => {
  await clearOpenShift();
  for (const entry of new Directory(Paths.document).list()) {
    if (entry instanceof File) entry.delete();
  }
  for (const key of Object.keys(mockParams)) mockParams[key] = undefined;
  for (const fn of Object.values(mockRouter)) fn.mockClear();
  jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
});
afterEach(() => { jest.restoreAllMocks(); });

async function open(): Promise<LocalShift> {
  const day = await readOpenShift();
  if (day === null) throw new Error("expected an open day");
  return day;
}

/** AB12 CDE 05:00–09:00, then XY34 ZZZ in use from 09:00 — no trailer. */
async function twoVehicles(workingFor: WorkingContext = PERSONAL): Promise<LocalShift> {
  const shift = await startLocalShift({ workingFor, startedAt: at(5), vehicle: UNIT });
  await changeVehicle({ shiftId: shift.id, endingUseId: (await open()).vehicle?.useId ?? "", endMileage: 100_100, next: RIGID, changedAt: at(9) });
  return open();
}

async function finishedDay(workingFor: WorkingContext, times: { startedAt: Date; endedAt: Date } = { startedAt: at(5), endedAt: at(17) }): Promise<CompletedShift> {
  const shift = await startLocalShift({ workingFor, startedAt: times.startedAt, vehicle: VAN });
  const done = await finishDeclared({
    shiftId: shift.id, vehicleUseId: (await open()).vehicle?.useId ?? null, trailerUseId: null,
    finalMileage: 5_200, endedAt: times.endedAt, nightOut: false, notes: "",
  });
  if (done === null) throw new Error("expected the day to finish");
  return done;
}

// ═══════════════════════════════════════════════════════════════════════════
// Use times, on the use's own page
// ═══════════════════════════════════════════════════════════════════════════

test("an ENDED vehicle use's start and end are corrected on its Edit — the id and every other use unchanged", async () => {
  const day = await twoVehicles();
  const ended = day.previousVehicles[0];
  Object.assign(mockParams, { usage: ended?.useId });
  const view = await mount(<VehicleUsageRoute />, ["usage-edit"]);
  await press(view, "usage-edit");

  await type(view, "usage-start-time-minutes", "15");
  await type(view, "usage-end-time-hours", "08");
  await type(view, "usage-end-time-minutes", "40");
  await press(view, "usage-times-save");

  await waitFor(() => { expect(view.queryByTestId("usage-times-saved")).not.toBeNull(); });
  const after = await open();
  expect(after.previousVehicles[0]).toEqual({ ...ended, startedAt: iso(5, 15), endedAt: iso(8, 40) });
  expect(after.vehicle).toEqual(day.vehicle);
});

test("the vehicle IN USE offers its start only — it ends at the finish", async () => {
  const day = await twoVehicles();
  Object.assign(mockParams, { usage: day.vehicle?.useId, usageState: USAGE_STATE.inUse });
  const view = await mount(<VehicleUsageRoute />, ["usage-edit"]);
  await press(view, "usage-edit");

  expect(view.queryByTestId("usage-end-at-finish")).not.toBeNull();
  expect(view.queryByTestId("usage-end-time-hours")).toBeNull();
});

test("a refused time says the rule and writes nothing — an end that runs into the next vehicle", async () => {
  const day = await twoVehicles();
  const before = openBytes();
  Object.assign(mockParams, { usage: day.previousVehicles[0]?.useId });
  const view = await mount(<VehicleUsageRoute />, ["usage-edit"]);
  await press(view, "usage-edit");

  await type(view, "usage-end-time-hours", "09");
  await type(view, "usage-end-time-minutes", "30");
  await press(view, "usage-times-save");

  await waitFor(() => { expect(alerts()).toContainEqual(["Couldn't save those times", "That overlaps XY34 ZZZ, Sat 19 Sep 2026, 09:00 – in use. Only one at a time."]); });
  expect(openBytes()).toBe(before);
});

test("an end before its start is said as the driver types, and cannot be saved", async () => {
  const day = await twoVehicles();
  Object.assign(mockParams, { usage: day.previousVehicles[0]?.useId });
  const view = await mount(<VehicleUsageRoute />, ["usage-edit"]);
  await press(view, "usage-edit");

  await type(view, "usage-end-time-hours", "04");

  expect(text(view, "usage-times-error")).toBe("The end can't be before the start.");
  expect(stateOf(view, "usage-times-save").disabled).toBe(true);
});

test("a trailer use's times are corrected on its own Edit — a standard trailer too", async () => {
  const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: at(5), vehicle: UNIT });
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: { trailerNumber: "TR23", trailerType: TRAILER_TYPE.standard }, startedAt: at(6) });
  await changeTrailer({ shiftId: shift.id, endingUseId: (await open()).trailer?.useId ?? "", next: null, changedAt: at(10) });
  const ended = (await open()).previousTrailers[0];
  Object.assign(mockParams, { usage: ended?.useId });
  const view = await mount(<TrailerUsageRoute />, ["trailer-usage-edit"]);
  await press(view, "trailer-usage-edit");

  await type(view, "trailer-usage-start-time-minutes", "20");
  await press(view, "trailer-usage-times-save");

  await waitFor(() => { expect(view.queryByTestId("trailer-usage-times-saved")).not.toBeNull(); });
  expect((await open()).previousTrailers[0]).toEqual({ ...ended, startedAt: iso(6, 20) });
});

// ═══════════════════════════════════════════════════════════════════════════
// The Finish Review, after a use's times are corrected from it
// ═══════════════════════════════════════════════════════════════════════════

test("a use's times corrected from the Review: the Review reads the day again, and the declaration is gone", async () => {
  const day = await twoVehicles(NORTHGATE);
  const view = await mount(<FinishShiftRoute />, ["final-mileage"]);
  await type(view, "final-mileage", "220100");
  await press(view, "finish-mileage-continue");
  await press(view, "night-out-no");
  await press(view, "finish-details-continue");
  await press(view, "finish-confirm-declaration");
  expect(stateOf(view, "finish-confirm-declaration").checked).toBe(true);

  await press(view, "review-vehicle-0-open");
  await correctVehicleUseTimes({ shiftId: day.id, useId: day.previousVehicles[0]?.useId ?? "", usageState: USAGE_STATE.ended, startedAt: at(5, 30), endedAt: at(9) });
  await refocus();

  await waitFor(() => { expect(text(view, "review-vehicle-0-times")).toBe("05:30 – 09:00"); });
  expect(stateOf(view, "finish-confirm-declaration").checked).toBe(false);
  expect(stateOf(view, "finish-confirm").disabled).toBe(true);
});

test("the company finish files the declaration: the version the driver saw, by the signed-in driver", async () => {
  await twoVehicles(NORTHGATE);
  const view = await mount(<FinishShiftRoute />, ["final-mileage"]);
  await type(view, "final-mileage", "220100");
  await press(view, "finish-mileage-continue");
  await press(view, "night-out-no");
  await press(view, "finish-details-continue");
  const opened = await open();
  await press(view, "finish-confirm-declaration");
  await press(view, "finish-confirm");

  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalledWith("/today"); });
  const stored = await readCompletedShift(opened.id);
  if (stored === null) throw new Error("expected the day");
  expect(stored.declaration).toMatchObject({ version: timesheetVersion(stored), declaredBy: DRIVER.user.id });
  expect(declarationHolds(stored)).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// A company's timesheet: every change reviewed and declared
// ═══════════════════════════════════════════════════════════════════════════

test.each([
  ["Notes",        async (view: View) => { await type(view, "edit-notes", "Waited at the gate"); }],
  ["Night Out",    async (view: View) => { await press(view, "edit-night-out-yes"); }],
  // Earlier than the first use began: a shift may start before its first use (D42).
  ["the start",    async (view: View) => { await type(view, "edit-start-time-hours", "04"); }],
  ["the finish",   async (view: View) => { await type(view, "edit-finish-time-minutes", "20"); }],
  ["Working For",  async (view: View) => { await press(view, "edit-working-for-m2"); }],
  ["to Personal",  async (view: View) => { await press(view, "edit-working-for-personal"); }],
])("company unsent: changing %s goes to the Review — nothing is saved until the driver declares it", async (_what, change) => {
  const done = await finishedDay(NORTHGATE);
  const before = recordFile(done.id).textSync();
  const view = await edit(done.id);

  await change(view);
  expect(view.getByText("Review")).toBeTruthy();
  await press(view, "edit-timesheet-save");
  expect(text(view, "screen-title")).toBe("Review Timesheet");
  expect(stateOf(view, "edit-timesheet-final-declaration").checked).toBe(false);
  await press(view, "edit-timesheet-final");
  expect(recordFile(done.id).textSync()).toBe(before);

  await press(view, "edit-timesheet-final-declaration");
  await press(view, "edit-timesheet-final");

  await waitFor(async () => { expect((await readCompletedShift(done.id))?.corrections).toHaveLength(1); });
  const stored = await readCompletedShift(done.id);
  if (stored === null) throw new Error("expected the day");
  expect(declarationHolds(stored)).toBe(true);
  if (stored.corrections?.[0]?.workingFor.kind === "company") {
    expect(stored.declaration).toMatchObject({ version: timesheetVersion(stored), declaredBy: DRIVER.user.id });
  } else {
    expect(stored.declaration).toBeUndefined();
  }
});

test("company unsent: nothing changed and the declaration holds — there is nothing to save", async () => {
  const done = await finishedDay(NORTHGATE);
  const view = await edit(done.id);

  expect(stateOf(view, "edit-timesheet-save").disabled).toBe(true);
});

test("a use changed on a company's timesheet: its page says so, and the Review declares it again — with no correction appended", async () => {
  const done = await finishedDay(NORTHGATE);
  await recordVehicleFill({
    shiftId: done.id, vehicleUseId: done.previousVehicles[0]?.useId ?? "", usageState: USAGE_STATE.ended,
    fillId: "late", type: FILL_TYPE.fuel, recordedAt: at(7), litres: 80, note: "",
  });

  const page = await detail(done.id);
  expect(text(page, "timesheet-unconfirmed")).toBe("This timesheet has changed since you confirmed it.");
  await press(page, "timesheet-review");
  expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: "/edit-timesheet", params: { id: done.id, review: REVIEW_TO_DECLARE } });
  await page.unmount();

  const review = await edit(done.id, REVIEW_TO_DECLARE);
  expect(text(review, "screen-title")).toBe("Review Timesheet");
  expect(text(review, "edit-timesheet-changed")).toBe("This timesheet has changed since you confirmed it. Check it, then confirm it again.");
  expect(review.getByTestId("review-vehicle-0-fuel")).toBeTruthy();
  await press(review, "edit-timesheet-final-declaration");
  await press(review, "edit-timesheet-final");

  await waitFor(async () => {
    const stored = await readCompletedShift(done.id);
    expect(stored === null ? false : declarationHolds(stored)).toBe(true);
  });
  expect((await readCompletedShift(done.id))?.corrections).toBeUndefined();
  await review.unmount();
  const again = await detail(done.id);
  expect(again.queryByTestId("timesheet-unconfirmed")).toBeNull();
});

test.each([
  ["NONE recorded (finished before declarations were stored)", undefined],
  ["a DAMAGED one", { version: "", declaredAt: "yesterday", declaredBy: "" }],
] as const)("a company's timesheet with %s reads, needs review and confirmation — never 'changed since you confirmed it' — and Review and Confirm records a valid one", async (_why, declaration) => {
  const done = await finishedDay(NORTHGATE);
  const raw = JSON.parse(recordFile(done.id).textSync()) as Record<string, unknown>;
  const { declaration: _stored, ...facts } = raw;
  recordFile(done.id).write(JSON.stringify(declaration === undefined ? facts : { ...facts, declaration }));
  const bytes = recordFile(done.id).textSync();

  const page = await detail(done.id);
  expect(text(page, "timesheet-unconfirmed")).toBe("This timesheet needs review and confirmation.");
  expect(JSON.stringify(page.toJSON())).not.toContain("changed since you confirmed");
  expect(page.queryByTestId("timesheet-review")).not.toBeNull();
  await page.unmount();
  // Reading it — list, page — wrote nothing.
  expect(recordFile(done.id).textSync()).toBe(bytes);

  const review = await edit(done.id, REVIEW_TO_DECLARE);
  expect(text(review, "edit-timesheet-changed")).toBe("This timesheet needs review and confirmation. Check it, then confirm it.");
  await press(review, "edit-timesheet-final-declaration");
  await press(review, "edit-timesheet-final");

  await waitFor(async () => { expect((await readCompletedShift(done.id))?.declaration?.declaredBy).toBe(DRIVER.user.id); });
  const stored = await readCompletedShift(done.id);
  if (stored === null) throw new Error("expected the day");
  expect(stored.declaration?.version).toBe(timesheetVersion(stored));
  expect(stored.corrections).toBeUndefined();
  // Nothing but the declaration changed.
  const { declaration: _new, ...rest } = stored;
  const { declaration: _old, ...was } = done;
  expect(rest).toEqual(was);
  await review.unmount();
  const again = await detail(done.id);
  expect(again.queryByTestId("timesheet-unconfirmed")).toBeNull();
});

test("Back from a Review opened to declare again leaves the timesheet — nothing saved", async () => {
  const done = await finishedDay(NORTHGATE);
  await recordVehicleFill({
    shiftId: done.id, vehicleUseId: done.previousVehicles[0]?.useId ?? "", usageState: USAGE_STATE.ended,
    fillId: "late", type: FILL_TYPE.fuel, recordedAt: at(7), litres: 80, note: "",
  });
  const before = recordFile(done.id).textSync();
  const review = await edit(done.id, REVIEW_TO_DECLARE);

  await press(review, "edit-timesheet-review-back");

  expect(mockRouter.back).toHaveBeenCalledTimes(1);
  expect(recordFile(done.id).textSync()).toBe(before);
});

test("declaring a company's timesheet again does not ask about a finish ahead of the clock — it did not change", async () => {
  const now = new Date();
  const done = await finishedDay(NORTHGATE, { startedAt: new Date(now.getTime() - 8 * 3_600_000), endedAt: new Date(now.getTime() + 3_600_000) });
  const view = await edit(done.id);

  await type(view, "edit-notes", "Left early for the ferry");
  await press(view, "edit-timesheet-save");
  await press(view, "edit-timesheet-final-declaration");
  await press(view, "edit-timesheet-final");

  await waitFor(async () => { expect((await readCompletedShift(done.id))?.corrections).toHaveLength(1); });
  expect(alerts().filter(([title]) => title === "Finish time is ahead")).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Personal: ordinary
// ═══════════════════════════════════════════════════════════════════════════

test("a Personal timesheet's ordinary correction is an ordinary save — no Review, no declaration", async () => {
  const done = await finishedDay(PERSONAL);
  const view = await edit(done.id);

  await type(view, "edit-notes", "Quiet day");
  expect(view.getByText("Save correction")).toBeTruthy();
  await press(view, "edit-timesheet-save");

  await waitFor(async () => { expect((await readCompletedShift(done.id))?.corrections).toHaveLength(1); });
  expect(view.queryByTestId("edit-timesheet-final")).toBeNull();
  expect((await readCompletedShift(done.id))?.declaration).toBeUndefined();
});

test("a use changed on a Personal timesheet asks for nothing", async () => {
  const done = await finishedDay(PERSONAL);
  await recordVehicleFill({
    shiftId: done.id, vehicleUseId: done.previousVehicles[0]?.useId ?? "", usageState: USAGE_STATE.ended,
    fillId: "late", type: FILL_TYPE.fuel, recordedAt: at(7), litres: 80, note: "",
  });

  const page = await detail(done.id);

  expect(page.queryByTestId("timesheet-unconfirmed")).toBeNull();
});

test("Personal → a company still goes through the Review (D41)", async () => {
  const done = await finishedDay(PERSONAL);
  const view = await edit(done.id);

  await press(view, "edit-working-for-m1");

  expect(view.getByText("Review")).toBeTruthy();
});
