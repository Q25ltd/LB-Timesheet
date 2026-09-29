/**
 * A finished day, corrected and deleted — the screens (D39, 2026-09-28).
 *
 *   DETAIL      read-only until Edit; says it was corrected, with its history
 *   EDIT        Working For, start, finish, Night Out and notes — the store's
 *               rules said as the driver types, and a correction appended
 *   DELETE      asks first; removes exactly this day
 *   USES        each use of a finished day opens its own screens, by identity
 *   IN USE      Active Shift corrects the plate or trailer number typed wrong
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { Directory, File, Paths } from "expo-file-system";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Alert, Pressable, Text } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AuthenticatedAccount } from "../api/account";
import TimesheetRoute from "../../app/(app)/timesheet";
import EditTimesheetRoute from "../../app/(app)/edit-timesheet";
import Timesheets from "../../app/(app)/(tabs)/timesheets";
import VehicleUsageRoute from "../../app/(app)/vehicle-usage";
import VehicleFillRoute from "../../app/(app)/vehicle-fill";
import VehicleCheckRoute from "../../app/(app)/vehicle-check";
import TrailerDieselRoute from "../../app/(app)/trailer-diesel";
import TrailerCheckRoute from "../../app/(app)/trailer-check";
import ActiveShiftRoute from "../../app/(app)/active-shift";
import CorrectNameRoute from "../../app/(app)/correct-name";
import TrailerUsageRoute from "../../app/(app)/trailer-usage";
import { EditTimesheetScreen, type TimesheetEdit } from "../screens/EditTimesheetScreen";
import { checklistItems, trailerChecklistFor } from "../shift/checklists";
import {
  COMPLETED_SHIFT_FILE_PREFIX,
  USAGE_STATE,
  addTrailerToOpenShift,
  changeTrailer,
  changeVehicle,
  clearOpenShift,
  completeTrailerCheck,
  effectiveUses,
  readCompletedShift,
  readOpenShift,
  startLocalShift,
  type CompletedShift,
  type VehicleDetails,
  type WorkingContext,
} from "../shift/localShift";
import { TRAILER_TYPE } from "../shift/trailer";
import { CHECK_RESULT } from "../shift/vehicleCheck";
import { trailerUseAt, vehicleUseAt } from "./useIdAt";
import { finishDeclared, correctDeclared } from "./declared";

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
const EASTWAY: WorkingContext = { kind: "company", membershipId: "m2", companyId: "c2", companyName: "Eastway Freight" };
const DRIVER: AuthenticatedAccount = {
  user: { id: "user_edit_1", firstName: "Nerijus", lastName: "Kuizinas", email: "driver@example.com" },
  identityToken: "identity.token.value",
  refreshToken: "refresh-secret-value",
  memberships: [
    { membershipId: "m1", companyId: "c1", companyName: "Northgate Haulage", role: "driver" },
    { membershipId: "m2", companyId: "c2", companyName: "Eastway Freight", role: "driver" },
  ],
};
const at = (hours: number, minutes = 0) => new Date(2026, 8, 19, hours, minutes);
const UNIT: VehicleDetails = { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 };
const RIGID: VehicleDetails = { vehicleClass: "class2", numberPlate: "XY34 ZZZ", startMileage: 220_000 };

type View = Awaited<ReturnType<typeof render>>;
const text = (view: View, testID: string) => {
  const children = (view.getByTestId(testID).props as { children?: unknown }).children;
  return Array.isArray(children) ? children.join("") : String(children);
};
const isDisabled = (view: View, testID: string) =>
  (view.getByTestId(testID).props as { accessibilityState?: { disabled?: boolean } }).accessibilityState?.disabled === true;
async function press(view: View, testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(view.getByTestId(testID)); });
}
async function type(view: View, testID: string, value: string): Promise<void> {
  await act(async () => { await fireEvent.changeText(view.getByTestId(testID), value); });
}
/** On the company review: declare it correct, then take the final action (D41). */
async function declareAndSave(view: View): Promise<void> {
  await press(view, "edit-timesheet-final-declaration");
  await press(view, "edit-timesheet-final");
}
async function refocus(): Promise<void> {
  await act(async () => { for (const again of [...mockFocus]) again(); await Promise.resolve(); });
}
const recordBytes = (id: string) => new File(Paths.document, `${COMPLETED_SHIFT_FILE_PREFIX}${id}.json`).textSync();

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
const detail = (id: string) => { mockParams.id = id; return mount(<TimesheetRoute />, ["timesheet-date", "timesheet-missing"]); };
const edit = (id: string) => { mockParams.id = id; return mount(<EditTimesheetRoute />, ["edit-timesheet-save"]); };

