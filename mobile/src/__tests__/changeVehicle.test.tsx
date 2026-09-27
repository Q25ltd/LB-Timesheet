/**
 * Change Unit / Change Vehicle — the screen, and the route that stores it.
 *
 * These drive the real route against the real store. They prove what the
 * driver is asked and offered — end mileage first, then the vehicles used
 * earlier today, most recent first, one entry per vehicle — that nothing is
 * written until the change is confirmed, and where a confirmed change leads:
 * a returned-to vehicle is a new use, checked afresh or not at all, never on
 * the strength of the morning's certificate.
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { File } from "expo-file-system";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Text, Pressable } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AuthenticatedAccount } from "../api/account";
import ChangeVehicleRoute from "../../app/(app)/change-vehicle";
import { ChangeVehicleScreen } from "../screens/ChangeVehicleScreen";
import ActiveShiftRoute from "../../app/(app)/active-shift";
import AddVehicleRoute from "../../app/(app)/add-vehicle";
import VehicleCheckRoute from "../../app/(app)/vehicle-check";
import { checklistFor, checklistItems } from "../shift/checklists";
import {
  OPEN_SHIFT_FILE,
  changeVehicle,
  clearOpenShift,
  completeVehicleCheck,
  readOpenShift,
  startLocalShift,
  type LocalShift,
  type VehicleDetails,
} from "../shift/localShift";
import { Paths } from "expo-file-system";

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismissTo: jest.fn() };

jest.mock("expo-router", () => {
  const react = jest.requireActual<typeof import("react")>("react");
  const rn = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    __esModule: true,
    router: {
      replace:   (href: string): void => { mockRouter.replace(href); },
      push:      (href: string): void => { mockRouter.push(href); },
      back:      (): void => { mockRouter.back(); },
      navigate:  (href: string): void => { mockRouter.navigate(href); },
      dismissTo: (href: string): void => { mockRouter.dismissTo(href); },
    },
    Redirect: ({ href }: { href: string }) => react.createElement(rn.Text, { testID: "redirect" }, String(href)),
    useFocusEffect: (effect: () => (() => void) | undefined) => { react.useEffect(effect, [effect]); },
  };
});

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const STARTED_AT = new Date(2026, 8, 19, 5, 30);
const at = (hours: number, minutes = 0) => new Date(2026, 8, 19, hours, minutes);
const AB12: VehicleDetails = { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 };
const XY34: VehicleDetails = { vehicleClass: "class1", numberPlate: "XY34 ZZZ", startMileage: 220_000 };
const CD56: VehicleDetails = { vehicleClass: "class1", numberPlate: "CD56 EFG", startMileage: 300_000 };

const DRIVER: AuthenticatedAccount = {
  user: { id: "user_1", firstName: "Nerijus", lastName: "Kuizinas", email: "driver@example.com" },
  identityToken: "identity.token.value",
  refreshToken: "refresh-secret-value",
  memberships: [],
};

type View = Awaited<ReturnType<typeof render>>;

const wrap = (node: React.ReactElement): Promise<View> =>
  render(<SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>);
const storedBytes = () => new File(Paths.document, OPEN_SHIFT_FILE).textSync();

async function press(view: View, testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(view.getByTestId(testID)); });
}
async function type(view: View, testID: string, value: string): Promise<void> {
  await act(async () => { await fireEvent.changeText(view.getByTestId(testID), value); });
}
function isDisabled(view: View, testID: string): boolean {
  const state: unknown = view.getByTestId(testID).props.accessibilityState;
  return typeof state === "object" && state !== null && "disabled" in state && state.disabled === true;
}
const text = (view: View, testID: string) => String(view.getByTestId(testID).props.children);
const candidates = (view: View) =>
  view.queryAllByTestId(/^candidate-/).map(node => String(node.props.testID).slice("candidate-".length));

async function dayWith(vehicle: VehicleDetails = AB12): Promise<LocalShift> {
  return startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle });
}

/** A change made directly through the store — how a day gets its history before the screen is opened. */
async function changed(to: VehicleDetails, hour: number): Promise<void> {
  const open = await readOpenShift();
  if (open?.vehicle == null) throw new Error("expected a vehicle in use");
  await changeVehicle({
    shiftId: open.id, endingStartedAt: open.vehicle.startedAt, endMileage: open.vehicle.startMileage + 50,
    changedAt: at(hour), next: to,
  });
}

async function openChange(): Promise<View> {
  const view = await wrap(<ChangeVehicleRoute />);
  await waitFor(() => { expect(view.queryByTestId("screen-title")).not.toBeNull(); });
  return view;
}

