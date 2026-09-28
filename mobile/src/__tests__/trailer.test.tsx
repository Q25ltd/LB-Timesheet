/**
 * Trailers on the phone — Active Shift's CURRENT TRAILER, Add Trailer, Change
 * Trailer, Fridge Diesel, and the van refusal on the vehicle screens (D34).
 *
 * The store is proven in `trailerStore.test.ts`; these prove what the driver
 * sees and presses, against the real routes and the real store: a trailer
 * section only behind a vehicle that tows one, no invented trailer check, the
 * vehicle card folding when — and only when — a trailer has just been taken
 * (D33), and every write naming the exact use it was begun for.
 */
import { render, fireEvent, act, waitFor, within } from "@testing-library/react-native";
import { File, Paths } from "expo-file-system";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Alert } from "react-native";
import { ActiveShiftScreen } from "../screens/ActiveShiftScreen";
import AddTrailerRoute from "../../app/(app)/add-trailer";
import ChangeTrailerRoute from "../../app/(app)/change-trailer";
import TrailerDieselRoute from "../../app/(app)/trailer-diesel";
import ChangeVehicleRoute from "../../app/(app)/change-vehicle";
import {
  OPEN_SHIFT_FILE,
  USAGE_STATE,
  addTrailerToOpenShift,
  addVehicleToOpenShift,
  changeTrailer,
  completeTrailerCheck,
  clearOpenShift,
  endVehicleUse,
  readOpenShift,
  recordReeferDiesel,
  startLocalShift,
  type LocalShift,
  type LocalVehicle,
  type VehicleDetails,
} from "../shift/localShift";
import { TRAILER_TYPE, type EndedTrailer, type LocalTrailer, type TrailerDetails } from "../shift/trailer";
import { checklistItems, trailerChecklistFor } from "../shift/checklists";

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismissTo: jest.fn() };
const params: { trailer?: string; usageState?: string } = {};

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
const STARTED_AT = new Date(2026, 8, 19, 5, 0);
const at = (hours: number, minutes = 0) => new Date(2026, 8, 19, hours, minutes);
const UNIT: VehicleDetails = { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 };
const VAN: VehicleDetails = { vehicleClass: "van", numberPlate: "VN12 ABC", startMileage: 9_000 };
const FRIDGE: TrailerDetails = { trailerNumber: "TR1234", trailerType: TRAILER_TYPE.refrigerated };
const BOX: TrailerDetails = { trailerNumber: "TR5678", trailerType: TRAILER_TYPE.standard };

type View = Awaited<ReturnType<typeof render>>;

const wrap = (node: React.ReactElement): Promise<View> =>
  render(<SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>);
const bytes = () => new File(Paths.document, OPEN_SHIFT_FILE).textSync();
const text = (view: View, testID: string) => String(view.getByTestId(testID).props.children);

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
function isExpanded(view: View, testID: string): boolean {
  const state: unknown = view.getByTestId(testID).props.accessibilityState;
  return typeof state === "object" && state !== null && "expanded" in state && state.expanded === true;
}

beforeEach(async () => {
  await clearOpenShift();
  delete params.trailer;
  delete params.usageState;
  for (const fn of Object.values(mockRouter)) fn.mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// Active Shift — the screen, fed a day directly
// ═══════════════════════════════════════════════════════════════════════════

function vehicleOf(details: VehicleDetails): LocalVehicle {
  return { ...details, startedAt: STARTED_AT.toISOString(), checks: [], fills: [] };
}
function trailerOf(details: TrailerDetails, startedAt = at(5, 35), litres: (number | null)[] = []): LocalTrailer {
  return {
    ...details, startedAt: startedAt.toISOString(),
    reeferDiesel: litres.map((amount, index) => ({ id: `f${index}`, recordedAt: at(7).toISOString(), litres: amount, note: null })),
    checks: [],
  };
}
function day(over: Partial<LocalShift> = {}): LocalShift {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    workingFor: { kind: "personal" },
    startedAt: STARTED_AT.toISOString(),
    vehicle: vehicleOf(UNIT),
    previousVehicles: [],
    trailer: null,
    previousTrailers: [],
    status: "open",
    createdAt: STARTED_AT.toISOString(),
    ...over,
  };
}

interface Handlers {
  onAddTrailer: jest.Mock; onChangeTrailer: jest.Mock; onFridgeDiesel: jest.Mock; onTrailerChecks: jest.Mock; onOpenTrailerUsage: jest.Mock;
  onFill: jest.Mock; onVehicleChecks: jest.Mock; onChangeVehicle: jest.Mock; onOpenUsage: jest.Mock;
}
function handlers(): Handlers {
  return {
    onAddTrailer: jest.fn(), onChangeTrailer: jest.fn(), onFridgeDiesel: jest.fn(), onTrailerChecks: jest.fn(), onOpenTrailerUsage: jest.fn(),
    onFill: jest.fn(), onVehicleChecks: jest.fn(), onChangeVehicle: jest.fn(), onOpenUsage: jest.fn(),
  };
}
function screen(shift: LocalShift, on: Handlers): React.ReactElement {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ActiveShiftScreen shift={shift} onDiscard={() => undefined} onAddVehicle={() => undefined} {...on} />
    </SafeAreaProvider>
  );
}
const show = (shift: LocalShift, on: Handlers = handlers()) => render(screen(shift, on));

