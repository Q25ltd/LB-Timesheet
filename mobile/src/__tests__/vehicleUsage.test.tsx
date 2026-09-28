/**
 * USED THIS SHIFT, and one ended vehicle use opened from it — read and corrected.
 *
 * These drive the real Active Shift and Vehicle Use routes against the real
 * store. They prove that history is one compact row per ENDED use, newest
 * first and never merged by plate; that a row opens EXACTLY its own use and
 * nothing named by plate or guessed; that the detail tells the truth; and that
 * Edit changes the end mileage alone — every other fact of the use, and every
 * other use, stays byte-for-byte as it was (D31). Also that none of this needs
 * a vehicle in use (D32).
 */
import { render, fireEvent, act, waitFor, within } from "@testing-library/react-native";
import { File, Paths } from "expo-file-system";
import { SafeAreaProvider } from "react-native-safe-area-context";
import ActiveShiftRoute from "../../app/(app)/active-shift";
import VehicleUsageRoute from "../../app/(app)/vehicle-usage";
import { checklistFor, checklistItems } from "../shift/checklists";
import {
  OPEN_SHIFT_FILE,
  USAGE_STATE,
  addVehicleToOpenShift,
  changeVehicle,
  clearOpenShift,
  completeVehicleCheck,
  correctEndMileage,
  endVehicleUse,
  newLocalId,
  readOpenShift,
  recordVehicleFill,
  startLocalShift,
  type EndedVehicle,
  type LocalShift,
  type VehicleDetails,
} from "../shift/localShift";
import { FILL_TYPE } from "../shift/vehicleFill";

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismissTo: jest.fn() };
const params: { usage?: string } = {};

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

const METRICS = { frame: { x: 0, y: 0, width: 402, height: 874 }, insets: { top: 62, left: 0, right: 0, bottom: 34 } };
const STARTED_AT = new Date(2026, 8, 19, 5, 30);
const at = (hours: number, minutes = 0) => new Date(2026, 8, 19, hours, minutes);
const AB12: VehicleDetails = { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 };
const XY34: VehicleDetails = { vehicleClass: "class2", numberPlate: "XY34 ZZZ", startMileage: 220_000 };

type View = Awaited<ReturnType<typeof render>>;

const wrap = (node: React.ReactElement): Promise<View> =>
  render(<SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>);
const storedBytes = () => new File(Paths.document, OPEN_SHIFT_FILE).textSync();
/** Everything a node says, including text nested inside it. */
function flat(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flat).join("");
  if (typeof node === "object" && node !== null && "props" in node) {
    const props: unknown = node.props;
    if (typeof props === "object" && props !== null && "children" in props) return flat(props.children);
  }
  return "";
}
const text = (view: View, testID: string) => flat(view.getByTestId(testID).props.children);
/** The testIDs of every text field on screen. */
const inputs = (view: View): string[] =>
  [...JSON.stringify(view.toJSON()).matchAll(/"type":"TextInput","props":\{[^}]*?"testID":"([^"]+)"/g)].map(match => match[1] ?? "");
function isDisabled(view: View, testID: string): boolean {
  const state: unknown = view.getByTestId(testID).props.accessibilityState;
  return typeof state === "object" && state !== null && "disabled" in state && state.disabled === true;
}

async function press(view: View, testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(view.getByTestId(testID)); });
}
async function type(view: View, testID: string, value: string): Promise<void> {
  await act(async () => { await fireEvent.changeText(view.getByTestId(testID), value); });
}

async function dayWith(vehicle: VehicleDetails | null = AB12): Promise<LocalShift> {
  return startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle });
}

/** Ends the use in progress with `endMileage` and takes `next`, as the Change flow would. */
async function changeTo(next: VehicleDetails, hour: number, endMileage: number): Promise<string> {
  const open = await readOpenShift();
  if (open?.vehicle == null) throw new Error("expected a vehicle in use");
  await changeVehicle({ shiftId: open.id, endingStartedAt: open.vehicle.startedAt, endMileage, changedAt: at(hour), next });
  return open.vehicle.startedAt;
}