/** A plain finished day 05:00–17:00, no vehicle. */
async function plainDay(workingFor: WorkingContext = { kind: "personal" }): Promise<CompletedShift> {
  const shift = await startLocalShift({ workingFor, startedAt: at(5), vehicle: null });
  const done = await finishDeclared({ shiftId: shift.id, vehicleUseId: null, trailerUseId: null, finalMileage: null, endedAt: at(17), nightOut: false, notes: "" });
  if (done === null) throw new Error("expected the day to finish");
  return done;
}

/** AB12 CDE 05:00–09:00, XY34 ZZZ 09:00–17:00; TR23 10:00–12:00 then RF77 12:00–17:00. */
async function busyDay(): Promise<CompletedShift> {
  const shift = await startLocalShift({ workingFor: NORTHGATE, startedAt: at(5), vehicle: UNIT });
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(at(5).toISOString()), endMileage: 100_100, next: RIGID, changedAt: at(9) });
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: { trailerNumber: "TR23", trailerType: TRAILER_TYPE.standard }, startedAt: at(10) });
  await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(at(10).toISOString()), next: { trailerNumber: "RF77", trailerType: TRAILER_TYPE.refrigerated }, changedAt: at(12) });
  const done = await finishDeclared({ shiftId: shift.id, vehicleUseId: vehicleUseAt(at(9).toISOString()), trailerUseId: trailerUseAt(at(12).toISOString()), finalMileage: 220_080, endedAt: at(17), nightOut: false, notes: "" });
  if (done === null) throw new Error("expected the day to finish");
  return done;
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
// Detail and Edit
// ═══════════════════════════════════════════════════════════════════════════

test("the page is READ-ONLY until Edit: nothing to type into, and Edit / Delete Timesheet are offered", async () => {
  const done = await plainDay();
  const view = await detail(done.id);

  // No field of any kind holds a value to edit.
  expect(view.queryAllByDisplayValue(/.*/)).toEqual([]);
  expect(view.queryByTestId("timesheet-corrected")).toBeNull();
  await press(view, "timesheet-edit");

  expect(mockRouter.push).toHaveBeenCalledWith({ pathname: "/edit-timesheet", params: { id: done.id } });
  expect(view.getByTestId("timesheet-delete")).toBeTruthy();
});

test("Edit opens on the day as it stands, with nothing to save until something changes", async () => {
  const done = await plainDay(NORTHGATE);
  const view = await edit(done.id);

  expect(view.getByTestId("edit-working-for-m1").props.accessibilityState).toMatchObject({ selected: true });
  expect(view.getByTestId("edit-start-time-hours").props.value).toBe("05");
  expect(view.getByTestId("edit-finish-time-hours").props.value).toBe("17");
  expect(text(view, "edit-start-date")).toBe("Sat 19 Sep 2026");
  expect(isDisabled(view, "edit-timesheet-save")).toBe(true);
});