test.each([["a Class 1", UNIT], ["a Class 2", { ...UNIT, vehicleClass: "class2" as const }]] as const)(
  "%s with no trailer shows CURRENT TRAILER — 'No trailer' and Add Trailer, and nothing more",
  async (_what, vehicle) => {
    const on = handlers();
    const view = await show(day({ vehicle: vehicleOf(vehicle) }), on);

    expect(text(view, "current-trailer-label")).toBe("CURRENT TRAILER");
    const card = within(view.getByTestId("no-trailer"));
    expect(card.getByText("No trailer")).toBeTruthy();
    await fireEvent.press(view.getByTestId("add-trailer"));
    expect(on.onAddTrailer).toHaveBeenCalledTimes(1);
    expect(view.queryByTestId("trailer-number-value")).toBeNull();
  },
);

test("a VAN shows no trailer section at all", async () => {
  const view = await show(day({ vehicle: vehicleOf(VAN) }));

  expect(view.queryByTestId("current-trailer-label")).toBeNull();
  expect(view.queryByTestId("add-trailer")).toBeNull();
});

test("the trailer section sits between the vehicle card and USED THIS SHIFT", async () => {
  const ended = { ...vehicleOf(UNIT), startedAt: at(4).toISOString(), endMileage: 100_000, endedAt: STARTED_AT.toISOString() };
  const view = await show(day({ previousVehicles: [ended], trailer: trailerOf(BOX) }));

  const order = ["current-asset-label", "current-trailer-label", "used-this-shift-label", "finish-shift"];
  const json = JSON.stringify(view.toJSON());
  const positions = order.map(id => json.indexOf(`"testID":"${id}"`));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
});

test("a STANDARD trailer: its number, 'Standard', Change Trailer — and no Fridge Diesel", async () => {
  const view = await show(day({ trailer: trailerOf(BOX) }));

  expect(text(view, "trailer-number-value")).toBe("TR5678");
  expect(text(view, "trailer-type-value")).toBe("Standard");
  expect(view.queryByTestId("change-trailer")).not.toBeNull();
  expect(view.queryByTestId("fridge-diesel")).toBeNull();
});

test("a REFRIGERATED trailer: its number, 'Refrigerated', Change Trailer and Fridge Diesel with its own total", async () => {
  const on = handlers();
  const trailer = trailerOf(FRIDGE, at(5, 35), [80, null]);
  const view = await show(day({ trailer }), on);

  expect(text(view, "trailer-number-value")).toBe("TR1234");
  expect(text(view, "trailer-type-value")).toBe("Refrigerated");
  expect(text(view, "fridge-diesel-amount")).toBe("80 L known");
  expect(text(view, "fridge-diesel-detail")).toBe("1 amount unknown");
  await fireEvent.press(view.getByTestId("fridge-diesel"));
  expect(on.onFridgeDiesel).toHaveBeenCalledWith(trailer.startedAt);
  // The unit's own Fuel tile knows nothing of it.
  expect(view.queryByTestId("fuel-amount")).toBeNull();
});


