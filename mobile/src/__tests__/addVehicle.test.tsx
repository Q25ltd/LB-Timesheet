/**
 * Add Vehicle — the first vehicle, into a day that started without one.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FLOW MAY CHANGE, AND WHAT IT MAY NOT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A driver books on at 06:00 and is handed a truck at 08:00 (D29). Add Vehicle
 * puts that truck into the day already running. It asks the same three things
 * Start Shift asks — class, number plate, start mileage — through the same
 * fields and the same rules, and it changes the vehicle and NOTHING else: not
 * the start the driver declared, not who the day is for, not the day's id.
 *
 * It does not check the vehicle. "Vehicle checks — Not completed" is still the
 * truth the moment a vehicle arrives, and a flow that quietly marked it done
 * would be putting a roadworthiness claim on the screen nobody made.
 *
 * It asks no server anything. The day is local (D28), and so is its vehicle.
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AddVehicleScreen } from "../screens/AddVehicleScreen";
import { ActiveShiftScreen } from "../screens/ActiveShiftScreen";
import AddVehicleRoute from "../../app/(app)/add-vehicle";
import ActiveShiftRoute from "../../app/(app)/active-shift";
import { clearOpenShift, readOpenShift, startLocalShift } from "../shift/localShift";
import type { LocalShift, VehicleDetails, WorkingContext } from "../shift/localShift";

const mockRouter = {
  replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismissTo: jest.fn(),
};
/** Every focus effect a mounted route registered — replayed to simulate returning to it. */
const mockFocusEffects: (() => unknown)[] = [];

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
    Redirect: ({ href }: { href: string }) =>
      react.createElement(rn.Text, { testID: "redirect" }, String(href)),
    // Runs on mount like a real first focus, and is kept so a test can replay
    // it the way returning to a screen does.
    useFocusEffect: (effect: () => unknown) => {
      react.useEffect(() => {
        mockFocusEffects.push(effect);
        return effect() as (() => void) | undefined;
      }, [effect]);
    },
  };
});

const METRICS = {
  frame:  { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const PERSONAL: WorkingContext = { kind: "personal" };
const NORTHGATE: WorkingContext = {
  kind: "company", membershipId: "mem_1", companyId: "co_1", companyName: "Northgate Logistics",
};
const STARTED_AT = new Date(2026, 8, 13, 5, 42);

type View = Awaited<ReturnType<typeof render>>;

function wrap(node: React.ReactElement): Promise<View> {
  return render(<SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>);
}

function enabled(view: View, testID: string): boolean {
  const state: unknown = view.getByTestId(testID).props.accessibilityState;
  if (typeof state !== "object" || state === null) return false;
  return Reflect.get(state, "disabled") === false;
}

async function press(view: View, testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(view.getByTestId(testID)); });
}

async function type(view: View, testID: string, value: string): Promise<void> {
  await act(async () => { await fireEvent.changeText(view.getByTestId(testID), value); });
}

async function fill(view: View, vehicleClass: string, plate: string, mileage: string): Promise<void> {
  await press(view, `vehicle-class-${vehicleClass}`);
  await type(view, "number-plate", plate);
  await type(view, "start-mileage", mileage);
}

/** Everything rendered, as one lower-cased string. */
function allText(view: View): string {
  return JSON.stringify(view.toJSON()).toLowerCase();
}

beforeEach(async () => {
  await clearOpenShift();
  for (const fn of Object.values(mockRouter)) fn.mockClear();
  mockFocusEffects.length = 0;
});
afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// The form: nothing is added until all three answers are real
// ═══════════════════════════════════════════════════════════════════════════

async function openForm(onAdd: (v: VehicleDetails) => Promise<void> = () => Promise.resolve()) {
  return wrap(<AddVehicleScreen onBack={() => undefined} onAdd={onAdd} />);
}

test("the form asks exactly the three vehicle questions, and starts unavailable", async () => {
  const view = await openForm();

  expect(view.getByTestId("screen-title").props.children).toBe("Add Vehicle");
  for (const id of ["vehicle-class-class1", "vehicle-class-class2", "vehicle-class-van", "number-plate", "start-mileage"]) {
    expect(view.getByTestId(id)).toBeTruthy();
  }
  // Nothing else is asked: no time, no trailer, no checks, no company.
  expect(view.queryByTestId("start-time")).toBeNull();
  expect(view.queryByTestId("working-for")).toBeNull();
  expect(allText(view)).not.toContain("trailer");
  expect(enabled(view, "add-vehicle-submit")).toBe(false);
});