test("correcting Working For Personal → company, Night Out and notes APPENDS a correction; the page shows it, and its history keeps the original", async () => {
  const done = await plainDay();
  const view = await edit(done.id);

  await press(view, "edit-working-for-m1");
  await press(view, "edit-night-out-yes");
  await type(view, "edit-notes", "Tipped late");
  await press(view, "edit-timesheet-save");
  // To a company: the corrected timesheet is reviewed and declared first (D41).
  await declareAndSave(view);

  await waitFor(() => { expect(mockRouter.back).toHaveBeenCalled(); });
  const stored = await readCompletedShift(done.id);
  expect(stored?.workingFor).toEqual({ kind: "personal" });
  expect(stored?.corrections).toEqual([expect.objectContaining({ workingFor: NORTHGATE, nightOut: true, notes: "Tipped late", correctedBy: DRIVER.user.id })]);

  const page = await detail(done.id);
  expect(text(page, "timesheet-working-for")).toBe("Northgate Haulage");
  expect(text(page, "timesheet-night-out")).toBe("Yes");
  expect(text(page, "timesheet-notes")).toBe("Tipped late");
  expect(text(page, "timesheet-corrected")).toMatch(/^Corrected · last /);
  await press(page, "timesheet-history-toggle");
  expect(page.getByTestId("timesheet-history-original")).toBeTruthy();
  expect(page.getByText("Working for: Personal → Northgate Haulage")).toBeTruthy();
  expect(page.getByText("Night out: No → Yes")).toBeTruthy();
  expect(page.getByText("Notes added")).toBeTruthy();
});

test("company A → company B, and company → Personal", async () => {
  const done = await plainDay(NORTHGATE);
  const first = await edit(done.id);
  await press(first, "edit-working-for-m2");
  await press(first, "edit-timesheet-save");
  await declareAndSave(first);
  await waitFor(async () => { expect((await readCompletedShift(done.id))?.corrections?.[0]?.workingFor).toEqual(EASTWAY); });
  await first.unmount();

  const second = await edit(done.id);
  await press(second, "edit-working-for-personal");
  // Leaving a company is still a change to a company's timesheet: reviewed and declared (D42).
  expect(second.getByText("Review")).toBeTruthy();
  await press(second, "edit-timesheet-save");
  await declareAndSave(second);

  await waitFor(async () => { expect((await readCompletedShift(done.id))?.corrections?.[1]?.workingFor).toEqual({ kind: "personal" }); });
});

test("a day worked for a company the driver no longer belongs to keeps it as an option — never dropped", async () => {
  const done = await plainDay({ kind: "company", membershipId: "m9", companyId: "c9", companyName: "Old Employer Ltd" });
  const view = await edit(done.id);

  expect(view.getByTestId("edit-working-for-m9").props.accessibilityState).toMatchObject({ selected: true });
  expect(view.getByTestId("edit-working-for-m1")).toBeTruthy();
});

test("a start corrected to the evening BEFORE — across midnight — is saved on the day given", async () => {
  const done = await plainDay();
  const view = await edit(done.id);

  await press(view, "edit-start-date-previous");
  await type(view, "edit-start-time-hours", "22");
  await type(view, "edit-start-time-minutes", "00");
  await press(view, "edit-timesheet-save");

  await waitFor(async () => {
    expect((await readCompletedShift(done.id))?.corrections?.[0]?.startedAt).toBe(new Date(2026, 8, 18, 22, 0).toISOString());
  });
});

test.each([
  ["a start AFTER a use began", async (view: View) => { await type(view, "edit-start-time-hours", "06"); }, "The start can't be after AB12 CDE began, Sat 19 Sep 2026, 05:00."],
  // XY34 ZZZ and RF77 were in use at the finish, so they move with it — but never
  // to before they began; the later start is the one that binds (D40).
  ["a finish before a finish-ended use BEGAN", async (view: View) => { await type(view, "edit-finish-time-hours", "11"); }, "The finish can't be before trailer RF77 started, Sat 19 Sep 2026, 12:00."],
  ["a finish before the start", async (view: View) => { await press(view, "edit-finish-date-previous"); }, "The finish can't be before the start."],
])("%s is explained and cannot be saved — nothing is moved to make it fit", async (_what, act_, message) => {
  const done = await busyDay();
  const before = recordBytes(done.id);
  const view = await edit(done.id);

  await act_(view);

  expect(text(view, "edit-timesheet-error")).toBe(message);
  expect(isDisabled(view, "edit-timesheet-save")).toBe(true);
  expect(recordBytes(done.id)).toBe(before);
});