test("the trailer card starts EXPANDED, folds to its number centred with a chevron, and opens again", async () => {
  const view = await show(day({ trailer: trailerOf(FRIDGE) }));
  expect(isExpanded(view, "current-trailer-toggle")).toBe(true);

  await fireEvent.press(view.getByTestId("current-trailer-toggle"));
  expect(isExpanded(view, "current-trailer-toggle")).toBe(false);
  expect(text(view, "trailer-number-value")).toBe("TR1234");
  expect(view.queryByTestId("current-trailer-chevron")).not.toBeNull();
  for (const hidden of ["trailer-type-value", "change-trailer", "fridge-diesel"]) expect(view.queryByTestId(hidden)).toBeNull();

  await fireEvent.press(view.getByTestId("current-trailer-toggle"));
  expect(isExpanded(view, "current-trailer-toggle")).toBe(true);
});

test("vehicle and trailer are NOT an exclusive accordion: both can be open, and folding one leaves the other", async () => {
  const view = await show(day({ trailer: trailerOf(FRIDGE) }));

  expect(isExpanded(view, "current-vehicle-toggle")).toBe(true);
  expect(isExpanded(view, "current-trailer-toggle")).toBe(true);
  await fireEvent.press(view.getByTestId("current-trailer-toggle"));
  expect(isExpanded(view, "current-vehicle-toggle")).toBe(true);
  await fireEvent.press(view.getByTestId("current-trailer-toggle"));
  await fireEvent.press(view.getByTestId("current-vehicle-toggle"));
  expect(isExpanded(view, "current-trailer-toggle")).toBe(true);
});

test("the card actions do their own jobs and fold nothing", async () => {
  const on = handlers();
  const view = await show(day({ trailer: trailerOf(FRIDGE) }), on);

  for (const action of ["change-trailer", "fridge-diesel", "vehicle-checks", "change-vehicle", "fuel", "adblue"]) {
    await fireEvent.press(view.getByTestId(action));
  }

  expect(on.onChangeTrailer).toHaveBeenCalledTimes(1);
  expect(on.onFridgeDiesel).toHaveBeenCalledTimes(1);
  expect(isExpanded(view, "current-vehicle-toggle")).toBe(true);
  expect(isExpanded(view, "current-trailer-toggle")).toBe(true);
});

test("pressing a USED THIS SHIFT row folds BOTH cards", async () => {
  const ended = { ...vehicleOf(UNIT), startedAt: at(4).toISOString(), endMileage: 100_000, endedAt: STARTED_AT.toISOString() };
  const on = handlers();
  const view = await show(day({ previousVehicles: [ended], trailer: trailerOf(FRIDGE) }), on);

  await fireEvent.press(view.getByTestId(`usage-${ended.startedAt}`));

  expect(on.onOpenUsage).toHaveBeenCalledWith(ended.startedAt);
  expect(isExpanded(view, "current-vehicle-toggle")).toBe(false);
  expect(isExpanded(view, "current-trailer-toggle")).toBe(false);
});

// ─── USED THIS SHIFT: vehicles, then trailers ─────────────────────────────

function endedTrailer(details: TrailerDetails, from: Date, to: Date, checks: EndedTrailer["checks"] = []): EndedTrailer {
  return { ...trailerOf(details, from), checks, endedAt: to.toISOString() };
}
const ENDED_VEHICLE = { ...vehicleOf(UNIT), startedAt: at(4).toISOString(), endMileage: 100_000, endedAt: STARTED_AT.toISOString() };
const certificate = (status: "completed" | "draft") => [{
  id: `c-${status}`, checklist: "trailer-standard" as const, checklistVersion: 1, startedAt: at(10, 6).toISOString(), status,
  completedAt: status === "completed" ? at(10, 10).toISOString() : null, completedBy: status === "completed" ? "user_1" : null,
  items: status === "completed"
    ? [{ key: "body", label: "Body panels & wings", section: { id: "body", title: "BODY / EXTERIOR" }, result: "pass" as const, note: null }]
    : [{ key: "landing-legs", label: "Landing legs", result: "na" as const, note: null }],
}];