/** Through the end-mileage step, to the choice of what comes next. */
async function toNextStep(view: View, endMileage: string): Promise<void> {
  await type(view, "end-mileage", endMileage);
  await press(view, "change-continue");
}

async function completeCheckOnCurrent(): Promise<void> {
  const open = await readOpenShift();
  if (open?.vehicle == null) throw new Error("expected a vehicle in use");
  await completeVehicleCheck({
    shiftId: open.id, vehicleStartedAt: open.vehicle.startedAt, checkId: "morning", startedAt: at(5, 40),
    answers: checklistItems(checklistFor("class1")).map(entry => ({ key: entry.key, result: entry.defaultResult, note: "" })),
    completedAt: at(5, 50), completedBy: DRIVER.user.id,
  });
}

beforeEach(async () => {
  await clearOpenShift();
  for (const fn of Object.values(mockRouter)) fn.mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// What it is called, and what opening it does
// ═══════════════════════════════════════════════════════════════════════════

test("a Class 1 is CHANGE UNIT, from Active Shift to the screen itself", async () => {
  await dayWith();
  const active = await wrap(<ActiveShiftRoute />);
  await waitFor(() => { expect(active.queryByTestId("change-vehicle")).not.toBeNull(); });
  expect(active.getByTestId("change-vehicle").props.accessibilityLabel).toBe("Change Unit");
  await press(active, "change-vehicle");
  expect(mockRouter.push).toHaveBeenCalledWith("/change-vehicle");
  await active.unmount();

  const view = await openChange();
  expect(text(view, "screen-title")).toBe("Change Unit");
  expect(view.getByText("ENDING UNIT")).toBeTruthy();
});

test.each([["class2"], ["van"]] as const)("a %s is CHANGE VEHICLE", async vehicleClass => {
  await dayWith({ vehicleClass, numberPlate: "RG11 AAA", startMileage: 10 });

  const view = await openChange();

  expect(text(view, "screen-title")).toBe("Change Vehicle");
  expect(view.getByText("ENDING VEHICLE")).toBeTruthy();
});

test("the wording follows the CURRENT use, not the day — a unit swapped for a van becomes Change Vehicle, and back", async () => {
  await dayWith();
  await changed({ vehicleClass: "van", numberPlate: "VN11 BBB", startMileage: 500 }, 9);

  const active = await wrap(<ActiveShiftRoute />);
  await waitFor(() => { expect(active.queryByTestId("change-vehicle")).not.toBeNull(); });
  expect(active.getByTestId("change-vehicle").props.accessibilityLabel).toBe("Change Vehicle");
  expect(active.getByText("CURRENT VEHICLE")).toBeTruthy();
  await active.unmount();

  const asVan = await openChange();
  expect(text(asVan, "screen-title")).toBe("Change Vehicle");
  expect(asVan.getByText("ENDING VEHICLE")).toBeTruthy();
  await asVan.unmount();

  await changed(AB12, 11);
  const asUnit = await openChange();
  expect(text(asUnit, "screen-title")).toBe("Change Unit");
  expect(asUnit.getByText("ENDING UNIT")).toBeTruthy();
});

test("the vehicle being ended is named — its plate and start mileage", async () => {
  await dayWith();

  const view = await openChange();

  expect(text(view, "ending-plate")).toBe("AB12 CDE");
  expect(text(view, "ending-start-mileage")).toBe("Class 1 · start mileage 100,000 mi");
});

test("OPENING the change writes nothing", async () => {
  await dayWith();
  const before = storedBytes();
  const writes = jest.spyOn(File.prototype, "write");

  await openChange();

  expect(writes).not.toHaveBeenCalled();
  expect(storedBytes()).toBe(before);
});

test("backing out after typing everything leaves the vehicle in use exactly as it was", async () => {
  await dayWith();
  const before = storedBytes();
  const writes = jest.spyOn(File.prototype, "write");
  const view = await openChange();

  await toNextStep(view, "100120");
  await press(view, "use-different");
  await type(view, "number-plate", "XY34 ZZZ");
  await type(view, "start-mileage", "220000");
  // Back through every step, and out.
  await press(view, "change-back");
  await press(view, "change-back");
  await press(view, "change-back");

  expect(mockRouter.back).toHaveBeenCalledTimes(1);
  expect(writes).not.toHaveBeenCalled();
  expect(storedBytes()).toBe(before);
  const day = await readOpenShift();
  expect(day?.vehicle).not.toHaveProperty("endMileage");
  expect(day?.previousVehicles).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// End mileage
// ═══════════════════════════════════════════════════════════════════════════

test("END MILEAGE is required before anything else is offered", async () => {
  await dayWith();
  const view = await openChange();

  expect(isDisabled(view, "change-continue")).toBe(true);
  await press(view, "change-continue");
  expect(view.queryByTestId("use-different")).toBeNull();
});

test("an end mileage below the start is refused and says why; at or above it, the driver may go on", async () => {
  await dayWith();
  const view = await openChange();

  await type(view, "end-mileage", "99999");
  expect(text(view, "end-mileage-error")).toBe("Can't be less than the start mileage, 100,000 mi.");
  expect(isDisabled(view, "change-continue")).toBe(true);

  await type(view, "end-mileage", "100000");
  expect(view.queryByTestId("end-mileage-error")).toBeNull();
  expect(isDisabled(view, "change-continue")).toBe(false);
});

test.each(["12.5", "-3", "1e5", "abc"])("an end mileage of %p is not a mileage", async raw => {
  await dayWith({ ...AB12, startMileage: 0 });
  const view = await openChange();

  await type(view, "end-mileage", raw);

  expect(isDisabled(view, "change-continue")).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// USED THIS SHIFT
// ═══════════════════════════════════════════════════════════════════════════

test("vehicles used earlier are offered MOST RECENTLY USED first", async () => {
  await dayWith();
  await changed(XY34, 9);
  await changed(CD56, 11);
  const view = await openChange();

  await toNextStep(view, "300100");

  expect(candidates(view)).toEqual(["XY34 ZZZ", "AB12 CDE"]);
  expect(view.getByTestId("candidate-XY34 ZZZ").props.accessibilityLabel).toBe("XY34 ZZZ. Class 1 · last used 11:00");
});

test("a vehicle used TWICE is offered once — and still kept as two uses", async () => {
  await dayWith();
  await changed(XY34, 9);
  await changed({ ...AB12, startMileage: 100_130 }, 11);
  await changed(CD56, 13);
  const view = await openChange();

  await toNextStep(view, "300100");

  expect(candidates(view)).toEqual(["AB12 CDE", "XY34 ZZZ"]);
  // The one row it keeps is its MOST RECENT use — 13:00, not the 09:00 one.
  expect(view.getByTestId("candidate-AB12 CDE").props.accessibilityLabel).toBe("AB12 CDE. Class 1 · last used 13:00");
  expect((await readOpenShift())?.previousVehicles.map(use => use.numberPlate)).toEqual(["AB12 CDE", "XY34 ZZZ", "AB12 CDE"]);
});

test("the vehicle being ended is never offered as the one to change to", async () => {
  await dayWith();
  await changed(XY34, 9);
  await changed({ ...AB12, startMileage: 100_130 }, 11);
  const view = await openChange();

  await toNextStep(view, "100200");

  expect(candidates(view)).toEqual(["XY34 ZZZ"]);
});

test("with nothing used earlier, only a different vehicle is offered", async () => {
  await dayWith();
  const view = await openChange();

  await toNextStep(view, "100120");

  expect(candidates(view)).toEqual([]);
  expect(view.queryByText("USED THIS SHIFT")).toBeNull();
  expect(text(view, "ending-summary")).toBe("Ending AB12 CDE at 100,120 mi");
  expect(view.getByTestId("use-different")).toBeTruthy();
});

test("every vehicle used earlier is offered back, whatever its class — a rigid and a van under a unit", async () => {
  await dayWith({ vehicleClass: "class2", numberPlate: "RG11 AAA", startMileage: 10 });
  await changed({ vehicleClass: "van", numberPlate: "VN11 BBB", startMileage: 500 }, 9);
  await changed(XY34, 11);
  const view = await openChange();

  await toNextStep(view, "220100");

  expect(candidates(view)).toEqual(["VN11 BBB", "RG11 AAA"]);
  expect(view.getByTestId("candidate-VN11 BBB").props.accessibilityLabel).toBe("VN11 BBB. Van · last used 11:00");
  expect(view.getByTestId("candidate-RG11 AAA").props.accessibilityLabel).toBe("RG11 AAA. Class 2 · last used 09:00");
});

// ═══════════════════════════════════════════════════════════════════════════
// Going back to a vehicle used earlier
// ═══════════════════════════════════════════════════════════════════════════

async function chooseEarlier(view: View, plate: string): Promise<void> {
  await press(view, `candidate-${plate}`);
}

test("choosing an earlier vehicle reuses its class and plate — and asks for a NEW start mileage", async () => {
  await dayWith();
  await changed(XY34, 9);
  const view = await openChange();
  await toNextStep(view, "220090");

  await chooseEarlier(view, "AB12 CDE");

  expect(text(view, "next-plate")).toBe("AB12 CDE");
  // Not pre-filled from the earlier use's end: it may have moved since.
  expect(view.getByTestId("next-start-mileage").props.value).toBe("");
  expect(isDisabled(view, "change-confirm")).toBe(true);
});

test("going back to a VAN from a unit names the van — the next vehicle's own class, and its own checklist", async () => {
  await dayWith({ vehicleClass: "van", numberPlate: "VN11 BBB", startMileage: 500 });
  await changed(AB12, 9);
  const view = await openChange();
  await toNextStep(view, "100120");

  await chooseEarlier(view, "VN11 BBB");

  expect(view.getByText("NEXT VEHICLE")).toBeTruthy();
  expect(text(view, "screen-title")).toBe("Change Unit");

  await type(view, "next-start-mileage", "560");
  await press(view, "perform-checks-no");
  await press(view, "change-confirm");

  const day = await readOpenShift();
  expect(day?.vehicle).toMatchObject({ vehicleClass: "van", numberPlate: "VN11 BBB", startMileage: 560, checks: [] });
});

test("an earlier vehicle asks PERFORM VEHICLE CHECKS? — and cannot be confirmed until answered", async () => {
  await dayWith();
  await changed(XY34, 9);
  const view = await openChange();
  await toNextStep(view, "220090");
  await chooseEarlier(view, "AB12 CDE");

  expect(view.getByText("PERFORM VEHICLE CHECKS?")).toBeTruthy();
  await type(view, "next-start-mileage", "100130");
  expect(isDisabled(view, "change-confirm")).toBe(true);

  await press(view, "perform-checks-no");
  expect(isDisabled(view, "change-confirm")).toBe(false);
});

test("YES: the returned-to vehicle becomes a new use and its Vehicle Checks open FRESH — not the morning's certificate", async () => {
  await dayWith();
  await completeCheckOnCurrent();
  await changed(XY34, 9);
  const view = await openChange();
  await toNextStep(view, "220090");
  await chooseEarlier(view, "AB12 CDE");
  await type(view, "next-start-mileage", "100130");
  await press(view, "perform-checks-yes");

  await press(view, "change-confirm");

  await waitFor(() => { expect(mockRouter.replace).toHaveBeenCalledWith("/vehicle-check"); });
  const day = await readOpenShift();
  expect(day?.vehicle).toMatchObject({ numberPlate: "AB12 CDE", startMileage: 100_130, checks: [] });
  expect(day?.previousVehicles[0]?.checks[0]?.status).toBe("completed");
  await view.unmount();

  // What the driver lands on: a fresh check for the new use.
  const check = await signedIn(<VehicleCheckRoute />);
  await waitFor(() => { expect(check.queryByTestId("check-status")).not.toBeNull(); });
  expect(text(check, "check-status")).toBe("Not confirmed");
  expect(check.queryByTestId("check-completed-at")).toBeNull();
  expect(check.getByTestId("complete-check")).toBeTruthy();
});

test("NO: the returned-to vehicle becomes a new use, back on Active Shift with checks NOT completed", async () => {
  await dayWith();
  await completeCheckOnCurrent();
  await changed(XY34, 9);
  const view = await openChange();
  await toNextStep(view, "220090");
  await chooseEarlier(view, "AB12 CDE");
  await type(view, "next-start-mileage", "100130");
  await press(view, "perform-checks-no");

  await press(view, "change-confirm");

  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift"); });
  expect(mockRouter.replace).not.toHaveBeenCalled();
  await view.unmount();
  const active = await wrap(<ActiveShiftRoute />);
  await waitFor(() => { expect(active.queryByTestId("vehicle-checks-state")).not.toBeNull(); });
  expect(text(active, "vehicle-plate-value")).toBe("AB12 CDE");
  expect(text(active, "vehicle-checks-state")).toBe("Not completed");
});

// ═══════════════════════════════════════════════════════════════════════════
// A different vehicle
// ═══════════════════════════════════════════════════════════════════════════

test.each([
  ["class1" as const, AB12],
  ["class2" as const, { vehicleClass: "class2" as const, numberPlate: "RG11 AAA", startMileage: 10 }],
  ["van" as const, { vehicleClass: "van" as const, numberPlate: "VN11 BBB", startMileage: 10 }],
])("a different vehicle after a %s may be ANY class, and none is assumed", async (_class, current) => {
  await dayWith(current);
  const view = await openChange();
  await toNextStep(view, String(current.startMileage + 20));

  await press(view, "use-different");

  for (const id of ["class1", "class2", "van"]) {
    expect(view.getByTestId(`vehicle-class-${id}`).props.accessibilityState).toMatchObject({ selected: false });
  }
});

test("a UNIT may be changed for a VAN — the class chosen is the one stored", async () => {
  const shift = await dayWith();
  const view = await openChange();
  await toNextStep(view, "100120");
  await press(view, "use-different");

  await press(view, "vehicle-class-van");
  await type(view, "number-plate", "vn11 bbb");
  await type(view, "start-mileage", "500");
  await press(view, "change-confirm");

  const day = await readOpenShift();
  expect(day?.vehicle).toMatchObject({ vehicleClass: "van", numberPlate: "VN11 BBB", startMileage: 500, checks: [] });
  expect(day?.previousVehicles.map(use => [use.vehicleClass, use.numberPlate, use.endMileage])).toEqual([
    ["class1", "AB12 CDE", 100_120],
  ]);
  expect(day?.id).toBe(shift.id);
});

test("a different vehicle uses the SAME rules as Add Vehicle — and asks nothing about checks", async () => {
  await dayWith();
  const view = await openChange();
  await toNextStep(view, "100120");
  await press(view, "use-different");

  expect(view.queryByText("PERFORM VEHICLE CHECKS?")).toBeNull();
  await type(view, "number-plate", "  zz99 abc ");
  await type(view, "start-mileage", "12.5");
  expect(isDisabled(view, "change-confirm")).toBe(true);
  await type(view, "start-mileage", "0");
  // The class is asked, never inherited from the one being ended.
  expect(isDisabled(view, "change-confirm")).toBe(true);
  await press(view, "vehicle-class-class1");
  expect(isDisabled(view, "change-confirm")).toBe(false);

  await press(view, "change-confirm");

  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift"); });
  const day = await readOpenShift();
  expect(day?.vehicle).toMatchObject({ vehicleClass: "class1", numberPlate: "ZZ99 ABC", startMileage: 0, checks: [] });
  expect(day?.previousVehicles[0]).toMatchObject({ numberPlate: "AB12 CDE", endMileage: 100_120 });
});

test("rapid taps on the confirmation change ONCE", async () => {
  await dayWith();
  const view = await openChange();
  await toNextStep(view, "100120");
  await press(view, "use-different");
  await press(view, "vehicle-class-class1");
  await type(view, "number-plate", "XY34 ZZZ");
  await type(view, "start-mileage", "220000");

  await act(async () => {
    const confirm = view.getByTestId("change-confirm");
    await Promise.all([fireEvent.press(confirm), fireEvent.press(confirm), fireEvent.press(confirm)]);
  });

  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalled(); });
  expect((await readOpenShift())?.previousVehicles).toHaveLength(1);
});

test("the screen itself asks ONCE — three taps while the write is still running is one change", async () => {
  // The store refuses a second change on its own; this is the guard in front
  // of it, proven where the store cannot mask it: a write that never settles.
  const onConfirm = jest.fn(() => new Promise<void>(() => { /* never settles */ }));
  const view = await wrap(
    <ChangeVehicleScreen
      current={{ ...AB12, startedAt: STARTED_AT.toISOString(), checks: [], fills: [] }}
      candidates={[]}
      onLeave={() => { /* not used here */ }}
      onConfirm={onConfirm}
    />,
  );
  await toNextStep(view, "100120");
  await press(view, "use-different");
  await press(view, "vehicle-class-class1");
  await type(view, "number-plate", "XY34 ZZZ");
  await type(view, "start-mileage", "220000");

  await act(async () => {
    const confirm = view.getByTestId("change-confirm");
    await Promise.all([fireEvent.press(confirm), fireEvent.press(confirm), fireEvent.press(confirm)]);
  });

  expect(onConfirm).toHaveBeenCalledTimes(1);
});

// ═══════════════════════════════════════════════════════════════════════════
// Active Shift after a change
// ═══════════════════════════════════════════════════════════════════════════

test("Active Shift shows the NEW vehicle as current, and the one before it under USED THIS SHIFT", async () => {
  await dayWith();
  await changed(XY34, 9);

  const active = await wrap(<ActiveShiftRoute />);

  await waitFor(() => { expect(active.queryByTestId("vehicle-plate-value")).not.toBeNull(); });
  expect(text(active, "vehicle-plate-value")).toBe("XY34 ZZZ");
  expect(text(active, "used-this-shift-label")).toBe("USED THIS SHIFT");
  // The ended use is its own compact row, identified by when it began and
  // saying which vehicle it was and the miles it did.
  const ended = (await readOpenShift())?.previousVehicles[0];
  expect(active.getByTestId(`usage-${ended?.startedAt ?? ""}`)).toBeTruthy();
  expect(String(active.getByTestId(`usage-${ended?.startedAt ?? ""}`).props.accessibilityLabel))
    .toBe(`AB12 CDE, Class 1. 100,000 → ${(ended?.endMileage ?? 0).toLocaleString("en-GB")} mi · ${(ended?.endMileage ?? 0) - 100_000} mi`);
});

test("Active Shift lists a truck used twice as TWO entries — the reuse list groups, the history does not", async () => {
  await dayWith();
  await changed(XY34, 9);
  await changed({ ...AB12, startMileage: 100_130 }, 11);
  await changed({ ...XY34, startMileage: 220_100 }, 13);

  const active = await wrap(<ActiveShiftRoute />);

  await waitFor(() => { expect(active.queryByTestId("used-this-shift")).not.toBeNull(); });
  const day = await readOpenShift();
  const starts = (day?.previousVehicles ?? []).map(use => use.startedAt);
  // Three ended uses, three entries — two of them the same registration
  // (owner decision, 2026-09-20).
  expect(active.queryAllByTestId(/^usage-[0-9]/).map(node => String(node.props.testID)))
    .toEqual([...starts].reverse().map(startedAt => `usage-${startedAt}`));
  expect(day?.previousVehicles.map(use => use.numberPlate)).toEqual(["AB12 CDE", "XY34 ZZZ", "AB12 CDE"]);
  await active.unmount();

  // The REUSE list is the other view and stays GROUPED: the two AB12 uses
  // are one candidate, and XY34 — the vehicle in use — is not offered at all.
  const view = await openChange();
  await toNextStep(view, "220200");
  expect(candidates(view)).toEqual(["AB12 CDE"]);
});

test("a day that has never changed vehicle shows no USED THIS SHIFT at all", async () => {
  await dayWith();

  const active = await wrap(<ActiveShiftRoute />);

  await waitFor(() => { expect(active.queryByTestId("vehicle-plate-value")).not.toBeNull(); });
  expect(active.queryByTestId("used-this-shift")).toBeNull();
});

test("after a RESTART, Active Shift shows the current vehicle and every earlier one from the file alone", async () => {
  await dayWith();
  await completeCheckOnCurrent();
  await changed(XY34, 9);
  await changed({ ...AB12, startMileage: 100_130 }, 11);

  // A fresh mount reads only what is on disk — what a relaunch has to work with.
  const active = await wrap(<ActiveShiftRoute />);

  await waitFor(() => { expect(active.queryByTestId("vehicle-plate-value")).not.toBeNull(); });
  expect(text(active, "vehicle-plate-value")).toBe("AB12 CDE");
  expect(text(active, "vehicle-checks-state")).toBe("Not completed");
  const day = await readOpenShift();
  const [first, second] = day?.previousVehicles ?? [];
  // Both earlier uses are rows, newest first, read from the file alone.
  expect(active.queryAllByTestId(/^usage-[0-9]/).map(node => String(node.props.testID)))
    .toEqual([`usage-${second?.startedAt ?? ""}`, `usage-${first?.startedAt ?? ""}`]);
  // Each use carries its OWN check state: the morning's is completed, the
  // XY34 use never was, and the current AB12 use is not either. (How an ended
  // use SHOWS it is proven in `vehicleUsage.test.tsx`.)
  expect(first?.checks[0]?.status).toBe("completed");
  expect(second?.checks).toEqual([]);
});

test("with no vehicle there is nothing to change — back to Active Shift; with no day, Home", async () => {
  await startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle: null });
  const noVehicle = await wrap(<ChangeVehicleRoute />);
  await waitFor(() => { expect(noVehicle.queryByTestId("redirect")).not.toBeNull(); });
  expect(text(noVehicle, "redirect")).toBe("/active-shift");
  await noVehicle.unmount();

  await clearOpenShift();
  const noDay = await wrap(<ChangeVehicleRoute />);
  await waitFor(() => { expect(noDay.queryByTestId("redirect")).not.toBeNull(); });
  expect(text(noDay, "redirect")).toBe("/today");
});

test("the whole change works with the network DEAD, and calls no server", async () => {
  const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(() => Promise.reject(new Error("offline")));
  await dayWith();
  await changed(XY34, 9);
  const view = await openChange();
  await toNextStep(view, "220090");
  await chooseEarlier(view, "AB12 CDE");
  await type(view, "next-start-mileage", "100130");
  await press(view, "perform-checks-no");

  await press(view, "change-confirm");

  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalled(); });
  expect(fetchSpy).not.toHaveBeenCalled();
});