test("a STALE edit — the day corrected elsewhere since it opened — saves nothing and says so", async () => {
  const done = await plainDay();
  const view = await edit(done.id);
  await correctDeclared({
    shiftId: done.id, basedOn: null, correctionId: "elsewhere", workingFor: { kind: "personal" }, startedAt: at(5), endedAt: at(17),
    nightOut: true, notes: "", correctedAt: new Date(), correctedBy: DRIVER.user.id,
  });
  const before = recordBytes(done.id);

  await type(view, "edit-notes", "From the stale screen");
  await press(view, "edit-timesheet-save");

  await waitFor(() => { expect(Alert.alert).toHaveBeenCalledWith("Nothing was saved", expect.stringContaining("changed after you opened it")); });
  expect(recordBytes(done.id)).toBe(before);
});

// ═══════════════════════════════════════════════════════════════════════════
// Delete Timesheet
// ═══════════════════════════════════════════════════════════════════════════

type AlertButtons = { text?: string; style?: string; onPress?: () => void }[];
function deleteButtons(): AlertButtons {
  const call = jest.mocked(Alert.alert).mock.calls.find(([title]) => title === "Delete this timesheet?");
  expect(call?.[1]).toBe("This removes the local timesheet from this phone.");
  return call?.[2] ?? [];
}

test("Delete asks first: Cancel leaves the timesheet exactly as it was", async () => {
  const done = await plainDay();
  const before = recordBytes(done.id);
  const view = await detail(done.id);

  await press(view, "timesheet-delete");
  const buttons = deleteButtons();
  expect(buttons.map(button => button.text)).toEqual(["Cancel", "Delete Timesheet"]);
  await act(async () => { buttons.find(button => button.text === "Cancel")?.onPress?.(); await Promise.resolve(); });

  expect(recordBytes(done.id)).toBe(before);
  expect(mockRouter.back).not.toHaveBeenCalled();
});

test("confirmed, Delete removes EXACTLY this timesheet and returns; the list shows what remains, then the empty state", async () => {
  const gone = await plainDay();
  const kept = await plainDay(NORTHGATE);
  const list = await mount(<Timesheets />, ["timesheets-list"]);
  const view = await detail(gone.id);

  await press(view, "timesheet-delete");
  await act(async () => { deleteButtons().find(button => button.text === "Delete Timesheet")?.onPress?.(); await Promise.resolve(); });

  await waitFor(() => { expect(mockRouter.back).toHaveBeenCalled(); });
  expect(await readCompletedShift(gone.id)).toBeNull();
  expect(await readCompletedShift(kept.id)).not.toBeNull();
  await refocus();
  await waitFor(() => { expect(list.queryByTestId("timesheet-1")).toBeNull(); });
  expect(text(list, "timesheet-0-working-for")).toBe("Northgate Haulage");

  const last = await detail(kept.id);
  jest.mocked(Alert.alert).mockClear();
  await press(last, "timesheet-delete");
  await act(async () => { deleteButtons().find(button => button.text === "Delete Timesheet")?.onPress?.(); await Promise.resolve(); });
  await waitFor(async () => { expect(await readCompletedShift(kept.id)).toBeNull(); });
  await refocus();
  await waitFor(() => { expect(list.getByTestId("timesheets-empty")).toBeTruthy(); });
});

test("a Delete that FAILS says nothing was deleted — and the timesheet is still there", async () => {
  const done = await plainDay();
  const view = await detail(done.id);
  const failing = jest.spyOn(File.prototype, "delete").mockImplementation(() => { throw new Error("busy"); });

  await press(view, "timesheet-delete");
  await act(async () => { deleteButtons().find(button => button.text === "Delete Timesheet")?.onPress?.(); await Promise.resolve(); });

  await waitFor(() => { expect(Alert.alert).toHaveBeenCalledWith("Couldn't delete the timesheet", "Nothing was deleted. Please try again."); });
  failing.mockRestore();
  expect(await readCompletedShift(done.id)).toEqual(done);
  expect(mockRouter.back).not.toHaveBeenCalled();
});

// ═══════════════════════════════════════════════════════════════════════════
// A finished day's uses, each by its identity
// ═══════════════════════════════════════════════════════════════════════════