test("ended trailers are listed under TRAILERS, below VEHICLES — one row per use, newest ended first, never grouped", async () => {
  const tr23a = endedTrailer({ trailerNumber: "TR23", trailerType: TRAILER_TYPE.standard }, at(10, 5), at(10, 13));
  const gfd = endedTrailer({ trailerNumber: "GFD", trailerType: TRAILER_TYPE.standard }, at(10, 13), at(10, 19));
  const tr23b = endedTrailer({ trailerNumber: "TR23", trailerType: TRAILER_TYPE.standard }, at(10, 19), at(11));
  const view = await show(day({
    previousVehicles: [ENDED_VEHICLE],
    previousTrailers: [tr23a, gfd, tr23b],
    trailer: trailerOf({ trailerNumber: "JGG", trailerType: TRAILER_TYPE.standard }, at(11)),
  }));

  expect(text(view, "used-vehicles-label")).toBe("VEHICLES");
  expect(text(view, "used-trailers-label")).toBe("TRAILERS");
  const json = JSON.stringify(view.toJSON());
  expect(json.indexOf('"testID":"used-vehicles-label"')).toBeLessThan(json.indexOf('"testID":"used-trailers-label"'));
  expect(view.queryAllByTestId(/^trailer-usage-[0-9]/).map(node => String(node.props.testID)))
    .toEqual([tr23b, gfd, tr23a].map(use => `trailer-usage-${use.startedAt}`));
  expect(text(view, `trailer-usage-number-${tr23a.startedAt}`)).toBe("TR23");
  expect(text(view, `trailer-usage-meta-${tr23a.startedAt}`)).toBe("Standard · 10:05–10:13");
  expect(text(view, `trailer-usage-meta-${gfd.startedAt}`)).toBe("Standard · 10:13–10:19");
  // The trailer in use is the current card, never history.
  expect(within(view.getByTestId("used-trailers")).queryByText("JGG")).toBeNull();
});

test("each trailer row states its OWN check truthfully — a draft is 'Checks not completed'", async () => {
  const done = endedTrailer(BOX, at(10, 5), at(10, 13), certificate("completed"));
  const drafted = endedTrailer(BOX, at(10, 13), at(10, 19), certificate("draft"));
  const none = endedTrailer(FRIDGE, at(10, 19), at(11));
  const view = await show(day({ previousTrailers: [done, drafted, none] }));

  const said = (use: EndedTrailer) => text(view, `trailer-usage-checks-${use.startedAt}`);
  expect(said(done)).toBe("Checks completed");
  expect(said(drafted)).toBe("Checks not completed");
  expect(said(none)).toBe("Checks not completed");
});

test("each trailer row is a way in, with a chevron, opening EXACTLY its own use — two TR23 rows open two uses", async () => {
  const on = handlers();
  const tr23a = endedTrailer({ trailerNumber: "TR23", trailerType: TRAILER_TYPE.refrigerated }, at(10, 5), at(10, 13));
  const tr23b = { ...endedTrailer({ trailerNumber: "TR23", trailerType: TRAILER_TYPE.refrigerated }, at(10, 19), at(11)),
    reeferDiesel: [{ id: "f1", recordedAt: at(10, 30).toISOString(), litres: 80, note: null }] };
  const view = await show(day({ previousTrailers: [tr23a, tr23b], trailer: trailerOf(FRIDGE, at(11)) }), on);

  for (const use of [tr23a, tr23b]) {
    expect(view.getByTestId(`trailer-usage-${use.startedAt}`).props.accessibilityRole).toBe("button");
    expect(view.queryByTestId(`trailer-usage-chevron-${use.startedAt}`)).not.toBeNull();
  }
  await fireEvent.press(view.getByTestId(`trailer-usage-${tr23b.startedAt}`));
  expect(on.onOpenTrailerUsage).toHaveBeenLastCalledWith(tr23b.startedAt);
  await fireEvent.press(view.getByTestId(`trailer-usage-${tr23a.startedAt}`));
  expect(on.onOpenTrailerUsage).toHaveBeenLastCalledWith(tr23a.startedAt);
  // Still no fridge diesel on the compact row.
  expect(within(view.getByTestId("used-trailers")).queryByText(/Diesel|80 L/)).toBeNull();
  // Opening a trailer use is focus elsewhere: the current cards fold.
  expect(view.getByTestId("current-trailer-toggle").props.accessibilityState).toMatchObject({ expanded: false });
});