test.each([
  ["no class",           "",       "AB24 XYZ", "1000"],
  ["no plate",           "class2", "",         "1000"],
  ["a whitespace plate", "class2", "   ",      "1000"],
  ["no mileage",         "class2", "AB24 XYZ", ""],
])("Add Vehicle stays unavailable with %s", async (_why, vehicleClass, plate, mileage) => {
  const view = await openForm();
  if (vehicleClass !== "") await press(view, `vehicle-class-${vehicleClass}`);
  await type(view, "number-plate", plate);
  await type(view, "start-mileage", mileage);

  expect(enabled(view, "add-vehicle-submit")).toBe(false);
});

test.each(["12.5", "-1", "1e4", "abc", "12 000"])("a mileage of %p is refused", async mileage => {
  const onAdd = jest.fn(() => Promise.resolve());
  const view = await openForm(onAdd);
  await fill(view, "class2", "AB24 XYZ", mileage);

  expect(enabled(view, "add-vehicle-submit")).toBe(false);
  await press(view, "add-vehicle-submit");
  expect(onAdd).not.toHaveBeenCalled();
});

test("a mileage of 0 is accepted — a new vehicle genuinely reads zero", async () => {
  const view = await openForm();
  await fill(view, "van", "NEW 1", "0");

  expect(enabled(view, "add-vehicle-submit")).toBe(true);
});

test.each([
  ["class1", "Class 1"],
  ["class2", "Class 2"],
  ["van",    "Van"],
] as const)("a %s is added with a trimmed, upper-cased plate", async (vehicleClass, _label) => {
  const onAdd = jest.fn((_vehicle: VehicleDetails) => Promise.resolve());
  const view = await openForm(onAdd);
  await fill(view, vehicleClass, "  ab24 xyz ", "184203");

  await press(view, "add-vehicle-submit");

  expect(onAdd).toHaveBeenCalledTimes(1);
  expect(onAdd).toHaveBeenCalledWith({ vehicleClass, numberPlate: "AB24 XYZ", startMileage: 184_203 });
});

test("an international plate is kept as typed, apart from case and outer space", async () => {
  const onAdd = jest.fn((_vehicle: VehicleDetails) => Promise.resolve());
  const view = await openForm(onAdd);
  await fill(view, "class1", " wgm-4471-klz", "9");

  await press(view, "add-vehicle-submit");

  expect(onAdd).toHaveBeenCalledWith({ vehicleClass: "class1", numberPlate: "WGM-4471-KLZ", startMileage: 9 });
});

test("rapid repeated taps submit ONCE", async () => {
  // A promise that has not settled: the write is still in flight when the
  // next taps land, which is exactly the double-tap case.
  const onAdd = jest.fn((_vehicle: VehicleDetails) => new Promise<void>(() => { /* in flight */ }));
  const view = await openForm(onAdd);
  await fill(view, "class2", "AB24 XYZ", "1000");

  const button = view.getByTestId("add-vehicle-submit");
  await act(async () => {
    await fireEvent.press(button);
    await fireEvent.press(button);
    await fireEvent.press(button);
  });

  expect(onAdd).toHaveBeenCalledTimes(1);
});

test("a failed add lets the driver try again", async () => {
  const onAdd = jest.fn((_vehicle: VehicleDetails) => Promise.reject(new Error("write failed")));
  const view = await openForm(onAdd);
  await fill(view, "class2", "AB24 XYZ", "1000");

  await press(view, "add-vehicle-submit");
  await waitFor(() => { expect(enabled(view, "add-vehicle-submit")).toBe(true); });
  await press(view, "add-vehicle-submit");

  expect(onAdd).toHaveBeenCalledTimes(2);
});