test("each use opens its own page and check BY IDENTITY, naming the finished day", async () => {
  const done = await busyDay();
  const view = await detail(done.id);

  await press(view, "timesheet-vehicle-1-open");
  await press(view, "timesheet-vehicle-0-check-action");
  await press(view, "timesheet-trailer-1-open");
  await press(view, "timesheet-trailer-0-check-action");

  expect(mockRouter.push.mock.calls.map(([href]: unknown[]) => href)).toEqual([
    { pathname: "/vehicle-usage", params: { usage: vehicleUseAt(at(9).toISOString()), timesheet: done.id } },
    { pathname: "/vehicle-check", params: { usage: vehicleUseAt(at(5).toISOString()), usageState: USAGE_STATE.ended, timesheet: done.id } },
    { pathname: "/trailer-usage", params: { usage: trailerUseAt(at(12).toISOString()), timesheet: done.id } },
    { pathname: "/trailer-check", params: { trailer: trailerUseAt(at(10).toISOString()), usageState: USAGE_STATE.ended, timesheet: done.id } },
  ]);
  expect(view.getByTestId("timesheet-vehicle-0-check-action").props.accessibilityLabel).toBe("Complete check");
});

test("Vehicle Use of a finished day corrects its END MILEAGE on that use only", async () => {
  const done = await busyDay();
  Object.assign(mockParams, { usage: vehicleUseAt(at(5).toISOString()), timesheet: done.id });
  const view = await mount(<VehicleUsageRoute />, ["usage-edit"]);

  await press(view, "usage-edit");
  await type(view, "usage-end-mileage-input", "100150");
  await press(view, "usage-end-mileage-save");

  const after = await readCompletedShift(done.id);
  expect(after?.previousVehicles.map(use => use.endMileage)).toEqual([100_150, 220_080]);
  expect(await readOpenShift()).toBeNull();
});

test("Fuel is added to a finished day's use from its Fuel screen", async () => {
  const done = await busyDay();
  Object.assign(mockParams, { type: "fuel", usage: vehicleUseAt(at(9).toISOString()), usageState: USAGE_STATE.ended, timesheet: done.id });
  const view = await mount(<VehicleFillRoute />, ["fill-save"]);

  await press(view, "amount-known");
  await type(view, "litres", "180");
  await press(view, "fill-save");

  await waitFor(async () => { expect((await readCompletedShift(done.id))?.previousVehicles[1]?.fills).toMatchObject([{ type: "fuel", litres: 180 }]); });
  expect((await readCompletedShift(done.id))?.previousVehicles[0]?.fills).toEqual([]);
});

test("a FORGOTTEN vehicle check is completed after the finish — by the driver, now — and returns to the day", async () => {
  const done = await busyDay();
  Object.assign(mockParams, { usage: vehicleUseAt(at(5).toISOString()), usageState: USAGE_STATE.ended, timesheet: done.id });
  const view = await mount(<VehicleCheckRoute />, ["complete-check"]);
  const pressedAt = Date.now();

  await press(view, "complete-check");

  await waitFor(async () => { expect((await readCompletedShift(done.id))?.previousVehicles[0]?.checks[0]?.status).toBe("completed"); });
  const check = (await readCompletedShift(done.id))?.previousVehicles[0]?.checks[0];
  expect(check?.completedBy).toBe(DRIVER.user.id);
  expect(Date.parse(check?.completedAt ?? "")).toBeGreaterThanOrEqual(pressedAt);
  expect((await readCompletedShift(done.id))?.previousVehicles[1]?.checks).toEqual([]);
  expect(mockRouter.back).toHaveBeenCalled();
});

test("Fridge Diesel is added to a finished day's refrigerated trailer use", async () => {
  const done = await busyDay();
  Object.assign(mockParams, { trailer: trailerUseAt(at(12).toISOString()), usageState: USAGE_STATE.ended, timesheet: done.id });
  const view = await mount(<TrailerDieselRoute />, ["fill-save"]);

  await press(view, "amount-unknown");
  await press(view, "fill-save");

  await waitFor(async () => { expect((await readCompletedShift(done.id))?.previousTrailers[1]?.reeferDiesel).toMatchObject([{ litres: null }]); });
});