test("with only trailer history, USED THIS SHIFT shows TRAILERS alone; with none at all, nothing", async () => {
  const onlyTrailers = await show(day({ previousTrailers: [endedTrailer(BOX, at(10, 5), at(10, 13))] }));
  expect(onlyTrailers.queryByTestId("used-this-shift-label")).not.toBeNull();
  expect(onlyTrailers.queryByTestId("used-vehicles-label")).toBeNull();
  expect(onlyTrailers.queryByTestId("used-trailers")).not.toBeNull();
  await onlyTrailers.unmount();

  const nothing = await show(day());
  expect(nothing.queryByTestId("used-this-shift-label")).toBeNull();
});

// ─── D33: a trailer JUST taken folds the vehicle card ─────────────────────

test("a trailer ADDED while the screen is open folds the vehicle card, and the new trailer opens expanded", async () => {
  const on = handlers();
  const view = await show(day(), on);
  expect(isExpanded(view, "current-vehicle-toggle")).toBe(true);

  await view.rerender(screen(day({ trailer: trailerOf(FRIDGE) }), on));

  expect(isExpanded(view, "current-vehicle-toggle")).toBe(false);
  expect(isExpanded(view, "current-trailer-toggle")).toBe(true);
  // … and the driver can open the vehicle again.
  await fireEvent.press(view.getByTestId("current-vehicle-toggle"));
  expect(isExpanded(view, "current-vehicle-toggle")).toBe(true);
});

test("a CANCELLED Add Trailer — the same day coming back — folds nothing", async () => {
  const on = handlers();
  const view = await show(day(), on);
  await fireEvent.press(view.getByTestId("add-trailer"));

  await view.rerender(screen(day(), on));

  expect(isExpanded(view, "current-vehicle-toggle")).toBe(true);
});

test("a trailer CHANGED to another folds the vehicle card; the same trailer re-rendered does not", async () => {
  const on = handlers();
  const first = trailerOf(FRIDGE);
  const view = await show(day({ trailer: first }), on);

  await view.rerender(screen(day({ trailer: first }), on));
  expect(isExpanded(view, "current-vehicle-toggle")).toBe(true);

  await view.rerender(screen(day({ trailer: trailerOf(BOX, at(9)) }), on));
  expect(isExpanded(view, "current-vehicle-toggle")).toBe(false);
});

test("opening Active Shift with a trailer ALREADY in use (a restart) folds nothing", async () => {
  const view = await show(day({ trailer: trailerOf(FRIDGE) }));

  expect(isExpanded(view, "current-vehicle-toggle")).toBe(true);
});

test("with NO vehicle there is no trailer section at all", async () => {
  const view = await show(day({ vehicle: null }));

  expect(view.queryByTestId("current-trailer-label")).toBeNull();
  expect(view.queryByTestId("add-trailer")).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// Add Trailer — the real route and store
// ═══════════════════════════════════════════════════════════════════════════

async function dayWith(vehicle: VehicleDetails | null = UNIT): Promise<LocalShift> {
  return startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle });
}
async function mount(node: React.ReactElement): Promise<View> {
  const view = await wrap(node);
  await waitFor(() => { expect(view.queryByTestId("screen-title") ?? view.queryByTestId("redirect")).not.toBeNull(); });
  return view;
}

test("Add Trailer asks the number and the type — nothing else — and stores ONE trailer however many taps", async () => {
  await dayWith();
  const view = await mount(<AddTrailerRoute />);

  expect(isDisabled(view, "add-trailer-submit")).toBe(true);
  await type(view, "trailer-number", " tr1234 ");
  expect(isDisabled(view, "add-trailer-submit")).toBe(true);
  await press(view, "trailer-type-refrigerated");
  await act(async () => {
    const add = view.getByTestId("add-trailer-submit");
    await Promise.all([fireEvent.press(add), fireEvent.press(add), fireEvent.press(add)]);
  });

  const stored = await readOpenShift();
  expect(stored?.trailer).toMatchObject({ trailerNumber: "TR1234", trailerType: "refrigerated", reeferDiesel: [] });
  expect(stored?.previousTrailers).toEqual([]);
  expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift");
  for (const absent of ["mileage", "odometer", "Checks", "Temperature", "litres"]) {
    expect(JSON.stringify(view.toJSON())).not.toContain(absent);
  }
});

test("backing out of Add Trailer writes nothing", async () => {
  await dayWith();
  const before = bytes();
  const view = await mount(<AddTrailerRoute />);
  await type(view, "trailer-number", "TR9");
  await press(view, "trailer-type-standard");

  await press(view, "add-trailer-back");

  expect(mockRouter.back).toHaveBeenCalled();
  expect(bytes()).toBe(before);
});