// ═══════════════════════════════════════════════════════════════════════════
// Carrying on with NO vehicle (D32)
// ═══════════════════════════════════════════════════════════════════════════

/** Through the end mileage to the No vehicle step, where it is confirmed. */
async function toNoVehicle(view: View, endMileage: string): Promise<void> {
  await toNextStep(view, endMileage);
  await press(view, "use-no-vehicle");
}

const activeShift = async (): Promise<View> => {
  const view = await wrap(<ActiveShiftRoute />);
  await waitFor(() => { expect(view.queryByTestId("screen-title")).not.toBeNull(); });
  return view;
};

test("THREE answers to what comes next: a vehicle used earlier, a different one, or none at all", async () => {
  await dayWith();
  await changed(XY34, 9);
  const view = await openChange();

  await toNextStep(view, "220090");

  expect(candidates(view)).toEqual(["AB12 CDE"]);
  expect(view.queryByTestId("use-different")).not.toBeNull();
  expect(view.queryByTestId("use-no-vehicle")).not.toBeNull();
  // Said in its own words, in its own section — never a plate among plates.
  expect(String(view.getByTestId("use-no-vehicle").props.accessibilityLabel))
    .toBe("No vehicle. Carry on with the shift without a vehicle");
});

test("it is offered on a day that has used only ONE vehicle", async () => {
  await dayWith();
  const view = await openChange();

  await toNextStep(view, "100250");

  expect(candidates(view)).toEqual([]);
  expect(view.queryByTestId("use-no-vehicle")).not.toBeNull();
});