test("a completed Trailer Check on a finished day is CORRECTED by an appended revision", async () => {
  const done = await busyDay();
  const items = checklistItems(trailerChecklistFor(TRAILER_TYPE.standard));
  await completeTrailerCheck({
    shiftId: done.id, trailerUseId: trailerUseAt(at(10).toISOString()), usageState: USAGE_STATE.ended, checkId: "tc", startedAt: new Date(),
    answers: items.map(entry => ({ key: entry.key, result: entry.defaultResult, note: "" })), completedAt: new Date(), completedBy: DRIVER.user.id,
  });
  Object.assign(mockParams, { trailer: trailerUseAt(at(10).toISOString()), usageState: USAGE_STATE.ended, timesheet: done.id });
  const view = await mount(<TrailerCheckRoute />, ["correct-check"]);
  const first = items[0];
  if (first === undefined) throw new Error("expected a row");

  await press(view, "correct-check");
  await press(view, `check-${first.key}-fail`);
  await type(view, `check-note-${first.key}`, "Found later");
  await press(view, "confirm-correction");

  await waitFor(async () => { expect((await readCompletedShift(done.id))?.previousTrailers[0]?.checks[0]?.revisions).toHaveLength(1); });
  const check = (await readCompletedShift(done.id))?.previousTrailers[0]?.checks[0];
  expect(check?.items.every(item => item.result !== CHECK_RESULT.defect)).toBe(true);
});

test("on a finished day nothing is IN USE: a use screen asked for one goes to the timesheets", async () => {
  const done = await busyDay();
  Object.assign(mockParams, { type: "fuel", usage: vehicleUseAt(at(9).toISOString()), usageState: USAGE_STATE.inUse, timesheet: done.id });

  const view = await mount(<VehicleFillRoute />, ["redirect"]);

  expect(text(view, "redirect")).toBe("/timesheets");
});

// ═══════════════════════════════════════════════════════════════════════════
// Active Shift — the plate or trailer number typed wrong
// ═══════════════════════════════════════════════════════════════════════════

test("the vehicle card offers Correct number plate for the EXACT use in it; the correction changes only the plate", async () => {
  const shift = await startLocalShift({ workingFor: { kind: "personal" }, startedAt: at(5), vehicle: { ...UNIT, numberPlate: "AB12 CED" } });
  const card = await mount(<ActiveShiftRoute />, ["correct-plate"]);
  await press(card, "correct-plate");
  expect(mockRouter.push).toHaveBeenCalledWith({ pathname: "/correct-name", params: { asset: "vehicle", usage: vehicleUseAt(at(5).toISOString()), usageState: USAGE_STATE.inUse } });
  const before = (await readOpenShift())?.vehicle;

  Object.assign(mockParams, { asset: "vehicle", usage: vehicleUseAt(at(5).toISOString()), usageState: USAGE_STATE.inUse });
  const view = await mount(<CorrectNameRoute />, ["correct-name-save"]);
  expect(isDisabled(view, "correct-name-save")).toBe(true);
  await type(view, "correct-name-input", "ab12 cde");
  await press(view, "correct-name-save");

  await waitFor(async () => { expect((await readOpenShift())?.vehicle?.numberPlate).toBe("AB12 CDE"); });
  expect((await readOpenShift())?.vehicle).toEqual({ ...before, numberPlate: "AB12 CDE" });
  expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift");
  expect(shift.id).toBe((await readOpenShift())?.id);
});

test("the trailer card offers Correct trailer number; a stale screen saves nothing and says so", async () => {
  const shift = await startLocalShift({ workingFor: { kind: "personal" }, startedAt: at(5), vehicle: UNIT });
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: { trailerNumber: "TR2", trailerType: TRAILER_TYPE.standard }, startedAt: at(6) });
  Object.assign(mockParams, { asset: "trailer", usage: trailerUseAt(at(6).toISOString()), usageState: USAGE_STATE.inUse });
  const view = await mount(<CorrectNameRoute />, ["correct-name-save"]);
  await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(at(6).toISOString()), next: { trailerNumber: "GFD", trailerType: TRAILER_TYPE.standard }, changedAt: at(8) });

  await type(view, "correct-name-input", "TR23");
  await press(view, "correct-name-save");

  await waitFor(() => { expect(Alert.alert).toHaveBeenCalledWith("Nothing was saved", "That trailer is no longer the one this was opened for."); });
  expect((await readOpenShift())?.trailer?.trailerNumber).toBe("GFD");
  expect((await readOpenShift())?.previousTrailers[0]?.trailerNumber).toBe("TR2");
});

