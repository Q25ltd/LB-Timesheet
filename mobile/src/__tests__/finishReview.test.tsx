/**
 * The Finish Review as the final verification point (D41, 2026-09-29).
 *
 *   CORRECT    every driver-entered fact on the Review opens where it is
 *              corrected — shift rows, each use by its identity, the final
 *              mileage — and the Review re-reads the day on return
 *   DECLARE    "I confirm all details are correct", unticked by default, bound
 *              to the exact version shown, cleared by any correction
 *   ACTION     Personal saves locally; a company's action says plainly that
 *              sending does not exist yet — nothing is sent or claimed sent
 *   HISTORY    changing a finished Personal day to a company goes through the
 *              same review and declaration, never an ordinary save
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { Directory, File, Paths } from "expo-file-system";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Alert, Pressable, Text } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AuthenticatedAccount } from "../api/account";
import FinishShiftRoute from "../../app/(app)/finish-shift";
import VehicleUsageRoute from "../../app/(app)/vehicle-usage";
import VehicleCheckRoute from "../../app/(app)/vehicle-check";
import TrailerCheckRoute from "../../app/(app)/trailer-check";
import CorrectNameRoute from "../../app/(app)/correct-name";
import EditShiftRoute from "../../app/(app)/edit-shift";
import TimesheetRoute from "../../app/(app)/timesheet";
import { FinishShiftScreen } from "../screens/FinishShiftScreen";
import { EditTimesheetScreen, type TimesheetEdit } from "../screens/EditTimesheetScreen";
import { VIA_FINISH_REVIEW } from "../navigation/useScreenDay";
import {
  COMPLETED_SHIFT_FILE_PREFIX,
  OPEN_SHIFT_FILE,
  TimesheetBoundsError,
  USAGE_STATE,
  addTrailerToOpenShift,
  changeTrailer,
  changeVehicle,
  clearOpenShift,
  completeVehicleCheck,
  correctNumberPlate,
  correctOpenShift,
  correctStartMileage,
  correctTrailerNumber,
  readCompletedShift,
  readOpenShift,
  recordVehicleFill,
  startLocalShift,
  type CompletedShift,
  type LocalShift,
  type ShiftFinish,
  type VehicleDetails,
  type WorkingContext,
} from "../shift/localShift";
import { TRAILER_TYPE } from "../shift/trailer";
import { checklistFor, checklistItems } from "../shift/checklists";
import { FILL_TYPE } from "../shift/vehicleFill";
import { trailerUseAt, vehicleUseAt } from "./useIdAt";
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
const NORTHGATE: WorkingContext = { kind: "company", membershipId: "m1", companyId: "c1", companyName: "Northgate Haulage" };
const DRIVER: AuthenticatedAccount = {
  user: { id: "user_review_1", firstName: "Nerijus", lastName: "Kuizinas", email: "driver@example.com" },
  identityToken: "identity.token.value",
  refreshToken: "refresh-secret-value",
  memberships: [{ membershipId: "m1", companyId: "c1", companyName: "Northgate Haulage", role: "driver" }],
};
const at = (hours: number, minutes = 0) => new Date(2026, 8, 19, hours, minutes);
const OPENED_AT = at(17, 40);
const UNIT: VehicleDetails = { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 };
const RIGID: VehicleDetails = { vehicleClass: "class2", numberPlate: "XY34 ZZZ", startMileage: 220_000 };
const TR23 = { trailerNumber: "TR23", trailerType: TRAILER_TYPE.standard };

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
async function open(): Promise<LocalShift> {
  const day = await readOpenShift();
  if (day === null) throw new Error("expected an open day");
  return day;
}

/**
 * AB12 CDE 05:00–09:00, then XY34 ZZZ in use; TR23 10:00–12:00, then RF77 in
 * use from 12:00 — every kind of use the Review offers a way into.
 */
async function fullDay(workingFor: WorkingContext = { kind: "personal" }): Promise<LocalShift> {
  const shift = await startLocalShift({ workingFor, startedAt: at(5), vehicle: UNIT });
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(at(5).toISOString()), endMileage: 100_100, next: RIGID, changedAt: at(9) });
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(10) });
  await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(at(10).toISOString()), next: { trailerNumber: "RF77", trailerType: TRAILER_TYPE.refrigerated }, changedAt: at(12) });
  return open();
}