test("the keyboard cannot sit on Number plate or Start mileage", async () => {
  const view = await openForm();
  const scroll = view.getByTestId("add-vehicle-scroll").props;

  // The contract Start Shift was verified with on a physical iPhone.
  expect(scroll.automaticallyAdjustKeyboardInsets).toBe(true);
  expect(scroll.keyboardDismissMode).toBe("on-drag");
  expect(scroll.keyboardShouldPersistTaps).toBe("handled");
  expect(scroll.scrollEnabled).not.toBe(false);
  expect(view.getByTestId("start-mileage").props.keyboardType).toBe("number-pad");
  expect(view.getByTestId("number-plate").props.keyboardType).toBeUndefined();
});

test("Back leaves without adding anything", async () => {
  const onBack = jest.fn();
  const onAdd = jest.fn(() => Promise.resolve());
  const view = await wrap(<AddVehicleScreen onBack={onBack} onAdd={onAdd} />);

  await press(view, "add-vehicle-back");

  expect(onBack).toHaveBeenCalledTimes(1);
  expect(onAdd).not.toHaveBeenCalled();
});

// ═══════════════════════════════════════════════════════════════════════════
// The route: the stored day, and the way back to it
// ═══════════════════════════════════════════════════════════════════════════

async function openRoute(): Promise<View> {
  const view = await wrap(<AddVehicleRoute />);
  await waitFor(() => { expect(view.queryByTestId("add-vehicle-submit")).not.toBeNull(); });
  return view;
}

test("adding stores the vehicle in the open day and returns to Active Shift", async () => {
  const before = await startLocalShift({ workingFor: NORTHGATE, startedAt: STARTED_AT, vehicle: null });

  const view = await openRoute();
  await fill(view, "class2", " ab24 xyz", "184203");
  await press(view, "add-vehicle-submit");

  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift"); });
  const after = await readOpenShift();
  expect(after?.vehicle).toMatchObject({ vehicleClass: "class2", numberPlate: "AB24 XYZ", startMileage: 184_203 });
  // Its use began when it was added — later than the day's declared start.
  expect(Date.parse(after?.vehicle?.startedAt ?? "")).toBeGreaterThan(Date.parse(before.startedAt));
  // The day itself is exactly as it was.
  expect(after?.id).toBe(before.id);
  expect(after?.startedAt).toBe(before.startedAt);
  expect(after?.workingFor).toEqual(before.workingFor);
  expect(after?.createdAt).toBe(before.createdAt);
});

test("the whole flow works with the network DEAD, and calls no server", async () => {
  const fetchSpy = jest.spyOn(global, "fetch")
    .mockImplementation(() => Promise.reject(new Error("Network request failed")));
  await startLocalShift({ workingFor: NORTHGATE, startedAt: STARTED_AT, vehicle: null });

  const view = await openRoute();
  await fill(view, "van", "KAT 123", "640");
  await press(view, "add-vehicle-submit");

  await waitFor(async () => { expect((await readOpenShift())?.vehicle?.numberPlate).toBe("KAT 123"); });
  // No /shifts/*, no /auth/switch-company, nothing.
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("a rapid double submit through the route stores ONE vehicle", async () => {
  await startLocalShift({ workingFor: PERSONAL, startedAt: STARTED_AT, vehicle: null });
  const view = await openRoute();
  await fill(view, "class1", "AB24 XYZ", "1000");

  const button = view.getByTestId("add-vehicle-submit");
  await act(async () => {
    await fireEvent.press(button);
    await fireEvent.press(button);
  });

  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalled(); });
  expect(mockRouter.dismissTo).toHaveBeenCalledTimes(1);
  expect((await readOpenShift())?.vehicle?.numberPlate).toBe("AB24 XYZ");
});

test("with NO open day there is nothing to add to — back to Home", async () => {
  const view = await wrap(<AddVehicleRoute />);

  await waitFor(() => { expect(view.queryByTestId("redirect")).not.toBeNull(); });
  expect(view.getByTestId("redirect").props.children).toBe("/today");
  expect(view.queryByTestId("add-vehicle-submit")).toBeNull();
});

test("a day that ALREADY has a vehicle is not offered Add — back to Active Shift", async () => {
  await startLocalShift({
    workingFor: PERSONAL, startedAt: STARTED_AT,
    vehicle: { vehicleClass: "class2", numberPlate: "AB24 XYZ", startMileage: 1000 },
  });

  const view = await wrap(<AddVehicleRoute />);

  await waitFor(() => { expect(view.queryByTestId("redirect")).not.toBeNull(); });
  expect(view.getByTestId("redirect").props.children).toBe("/active-shift");
});