// ═══════════════════════════════════════════════════════════════════════════
// Edit Timesheet — a corrected finish ahead of now is confirmed, never refused (D40)
// ═══════════════════════════════════════════════════════════════════════════

type AheadButtons = { text?: string; style?: string; onPress?: () => void }[];
const aheadCalls = () =>
  jest.mocked(Alert.alert).mock.calls.filter(([title]) => title === "Finish time is ahead") as [string, string, AheadButtons][];

/** The edit screen alone, the day finished at 17:00, with the clock at `clock` when Save is pressed. */
async function editAt(clock: () => Date) {
  const done = await plainDay();
  const saved: TimesheetEdit[] = [];
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <EditTimesheetScreen shift={done} memberships={DRIVER.memberships} now={clock} onLeave={() => undefined} onSave={entered => { saved.push(entered); return Promise.resolve(); }} />
    </SafeAreaProvider>,
  );
  return { view, saved, done };
}

test.each([
  ["15 minutes ahead exactly", "17", "05", false],
  ["a minute past 15 ahead", "17", "06", true],
])("a corrected finish %s — asks: %s", async (_what, hours, minutes, asks) => {
  let clock = at(16, 50);
  const { view, saved } = await editAt(() => clock);
  await type(view, "edit-finish-time-hours", hours);
  await type(view, "edit-finish-time-minutes", minutes);

  clock = at(16, 50);
  await press(view, "edit-timesheet-save");

  expect(aheadCalls()).toHaveLength(asks ? 1 : 0);
  expect(saved).toHaveLength(asks ? 0 : 1);
});

test("Edit asks against the clock AT THE PRESS — not when the screen opened", async () => {
  let clock = at(16, 30);
  const { view, saved } = await editAt(() => clock);
  await type(view, "edit-finish-time-hours", "17");
  await type(view, "edit-finish-time-minutes", "10");

  // 17:10 is 40 minutes ahead of the opening clock, but only 10 ahead by the press.
  clock = at(17, 0);
  await press(view, "edit-timesheet-save");

  expect(aheadCalls()).toEqual([]);
  expect(saved).toHaveLength(1);
});

test("an UNCHANGED finish is never asked about, whatever the clock — only a corrected one is", async () => {
  const { view, saved } = await editAt(() => at(10));
  await press(view, "edit-night-out-yes");

  await press(view, "edit-timesheet-save");

  expect(aheadCalls()).toEqual([]);
  expect(saved).toHaveLength(1);
});

test("GO BACK saves nothing; USE THIS TIME saves the exact finish given — the correction history kept", async () => {
  const done = await plainDay();
  await correctDeclared({
    shiftId: done.id, basedOn: null, correctionId: "earlier", workingFor: { kind: "personal" }, startedAt: at(5), endedAt: at(17),
    nightOut: true, notes: "", correctedAt: new Date(), correctedBy: DRIVER.user.id,
  });
  const before = recordBytes(done.id);
  const view = await edit(done.id);
  for (let step = 0; step < 30; step += 1) await press(view, "edit-finish-date-next");
  const declared = new Date(2026, 9, 19, 17, 0);

  await press(view, "edit-timesheet-save");
  const [[, , firstButtons]] = aheadCalls() as [[string, string, AheadButtons]];
  await act(async () => { firstButtons.find(button => button.text === "Go Back")?.onPress?.(); await Promise.resolve(); });
  expect(recordBytes(done.id)).toBe(before);

  await press(view, "edit-timesheet-save");
  const [, [, , buttons]] = aheadCalls() as [unknown, [string, string, AheadButtons]];
  await act(async () => { buttons.find(button => button.text === "Use This Time")?.onPress?.(); await Promise.resolve(); });

  await waitFor(async () => { expect((await readCompletedShift(done.id))?.corrections).toHaveLength(2); });
  const stored = await readCompletedShift(done.id);
  expect(stored?.corrections?.[0]?.id).toBe("earlier");
  expect(stored?.corrections?.[1]?.endedAt).toBe(declared.toISOString());
});