/** The Review alone, opened at OPENED_AT, its corrections and confirmation captured. */
async function review(shift: LocalShift) {
  const confirmed: ShiftFinish[] = [];
  const corrections: unknown[][] = [];
  const props = {
    openedAt: OPENED_AT,
    now: () => OPENED_AT,
    onLeave: () => undefined,
    onConfirm: (finish: ShiftFinish) => { confirmed.push(finish); return Promise.resolve(); },
    onEditShift: () => { corrections.push(["shift"]); },
    onOpenVehicleUse: (usage: string, inUse: boolean) => { corrections.push(["vehicle", usage, inUse]); },
    onOpenTrailerUse: (usage: string, inUse: boolean) => { corrections.push(["trailer", usage, inUse]); },
  };
  const view = await render(<SafeAreaProvider initialMetrics={METRICS}><FinishShiftScreen shift={shift} {...props} /></SafeAreaProvider>);
  if (shift.vehicle !== null) {
    await type(view, "final-mileage", String(shift.vehicle.startMileage + 100));
    await press(view, "finish-mileage-continue");
  }
  await press(view, "night-out-no");
  await press(view, "finish-details-continue");
  const rerender = async (next: LocalShift) => {
    await act(async () => { await view.rerender(<SafeAreaProvider initialMetrics={METRICS}><FinishShiftScreen shift={next} {...props} /></SafeAreaProvider>); });
  };
  return { view, confirmed, corrections, rerender };
}

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
  await waitFor(() => { expect(text(view, "status")).toBe("unauthenticated"); });
  await press(view, "authenticate");
  await waitFor(() => { expect(ready.some(id => view.queryByTestId(id) !== null)).toBe(true); });
  return view;
}

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

// ═══════════════════════════════════════════════════════════════════════════
// Every driver-entered fact on the Review opens where it is corrected
// ═══════════════════════════════════════════════════════════════════════════

test("Working For and Started open the shift correction", async () => {
  const { view, corrections } = await review(await fullDay());

  await press(view, "review-working-for-edit");
  await press(view, "review-started-edit");

  expect(corrections).toEqual([["shift"], ["shift"]]);
});

test.each([["review-finished-edit"], ["review-night-out-edit"], ["review-add-notes-edit"]])(
  "%s goes back to Finish Details, keeping what was entered",
  async testID => {
    const { view } = await review(await fullDay());

    await press(view, testID);

    expect(view.getByTestId("finish-time-hours").props.value).toBe("17");
    expect(view.getByTestId("night-out-no").props.accessibilityState).toMatchObject({ selected: true });
  },
);

test("the vehicle in use's final mileage goes back to its step, as entered", async () => {
  const { view } = await review(await fullDay());

  await press(view, "review-vehicle-1-final-mileage");

  expect(view.getByTestId("final-mileage").props.value).toBe("220100");
});

test("EVERY use opens by its identity, in the state it is in — the earlier ones ended, the current ones in use", async () => {
  const { view, corrections } = await review(await fullDay());

  await press(view, "review-vehicle-0-open");
  await press(view, "review-vehicle-1-open");
  await press(view, "review-trailer-0-open");
  await press(view, "review-trailer-1-open");

  expect(corrections).toEqual([
    ["vehicle", vehicleUseAt(at(5).toISOString()), false],
    ["vehicle", vehicleUseAt(at(9).toISOString()), true],
    ["trailer", trailerUseAt(at(10).toISOString()), false],
    ["trailer", trailerUseAt(at(12).toISOString()), true],
  ]);
});

test("the route opens each use's page with its state — and says it came from the Review", async () => {
  await fullDay();
  const view = await mount(<FinishShiftRoute />, ["final-mileage"]);
  await type(view, "final-mileage", "220100");
  await press(view, "finish-mileage-continue");
  await press(view, "night-out-no");
  await press(view, "finish-details-continue");

  await press(view, "review-vehicle-1-open");
  await press(view, "review-trailer-0-open");
  await press(view, "review-working-for-edit");

  expect(mockRouter.push.mock.calls.map(([href]: unknown[]) => href)).toEqual([
    { pathname: "/vehicle-usage", params: { usage: vehicleUseAt(at(9).toISOString()), usageState: USAGE_STATE.inUse, via: VIA_FINISH_REVIEW } },
    { pathname: "/trailer-usage", params: { usage: trailerUseAt(at(10).toISOString()), usageState: USAGE_STATE.ended, via: VIA_FINISH_REVIEW } },
    "/edit-shift",
  ]);
});