/** A fill on the vehicle in use. */
async function fillNow(litres: number | null, over: { type?: "fuel" | "adblue"; note?: string; recordedAt?: Date } = {}): Promise<void> {
  const open = await readOpenShift();
  await recordVehicleFill({
    shiftId: open?.id ?? "", vehicleStartedAt: open?.vehicle?.startedAt ?? "", usageState: USAGE_STATE.inUse,
    fillId: newLocalId(), type: over.type ?? FILL_TYPE.fuel, recordedAt: over.recordedAt ?? at(8),
    litres, note: over.note ?? "",
  });
}

/**
 * AB12 CDE 05:30–10:00 (100,000 → 100,120, 300 L fuel, 20 L AdBlue, checked),
 * XY34 ZZZ 10:00–12:00 (220,000 → 220,050, fuel of unknown amount),
 * AB12 CDE 12:00–14:00 (100,500 → 100,620, 60 L), and XY34 ZZZ in use now.
 */
async function threeUseDay(): Promise<{ first: string; middle: string; second: string }> {
  const shift = await dayWith();
  await completeVehicleCheck({
    shiftId: shift.id, vehicleStartedAt: shift.vehicle?.startedAt ?? "", usageState: USAGE_STATE.inUse, checkId: "morning", startedAt: at(5, 40),
    answers: checklistItems(checklistFor("class1")).map(entry => ({ key: entry.key, result: entry.defaultResult, note: "" })),
    completedAt: at(5, 50), completedBy: "user_1",
  });
  await fillNow(300, { note: "Truckstop" });
  await fillNow(20, { type: "adblue", recordedAt: at(8, 5) });
  const first = await changeTo(XY34, 10, 100_120);
  await fillNow(null, { recordedAt: at(11) });
  const middle = await changeTo({ ...AB12, startMileage: 100_500 }, 12, 220_050);
  await fillNow(60, { recordedAt: at(13) });
  const second = await changeTo({ ...XY34, startMileage: 220_400 }, 14, 100_620);
  return { first, middle, second };
}

const usageOf = async (startedAt: string): Promise<EndedVehicle | undefined> =>
  (await readOpenShift())?.previousVehicles.find(use => use.startedAt === startedAt);

async function activeShift(): Promise<View> {
  const view = await wrap(<ActiveShiftRoute />);
  await waitFor(() => { expect(view.queryByTestId("screen-title")).not.toBeNull(); });
  return view;
}

async function openUsage(usage: string): Promise<View> {
  params.usage = usage;
  const view = await wrap(<VehicleUsageRoute />);
  await waitFor(() => { expect(view.queryByTestId("screen-title") ?? view.queryByTestId("redirect")).not.toBeNull(); });
  return view;
}

const rowIds = (view: View) =>
  view.queryAllByTestId(/^usage-[0-9]/).map(node => String(node.props.testID).slice("usage-".length));