test("a corrected finish moves the vehicle and trailer the finish ended — the handed-back ones stay", async () => {
  const done = await busyDay();
  const view = await edit(done.id);
  await type(view, "edit-finish-time-hours", "16");
  await type(view, "edit-finish-time-minutes", "30");

  // A company's day: the corrected timesheet is reviewed and declared.
  await press(view, "edit-timesheet-save");
  await declareAndSave(view);

  await waitFor(async () => { expect((await readCompletedShift(done.id))?.corrections).toHaveLength(1); });
  const stored = await readCompletedShift(done.id);
  if (stored === null) throw new Error("expected the day");
  const uses = effectiveUses(stored);
  expect(uses.previousVehicles.map(use => use.endedAt)).toEqual([at(9).toISOString(), at(16, 30).toISOString()]);
  expect(uses.previousTrailers.map(use => use.endedAt)).toEqual([at(12).toISOString(), at(16, 30).toISOString()]);

  const page = await detail(done.id);
  expect(text(page, "timesheet-vehicle-1-ended")).toBe("16:30");
  expect(text(page, "timesheet-vehicle-0-ended")).toBe("09:00");
  await press(page, "timesheet-history-toggle");
  expect(page.getByText("XY34 ZZZ and trailer RF77 end with the finish")).toBeTruthy();
});

// ═══════════════════════════════════════════════════════════════════════════
// A plate or trailer number typed wrong — on ANY use, by its identity (D40)
// ═══════════════════════════════════════════════════════════════════════════

test("a finished day's Vehicle Use offers Correct number plate for EXACTLY that use; the correction lands on it alone", async () => {
  const done = await busyDay();
  Object.assign(mockParams, { usage: vehicleUseAt(at(9).toISOString()), timesheet: done.id });
  const usage = await mount(<VehicleUsageRoute />, ["usage-correct-plate"]);
  await press(usage, "usage-correct-plate");
  expect(mockRouter.push).toHaveBeenCalledWith({ pathname: "/correct-name", params: { asset: "vehicle", usage: vehicleUseAt(at(9).toISOString()), usageState: USAGE_STATE.ended, timesheet: done.id } });

  Object.assign(mockParams, { asset: "vehicle", usage: vehicleUseAt(at(9).toISOString()), usageState: USAGE_STATE.ended, timesheet: done.id });
  const view = await mount(<CorrectNameRoute />, ["correct-name-save"]);
  await type(view, "correct-name-input", "xy34 zzy");
  await press(view, "correct-name-save");

  await waitFor(async () => { expect((await readCompletedShift(done.id))?.previousVehicles[1]?.numberPlate).toBe("XY34 ZZY"); });
  const after = await readCompletedShift(done.id);
  expect(after?.previousVehicles[1]).toEqual({ ...done.previousVehicles[1], numberPlate: "XY34 ZZY" });
  expect(after?.previousVehicles[0]).toEqual(done.previousVehicles[0]);
  expect(mockRouter.back).toHaveBeenCalled();
});

test("a finished day's Trailer Use offers Correct trailer number for EXACTLY that use", async () => {
  const done = await busyDay();
  Object.assign(mockParams, { usage: trailerUseAt(at(10).toISOString()), timesheet: done.id });
  const usage = await mount(<TrailerUsageRoute />, ["trailer-usage-correct-number"]);
  await press(usage, "trailer-usage-correct-number");
  expect(mockRouter.push).toHaveBeenCalledWith({ pathname: "/correct-name", params: { asset: "trailer", usage: trailerUseAt(at(10).toISOString()), usageState: USAGE_STATE.ended, timesheet: done.id } });

  Object.assign(mockParams, { asset: "trailer", usage: trailerUseAt(at(10).toISOString()), usageState: USAGE_STATE.ended, timesheet: done.id });
  const view = await mount(<CorrectNameRoute />, ["correct-name-save"]);
  await type(view, "correct-name-input", "TR24");
  await press(view, "correct-name-save");

  await waitFor(async () => { expect((await readCompletedShift(done.id))?.previousTrailers[0]?.trailerNumber).toBe("TR24"); });
  expect((await readCompletedShift(done.id))?.previousTrailers[1]).toEqual(done.previousTrailers[1]);
});