test("the vehicle IN USE opens its own page: plate, start mileage, fuel, AdBlue and check reach EXACTLY it — and come back to the Review", async () => {
  const shift = await fullDay();
  Object.assign(mockParams, { usage: vehicleUseAt(at(9).toISOString()), usageState: USAGE_STATE.inUse, via: VIA_FINISH_REVIEW });
  const view = await mount(<VehicleUsageRoute />, ["usage-edit"]);

  expect(text(view, "usage-plate")).toBe("XY34 ZZZ");
  expect(text(view, "usage-end-mileage")).toBe("At the finish");
  await press(view, "usage-correct-plate");
  await press(view, "usage-vehicle-checks");
  await press(view, "usage-edit");
  await press(view, "usage-edit-fuel");
  await press(view, "usage-edit-adblue");
  const carried = { usage: vehicleUseAt(at(9).toISOString()), usageState: USAGE_STATE.inUse, via: VIA_FINISH_REVIEW };
  expect(mockRouter.push.mock.calls.map(([href]: unknown[]) => href)).toEqual([
    { pathname: "/correct-name", params: { asset: "vehicle", ...carried } },
    { pathname: "/vehicle-check", params: carried },
    { pathname: "/vehicle-fill", params: { type: "fuel", ...carried } },
    { pathname: "/vehicle-fill", params: { type: "adblue", ...carried } },
  ]);

  await type(view, "usage-start-mileage-input", "219990");
  await press(view, "usage-start-mileage-save");

  await waitFor(async () => { expect((await open()).vehicle?.startMileage).toBe(219_990); });
  expect((await open()).previousVehicles).toEqual(shift.previousVehicles);
});

test("a check on the use in use, completed from the Review, returns to the Review — never out of the Finish flow", async () => {
  await fullDay();
  Object.assign(mockParams, { usage: vehicleUseAt(at(9).toISOString()), usageState: USAGE_STATE.inUse, via: VIA_FINISH_REVIEW });
  const view = await mount(<VehicleCheckRoute />, ["complete-check"]);

  await press(view, "complete-check");

  await waitFor(async () => { expect((await open()).vehicle?.checks[0]?.status).toBe("completed"); });
  expect(mockRouter.back).toHaveBeenCalled();
  expect(mockRouter.dismissTo).not.toHaveBeenCalled();
});

test("the TRAILER in use's check from the Review returns to the Review too", async () => {
  await fullDay();
  Object.assign(mockParams, { trailer: trailerUseAt(at(12).toISOString()), usageState: USAGE_STATE.inUse, via: VIA_FINISH_REVIEW });
  const view = await mount(<TrailerCheckRoute />, ["complete-check"]);

  await press(view, "complete-check");

  await waitFor(async () => { expect((await open()).trailer?.checks[0]?.status).toBe("completed"); });
  expect(mockRouter.back).toHaveBeenCalled();
  expect(mockRouter.dismissTo).not.toHaveBeenCalled();
});

test("a plate corrected from the Review on the use in use returns to the Review, and changes only that use", async () => {
  const before = await fullDay();
  Object.assign(mockParams, { asset: "vehicle", usage: vehicleUseAt(at(9).toISOString()), usageState: USAGE_STATE.inUse, via: VIA_FINISH_REVIEW });
  const view = await mount(<CorrectNameRoute />, ["correct-name-save"]);

  await type(view, "correct-name-input", "XY34 ZZY");
  await press(view, "correct-name-save");

  await waitFor(async () => { expect((await open()).vehicle?.numberPlate).toBe("XY34 ZZY"); });
  expect((await open()).previousVehicles).toEqual(before.previousVehicles);
  expect(mockRouter.back).toHaveBeenCalled();
  expect(mockRouter.dismissTo).not.toHaveBeenCalled();
});