test("choosing it says what will happen, and cannot be mistaken for Cancel or Finish Shift", async () => {
  await dayWith();
  const before = storedBytes();
  const view = await openChange();

  await toNoVehicle(view, "100250");

  expect(text(view, "ending-summary")).toBe("Ending AB12 CDE at 100,250 mi");
  expect(text(view, "no-vehicle-headline")).toBe("Carry on without a vehicle");
  expect(text(view, "no-vehicle-detail")).toContain("shift stays open");
  expect(view.getByText(/not Finish Shift/)).toBeTruthy();
  // A filled button like the other two answers, not a quiet way out.
  expect(String(view.getByTestId("no-vehicle-confirm").props.accessibilityLabel)).toBe("Continue Without a Vehicle");
  expect(isDisabled(view, "no-vehicle-confirm")).toBe(false);
  // Reading the step writes nothing.
  expect(storedBytes()).toBe(before);
  expect((await readOpenShift())?.vehicle).not.toBeNull();
});

test("BACK from it returns to the choices, having changed nothing", async () => {
  await dayWith();
  const before = storedBytes();
  const view = await openChange();
  await toNoVehicle(view, "100250");

  await press(view, "change-back");

  expect(view.queryByTestId("use-no-vehicle")).not.toBeNull();
  expect(view.queryByTestId("no-vehicle-confirm")).toBeNull();
  expect(storedBytes()).toBe(before);
  expect(mockRouter.dismissTo).not.toHaveBeenCalled();
});