test.each([["a van", VAN], ["no vehicle", null]] as const)("Add Trailer is not a screen behind %s", async (_what, vehicle) => {
  await dayWith(vehicle);

  const view = await mount(<AddTrailerRoute />);

  expect(text(view, "redirect")).toBe("/active-shift");
});

// ═══════════════════════════════════════════════════════════════════════════
// Change Trailer — the real route and store
// ═══════════════════════════════════════════════════════════════════════════

async function withTrailer(trailer: TrailerDetails = FRIDGE, hour = 5): Promise<LocalShift> {
  const shift = await dayWith();
  await addTrailerToOpenShift({ shiftId: shift.id, trailer, startedAt: at(hour, 35) });
  return shift;
}

test("a DIFFERENT trailer: the one in use ends, the new one begins — the vehicle is untouched", async () => {
  await withTrailer(FRIDGE);
  const vehicle = JSON.stringify((await readOpenShift())?.vehicle);
  const view = await mount(<ChangeTrailerRoute />);

  expect(text(view, "ending-trailer")).toBe("TR1234");
  await press(view, "use-different-trailer");
  await type(view, "trailer-number", "tr5678");
  await press(view, "trailer-type-standard");
  await press(view, "change-trailer-confirm");

  const stored = await readOpenShift();
  expect(stored?.previousTrailers).toMatchObject([{ trailerNumber: "TR1234" }]);
  expect(stored?.trailer).toMatchObject({ trailerNumber: "TR5678", trailerType: "standard", reeferDiesel: [] });
  expect(stored?.previousTrailers[0]?.endedAt).toBe(stored?.trailer?.startedAt);
  expect(JSON.stringify(stored?.vehicle)).toBe(vehicle);
});

test("Change Trailer offers ONLY a different trailer or No trailer — no trailer used earlier is listed", async () => {
  const shift = await withTrailer(FRIDGE);
  await changeTrailer({ shiftId: shift.id, endingStartedAt: at(5, 35).toISOString(), next: BOX, changedAt: at(9) });

  const view = await mount(<ChangeTrailerRoute />);

  expect(text(view, "ending-trailer")).toBe("TR5678");
  expect(view.queryByTestId("use-different-trailer")).not.toBeNull();
  expect(view.queryByTestId("use-no-trailer")).not.toBeNull();
  expect(view.queryAllByTestId(/^trailer-candidate-/)).toEqual([]);
  expect(JSON.stringify(view.toJSON())).not.toContain("USED THIS SHIFT");
  expect(JSON.stringify(view.toJSON())).not.toContain("TR1234");
});

test("typing a trailer used EARLIER is a NEW use — new start, no fridge diesel, no Trailer Check inherited", async () => {
  const shift = await withTrailer(FRIDGE);
  const morning = at(5, 35).toISOString();
  await recordReeferDiesel({ shiftId: shift.id, trailerStartedAt: morning, usageState: USAGE_STATE.inUse, fillId: "morning-fill", recordedAt: at(6), litres: 50, note: "" });
  await completeTrailerCheck({
    shiftId: shift.id, trailerStartedAt: morning, usageState: USAGE_STATE.inUse, checkId: "morning-check", startedAt: at(5, 40),
    answers: checklistItems(trailerChecklistFor(TRAILER_TYPE.refrigerated)).map(entry => ({ key: entry.key, result: entry.defaultResult, note: "" })),
    completedAt: at(5, 50), completedBy: "user_1",
  });
  await changeTrailer({ shiftId: shift.id, endingStartedAt: morning, next: BOX, changedAt: at(9) });
  const view = await mount(<ChangeTrailerRoute />);

  await press(view, "use-different-trailer");
  await type(view, "trailer-number", "tr1234");
  await press(view, "trailer-type-refrigerated");
  await press(view, "change-trailer-confirm");

  const stored = await readOpenShift();
  expect(stored?.trailer?.trailerNumber).toBe("TR1234");
  expect(stored?.trailer?.startedAt).not.toBe(morning);
  expect(stored?.trailer?.reeferDiesel).toEqual([]);
  expect(stored?.trailer?.checks).toEqual([]);
  // The morning's use keeps its own diesel and certificate.
  expect(stored?.previousTrailers[0]).toMatchObject({ startedAt: morning, reeferDiesel: [{ id: "morning-fill" }], checks: [{ id: "morning-check" }] });
});