test("Edit Shift corrects who the open day is for and an EARLIER start; a start after a use began is explained and not saved", async () => {
  await fullDay();
  const view = await mount(<EditShiftRoute />, ["edit-shift-save"]);

  await type(view, "edit-shift-start-time-hours", "06");
  expect(text(view, "edit-shift-error")).toBe("The start can't be after AB12 CDE began, Sat 19 Sep 2026, 05:00.");
  expect(stateOf(view, "edit-shift-save").disabled).toBe(true);

  await type(view, "edit-shift-start-time-hours", "04");
  await type(view, "edit-shift-start-time-minutes", "30");
  await press(view, "edit-shift-working-for-m1");
  await press(view, "edit-shift-save");

  await waitFor(async () => { expect((await open()).workingFor).toEqual(NORTHGATE); });
  expect((await open()).startedAt).toBe(at(4, 30).toISOString());
  expect(mockRouter.back).toHaveBeenCalled();
  // Choosing a company sent nothing and recorded nothing as sent.
  expect(new File(Paths.document, OPEN_SHIFT_FILE).textSync()).not.toMatch(/sent|submitted/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// The Review re-reads the day; the declaration follows the version
// ═══════════════════════════════════════════════════════════════════════════

test("the declaration starts UNTICKED, is a real checkbox, and the final action waits for it", async () => {
  const { view, confirmed } = await review(await fullDay());

  expect(view.getByTestId("finish-confirm-declaration").props.accessibilityRole).toBe("checkbox");
  expect(view.getByTestId("finish-confirm-declaration").props.accessibilityLabel).toBe("I confirm all details are correct");
  expect(stateOf(view, "finish-confirm-declaration").checked).toBe(false);
  expect(stateOf(view, "finish-confirm").disabled).toBe(true);
  await press(view, "finish-confirm");
  expect(confirmed).toEqual([]);

  await press(view, "finish-confirm-declaration");

  expect(stateOf(view, "finish-confirm-declaration").checked).toBe(true);
  expect(stateOf(view, "finish-confirm").disabled).toBe(false);
});

test("leaving the Review to correct anything clears the declaration — even with nothing changed", async () => {
  const { view } = await review(await fullDay());
  await press(view, "finish-confirm-declaration");

  await press(view, "review-night-out-edit");
  await press(view, "finish-details-continue");

  expect(stateOf(view, "finish-confirm-declaration").checked).toBe(false);
  expect(stateOf(view, "finish-confirm").disabled).toBe(true);
});

test.each([
  ["a plate", async (shift: LocalShift) => { await correctNumberPlate({ shiftId: shift.id, useId: vehicleUseAt(at(9).toISOString()), usageState: USAGE_STATE.inUse, value: "XY34 ZZY" }); }, "review-vehicle-1-title", "XY34 ZZY · Rigid truck"],
  ["a start mileage", async (shift: LocalShift) => { await correctStartMileage({ shiftId: shift.id, vehicleUseId: vehicleUseAt(at(9).toISOString()), usageState: USAGE_STATE.inUse, startMileage: 220_050 }); }, "review-vehicle-1-mileage", "220,050 → 220,100 · 50 mi"],
  ["a fill", async (shift: LocalShift) => { await recordVehicleFill({ shiftId: shift.id, vehicleUseId: vehicleUseAt(at(5).toISOString()), usageState: USAGE_STATE.ended, fillId: "f", type: FILL_TYPE.fuel, recordedAt: at(6), litres: 80, note: "" }); }, "review-vehicle-0-fuel", "Fuel: 80 L · 1 entry"],
  ["the start and who it is for", async (shift: LocalShift) => { await correctOpenShift({ shiftId: shift.id, workingFor: NORTHGATE, startedAt: at(4) }); }, "review-duration", "13 h 40 min"],
  ["a trailer number", async (shift: LocalShift) => { await correctTrailerNumberAt(shift, at(10), "TR24"); }, "review-trailer-0-title", "TR24 · Standard"],
])("a correction of %s shows on the Review at once — and the old declaration no longer holds", async (_what, correction, testID, shown) => {
  const shift = await fullDay();
  const { view, rerender } = await review(shift);
  await press(view, "finish-confirm-declaration");

  await correction(shift);
  await rerender(await open());

  expect(text(view, testID)).toBe(shown);
  expect(stateOf(view, "finish-confirm-declaration").checked).toBe(false);
  expect(stateOf(view, "finish-confirm").disabled).toBe(true);
});

async function correctTrailerNumberAt(shift: LocalShift, startedAt: Date, value: string): Promise<void> {
  await correctTrailerNumber({ shiftId: shift.id, useId: trailerUseAt(startedAt.toISOString()), usageState: USAGE_STATE.ended, value });
}

test("the Finish route RE-READS the day as it comes back into view — a completed check shows, the declaration is clear", async () => {
  const shift = await fullDay();
  const view = await mount(<FinishShiftRoute />, ["final-mileage"]);
  await type(view, "final-mileage", "220100");
  await press(view, "finish-mileage-continue");
  await press(view, "night-out-no");
  await press(view, "finish-details-continue");
  expect(text(view, "review-vehicle-0-checks")).toBe("Not completed");
  await press(view, "finish-confirm-declaration");

  await completeVehicleCheck({
    shiftId: shift.id, vehicleUseId: vehicleUseAt(at(5).toISOString()), usageState: USAGE_STATE.ended, checkId: "late", startedAt: new Date(),
    answers: checklistItems(checklistFor("class1")).map(entry => ({ key: entry.key, result: entry.defaultResult, note: "" })),
    completedAt: new Date(), completedBy: DRIVER.user.id,
  });
  await refocus();

  await waitFor(() => { expect(text(view, "review-vehicle-0-checks")).toBe("Completed"); });
  expect(stateOf(view, "finish-confirm-declaration").checked).toBe(false);
});

// ═══════════════════════════════════════════════════════════════════════════
// What the final action means — Personal saves; a company's says sending is not built
// ═══════════════════════════════════════════════════════════════════════════

test("PERSONAL: 'Save Timesheet' — saved on this phone, nothing sent, nothing claimed sent; still editable and deletable", async () => {
  const shift = await startLocalShift({ workingFor: { kind: "personal" }, startedAt: at(5), vehicle: null });
  jest.mocked(Alert.alert).mockClear();
  const view = await mount(<FinishShiftRoute />, ["night-out-no"]);
  await press(view, "night-out-no");
  await press(view, "finish-details-continue");

  expect(text(view, "finish-confirm-meaning")).toBe("This saves your completed timesheet on this phone. Nothing is sent.");
  expect(view.getByText("Save Timesheet")).toBeTruthy();
  await press(view, "finish-confirm-declaration");
  await press(view, "finish-confirm");

  await waitFor(async () => { expect(await readCompletedShift(shift.id)).not.toBeNull(); });
  const stored = new File(Paths.document, `${COMPLETED_SHIFT_FILE_PREFIX}${shift.id}.json`).textSync();
  expect(stored).not.toMatch(/sent|submitted|declar|confirm/i);
  mockParams.id = shift.id;
  const page = await mount(<TimesheetRoute />, ["timesheet-edit"]);
  expect(page.getByTestId("timesheet-edit")).toBeTruthy();
  expect(page.getByTestId("timesheet-delete")).toBeTruthy();
});

test("COMPANY: the action says plainly that sending is not built — no 'Save & Send', nothing sent, nothing claimed", async () => {
  const shift = await startLocalShift({ workingFor: NORTHGATE, startedAt: at(5), vehicle: null });
  const { view, confirmed } = await review(shift);

  expect(text(view, "finish-confirm-meaning")).toBe("Sending timesheets to Northgate Haulage isn't available yet. This saves it on this phone only — nothing is sent to Northgate Haulage.");
  expect(view.getByText("Save Timesheet — Not Sent")).toBeTruthy();
  expect(view.queryByText(/Save & Send/)).toBeNull();
  await press(view, "finish-confirm-declaration");
  await press(view, "finish-confirm");

  expect(confirmed).toHaveLength(1);
});

test("the declaration marks nothing done: an incomplete check stays incomplete in the saved timesheet", async () => {
  const shift = await fullDay();
  const { view, confirmed } = await review(shift);
  await press(view, "finish-confirm-declaration");
  await press(view, "finish-confirm");
  const finish = confirmed[0];
  if (finish === undefined) throw new Error("expected the confirmation");

  const done = await finishDeclared({ shiftId: shift.id, vehicleUseId: vehicleUseAt(at(9).toISOString()), trailerUseId: trailerUseAt(at(12).toISOString()), ...finish });

  expect(done?.previousVehicles.every(use => use.checks.length === 0)).toBe(true);
  expect(done?.previousTrailers.every(use => use.checks.length === 0)).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// History: a Personal day changed to a company takes the same final path
// ═══════════════════════════════════════════════════════════════════════════

async function finishedPersonalDay(): Promise<CompletedShift> {
  const shift = await startLocalShift({ workingFor: { kind: "personal" }, startedAt: at(5), vehicle: null });
  const done = await finishDeclared({ shiftId: shift.id, vehicleUseId: null, trailerUseId: null, finalMileage: null, endedAt: at(17), nightOut: false, notes: "" });
  if (done === null) throw new Error("expected the day to finish");
  return done;
}

async function editScreen(shift: CompletedShift) {
  const saved: TimesheetEdit[] = [];
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <EditTimesheetScreen shift={shift} memberships={DRIVER.memberships} now={() => at(18)} onLeave={() => undefined} onSave={entered => { saved.push(entered); return Promise.resolve(); }} />
    </SafeAreaProvider>,
  );
  return { view, saved };
}

test("Personal → Company is NOT an ordinary save: it shows the corrected timesheet and waits for the declaration", async () => {
  const { view, saved } = await editScreen(await finishedPersonalDay());

  await press(view, "edit-working-for-m1");
  expect(view.getByText("Review")).toBeTruthy();
  await press(view, "edit-timesheet-save");

  expect(saved).toEqual([]);
  expect(text(view, "screen-title")).toBe("Review Timesheet");
  expect(text(view, "review-working-for")).toBe("Northgate Haulage");
  expect(text(view, "edit-timesheet-final-meaning")).toMatch(/isn't available yet/);
  expect(stateOf(view, "edit-timesheet-final-declaration").checked).toBe(false);
  expect(stateOf(view, "edit-timesheet-final").disabled).toBe(true);
  await press(view, "edit-timesheet-final");
  expect(saved).toEqual([]);

  await press(view, "edit-timesheet-final-declaration");
  await press(view, "edit-timesheet-final");

  expect(saved.map(entry => entry.workingFor)).toEqual([NORTHGATE]);
});

test("going Back from that review clears the declaration; the form keeps what was entered", async () => {
  const { view, saved } = await editScreen(await finishedPersonalDay());
  await press(view, "edit-working-for-m1");
  await press(view, "edit-timesheet-save");
  await press(view, "edit-timesheet-final-declaration");

  await press(view, "edit-timesheet-review-back");
  expect(view.getByTestId("edit-working-for-m1").props.accessibilityState).toMatchObject({ selected: true });
  await press(view, "edit-timesheet-save");

  expect(stateOf(view, "edit-timesheet-final-declaration").checked).toBe(false);
  expect(saved).toEqual([]);
});

test("a Personal day's edit that does NOT make it a company's is an ordinary save (D41, D42)", async () => {
  const personal = await editScreen(await finishedPersonalDay());
  await type(personal.view, "edit-notes", "Late tip");
  expect(personal.view.getByText("Save correction")).toBeTruthy();
  await press(personal.view, "edit-timesheet-save");
  expect(personal.saved).toHaveLength(1);
});

test("the store keeps its rules for the open-day corrections: a start after a use refused; a start mileage above the end refused", async () => {
  const shift = await fullDay();

  await expect(correctOpenShift({ shiftId: shift.id, workingFor: { kind: "personal" }, startedAt: at(6) })).rejects.toThrow(TimesheetBoundsError);
  await expect(correctStartMileage({ shiftId: shift.id, vehicleUseId: vehicleUseAt(at(5).toISOString()), usageState: USAGE_STATE.ended, startMileage: 100_200 })).rejects.toThrow(Error);
  expect(await correctStartMileage({ shiftId: shift.id, vehicleUseId: vehicleUseAt("AB12 CDE"), usageState: USAGE_STATE.ended, startMileage: 1 })).toBeNull();

  expect(await open()).toEqual(shift);
});

test("a start mileage is corrected on EXACTLY one use — never the same plate's other use", async () => {
  const shift = await startLocalShift({ workingFor: { kind: "personal" }, startedAt: at(5), vehicle: UNIT });
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(at(5).toISOString()), endMileage: 100_100, next: RIGID, changedAt: at(9) });
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(at(9).toISOString()), endMileage: 220_040, next: { ...UNIT, startMileage: 100_100 }, changedAt: at(11) });
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(at(11).toISOString()), endMileage: 100_300, next: RIGID, changedAt: at(13) });
  const before = await open();

  // The SECOND use of AB12 CDE — a plate lookup would find the first.
  await correctStartMileage({ shiftId: shift.id, vehicleUseId: vehicleUseAt(at(11).toISOString()), usageState: USAGE_STATE.ended, startMileage: 100_110 });

  const after = await open();
  expect(after.previousVehicles[2]).toEqual({ ...before.previousVehicles[2], startMileage: 100_110 });
  expect(after.previousVehicles[0]).toEqual(before.previousVehicles[0]);
  expect(after.previousVehicles[1]).toEqual(before.previousVehicles[1]);
  expect(after.vehicle).toEqual(before.vehicle);
});