beforeEach(async () => {
  await clearOpenShift();
  delete params.usage;
  for (const fn of Object.values(mockRouter)) fn.mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// USED THIS SHIFT — one compact row per ENDED use
// ═══════════════════════════════════════════════════════════════════════════

test("one row per ENDED use, newest ended first — the vehicle in use is not history", async () => {
  const { first, middle, second } = await threeUseDay();
  const current = (await readOpenShift())?.vehicle?.startedAt ?? "";

  const view = await activeShift();

  expect(rowIds(view)).toEqual([second, middle, first]);
  expect(rowIds(view)).not.toContain(current);
});

test("two uses of ONE plate are two rows, each with its own mileage — never merged", async () => {
  const { first, second } = await threeUseDay();

  const view = await activeShift();

  expect(text(view, `usage-title-${first}`)).toBe("AB12 CDE · Class 1");
  expect(text(view, `usage-title-${second}`)).toBe("AB12 CDE · Class 1");
  expect(text(view, `usage-mileage-${first}`)).toBe("100,000 → 100,120 mi · 120 mi");
  expect(text(view, `usage-mileage-${second}`)).toBe("100,500 → 100,620 mi · 120 mi");
});

test("a row states its plate, its own class, start → end and what it travelled", async () => {
  const { middle } = await threeUseDay();

  const view = await activeShift();

  expect(text(view, `usage-title-${middle}`)).toBe("XY34 ZZZ · Class 2");
  expect(text(view, `usage-mileage-${middle}`)).toBe("220,000 → 220,050 mi · 50 mi");
});

test("a use that stood still reads 0 mi", async () => {
  await dayWith();
  const stood = await changeTo(XY34, 10, 100_000);

  const view = await activeShift();

  expect(text(view, `usage-mileage-${stood}`)).toBe("100,000 → 100,000 mi · 0 mi");
});

test("history rows carry NO check, Fuel or AdBlue rows — those belong to the use's own screen", async () => {
  const { first } = await threeUseDay();

  const view = await activeShift();

  const history = within(view.getByTestId("used-this-shift"));
  const said = history.queryAllByText(/.+/).map(node => flat(node.props.children)).join(" | ");
  for (const hidden of [`usage-fuel-${first}`, `usage-adblue-${first}`, `usage-checks-${first}`]) {
    expect(view.queryByTestId(hidden)).toBeNull();
  }
  expect(history.queryByText(/Fuel|AdBlue|Completed|Not completed/)).toBeNull();
  // The rows DO say something — plates and mileages — just not that.
  expect(said).toContain("AB12 CDE");
  expect(said).toContain("100,000 → 100,120 mi · 120 mi");
  expect(said).not.toContain("300 L");
});

test("pressing a row opens EXACTLY that use, by its identity — never by plate", async () => {
  const { first, second } = await threeUseDay();
  const view = await activeShift();

  await press(view, `usage-${second}`);
  expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: "/vehicle-usage", params: { usage: second } });

  await press(view, `usage-${first}`);
  expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: "/vehicle-usage", params: { usage: first } });
});

test("rendering the history neither writes nor reorders the stored day", async () => {
  const { first, middle, second } = await threeUseDay();
  const before = storedBytes();

  await activeShift();

  expect(storedBytes()).toBe(before);
  expect((await readOpenShift())?.previousVehicles.map(use => use.startedAt)).toEqual([first, middle, second]);
});