test("NO TRAILER ends the trailer and leaves the shift and the vehicle as they were", async () => {
  await withTrailer(FRIDGE);
  const vehicle = JSON.stringify((await readOpenShift())?.vehicle);
  const view = await mount(<ChangeTrailerRoute />);

  await press(view, "use-no-trailer");
  await act(async () => {
    const confirm = view.getByTestId("no-trailer-confirm");
    await Promise.all([fireEvent.press(confirm), fireEvent.press(confirm)]);
  });

  const stored = await readOpenShift();
  expect(stored?.trailer).toBeNull();
  expect(stored?.status).toBe("open");
  expect(stored?.previousTrailers).toHaveLength(1);
  expect(JSON.stringify(stored?.vehicle)).toBe(vehicle);
});

test("backing out of Change Trailer writes nothing", async () => {
  await withTrailer(FRIDGE);
  const before = bytes();
  const view = await mount(<ChangeTrailerRoute />);

  await press(view, "use-no-trailer");
  await press(view, "change-trailer-back");
  await press(view, "change-trailer-back");

  expect(mockRouter.back).toHaveBeenCalled();
  expect(bytes()).toBe(before);
});

// ═══════════════════════════════════════════════════════════════════════════
// Fridge Diesel — the real route and store
// ═══════════════════════════════════════════════════════════════════════════

async function openDiesel(): Promise<View> {
  params.trailer = (await readOpenShift())?.trailer?.startedAt ?? "";
  params.usageState = USAGE_STATE.inUse;
  return mount(<TrailerDieselRoute />);
}

test("Fridge Diesel is named as such, for the trailer — never as Fuel", async () => {
  await withTrailer(FRIDGE);

  const view = await openDiesel();

  expect(text(view, "screen-title")).toBe("Add Fridge Diesel");
  expect(text(view, "fill-vehicle")).toBe("TR1234");
});

test("a KNOWN amount with a time and a note lands on the trailer use — and nowhere on the vehicle", async () => {
  await withTrailer(FRIDGE);
  const view = await openDiesel();

  await type(view, "fill-time-hours", "07");
  await type(view, "fill-time-minutes", "20");
  await press(view, "amount-known");
  await type(view, "litres", "62,5");
  await type(view, "fill-note", "Depot tank");
  await press(view, "fill-save");

  const stored = await readOpenShift();
  expect(stored?.trailer?.reeferDiesel).toMatchObject([{ litres: 62.5, note: "Depot tank" }]);
  const when = new Date(stored?.trailer?.reeferDiesel[0]?.recordedAt ?? "");
  expect([when.getHours(), when.getMinutes()]).toEqual([7, 20]);
  expect(stored?.vehicle?.fills).toEqual([]);
});

test("an UNKNOWN amount is stored with no litres, and a double tap stores one", async () => {
  await withTrailer(FRIDGE);
  const view = await openDiesel();

  await press(view, "amount-unknown");
  await act(async () => {
    const save = view.getByTestId("fill-save");
    await Promise.all([fireEvent.press(save), fireEvent.press(save), fireEvent.press(save)]);
  });

  expect((await readOpenShift())?.trailer?.reeferDiesel).toMatchObject([{ litres: null }]);
});

test("STALE: the trailer was changed while the form was open — nothing is saved anywhere, and the driver is told", async () => {
  const shift = await withTrailer(FRIDGE);
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await openDiesel();
  await press(view, "amount-known");
  await type(view, "litres", "70");

  // Behind the form, TR1234 is swapped for ANOTHER refrigerated TR1234 use.
  await changeTrailer({ shiftId: shift.id, endingStartedAt: at(5, 35).toISOString(), next: FRIDGE, changedAt: at(9) });
  const before = bytes();
  await press(view, "fill-save");

  expect(bytes()).toBe(before);
  const stored = await readOpenShift();
  expect(stored?.trailer?.reeferDiesel).toEqual([]);
  expect(stored?.previousTrailers[0]?.reeferDiesel).toEqual([]);
  expect(alert).toHaveBeenCalled();
  expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift");
});