// ═══════════════════════════════════════════════════════════════════════════
// Active Shift: the way in, and what it shows on the way back
// ═══════════════════════════════════════════════════════════════════════════

function noVehicleShift(): LocalShift {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    workingFor: PERSONAL,
    startedAt: STARTED_AT.toISOString(),
    vehicle: null,
    status: "open",
    createdAt: STARTED_AT.toISOString(),
  };
}

test("Add Vehicle on a no-vehicle Active Shift opens the flow", async () => {
  const onAddVehicle = jest.fn();
  const view = await wrap(
    <ActiveShiftScreen shift={noVehicleShift()} onDiscard={() => undefined} onAddVehicle={onAddVehicle} />,
  );

  expect(enabled(view, "add-vehicle")).toBe(true);
  await press(view, "add-vehicle");
  expect(onAddVehicle).toHaveBeenCalledTimes(1);
});

test("the Active Shift route sends Add Vehicle to the add-vehicle screen", async () => {
  await startLocalShift({ workingFor: PERSONAL, startedAt: STARTED_AT, vehicle: null });
  const view = await wrap(<ActiveShiftRoute />);
  await waitFor(() => { expect(view.queryByTestId("add-vehicle")).not.toBeNull(); });

  await press(view, "add-vehicle");

  expect(mockRouter.push).toHaveBeenCalledWith("/add-vehicle");
});

test("returning to Active Shift shows the vehicle IMMEDIATELY — checks still Not completed", async () => {
  await startLocalShift({ workingFor: PERSONAL, startedAt: STARTED_AT, vehicle: null });
  const view = await wrap(<ActiveShiftRoute />);
  await waitFor(() => { expect(view.queryByTestId("no-vehicle")).not.toBeNull(); });

  // The add happens on another screen; Active Shift stays mounted beneath it.
  const add = await openRoute();
  await fill(add, "class1", "wgm-4471-klz", "9");
  await press(add, "add-vehicle-submit");
  await waitFor(async () => { expect((await readOpenShift())?.vehicle).not.toBeNull(); });

  // Coming back into focus re-reads the day rather than showing a stale one.
  await act(async () => { for (const effect of [...mockFocusEffects]) await Promise.resolve(effect()); });

  await waitFor(() => { expect(view.queryByTestId("active-vehicle")).not.toBeNull(); });
  expect(view.queryByTestId("no-vehicle")).toBeNull();
  expect(view.getByTestId("vehicle-plate-value").props.children).toBe("WGM-4471-KLZ");
  expect(view.getByTestId("vehicle-class-value").props.children).toBe("Class 1");
  expect(view.getByTestId("current-asset-label").props.children).toBe("CURRENT UNIT");
  // Adding a vehicle checked nothing.
  expect(view.getByTestId("vehicle-checks-state").props.children).toBe("Not completed");
  expect(allText(view)).not.toMatch(/passed|roadworthy|checks completed/);
});

test("after a RESTART the day comes back with its vehicle, start and company unchanged", async () => {
  const before = await startLocalShift({ workingFor: NORTHGATE, startedAt: STARTED_AT, vehicle: null });
  const add = await openRoute();
  await fill(add, "van", "KAT 123", "640");
  await press(add, "add-vehicle-submit");
  await waitFor(async () => { expect((await readOpenShift())?.vehicle).not.toBeNull(); });
  await add.unmount();

  // A fresh mount reads only the file: what a relaunch has to work with.
  const relaunched = await wrap(<ActiveShiftRoute />);

  await waitFor(() => { expect(relaunched.queryByTestId("active-vehicle")).not.toBeNull(); });
  expect(relaunched.getByTestId("vehicle-plate-value").props.children).toBe("KAT 123");
  expect(relaunched.getByTestId("vehicle-mileage-value").props.children).toBe("640 mi");
  expect(relaunched.getByTestId("current-asset-label").props.children).toBe("CURRENT VEHICLE");
  expect(relaunched.getByTestId("shift-working-for").props.children).toBe("Northgate Logistics");
  expect(relaunched.getByTestId("shift-started-at").props.children).toBe("05:42");
  expect((await readOpenShift())?.startedAt).toBe(before.startedAt);
});