test("TEN changes stay ten compact rows below the current vehicle's actions", async () => {
  await dayWith();
  for (let hour = 6; hour <= 15; hour += 1) {
    const open = await readOpenShift();
    await changeTo(hour % 2 === 0 ? XY34 : AB12, hour, (open?.vehicle?.startMileage ?? 0) + 10);
  }

  const view = await activeShift();

  expect(rowIds(view)).toHaveLength(10);
  // Every live action on the vehicle in use is in its card, above the list.
  const card = within(view.getByTestId("active-vehicle"));
  for (const action of ["vehicle-checks", "change-vehicle", "fuel", "adblue"]) {
    expect(card.queryByTestId(action)).not.toBeNull();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// NO VEHICLE in use (D32): current fills gone, history still open
// ═══════════════════════════════════════════════════════════════════════════

async function endWithNoVehicle(hour: number, endMileage: number): Promise<string> {
  const open = await readOpenShift();
  if (open?.vehicle == null) throw new Error("expected a vehicle in use");
  await endVehicleUse({ shiftId: open.id, endingStartedAt: open.vehicle.startedAt, endMileage, endedAt: at(hour) });
  return open.vehicle.startedAt;
}

test("with NO vehicle: the shift is open, says so, offers Add Vehicle — and no Fuel or AdBlue", async () => {
  await threeUseDay();
  await endWithNoVehicle(15, 220_450);

  const view = await activeShift();

  expect((await readOpenShift())?.status).toBe("open");
  expect(view.queryByTestId("no-vehicle")).not.toBeNull();
  expect(text(view, "still-on-shift")).toBe("You are still on shift.");
  expect(view.queryByTestId("add-vehicle")).not.toBeNull();
  expect(view.queryByTestId("fuel")).toBeNull();
  expect(view.queryByTestId("adblue")).toBeNull();
});

test("with NO vehicle: every ended use is still a row, and each still opens", async () => {
  const { first, middle, second } = await threeUseDay();
  const last = await endWithNoVehicle(15, 220_450);

  const view = await activeShift();

  expect(rowIds(view)).toEqual([last, second, middle, first]);
  await press(view, `usage-${first}`);
  expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: "/vehicle-usage", params: { usage: first } });
});

test("a day that simply booked on without a vehicle does not claim anyone is 'still' on shift", async () => {
  await dayWith(null);

  const view = await activeShift();

  expect(view.queryByTestId("no-vehicle")).not.toBeNull();
  expect(view.queryByTestId("still-on-shift")).toBeNull();
  expect(view.queryByTestId("used-this-shift")).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// Vehicle Use — the detail
// ═══════════════════════════════════════════════════════════════════════════

test("the detail is the EXACT use named — the afternoon AB12 is not the morning's", async () => {
  const { first, second } = await threeUseDay();

  const morning = await openUsage(first);
  expect(text(morning, "usage-class-hours")).toBe("Class 1 · 05:30–10:00");
  expect(text(morning, "usage-start-mileage")).toBe("100,000 mi");
  await morning.unmount();

  const afternoon = await openUsage(second);
  expect(text(afternoon, "usage-plate")).toBe("AB12 CDE");
  expect(text(afternoon, "usage-class-hours")).toBe("Class 1 · 12:00–14:00");
  expect(text(afternoon, "usage-start-mileage")).toBe("100,500 mi");
  expect(text(afternoon, "usage-end-mileage")).toBe("100,620 mi");
  expect(text(afternoon, "usage-travelled")).toBe("120 mi");
});

test("its checks are reported as stored — Completed on the use that earned it, and only there", async () => {
  const { first, second } = await threeUseDay();

  const checked = await openUsage(first);
  expect(text(checked, "usage-checks")).toBe("Completed");
  await checked.unmount();

  const unchecked = await openUsage(second);
  expect(text(unchecked, "usage-checks")).toBe("Not completed");
});

test("its fuel and AdBlue are listed as recorded — an unknown amount says so, never 0 L", async () => {
  const { first, middle, second } = await threeUseDay();

  const morning = await openUsage(first);
  const said = JSON.stringify(morning.toJSON());
  expect(said).toContain("300 L");
  expect(said).toContain("Truckstop");
  expect(said).toContain("20 L");
  expect(morning.queryByTestId("usage-fuel-entries")).not.toBeNull();
  await morning.unmount();

  const unknown = await openUsage(middle);
  expect(JSON.stringify(unknown.toJSON())).toContain("Amount unknown");
  expect(unknown.queryAllByText(/^0 L$/)).toEqual([]);
  expect(unknown.queryByTestId("usage-adblue-none")).not.toBeNull();
  await unknown.unmount();

  const afternoon = await openUsage(second);
  expect(JSON.stringify(afternoon.toJSON())).toContain("60 L");
  expect(JSON.stringify(afternoon.toJSON())).not.toContain("300 L");
});

test("the detail has nothing to type into — it only reads", async () => {
  const { first } = await threeUseDay();

  const view = await openUsage(first);

  expect(inputs(view)).toEqual([]);
  expect(view.queryByTestId("usage-edit")).not.toBeNull();
});

test.each([
  ["a time the day does not hold", "2026-09-19T23:59:00.000Z"],
  ["a plate", "AB12 CDE"],
  ["nothing", ""],
])("a use named by %s is not a screen — no fallback, no plate lookup", async (_why, usage) => {
  await threeUseDay();

  const view = await openUsage(usage);

  expect(text(view, "redirect")).toBe("/active-shift");
});

test("the vehicle IN USE is not an ended use, and does not open here", async () => {
  await threeUseDay();

  const view = await openUsage((await readOpenShift())?.vehicle?.startedAt ?? "");

  expect(text(view, "redirect")).toBe("/active-shift");
});

test("with no open day it goes Home", async () => {
  const view = await openUsage("2026-09-19T04:30:00.000Z");

  expect(text(view, "redirect")).toBe("/today");
});

// ═══════════════════════════════════════════════════════════════════════════
// Vehicle Use — Edit
// ═══════════════════════════════════════════════════════════════════════════

async function openEdit(usage: string): Promise<View> {
  const view = await openUsage(usage);
  await press(view, "usage-edit");
  return view;
}

test("Edit offers ONE field — the end mileage — and states the rest", async () => {
  const { first } = await threeUseDay();

  const view = await openEdit(first);

  expect(text(view, "screen-title")).toBe("Edit Vehicle Use");
  expect(inputs(view)).toEqual(["usage-end-mileage-input"]);
  expect(view.getByTestId("usage-end-mileage-input").props.value).toBe("100120");
  // Plate, class and hours are still shown, and are not inputs.
  expect(text(view, "usage-plate")).toBe("AB12 CDE");
  expect(text(view, "usage-class-hours")).toBe("Class 1 · 05:30–10:00");
});

test("correcting the end mileage stores it, and the distance follows", async () => {
  const { first } = await threeUseDay();
  const view = await openEdit(first);

  await type(view, "usage-end-mileage-input", "100180");
  expect(text(view, "usage-end-mileage-hint")).toBe("Start mileage 100,000 mi · Travelled 180 mi");
  await press(view, "usage-end-mileage-save");

  expect((await usageOf(first))?.endMileage).toBe(100_180);
  expect(view.queryByTestId("usage-end-mileage-saved")).not.toBeNull();
  await press(view, "usage-done");
  expect(text(view, "usage-end-mileage")).toBe("100,180 mi");
  expect(text(view, "usage-travelled")).toBe("180 mi");
});

test("an end mileage BELOW the start is refused on screen, and nothing is written", async () => {
  const { first } = await threeUseDay();
  const before = storedBytes();
  const view = await openEdit(first);

  await type(view, "usage-end-mileage-input", "99999");

  expect(text(view, "usage-end-mileage-hint")).toContain("cannot be below the start mileage");
  expect(isDisabled(view, "usage-end-mileage-save")).toBe(true);
  await press(view, "usage-end-mileage-save");
  expect(storedBytes()).toBe(before);
});

test("an end EQUAL to the start is a use that stood still, and is accepted", async () => {
  const { first } = await threeUseDay();
  const view = await openEdit(first);

  await type(view, "usage-end-mileage-input", "100000");
  await press(view, "usage-end-mileage-save");

  expect((await usageOf(first))?.endMileage).toBe(100_000);
});

test("an unchanged end mileage has nothing to save", async () => {
  const { first } = await threeUseDay();

  const view = await openEdit(first);

  expect(isDisabled(view, "usage-end-mileage-save")).toBe(true);
});

test("correcting one use changes its end mileage ALONE — its other facts, every other use and the vehicle in use are untouched", async () => {
  const { first, middle, second } = await threeUseDay();
  const before = await readOpenShift();
  const view = await openEdit(first);

  await type(view, "usage-end-mileage-input", "100150");
  await press(view, "usage-end-mileage-save");

  const after = await readOpenShift();
  const was = before?.previousVehicles.find(use => use.startedAt === first);
  const now = after?.previousVehicles.find(use => use.startedAt === first);
  // Plate, class, startedAt, endedAt, start mileage, checks and fills: identical.
  expect({ ...now, endMileage: 0 }).toEqual({ ...was, endMileage: 0 });
  expect(now?.endMileage).toBe(100_150);
  // The OTHER AB12 use, the XY34 use that followed, and the vehicle in use.
  for (const other of [middle, second]) {
    expect(JSON.stringify(after?.previousVehicles.find(use => use.startedAt === other)))
      .toBe(JSON.stringify(before?.previousVehicles.find(use => use.startedAt === other)));
  }
  expect(JSON.stringify(after?.vehicle)).toBe(JSON.stringify(before?.vehicle));
  expect(after?.previousVehicles.map(use => use.startedAt)).toEqual([first, middle, second]);
});

test("correcting the AFTERNOON AB12 leaves the MORNING AB12 byte-for-byte as it was", async () => {
  const { first, second } = await threeUseDay();
  const morning = JSON.stringify(await usageOf(first));
  const view = await openEdit(second);

  // A reading the morning use could also hold — a plate-based write would reach it.
  await type(view, "usage-end-mileage-input", "100700");
  await press(view, "usage-end-mileage-save");

  expect((await usageOf(second))?.endMileage).toBe(100_700);
  expect(JSON.stringify(await usageOf(first))).toBe(morning);
});

test("Edit's Fuel and AdBlue open the fill screen for THIS ended use", async () => {
  const { second } = await threeUseDay();
  const view = await openEdit(second);

  expect(text(view, "usage-edit-fuel-total")).toBe("60 L · 1 entry");
  expect(text(view, "usage-edit-adblue-total")).toBe("No entries");
  await press(view, "usage-edit-fuel");
  expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: "/vehicle-fill", params: { type: "fuel", usage: second, usageState: "ended" } });
  await press(view, "usage-edit-adblue");
  expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: "/vehicle-fill", params: { type: "adblue", usage: second, usageState: "ended" } });
});