test.each([
  ["a STANDARD trailer", async (): Promise<string> => { await withTrailer(BOX); return (await readOpenShift())?.trailer?.startedAt ?? ""; }],
  ["a trailer number", async (): Promise<string> => { await withTrailer(FRIDGE); return "TR1234"; }],
  ["a use that has ended", async (): Promise<string> => {
    const shift = await withTrailer(FRIDGE);
    await changeTrailer({ shiftId: shift.id, endingStartedAt: at(5, 35).toISOString(), next: null, changedAt: at(9) });
    return at(5, 35).toISOString();
  }],
] as const)("Fridge Diesel is not a screen for %s", async (_what, name) => {
  params.trailer = await name();

  const view = await mount(<TrailerDieselRoute />);

  expect(text(view, "redirect")).toBe("/active-shift");
});

// ═══════════════════════════════════════════════════════════════════════════
// The vehicle screens refuse a van while a trailer is in use
// ═══════════════════════════════════════════════════════════════════════════

test("Change Vehicle to a NEW van with a trailer in use: blocked, told why, and nothing changes", async () => {
  await withTrailer(FRIDGE);
  const before = bytes();
  const view = await mount(<ChangeVehicleRoute />);
  await type(view, "end-mileage", "100100");
  await press(view, "change-continue");
  await press(view, "use-different");

  await press(view, "vehicle-class-van");
  await type(view, "number-plate", "VN12 ABC");
  await type(view, "start-mileage", "9000");

  expect(text(view, "van-trailer-block")).toContain("TR1234");
  expect(isDisabled(view, "change-confirm")).toBe(true);
  await press(view, "change-confirm");
  expect(bytes()).toBe(before);

  // CONTROL: a Class 2 instead is allowed.
  await press(view, "vehicle-class-class2");
  expect(view.queryByTestId("van-trailer-block")).toBeNull();
  expect(isDisabled(view, "change-confirm")).toBe(false);
});

test("Change Vehicle BACK to a van used earlier, with a trailer in use: blocked the same way", async () => {
  const shift = await dayWith(VAN);
  const open = await readOpenShift();
  await endVehicleUse({ shiftId: shift.id, endingStartedAt: open?.vehicle?.startedAt ?? "", endMileage: 9_100, endedAt: at(6) });
  // A unit is taken, then a trailer behind it.
  await addVehicleToOpenShift({ vehicle: UNIT, startedAt: at(7) });
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: FRIDGE, startedAt: at(7, 30) });
  const before = bytes();
  const view = await mount(<ChangeVehicleRoute />);
  await type(view, "end-mileage", "100100");
  await press(view, "change-continue");

  await press(view, "candidate-VN12 ABC");
  await type(view, "next-start-mileage", "9100");
  await press(view, "perform-checks-no");

  expect(view.queryByTestId("van-trailer-block")).not.toBeNull();
  expect(isDisabled(view, "change-confirm")).toBe(true);
  expect(bytes()).toBe(before);
});

test("Change Vehicle to NO VEHICLE with a trailer in use: blocked, told to hand it back, and nothing changes", async () => {
  await withTrailer(FRIDGE);
  const before = bytes();
  const view = await mount(<ChangeVehicleRoute />);
  await type(view, "end-mileage", "100100");
  await press(view, "change-continue");

  await press(view, "use-no-vehicle");

  expect(text(view, "no-vehicle-trailer-block")).toContain("Hand back TR1234 first");
  expect(isDisabled(view, "no-vehicle-confirm")).toBe(true);
  await press(view, "no-vehicle-confirm");
  expect(bytes()).toBe(before);
});

test("after No trailer, Change Vehicle to No vehicle goes through", async () => {
  const shift = await withTrailer(FRIDGE);
  await changeTrailer({ shiftId: shift.id, endingStartedAt: at(5, 35).toISOString(), next: null, changedAt: at(9) });
  const view = await mount(<ChangeVehicleRoute />);
  await type(view, "end-mileage", "100100");
  await press(view, "change-continue");

  await press(view, "use-no-vehicle");
  expect(view.queryByTestId("no-vehicle-trailer-block")).toBeNull();
  await press(view, "no-vehicle-confirm");

  const stored = await readOpenShift();
  expect(stored?.vehicle).toBeNull();
  expect(stored?.trailer).toBeNull();
});