test.each([
  ["a Class 1", { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 }, "100250", "Change Unit"],
  ["a Class 2", { vehicleClass: "class2", numberPlate: "RG11 AAA", startMileage: 40_000 }, "40100", "Change Vehicle"],
  ["a van",     { vehicleClass: "van",    numberPlate: "VN11 BBB", startMileage: 500 },     "640",    "Change Vehicle"],
] as const)("%s can be given up for no vehicle, and the day carries on", async (_what, vehicle, endMileage, title) => {
  await dayWith(vehicle);
  const view = await openChange();
  expect(text(view, "screen-title")).toBe(title);

  await toNoVehicle(view, endMileage);
  await press(view, "no-vehicle-confirm");

  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift"); });
  const day = await readOpenShift();
  expect(day?.status).toBe("open");
  expect(day?.vehicle).toBeNull();
  expect(day?.previousVehicles).toMatchObject([{ numberPlate: vehicle.numberPlate, endMileage: Number(endMileage) }]);
  // Never Vehicle Checks: there is no vehicle to check.
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

test("the end mileage is still validated on the way to No vehicle", async () => {
  await dayWith();
  const view = await openChange();

  await type(view, "end-mileage", "99999");

  expect(isDisabled(view, "change-continue")).toBe(true);
  expect(text(view, "end-mileage-error")).toBe("Can't be less than the start mileage, 100,000 mi.");
  expect(view.queryByTestId("use-no-vehicle")).toBeNull();
});

test("Active Shift then says NO ACTIVE VEHICLE, keeps the ended use, and still offers Add Vehicle", async () => {
  await dayWith();
  await completeCheckOnCurrent();
  const ended = (await readOpenShift())?.vehicle?.startedAt ?? "";
  const view = await openChange();
  await toNoVehicle(view, "100250");
  await press(view, "no-vehicle-confirm");
  await view.unmount();

  const active = await activeShift();

  expect(active.getByText("No active vehicle")).toBeTruthy();
  expect(active.queryByTestId("add-vehicle")).not.toBeNull();
  expect(active.queryByTestId("active-vehicle")).toBeNull();
  expect(active.queryByTestId("still-on-shift")).not.toBeNull();
  // The use it just closed is in the day's history, with its own numbers —
  // and keeps its completed check.
  expect(text(active, `usage-mileage-${ended}`)).toBe("100,000 → 100,250 mi · 250 mi");
  expect((await readOpenShift())?.previousVehicles[0]?.checks[0]?.status).toBe("completed");
  // Nothing invented for the time with no vehicle.
  expect(active.queryAllByTestId(/^usage-[0-9]/)).toHaveLength(1);
});

test("Fuel and AdBlue are unavailable, and Finish Shift is still its own separate action", async () => {
  await dayWith();
  const view = await openChange();
  await toNoVehicle(view, "100250");
  await press(view, "no-vehicle-confirm");
  await view.unmount();

  const active = await activeShift();

  // Not even rendered: with no vehicle in use there is nothing to put them in.
  expect(active.queryByTestId("fuel")).toBeNull();
  expect(active.queryByTestId("adblue")).toBeNull();
  // Still on the screen, still not this increment's to press.
  expect(active.queryByTestId("finish-shift")).not.toBeNull();
  expect(isDisabled(active, "finish-shift")).toBe(true);
  // And the shift is genuinely still open.
  expect((await readOpenShift())?.status).toBe("open");
});

test("a rapid double press closes ONE use and leaves one day", async () => {
  await dayWith();
  const view = await openChange();
  await toNoVehicle(view, "100250");

  await act(async () => {
    const confirm = view.getByTestId("no-vehicle-confirm");
    await Promise.all([fireEvent.press(confirm), fireEvent.press(confirm), fireEvent.press(confirm)]);
  });

  const day = await readOpenShift();
  expect(day?.previousVehicles).toHaveLength(1);
  expect(day?.vehicle).toBeNull();
});

test("a vehicle added after the gap is a NEW use, and the earlier end is not moved to meet it", async () => {
  await dayWith();
  const view = await openChange();
  await toNoVehicle(view, "100250");
  await press(view, "no-vehicle-confirm");
  await view.unmount();
  const closed = (await readOpenShift())?.previousVehicles[0];

  const add = await wrap(<AddVehicleRoute />);
  await waitFor(() => { expect(add.queryByTestId("number-plate")).not.toBeNull(); });
  await press(add, "vehicle-class-class1");
  await type(add, "number-plate", "XY34 ZZZ");
  await type(add, "start-mileage", "220000");
  await press(add, "add-vehicle-submit");
  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift"); });

  const day = await readOpenShift();
  expect(day?.vehicle).toMatchObject({ numberPlate: "XY34 ZZZ", startMileage: 220_000, checks: [], fills: [] });
  // Its own start, later than the end it followed — the gap is real.
  expect(day?.previousVehicles[0]).toEqual(closed);
  expect(Date.parse(day?.vehicle?.startedAt ?? "")).toBeGreaterThan(Date.parse(closed?.endedAt ?? ""));
  expect(day?.previousVehicles).toHaveLength(1);
});

// ── The signed-in harness the Vehicle Check route needs ───────────────────

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

async function signedIn(node: React.ReactElement): Promise<View> {
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AuthProvider><SignedIn>{node}</SignedIn></AuthProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => { expect(text(view, "status")).toBe("unauthenticated"); });
  await act(async () => { await fireEvent.press(view.getByTestId("authenticate")); });
  return view;
}