test("Back from Edit returns to the use without writing, and a typed value is dropped", async () => {
  const { first } = await threeUseDay();
  const before = storedBytes();
  const view = await openEdit(first);

  await type(view, "usage-end-mileage-input", "100999");
  await press(view, "usage-back");

  expect(text(view, "screen-title")).toBe("Vehicle Use");
  expect(text(view, "usage-end-mileage")).toBe("100,120 mi");
  expect(mockRouter.back).not.toHaveBeenCalled();
  expect(storedBytes()).toBe(before);
});

test("with NO vehicle in use, an ended use can still be opened and its end mileage corrected", async () => {
  const { first } = await threeUseDay();
  await endWithNoVehicle(15, 220_450);
  const view = await openEdit(first);

  await type(view, "usage-end-mileage-input", "100130");
  await press(view, "usage-end-mileage-save");

  const day = await readOpenShift();
  expect(day?.vehicle).toBeNull();
  expect((await usageOf(first))?.endMileage).toBe(100_130);
});

test("a correction after the gap leaves the LATER vehicle's use exactly as it began", async () => {
  await dayWith();
  const morning = await endWithNoVehicle(13, 100_080);
  await addVehicleToOpenShift({ vehicle: XY34, startedAt: at(15) });
  const before = await readOpenShift();
  const view = await openEdit(morning);

  await type(view, "usage-end-mileage-input", "100090");
  await press(view, "usage-end-mileage-save");

  const after = await readOpenShift();
  expect(JSON.stringify(after?.vehicle)).toBe(JSON.stringify(before?.vehicle));
  // The two-hour gap survives: 13:00 end, 15:00 start.
  expect(after?.previousVehicles[0]?.endedAt).toBe(at(13).toISOString());
  expect(after?.vehicle?.startedAt).toBe(at(15).toISOString());
});

