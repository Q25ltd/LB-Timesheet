/**
 * Add Fuel / Add AdBlue — the screen, the route, and the Active Shift tiles.
 *
 * These drive the real route against the real store. They prove the fast path
 * a driver at a broken pump actually takes, that an unknown amount is never
 * shown or stored as zero, that a correction touches one entry and nothing
 * else, that the tiles on Active Shift tell the truth about what the vehicle
 * in use holds — and that a fill always lands on the ONE use the screen was
 * opened for, with no chooser, failing closed if that use has moved on (D31).
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { File, Paths } from "expo-file-system";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Alert, Text, Pressable } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AuthenticatedAccount } from "../api/account";
import VehicleFillRoute from "../../app/(app)/vehicle-fill";
import ActiveShiftRoute from "../../app/(app)/active-shift";
import { checklistFor, checklistItems } from "../shift/checklists";
import {
  OPEN_SHIFT_FILE,
  USAGE_STATE,
  changeVehicle,
  clearOpenShift,
  completeVehicleCheck,
  endVehicleUse,
  newLocalId,
  readOpenShift,
  recordVehicleFill,
  startLocalShift,
  type LocalShift,
  type VehicleDetails,
} from "../shift/localShift";
import { FILL_TYPE } from "../shift/vehicleFill";

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismissTo: jest.fn() };
const params: { type?: string; usage?: string; usageState?: string } = { type: "fuel" };

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
    Redirect: ({ href }: { href: string }) => react.createElement(rn.Text, { testID: "redirect" }, String(href)),
    useFocusEffect: (effect: () => (() => void) | undefined) => { react.useEffect(effect, [effect]); },
    useLocalSearchParams: () => params,
  };
});

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const STARTED_AT = new Date(2026, 8, 19, 5, 30);
const at = (hours: number, minutes = 0) => new Date(2026, 8, 19, hours, minutes);
const AB12: VehicleDetails = { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 };
const XY34: VehicleDetails = { vehicleClass: "class1", numberPlate: "XY34 ZZZ", startMileage: 220_000 };

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

async function dayWith(vehicle: VehicleDetails | null = AB12): Promise<LocalShift> {
  return startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle });
}

/** A fill stored directly — how a day gets history before the screen opens. */
async function recorded(litres: number | null, over: { type?: "fuel" | "adblue"; recordedAt?: Date; note?: string } = {}): Promise<string> {
  const open = await readOpenShift();
  const fillId = newLocalId();
  await recordVehicleFill({
    shiftId: open?.id ?? "", vehicleStartedAt: open?.vehicle?.startedAt ?? "", usageState: USAGE_STATE.inUse, fillId,
    type: over.type ?? FILL_TYPE.fuel, recordedAt: over.recordedAt ?? at(9), litres, note: over.note ?? "",
  });
  return fillId;
}

/** The fill screen as Fuel / AdBlue in the current card opens it: for the use in the card. */
async function openFill(which: "fuel" | "adblue" = "fuel"): Promise<View> {
  params.type = which;
  params.usage = (await readOpenShift())?.vehicle?.startedAt ?? "";
  params.usageState = USAGE_STATE.inUse;
  const view = await wrap(<VehicleFillRoute />);
  await waitFor(() => { expect(view.queryByTestId("screen-title")).not.toBeNull(); });
  return view;
}

const fillsNow = async () => (await readOpenShift())?.vehicle?.fills ?? [];