// ═══════════════════════════════════════════════════════════════════════════
// The store: correctEndMileage
// ═══════════════════════════════════════════════════════════════════════════

test("STORE: a below-start or non-whole reading is refused, writing nothing", async () => {
  const { first } = await threeUseDay();
  const shiftId = (await readOpenShift())?.id ?? "";
  const before = storedBytes();

  for (const endMileage of [99_999, -1, 100_120.5, Number.NaN]) {
    await expect(correctEndMileage({ shiftId, vehicleStartedAt: first, endMileage })).rejects.toThrow("Refusing");
  }

  expect(storedBytes()).toBe(before);
});

test("STORE: a use that is not an ENDED use of this open day is never corrected", async () => {
  const { first } = await threeUseDay();
  const day = await readOpenShift();
  const before = storedBytes();

  const results = await Promise.all([
    correctEndMileage({ shiftId: day?.id ?? "", vehicleStartedAt: "2026-09-19T23:59:00.000Z", endMileage: 100_200 }),
    correctEndMileage({ shiftId: day?.id ?? "", vehicleStartedAt: "AB12 CDE", endMileage: 100_200 }),
    correctEndMileage({ shiftId: day?.id ?? "", vehicleStartedAt: "", endMileage: 100_200 }),
    // The vehicle in use has no end to correct.
    correctEndMileage({ shiftId: day?.id ?? "", vehicleStartedAt: day?.vehicle?.startedAt ?? "", endMileage: 300_000 }),
    correctEndMileage({ shiftId: "another-day", vehicleStartedAt: first, endMileage: 100_200 }),
  ]);

  expect(results).toEqual([null, null, null, null, null]);
  expect(storedBytes()).toBe(before);
});

test("STORE: a corrected end mileage survives a cold start", async () => {
  const { first } = await threeUseDay();
  const shiftId = (await readOpenShift())?.id ?? "";

  await correctEndMileage({ shiftId, vehicleStartedAt: first, endMileage: 100_140 });

  // Read again from the file alone.
  expect(storedBytes()).toContain('"endMileage":100140');
  expect((await usageOf(first))?.endMileage).toBe(100_140);
});