beforeEach(async () => {
  await clearOpenShift();
  params.type = "fuel";
  delete params.usage;
  delete params.usageState;
  for (const fn of Object.values(mockRouter)) fn.mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// Getting there
// ═══════════════════════════════════════════════════════════════════════════

test("Active Shift opens Fuel and AdBlue for the EXACT use in the card, as the one in use", async () => {
  const shift = await dayWith();
  const current = shift.vehicle?.startedAt ?? "";
  const active = await wrap(<ActiveShiftRoute />);
  await waitFor(() => { expect(active.queryByTestId("fuel")).not.toBeNull(); });

  await press(active, "fuel");
  expect(mockRouter.push).toHaveBeenCalledWith({ pathname: "/vehicle-fill", params: { type: "fuel", usage: current, usageState: "in-use" } });

  await press(active, "adblue");
  expect(mockRouter.push).toHaveBeenCalledWith({ pathname: "/vehicle-fill", params: { type: "adblue", usage: current, usageState: "in-use" } });
});

test("the screen names the type and the vehicle the fill will belong to", async () => {
  await dayWith();

  const view = await openFill("adblue");

  expect(text(view, "screen-title")).toBe("Add AdBlue");
  expect(text(view, "fill-vehicle")).toBe("AB12 CDE");
});

test("with NO vehicle in use there is nowhere to put fuel — back to Active Shift", async () => {
  await dayWith(null);
  params.usage = STARTED_AT.toISOString();
  params.usageState = USAGE_STATE.inUse;

  const view = await wrap(<VehicleFillRoute />);

  await waitFor(() => { expect(text(view, "redirect")).toBe("/active-shift"); });
});

test("with no open day at all it goes Home", async () => {
  params.usage = STARTED_AT.toISOString();
  params.usageState = USAGE_STATE.inUse;
  const view = await wrap(<VehicleFillRoute />);

  await waitFor(() => { expect(text(view, "redirect")).toBe("/today"); });
});

test("a type that is not one of the two is not a screen", async () => {
  const shift = await dayWith();
  params.type = "petrol";
  params.usage = shift.vehicle?.startedAt ?? "";
  params.usageState = USAGE_STATE.inUse;

  const view = await wrap(<VehicleFillRoute />);

  await waitFor(() => { expect(text(view, "redirect")).toBe("/active-shift"); });
});

// ═══════════════════════════════════════════════════════════════════════════
// The fast path: a yard pump with no meter
// ═══════════════════════════════════════════════════════════════════════════

test("Amount unknown then Add is the WHOLE flow — no litres, no keyboard, no reason asked", async () => {
  await dayWith();
  const view = await openFill("adblue");

  await press(view, "amount-unknown");
  // Nothing asks for a quantity, and nothing asks why it is unknown.
  expect(view.queryByTestId("litres")).toBeNull();
  await press(view, "fill-save");

  expect(await fillsNow()).toMatchObject([{ type: "adblue", litres: null, note: null }]);
});

test("nothing can be stored until the driver says which amount it is", async () => {
  await dayWith();
  const view = await openFill();

  expect(isDisabled(view, "fill-save")).toBe(true);
  await press(view, "fill-save");
  expect(await fillsNow()).toEqual([]);

  await press(view, "amount-unknown");
  expect(isDisabled(view, "fill-save")).toBe(false);
});

test("a KNOWN amount stores the litres typed, to the litre or half of one", async () => {
  await dayWith();
  const view = await openFill();

  await press(view, "amount-known");
  await type(view, "litres", "312.5");
  await type(view, "fill-note", "Truckstop, pump 4");
  await press(view, "fill-save");

  expect(await fillsNow()).toMatchObject([{ type: "fuel", litres: 312.5, note: "Truckstop, pump 4" }]);
});

test.each([["0"], ["-5"], ["abc"], ["12.345"], ["1e3"]])("%s is not a quantity: it is refused and nothing is stored", async typed => {
  await dayWith();
  const view = await openFill();
  await press(view, "amount-known");

  await type(view, "litres", typed);

  expect(isDisabled(view, "fill-save")).toBe(true);
  expect(view.queryByTestId("litres-error")).not.toBeNull();
  await press(view, "fill-save");
  expect(await fillsNow()).toEqual([]);
});

test("choosing Amount unknown after typing litres stores NO quantity", async () => {
  await dayWith();
  const view = await openFill();
  await press(view, "amount-known");
  await type(view, "litres", "300");

  await press(view, "amount-unknown");
  await press(view, "fill-save");

  expect((await fillsNow())[0]?.litres).toBeNull();
});

test("the time is already set to now, and the driver may correct it", async () => {
  await dayWith();
  const view = await openFill();
  const now = new Date();

  expect(view.getByTestId("fill-time-hours").props.value).toBe(String(now.getHours()).padStart(2, "0"));
  await type(view, "fill-time-hours", "06");
  await type(view, "fill-time-minutes", "45");
  await press(view, "amount-unknown");
  await press(view, "fill-save");

  const stored = new Date((await fillsNow())[0]?.recordedAt ?? "");
  expect([stored.getHours(), stored.getMinutes()]).toEqual([6, 45]);
});

test("an impossible clock time cannot be stored", async () => {
  await dayWith();
  const view = await openFill();
  await press(view, "amount-unknown");

  await type(view, "fill-time-hours", "99");

  expect(isDisabled(view, "fill-save")).toBe(true);
});

test("opening the screen and backing out writes NOTHING", async () => {
  await dayWith();
  const before = storedBytes();
  const view = await openFill();

  await press(view, "amount-known");
  await type(view, "litres", "300");
  await type(view, "fill-note", "second thoughts");
  await press(view, "fill-back");

  expect(mockRouter.back).toHaveBeenCalled();
  expect(storedBytes()).toBe(before);
});

test("rapid taps on Add record ONE entry", async () => {
  await dayWith();
  const view = await openFill();
  await press(view, "amount-unknown");

  await act(async () => {
    const save = view.getByTestId("fill-save");
    await Promise.all([fireEvent.press(save), fireEvent.press(save), fireEvent.press(save)]);
  });

  expect(await fillsNow()).toHaveLength(1);
});

// ═══════════════════════════════════════════════════════════════════════════
// Reviewing, correcting, removing
// ═══════════════════════════════════════════════════════════════════════════

test("the list shows THIS type's entries on the vehicle in use — an unknown amount says so", async () => {
  await dayWith();
  const unknown = await recorded(null, { recordedAt: at(9, 5), note: "Yard pump — meter broken" });
  await recorded(300, { recordedAt: at(13) });
  await recorded(20, { type: "adblue" });

  const view = await openFill();

  expect(text(view, "recorded-label")).toBe("FUEL ON THIS VEHICLE");
  expect(view.getByTestId(`fill-${unknown}`)).toBeTruthy();
  const shown = JSON.stringify(view.toJSON());
  expect(shown).toContain("Amount unknown");
  expect(shown).toContain("300 L");
  expect(shown).toContain("Yard pump — meter broken");
  // Never dressed up as a measurement: no row reads "0 L".
  expect(view.queryAllByText("0 L")).toEqual([]);
  // The AdBlue entry belongs to the other tile.
  expect(shown).not.toContain("20 L");
});

test("pressing an entry loads it back, and saving corrects ONLY that one", async () => {
  await dayWith();
  const first = await recorded(300, { recordedAt: at(9) });
  const wrong = await recorded(30, { recordedAt: at(13), note: "typo" });
  const view = await openFill();

  await press(view, `fill-${wrong}`);
  expect(text(view, "screen-title")).toBe("Edit Fuel");
  await type(view, "litres", "300");
  await press(view, "fill-save");

  expect(await fillsNow()).toMatchObject([
    { id: first, litres: 300, note: null },
    { id: wrong, litres: 300, note: "typo" },
  ]);
});

test("a correction can change a known amount to UNKNOWN", async () => {
  await dayWith();
  const id = await recorded(300);
  const view = await openFill();

  await press(view, `fill-${id}`);
  await press(view, "amount-unknown");
  await press(view, "fill-save");

  expect(await fillsNow()).toMatchObject([{ id, litres: null }]);
});

test("Remove takes only the entry being edited", async () => {
  await dayWith();
  const keep = await recorded(300);
  const mistake = await recorded(null, { recordedAt: at(11) });
  const view = await openFill();

  await press(view, `fill-${mistake}`);
  await press(view, "fill-remove");

  expect((await fillsNow()).map(entry => entry.id)).toEqual([keep]);
});

test("Cancel leaves the entry exactly as it was", async () => {
  await dayWith();
  const id = await recorded(300);
  const view = await openFill();

  await press(view, `fill-${id}`);
  await type(view, "litres", "12");
  await press(view, "fill-cancel-edit");

  expect(await fillsNow()).toMatchObject([{ id, litres: 300 }]);
  expect(text(view, "screen-title")).toBe("Add Fuel");
});

test("recording a fill leaves the vehicle, its check and the day's history untouched", async () => {
  const shift = await dayWith();
  await completeVehicleCheck({
    shiftId: shift.id, vehicleStartedAt: shift.vehicle?.startedAt ?? "", usageState: USAGE_STATE.inUse, checkId: "morning", startedAt: at(5, 40),
    answers: checklistItems(checklistFor("class1")).map(entry => ({ key: entry.key, result: entry.defaultResult, note: "" })),
    completedAt: at(5, 50), completedBy: DRIVER.user.id,
  });
  const before = await readOpenShift();
  const view = await openFill();

  await press(view, "amount-unknown");
  await press(view, "fill-save");

  const after = await readOpenShift();
  expect(after?.vehicle?.checks).toEqual(before?.vehicle?.checks);
  expect(after?.vehicle?.startMileage).toBe(before?.vehicle?.startMileage);
  expect(after?.previousVehicles).toEqual(before?.previousVehicles);
});

// ═══════════════════════════════════════════════════════════════════════════
// What Active Shift says about it
// ═══════════════════════════════════════════════════════════════════════════

async function activeShift(): Promise<View> {
  const view = await wrap(<ActiveShiftRoute />);
  await waitFor(() => { expect(view.queryByTestId("fuel")).not.toBeNull(); });
  return view;
}

test("ALL KNOWN: the tile totals the litres and counts the entries", async () => {
  await dayWith();
  await recorded(300);
  await recorded(50);

  const view = await activeShift();

  expect(text(view, "fuel-amount")).toBe("350 L");
  expect(text(view, "fuel-detail")).toBe("2 entries");
});

test("MIXED: the tile reports the litres it knows and counts what it does not", async () => {
  await dayWith();
  await recorded(300);
  await recorded(50);
  await recorded(null);

  const view = await activeShift();

  expect(text(view, "fuel-amount")).toBe("350 L known");
  expect(text(view, "fuel-detail")).toBe("1 amount unknown");
});

test("ALL UNKNOWN: the tile says how many fills, and that the amount is unknown", async () => {
  await dayWith();
  await recorded(null, { type: "adblue" });

  const view = await activeShift();

  expect(text(view, "adblue-amount")).toBe("1 fill");
  expect(text(view, "adblue-detail")).toBe("Amount unknown");
  // An unknown amount is never dressed as a measured zero.
  expect(view.queryAllByText("0 L")).toEqual([]);
});

test("NOTHING RECORDED: the tile carries no total at all", async () => {
  await dayWith();

  const view = await activeShift();

  expect(view.queryByTestId("fuel-amount")).toBeNull();
  expect(view.queryByTestId("adblue-amount")).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// Across a vehicle change, and a restart
// ═══════════════════════════════════════════════════════════════════════════

test("changing vehicle leaves the old use's fuel on it, and the new use empty", async () => {
  const shift = await dayWith();
  await recorded(300);
  await changeVehicle({
    shiftId: shift.id, endingStartedAt: shift.vehicle?.startedAt ?? "",
    endMileage: 100_120, changedAt: at(11), next: XY34,
  });

  const view = await activeShift();

  expect(view.queryByTestId("fuel-amount")).toBeNull();
  const day = await readOpenShift();
  expect(day?.previousVehicles[0]?.fills).toHaveLength(1);
});

test("returning to a plate used earlier shows NO fuel carried over", async () => {
  const shift = await dayWith();
  await recorded(300);
  await changeVehicle({
    shiftId: shift.id, endingStartedAt: shift.vehicle?.startedAt ?? "",
    endMileage: 100_120, changedAt: at(11), next: XY34,
  });
  const second = await readOpenShift();
  await changeVehicle({
    shiftId: shift.id, endingStartedAt: second?.vehicle?.startedAt ?? "",
    endMileage: 220_050, changedAt: at(13), next: { ...AB12, startMileage: 100_400 },
  });

  const view = await openFill();

  expect(view.queryByTestId("recorded-fills")).toBeNull();
  expect(await fillsNow()).toEqual([]);
});

test("after a RESTART the fills are read from the file alone", async () => {
  await dayWith();
  await recorded(300, { recordedAt: at(9) });
  await recorded(null, { recordedAt: at(14) });

  const view = await activeShift();

  expect(text(view, "fuel-amount")).toBe("300 L known");
  expect(text(view, "fuel-detail")).toBe("1 amount unknown");
});

test("recording fuel never reaches the network", async () => {
  await dayWith();
  const fetched = jest.spyOn(globalThis, "fetch");
  const view = await openFill();

  await press(view, "amount-unknown");
  await press(view, "fill-save");

  expect(fetched).not.toHaveBeenCalled();
});

/** The gate's own guard: this file drives the real screens, not a double. */
test("the suite renders the real route, not a stand-in", async () => {
  await dayWith();
  const view = await openFill();

  expect(view.queryByTestId("vehicle-fill-scroll")).not.toBeNull();
  expect(Text).toBeTruthy();
  expect(Pressable).toBeTruthy();
  expect(AuthProvider).toBeTruthy();
  expect(useAuth).toBeTruthy();
});

// ═══════════════════════════════════════════════════════════════════════════
// One use, named by whoever opened the screen — no chooser (D31)
// ═══════════════════════════════════════════════════════════════════════════

/** Ends the use in progress and takes `next`, as the Change flow would. */
async function changeTo(next: VehicleDetails, hour: number, endMileage?: number): Promise<void> {
  const open = await readOpenShift();
  if (open?.vehicle == null) throw new Error("expected a vehicle in use");
  await changeVehicle({
    shiftId: open.id, endingStartedAt: open.vehicle.startedAt,
    endMileage: endMileage ?? open.vehicle.startMileage + 120, changedAt: at(hour), next,
  });
}

/** End the use in progress and carry on with no vehicle, as the Change flow does. */
async function endWithNoVehicle(hour: number): Promise<void> {
  const open = await readOpenShift();
  if (open?.vehicle == null) throw new Error("expected a vehicle in use");
  await endVehicleUse({
    shiftId: open.id, endingStartedAt: open.vehicle.startedAt,
    endMileage: open.vehicle.startMileage + 10, endedAt: at(hour),
  });
}

/** AB12 CDE, then XY34 ZZZ, then AB12 CDE again — and XY34 ZZZ in use now. */
async function threeUseDay(): Promise<{ first: string; middle: string; second: string }> {
  await dayWith();
  const first = (await readOpenShift())?.vehicle?.startedAt ?? "";
  await recorded(300, { recordedAt: at(8) });
  await recorded(20, { type: "adblue", recordedAt: at(8, 5) });

  await changeTo(XY34, 10, 100_120);
  const middle = (await readOpenShift())?.vehicle?.startedAt ?? "";
  await recorded(null, { recordedAt: at(11) });

  await changeTo({ ...AB12, startMileage: 100_500 }, 12, 220_050);
  const second = (await readOpenShift())?.vehicle?.startedAt ?? "";
  await recorded(60, { recordedAt: at(13) });

  await changeTo({ ...XY34, startMileage: 220_400 }, 14, 100_620);
  return { first, middle, second };
}

const fillsOfUsage = async (startedAt: string) =>
  (await readOpenShift())?.previousVehicles.find(use => use.startedAt === startedAt)?.fills ?? [];

/** The fill screen as a used vehicle's Edit opens it: for that ended use. */
async function openEndedFills(usage: string, which: "fuel" | "adblue" = "fuel"): Promise<View> {
  params.type = which;
  params.usage = usage;
  params.usageState = USAGE_STATE.ended;
  const view = await wrap(<VehicleFillRoute />);
  await waitFor(() => { expect(view.queryByTestId("screen-title")).not.toBeNull(); });
  return view;
}

test("a day of TEN uses: the current fill screen still offers no choice of vehicle", async () => {
  await dayWith();
  for (let hour = 6; hour <= 14; hour += 1) {
    await changeTo(hour % 2 === 0 ? { ...XY34, startMileage: 220_000 } : { ...AB12, startMileage: 100_000 }, hour);
  }

  const view = await openFill();

  // The superseded chooser, and every part of it, is gone.
  for (const gone of ["fill-selected-usage", "fill-change-usage", "fill-usages", "fill-usage-locked"]) {
    expect(view.queryByTestId(gone)).toBeNull();
  }
  expect(view.queryAllByTestId(/^fill-usage-/)).toEqual([]);
  expect(JSON.stringify(view.toJSON())).not.toContain("Select Vehicle");
  // The vehicle in use (XY34 ZZZ, taken at 14:00) is simply named, and the
  // form follows at once.
  expect(text(view, "fill-vehicle")).toBe("XY34 ZZZ");
  expect(view.queryByTestId("amount-known")).not.toBeNull();
});

test("current Fuel lands on the vehicle in use, and on no earlier use", async () => {
  const { first, middle, second } = await threeUseDay();
  const before = await Promise.all([fillsOfUsage(first), fillsOfUsage(middle), fillsOfUsage(second)]);
  const view = await openFill();

  await press(view, "amount-known");
  await type(view, "litres", "90");
  await press(view, "fill-save");

  expect(await fillsNow()).toMatchObject([{ type: "fuel", litres: 90 }]);
  expect(await Promise.all([fillsOfUsage(first), fillsOfUsage(middle), fillsOfUsage(second)])).toEqual(before);
});

test("current AdBlue with an UNKNOWN amount lands on the vehicle in use with no litres", async () => {
  const { first, middle, second } = await threeUseDay();
  const before = await Promise.all([fillsOfUsage(first), fillsOfUsage(middle), fillsOfUsage(second)]);
  const view = await openFill("adblue");

  await press(view, "amount-unknown");
  await press(view, "fill-save");

  expect(await fillsNow()).toMatchObject([{ type: "adblue", litres: null }]);
  expect(await Promise.all([fillsOfUsage(first), fillsOfUsage(middle), fillsOfUsage(second)])).toEqual(before);
});

test("the current tile totals the CURRENT use only — never the day", async () => {
  await threeUseDay();
  // 300 L already sits on the first use; put 90 L on the current one.
  const view = await openFill();
  await press(view, "amount-known");
  await type(view, "litres", "90");
  await press(view, "fill-save");
  await view.unmount();

  const active = await activeShift();

  expect(text(active, "fuel-amount")).toBe("90 L");
  expect(text(active, "fuel-detail")).toBe("1 entry");
});

// ═══════════════════════════════════════════════════════════════════════════
// STALE: the use the screen was opened for has moved on — FAIL CLOSED
// ═══════════════════════════════════════════════════════════════════════════

test("the vehicle was CHANGED while the screen was open: Add writes nothing, anywhere", async () => {
  await dayWith();
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await openFill();
  await press(view, "amount-known");
  await type(view, "litres", "300");

  // Behind the screen, AB12 CDE is handed back and XY34 ZZZ taken.
  await changeTo(XY34, 11);
  const before = storedBytes();
  await press(view, "fill-save");

  expect(storedBytes()).toBe(before);
  const day = await readOpenShift();
  expect(day?.previousVehicles[0]?.fills).toEqual([]);
  expect(day?.vehicle?.fills).toEqual([]);
  // The driver is told, and returned to the day.
  expect(alert).toHaveBeenCalled();
  expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift");
});

test("the vehicle was handed back with NO vehicle while the screen was open: nothing is written", async () => {
  await dayWith();
  jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await openFill("adblue");
  await press(view, "amount-unknown");

  await endWithNoVehicle(12);
  const before = storedBytes();
  await press(view, "fill-save");

  expect(storedBytes()).toBe(before);
  expect((await readOpenShift())?.previousVehicles[0]?.fills).toEqual([]);
});

test("opening the current fill screen for a use that has ENDED is not a screen — it is not treated as history", async () => {
  const { first } = await threeUseDay();

  params.type = "fuel";
  params.usage = first;
  params.usageState = USAGE_STATE.inUse;
  const view = await wrap(<VehicleFillRoute />);

  await waitFor(() => { expect(text(view, "redirect")).toBe("/active-shift"); });
});

test.each([
  ["no use named", false, "in-use"],
  ["no state named", true, undefined],
  ["an unknown state", true, "current"],
])("%s is not a screen — nothing falls back to the vehicle in use", async (_why, namesUse, usageState) => {
  const shift = await dayWith();
  params.type = "fuel";
  if (namesUse) params.usage = shift.vehicle?.startedAt ?? "";
  if (usageState !== undefined) params.usageState = usageState;

  const view = await wrap(<VehicleFillRoute />);

  await waitFor(() => { expect(text(view, "redirect")).toBe("/active-shift"); });
});

// ═══════════════════════════════════════════════════════════════════════════
// An ENDED use's fills, as its Edit opens them
// ═══════════════════════════════════════════════════════════════════════════

test("an ENDED use opens for itself, named by plate AND hours — the same plate twice is told apart", async () => {
  const { first, second } = await threeUseDay();

  const morning = await openEndedFills(first);
  expect(text(morning, "fill-vehicle")).toBe("AB12 CDE · 05:30–10:00");
  await morning.unmount();

  const afternoon = await openEndedFills(second);
  expect(text(afternoon, "fill-vehicle")).toBe("AB12 CDE · 12:00–14:00");
});

test("a forgotten 300 L added to an ENDED use lands there alone — not the vehicle in use, not the other AB12", async () => {
  const { first, middle, second } = await threeUseDay();
  const view = await openEndedFills(middle);

  await press(view, "amount-known");
  await type(view, "litres", "300");
  await press(view, "fill-save");

  expect((await fillsOfUsage(middle)).map(entry => [entry.type, entry.litres])).toEqual([["fuel", null], ["fuel", 300]]);
  expect((await fillsOfUsage(first)).map(entry => [entry.type, entry.litres])).toEqual([["fuel", 300], ["adblue", 20]]);
  expect((await fillsOfUsage(second)).map(entry => entry.litres)).toEqual([60]);
  expect(await fillsNow()).toEqual([]);
});

test("an UNKNOWN AdBlue added to an ENDED use is stored with no litres — never 0", async () => {
  const { second } = await threeUseDay();
  const view = await openEndedFills(second, "adblue");

  await press(view, "amount-unknown");
  await press(view, "fill-save");

  const stored = (await fillsOfUsage(second)).filter(entry => entry.type === "adblue");
  expect(stored).toHaveLength(1);
  expect(stored[0]?.litres).toBeNull();
});

test("an ENDED use's entry is corrected in place, keeping its own day, and the other AB12 is untouched", async () => {
  const { first, second } = await threeUseDay();
  const [historical] = await fillsOfUsage(first);
  const view = await openEndedFills(first);

  await press(view, `fill-${historical?.id ?? ""}`);
  expect(text(view, "screen-title")).toBe("Edit Fuel");
  await type(view, "litres", "30");
  await press(view, "fill-save");

  expect((await fillsOfUsage(first)).map(entry => [entry.type, entry.litres])).toEqual([["fuel", 30], ["adblue", 20]]);
  expect(await fillsOfUsage(second)).toMatchObject([{ litres: 60 }]);
  expect((await fillsOfUsage(first))[0]?.recordedAt.slice(0, 10)).toBe(at(8).toISOString().slice(0, 10));
});

test("an ENDED use's entry is removed, and only that one goes", async () => {
  const { first, second } = await threeUseDay();
  const [historical] = await fillsOfUsage(first);
  const view = await openEndedFills(first);

  await press(view, `fill-${historical?.id ?? ""}`);
  await press(view, "fill-remove");

  expect((await fillsOfUsage(first)).map(entry => entry.type)).toEqual(["adblue"]);
  expect(await fillsOfUsage(second)).toHaveLength(1);
});

test("correcting an ENDED use's fuel leaves its plate, class, times, mileages and check alone", async () => {
  const { first } = await threeUseDay();
  const before = (await readOpenShift())?.previousVehicles.find(use => use.startedAt === first);
  const [historical] = await fillsOfUsage(first);
  const view = await openEndedFills(first);

  await press(view, `fill-${historical?.id ?? ""}`);
  await press(view, "amount-unknown");
  await press(view, "fill-save");

  const after = (await readOpenShift())?.previousVehicles.find(use => use.startedAt === first);
  expect({ ...after, fills: [] }).toEqual({ ...before, fills: [] });
  expect(after?.fills?.[0]).toMatchObject({ type: "fuel", litres: null });
});

test("with NO vehicle in use, an ENDED use's fuel can still be added and corrected", async () => {
  const { first } = await threeUseDay();
  await endWithNoVehicle(15);
  const view = await openEndedFills(first);

  await press(view, "amount-known");
  await type(view, "litres", "45");
  await press(view, "fill-save");

  expect((await readOpenShift())?.vehicle).toBeNull();
  expect((await fillsOfUsage(first)).map(entry => [entry.type, entry.litres])).toEqual([["fuel", 300], ["adblue", 20], ["fuel", 45]]);
});

test.each([
  ["a time the day does not hold", "2026-09-19T23:59:00.000Z"],
  ["a plate", "AB12 CDE"],
  ["nothing", ""],
])("an ENDED use named by %s is not a screen", async (_why, usage) => {
  await threeUseDay();

  params.type = "fuel";
  params.usage = usage;
  params.usageState = USAGE_STATE.ended;
  const view = await wrap(<VehicleFillRoute />);

  await waitFor(() => { expect(text(view, "redirect")).toBe("/active-shift"); });
});

test("the vehicle IN USE is not history: an ended-use screen naming it is refused", async () => {
  await threeUseDay();

  params.type = "fuel";
  params.usage = (await readOpenShift())?.vehicle?.startedAt ?? "";
  params.usageState = USAGE_STATE.ended;
  const view = await wrap(<VehicleFillRoute />);

  await waitFor(() => { expect(text(view, "redirect")).toBe("/active-shift"); });
});
