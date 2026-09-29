/**
 * Vehicle Check — the walkaround screen, and the route that stores it.
 *
 * The screen cases prove what the driver can and cannot do: every row starts
 * at the result declared for the class, any row can be changed, a defect
 * demands its description, and — crucially — a screen full of defaults is not
 * a completed check. The
 * route cases prove what reaches the phone: a draft saved as the driver goes,
 * restored exactly on return or after a restart, completed once with its
 * time, and never sent anywhere.
 */
import { useEffect, useRef } from "react";
import { render, fireEvent, act, waitFor, within } from "@testing-library/react-native";
import { File } from "expo-file-system";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Text, Pressable, View as RNView, ScrollView, TextInput, DeviceEventEmitter } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AuthenticatedAccount } from "../api/account";
import { VehicleCheckScreen, revealOffset, vehicleCheckSubject, visibleArea } from "../screens/VehicleCheckScreen";
import VehicleCheckRoute from "../../app/(app)/vehicle-check";
import ActiveShiftRoute from "../../app/(app)/active-shift";
import { checklistFor, checklistItems } from "../shift/checklists";
import * as localShift from "../shift/localShift";
import {
  USAGE_STATE,
  clearOpenShift,
  completeVehicleCheck,
  readOpenShift,
  saveVehicleCheckDraft,
  startLocalShift,
  type LocalShift,
  type LocalVehicle,
  type VehicleDetails,
} from "../shift/localShift";
import type { CheckAnswer, VehicleCheck } from "../shift/vehicleCheck";

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
    // Vehicle Checks for the vehicle in use are opened with no parameters.
    useLocalSearchParams: () => ({}),
    useFocusEffect: (effect: () => (() => void) | undefined) => { react.useEffect(effect, [effect]); },
  };
});

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const STARTED_AT = new Date(2026, 8, 13, 5, 42);
const UNIT: VehicleDetails = { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 124_560 };

/** The signed-in driver a completed check is attributed to. */
const DRIVER: AuthenticatedAccount = {
  user: { id: "user_1", firstName: "Nerijus", lastName: "Kuizinas", email: "driver@example.com" },
  identityToken: "identity.token.value",
  refreshToken: "refresh-secret-value",
  memberships: [],
};

type View = Awaited<ReturnType<typeof render>>;

const wrap = (node: React.ReactElement): Promise<View> =>
  render(<SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>);

async function press(view: View, testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(view.getByTestId(testID)); });
}
async function type(view: View, testID: string, value: string): Promise<void> {
  await act(async () => { await fireEvent.changeText(view.getByTestId(testID), value); });
}
function stateOf(view: View, testID: string): { selected?: boolean; disabled?: boolean } {
  const state: unknown = view.getByTestId(testID).props.accessibilityState;
  return typeof state === "object" && state !== null ? state : {};
}
const text = (view: View, testID: string) => String(view.getByTestId(testID).props.children);
const allText = (view: View) => JSON.stringify(view.toJSON()).toLowerCase();

function vehicleOf(details: VehicleDetails = UNIT, checks: VehicleCheck[] = []): LocalVehicle {
  return { ...details, useId: "use-unit", startedAt: STARTED_AT.toISOString(), checks, fills: [] };
}

const keysOf = (vehicleClass: VehicleDetails["vehicleClass"]) => checklistItems(checklistFor(vehicleClass)).map(entry => entry.key);

function draft(items: VehicleCheck["items"]): VehicleCheck {
  return { id: "c1", checklist: "hgv-unit", checklistVersion: 1, startedAt: STARTED_AT.toISOString(), status: "draft", completedAt: null, completedBy: null, items };
}
const passItem = (key: string) => ({ key, label: checklistItems(checklistFor("class1")).find(entry => entry.key === key)?.label ?? key, result: "pass" as const, note: null });

/** Typed, so a test reading back what the screen handed over stays type-safe. */
type AnswersMock = jest.Mock<Promise<void>, [CheckAnswer[]]>;
interface Harness { view: View; onSave: AnswersMock; onComplete: AnswersMock; onExit: jest.Mock<undefined, []> }

async function openScreen(details: VehicleDetails = UNIT, check: VehicleCheck | null = null): Promise<Harness> {
  const onSave: AnswersMock = jest.fn((_answers: CheckAnswer[]) => Promise.resolve());
  const onComplete: AnswersMock = jest.fn((_answers: CheckAnswer[]) => Promise.resolve());
  const onExit = jest.fn(() => undefined);
  const view = await wrap(
    <VehicleCheckScreen
      subject={vehicleCheckSubject(vehicleOf(details))} checklist={checklistFor(details.vehicleClass)} check={check}
      onSave={onSave} onComplete={onComplete} onExit={onExit}
    />,
  );
  return { view, onSave, onComplete, onExit };
}

beforeEach(async () => {
  await clearOpenShift();
  for (const fn of Object.values(mockRouter)) fn.mockClear();
});
afterEach(() => {
  jest.restoreAllMocks();
  // RN's test setup makes `isFocused` a plain mock, which restoring does not
  // reset: a test that says a field has the cursor must not leak into the next.
  jest.mocked(TextInput.prototype.isFocused).mockReset();
});

// ═══════════════════════════════════════════════════════════════════════════
// The right list for the vehicle
// ═══════════════════════════════════════════════════════════════════════════

test("a Class 1 is a UNIT CHECK over the unit list — and says nothing about a trailer", async () => {
  const { view } = await openScreen();

  expect(text(view, "screen-title")).toBe("Unit Check");
  for (const key of keysOf("class1")) expect(view.getByTestId(`check-row-${key}`)).toBeTruthy();
  expect(view.queryAllByTestId(/^check-row-/)).toHaveLength(42);
  expect(allText(view)).not.toMatch(/trailer|coupling|landing leg|brake line/);
});

test("a Class 2 is a VEHICLE CHECK over the rigid list", async () => {
  const { view } = await openScreen({ ...UNIT, vehicleClass: "class2" });

  expect(text(view, "screen-title")).toBe("Vehicle Check");
  expect(view.queryAllByTestId(/^check-row-/)).toHaveLength(42);
  expect(allText(view)).toContain("body, doors & wings");
  expect(allText(view)).not.toContain("tractor");
});

test("a Van is a VEHICLE CHECK over the VAN list, not the HGV one", async () => {
  const { view } = await openScreen({ vehicleClass: "van", numberPlate: "KAT 123", startMileage: 640 });

  expect(text(view, "screen-title")).toBe("Vehicle Check");
  for (const key of keysOf("van")) expect(view.getByTestId(`check-row-${key}`)).toBeTruthy();
  expect(view.queryAllByTestId(/^check-row-/)).toHaveLength(31);
  expect(view.queryByTestId("check-row-air-leaks")).toBeNull();
});

test("the vehicle is identified by its plate and start mileage", async () => {
  const { view } = await openScreen();

  expect(text(view, "check-plate")).toBe("AB12 CDE");
  expect(text(view, "check-mileage")).toBe("Start mileage: 124,560 mi");
});

// ═══════════════════════════════════════════════════════════════════════════
// Nothing is answered for the driver
// ═══════════════════════════════════════════════════════════════════════════

test("a FRESH check opens at the declared defaults — and is NOT a performed check", async () => {
  const { view, onSave } = await openScreen();

  // Everyday equipment starts OK; equipment a unit may not have starts N/A.
  expect(stateOf(view, "check-front-view-pass").selected).toBe(true);
  expect(stateOf(view, "check-horn-pass").selected).toBe(true);
  expect(stateOf(view, "check-hv-cut-off-na").selected).toBe(true);
  expect(stateOf(view, "check-other-equipment-na").selected).toBe(true);
  expect(stateOf(view, "check-front-view-na").selected).toBe(false);

  // Defaults are not evidence: nothing is stored, nothing claims completion,
  // and no counter says the round has been walked.
  expect(onSave).not.toHaveBeenCalled();
  expect(text(view, "check-status")).toBe("Not confirmed");
  expect(view.queryByTestId("check-progress")).toBeNull();
  expect(view.queryByTestId("check-percent")).toBeNull();
  expect(allText(view)).not.toContain("checks completed");
  // The footer states the results that stand, and the size of the list.
  expect(text(view, "summary-ok")).toBe("37 OK");
  expect(text(view, "summary-na")).toBe("5 N/A");
  expect(text(view, "summary-defects")).toBe("0 Defects");
  expect(text(view, "summary-total")).toBe("42 checks");
});

test("confirming a check with nothing wrong is one press — but it must BE pressed", async () => {
  const { view, onComplete } = await openScreen();

  // Nothing is wrong, so the defaults stand and Complete Check is available
  // immediately. It is still the driver's explicit confirmation.
  expect(stateOf(view, "complete-check").disabled).toBe(false);
  expect(onComplete).not.toHaveBeenCalled();

  await press(view, "complete-check");

  expect(onComplete).toHaveBeenCalledTimes(1);
  // And it confirms every row, defaults included.
  expect(onComplete.mock.calls[0]?.[0]).toHaveLength(42);
});

test("a default OK row can be changed — to N/A, or to DEFECT", async () => {
  const { view, onSave } = await openScreen();

  await press(view, "check-horn-na");
  expect(stateOf(view, "check-horn-na").selected).toBe(true);
  expect(stateOf(view, "check-horn-pass").selected).toBe(false);
  expect(text(view, "summary-ok")).toBe("36 OK");
  expect(text(view, "summary-na")).toBe("6 N/A");
  expect(onSave).toHaveBeenCalled();

  await press(view, "check-horn-fail");
  expect(stateOf(view, "check-horn-fail").selected).toBe(true);
  expect(view.getByTestId("check-defect-horn")).toBeTruthy();
  expect(text(view, "summary-defects")).toBe("1 Defect");
});

test("a default N/A row can be changed — to OK when the vehicle HAS the equipment, or to DEFECT", async () => {
  const { view } = await openScreen();

  // A unit that does carry a load, and does have a high-voltage system.
  await press(view, "check-load-security-pass");
  expect(stateOf(view, "check-load-security-pass").selected).toBe(true);
  expect(text(view, "summary-ok")).toBe("38 OK");
  expect(text(view, "summary-na")).toBe("4 N/A");

  await press(view, "check-hv-cut-off-fail");
  expect(stateOf(view, "check-hv-cut-off-fail").selected).toBe(true);
  expect(view.getByTestId("check-defect-hv-cut-off")).toBeTruthy();
  expect(text(view, "summary-defects")).toBe("1 Defect");
});

test("only ONE answer per row — choosing another replaces it", async () => {
  const { view } = await openScreen();

  await press(view, "check-horn-pass");
  await press(view, "check-horn-fail");

  expect(stateOf(view, "check-horn-pass").selected).toBe(false);
  expect(stateOf(view, "check-horn-na").selected).toBe(false);
  expect(stateOf(view, "check-horn-fail").selected).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// A defect needs its description
// ═══════════════════════════════════════════════════════════════════════════

test("DEFECT reveals 'Describe the defect *' under that row, at once", async () => {
  const { view, onSave } = await openScreen();

  await press(view, "check-oil-leaks-fail");

  const box = within(view.getByTestId("check-defect-oil-leaks"));
  expect(box.getByText("Describe the defect *")).toBeTruthy();
  expect(view.getByTestId("check-note-oil-leaks").props.maxLength).toBe(500);
  await type(view, "check-note-oil-leaks", "Oil level low.");
  // The screen hands over every row; the store keeps only what changed.
  const saved = onSave.mock.calls.at(-1)?.[0] ?? [];
  expect(saved).toHaveLength(42);
  expect(saved).toContainEqual({ key: "oil-leaks", result: "fail", note: "Oil level low." });
  expect(box.getByText("14/500")).toBeTruthy();
});

test("an UNDESCRIBED defect blocks completion — until it is described", async () => {
  const { view, onComplete } = await openScreen();

  await press(view, "check-horn-fail");
  expect(stateOf(view, "complete-check").disabled).toBe(true);
  expect(text(view, "check-blocker")).toBe("Describe the defect to complete the check");

  await type(view, "check-note-horn", "   ");
  expect(stateOf(view, "complete-check").disabled).toBe(true);
  await press(view, "complete-check");
  expect(onComplete).not.toHaveBeenCalled();

  await type(view, "check-note-horn", "Horn silent");
  expect(stateOf(view, "complete-check").disabled).toBe(false);
  expect(view.queryByTestId("check-blocker")).toBeNull();
});

test("changing DEFECT back to OK hides the field and drops the description", async () => {
  const { view, onSave } = await openScreen();
  await press(view, "check-horn-fail");
  await type(view, "check-note-horn", "Horn silent");

  await press(view, "check-horn-pass");

  expect(view.queryByTestId("check-defect-horn")).toBeNull();
  expect(onSave.mock.calls.at(-1)?.[0]).toContainEqual({ key: "horn", result: "pass", note: "" });
  // And choosing DEFECT again starts with an empty description, not the old one.
  await press(view, "check-horn-fail");
  expect(view.getByTestId("check-note-horn").props.value).toBe("");
});

test("the live summary counts the results that stand, defaults included", async () => {
  const { view } = await openScreen();

  expect(text(view, "summary-ok")).toBe("37 OK");

  await press(view, "check-adblue-na");
  await press(view, "check-oil-leaks-fail");
  await type(view, "check-note-oil-leaks", "Oil level low.");

  expect(text(view, "summary-ok")).toBe("35 OK");
  expect(text(view, "summary-na")).toBe("6 N/A");
  expect(text(view, "summary-defects")).toBe("1 Defect");
  expect(text(view, "summary-total")).toBe("42 checks");

  await press(view, "check-steering-fail");
  expect(text(view, "summary-defects")).toBe("2 Defects");
});

test("a draft in progress reads In progress — still not a completed check", async () => {
  const { view, onComplete } = await openScreen(UNIT, draft([
    { key: "horn", label: "Horn", result: "na", note: null },
  ]));

  expect(text(view, "check-status")).toBe("In progress");
  expect(stateOf(view, "check-horn-na").selected).toBe(true);
  expect(onComplete).not.toHaveBeenCalled();
});

test("rapid repeated Complete taps complete ONCE, with every answer", async () => {
  const onComplete: AnswersMock = jest.fn((_answers: CheckAnswer[]) => new Promise<void>(() => { /* in flight */ }));
  const view = await wrap(
    <VehicleCheckScreen
      subject={vehicleCheckSubject(vehicleOf())} checklist={checklistFor("class1")} check={null}
      onSave={() => Promise.resolve()} onComplete={onComplete} onExit={() => undefined}
    />,
  );

  const button = view.getByTestId("complete-check");
  await act(async () => {
    await fireEvent.press(button);
    await fireEvent.press(button);
    await fireEvent.press(button);
  });

  await waitFor(() => { expect(onComplete).toHaveBeenCalled(); });
  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(onComplete.mock.calls[0]?.[0]).toHaveLength(42);
});

// ═══════════════════════════════════════════════════════════════════════════
// Leaving, returning, and the finished check
// ═══════════════════════════════════════════════════════════════════════════

test("BACK is the only way out, and it loses nothing", async () => {
  const { view, onSave, onExit } = await openScreen();
  await press(view, "check-horn-na");

  // No Save & Exit beside it: answers are already saved, and offering both
  // would imply that Back is the one that discards them (owner correction).
  expect(view.queryByTestId("vehicle-check-save-exit")).toBeNull();
  await press(view, "vehicle-check-back");

  await waitFor(() => { expect(onExit).toHaveBeenCalledTimes(1); });
  expect(onSave).toHaveBeenCalled();
});

test("a saved draft opens EXACTLY as it was left — changes over defaults, description included", async () => {
  const check = draft([
    { key: "adblue", label: "AdBlue level", result: "na", note: null },
    { key: "hv-cut-off", label: "High-voltage cut-off", result: "pass", note: null },
    { key: "oil-leaks", label: "Oil leaks", result: "fail", note: "Oil level low." },
  ]);
  const { view } = await openScreen(UNIT, check);

  // The driver's changes...
  expect(stateOf(view, "check-adblue-na").selected).toBe(true);
  expect(stateOf(view, "check-hv-cut-off-pass").selected).toBe(true);
  expect(stateOf(view, "check-oil-leaks-fail").selected).toBe(true);
  expect(view.getByTestId("check-note-oil-leaks").props.value).toBe("Oil level low.");
  // ...over the untouched defaults.
  expect(stateOf(view, "check-front-view-pass").selected).toBe(true);
  expect(stateOf(view, "check-other-equipment-na").selected).toBe(true);
  expect(text(view, "check-status")).toBe("In progress");
});

test("a COMPLETED check is shown as completed and cannot be changed", async () => {
  const items = keysOf("class1").map(key => (key === "oil-leaks"
    ? { key, label: "Oil leaks", result: "fail" as const, note: "Oil level low." }
    : passItem(key)));
  const done: VehicleCheck = {
    ...draft(items), status: "completed",
    completedAt: new Date(2026, 8, 13, 6, 2).toISOString(), completedBy: "user_1",
  };
  const { view, onSave } = await openScreen(UNIT, done);

  expect(text(view, "check-status")).toBe("Completed");
  expect(text(view, "check-completed-at").toString()).toBeTruthy();
  expect(allText(view)).toContain("check completed at 06:02");
  expect(view.queryByTestId("complete-check")).toBeNull();
  expect(view.queryByTestId("vehicle-check-save-exit")).toBeNull();
  // A finished check records the defect; it no longer asks for it.
  expect(within(view.getByTestId("check-defect-oil-leaks")).getByText("Defect")).toBeTruthy();
  expect(allText(view)).not.toContain("describe the defect");
  expect(text(view, "check-note-oil-leaks")).toBe("Oil level low.");
  expect(stateOf(view, "check-horn-na").disabled).toBe(true);
  await press(view, "check-horn-na");
  expect(stateOf(view, "check-horn-pass").selected).toBe(true);
  expect(onSave).not.toHaveBeenCalled();
});

// ═══════════════════════════════════════════════════════════════════════════
// The status says what the driver has done — live
// ═══════════════════════════════════════════════════════════════════════════

test("the FIRST real change reads In progress at once — N/A to OK, on the same screen", async () => {
  const { view } = await openScreen();
  expect(text(view, "check-status")).toBe("Not confirmed");

  await press(view, "check-hv-cut-off-pass");

  expect(text(view, "check-status")).toBe("In progress");
});

test("OK to DEFECT reads In progress at once, and stays so while it is described", async () => {
  const { view } = await openScreen();

  await press(view, "check-horn-fail");
  expect(text(view, "check-status")).toBe("In progress");

  await type(view, "check-note-horn", "Horn silent");
  expect(text(view, "check-status")).toBe("In progress");
});

test("putting every change back to its default reads Not confirmed again", async () => {
  const { view } = await openScreen();

  await press(view, "check-hv-cut-off-pass");
  await press(view, "check-horn-fail");
  expect(text(view, "check-status")).toBe("In progress");

  await press(view, "check-horn-pass");
  // One change still stands.
  expect(text(view, "check-status")).toBe("In progress");

  await press(view, "check-hv-cut-off-na");
  expect(text(view, "check-status")).toBe("Not confirmed");
});

test("a saved draft of NO changes opens Not confirmed — defaults are not progress", async () => {
  const { view } = await openScreen(UNIT, draft([]));

  expect(text(view, "check-status")).toBe("Not confirmed");
});

test("put back and left, Active Shift agrees — Not completed, and no default rows were stored", async () => {
  await dayWith();
  const view = await openRoute();

  await press(view, "check-hv-cut-off-pass");
  await press(view, "check-hv-cut-off-na");
  await press(view, "vehicle-check-back");
  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift"); });

  // Only overrides are ever stored: with none left, the draft holds nothing.
  expect((await readOpenShift())?.vehicle?.checks[0]?.items).toEqual([]);
  const active = await wrap(<ActiveShiftRoute />);
  await waitFor(() => { expect(active.queryByTestId("vehicle-checks-state")).not.toBeNull(); });
  expect(text(active, "vehicle-checks-state")).toBe("Not completed");
});

// ═══════════════════════════════════════════════════════════════════════════
// Loading says what is happening
// ═══════════════════════════════════════════════════════════════════════════

test("while the check loads it says Loading check… — never Signing you in…", async () => {
  await dayWith();
  // Hold the read open, so the loading frame is what is on screen.
  jest.spyOn(localShift, "readOpenShift").mockReturnValue(new Promise<null>(() => undefined));

  const view = await signedIn(<VehicleCheckRoute />);

  expect(view.getByText("Loading check…")).toBeTruthy();
  expect(view.queryByText("Signing you in…")).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// A new defect's description is brought into view, and takes the cursor
// ═══════════════════════════════════════════════════════════════════════════

test.each([
  ["already clear of both bars",          { top: 300, bottom: 400 }, null],
  ["below the fold, behind the footer",   { top: 680, bottom: 800 }, 1112],   // 800 - (700 - 12)
  ["half behind the footer (last row)",   { top: 650, bottom: 760 }, 1072],   // 760 - 688
  ["taller than the list: top aligned",   { top: 500, bottom: 1400 }, 1388],  // 500 - (100 + 12)
  ["above the list, under the top bar",   { top: 60, bottom: 160 }, 948],     // 60 - 112
])("revealOffset: a box %s", (_where, box, expected) => {
  const list = { top: 100, bottom: 700 };

  expect(revealOffset(1000, box, list, 12)).toBe(expected);
});

test("revealOffset never asks to scroll above the top of the list", () => {
  expect(revealOffset(10, { top: 0, bottom: 50 }, { top: 100, bottom: 700 }, 12)).toBe(0);
});

/** The prototype every host view's `measureInWindow` comes from, in this renderer. */
async function hostViewPrototype(): Promise<{ measureInWindow: (callback: MeasureCallback) => void }> {
  let found: unknown = null;
  function Grab() {
    const ref = useRef<RNView>(null);
    useEffect(() => { found = ref.current === null ? null : Object.getPrototypeOf(ref.current); });
    return <RNView ref={ref} />;
  }
  const probe = await render(<Grab />);
  await probe.unmount();
  if (typeof found !== "object" || found === null || !("measureInWindow" in found)) throw new Error("no host view prototype");
  return found as { measureInWindow: (callback: MeasureCallback) => void };
}
type MeasureCallback = (x: number, y: number, width: number, height: number) => void;

/**
 * Lay the screen out as a phone would: a top bar ending at 100, the footer
 * starting at 700, and `box` wherever the new defect's field lands.
 */
async function withLayout(box: { top: number; height: number }) {
  const proto = await hostViewPrototype();
  jest.spyOn(proto, "measureInWindow").mockImplementation(function (this: { props?: { testID?: string } }, callback: MeasureCallback) {
    const id = this.props?.testID ?? "";
    if (id === "check-top-bar") callback(0, 0, 390, 100);
    else if (id === "check-footer") callback(0, 700, 390, 144);
    else if (id.startsWith("check-defect-")) callback(16, box.top, 358, box.height);
    else callback(0, 0, 0, 0);
  });
  const scrollTo = jest.spyOn(ScrollView.prototype, "scrollTo");
  const focus = jest.spyOn(TextInput.prototype, "focus");
  return { scrollTo, focus };
}

/** The platform's report that a view has been laid out — this renderer has no layout engine to send it. */
async function laidOut(view: View, testID: string): Promise<void> {
  await act(async () => {
    await fireEvent(view.getByTestId(testID), "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 358, height: 120 } } });
  });
}

test("DEFECT on a row near the bottom scrolls its field clear of the footer — and puts the cursor in it", async () => {
  const { scrollTo, focus } = await withLayout({ top: 680, height: 120 });
  const { view } = await openScreen();

  await press(view, "check-other-equipment-fail");
  await laidOut(view, "check-defect-other-equipment");

  // Exactly far enough: the box's bottom lands 12pt above the footer.
  await waitFor(() => { expect(scrollTo).toHaveBeenCalledWith({ y: 112, animated: true }); });
  expect(scrollTo).toHaveBeenCalledTimes(1);
  await waitFor(() => { expect(focus).toHaveBeenCalledTimes(1); });
});

test("DEFECT on a row already in view does not move the list — it only takes the cursor", async () => {
  const { scrollTo, focus } = await withLayout({ top: 300, height: 120 });
  const { view } = await openScreen();

  await press(view, "check-horn-fail");
  await laidOut(view, "check-defect-horn");

  await waitFor(() => { expect(focus).toHaveBeenCalledTimes(1); });
  expect(scrollTo).not.toHaveBeenCalled();
});

test("OK and N/A never move the list or raise the keyboard; nor does opening a saved defect", async () => {
  const { scrollTo, focus } = await withLayout({ top: 680, height: 120 });
  const { view } = await openScreen(UNIT, draft([{ key: "horn", label: "Horn", result: "fail", note: "Horn silent" }]));

  await press(view, "check-steering-na");
  await press(view, "check-hv-cut-off-pass");
  // The saved defect's box lays out on opening — that is not a new defect.
  await laidOut(view, "check-defect-horn");

  expect(scrollTo).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
});

// ═══════════════════════════════════════════════════════════════════════════
// With the keyboard up, the WHOLE description stays in view
// ═══════════════════════════════════════════════════════════════════════════

test.each([
  ["no keyboard: the footer is the limit",                         null, { top: 100, bottom: 700 }],
  ["keyboard up: what is left above it is the limit",              500,  { top: 100, bottom: 500 }],
  ["a keyboard lower than the footer: the footer is still the limit", 780, { top: 100, bottom: 700 }],
])("visibleArea — %s", (_case, keyboardTop, expected) => {
  expect(visibleArea(100, 700, keyboardTop)).toEqual(expected);
});

/** What the platform reports once the software keyboard has finished rising to `top`. */
async function keyboardShown(top: number): Promise<void> {
  await act(async () => {
    DeviceEventEmitter.emit("keyboardDidShow", { endCoordinates: { screenX: 0, screenY: top, width: 390, height: 844 - top } });
    await Promise.resolve();
  });
}

/** The list reporting where it has scrolled to — as the platform does on every scroll. */
async function scrolledTo(view: View, y: number): Promise<void> {
  await act(async () => {
    await fireEvent.scroll(view.getByTestId("vehicle-check-scroll"), { nativeEvent: { contentOffset: { x: 0, y } } });
  });
}

test("the LAST row's description is refitted above the settled keyboard — box, counter and all", async () => {
  // The last row's new box: 680–800, behind the footer at 700.
  const box = { top: 680, height: 120 };
  const { scrollTo } = await withLayout(box);
  const { view } = await openScreen();

  await press(view, "check-other-equipment-fail");
  await laidOut(view, "check-defect-other-equipment");
  // First, clear of the footer: 800 - (700 - 12).
  await waitFor(() => { expect(scrollTo).toHaveBeenLastCalledWith({ y: 112, animated: true }); });

  // The list has moved there; the field has the cursor; the keyboard settles with its top at 500.
  await scrolledTo(view, 112);
  box.top = 568;
  jest.spyOn(TextInput.prototype, "isFocused").mockReturnValue(true);
  await keyboardShown(500);

  // Refitted to the space left ABOVE the keyboard: the box's bottom lands 12pt
  // above it (112 + 688 - 488) — not merely above the footer the keyboard now hides.
  await waitFor(() => { expect(scrollTo).toHaveBeenLastCalledWith({ y: 312, animated: true }); });
  expect(scrollTo).toHaveBeenCalledTimes(2);
});

test("a description already clear of the settled keyboard is not moved", async () => {
  const { scrollTo, focus } = await withLayout({ top: 300, height: 120 });
  const { view } = await openScreen();

  await press(view, "check-horn-fail");
  await laidOut(view, "check-defect-horn");
  await waitFor(() => { expect(focus).toHaveBeenCalledTimes(1); });
  jest.spyOn(TextInput.prototype, "isFocused").mockReturnValue(true);
  await keyboardShown(500);
  await act(async () => { await Promise.resolve(); });

  expect(scrollTo).not.toHaveBeenCalled();
});

test("typing onto another line grows the box — and the list follows, keeping all of it above the keyboard", async () => {
  // Opens just clear of where the keyboard will settle: 368–488, limit 500 - 12.
  const box = { top: 368, height: 120 };
  const { scrollTo } = await withLayout(box);
  const { view } = await openScreen();
  await press(view, "check-other-equipment-fail");
  await laidOut(view, "check-defect-other-equipment");
  jest.spyOn(TextInput.prototype, "isFocused").mockReturnValue(true);
  await keyboardShown(500);
  expect(scrollTo).not.toHaveBeenCalled();

  // A second line of text: the box is 30pt taller, its bottom now at 518.
  box.height = 150;
  await laidOut(view, "check-defect-other-equipment");

  await waitFor(() => { expect(scrollTo).toHaveBeenLastCalledWith({ y: 30, animated: true }); });
});

test("once the driver has put the keyboard away, a later keyboard change does not pull the list back", async () => {
  const box = { top: 300, height: 120 };
  const { scrollTo } = await withLayout(box);
  const { view } = await openScreen();
  await press(view, "check-horn-fail");
  await laidOut(view, "check-defect-horn");
  const focused = jest.spyOn(TextInput.prototype, "isFocused").mockReturnValue(true);
  await keyboardShown(500);
  expect(scrollTo).not.toHaveBeenCalled();

  // Dragged away: the field loses the cursor, and the driver scrolls on so the
  // box now sits half behind the footer. The keyboard's frame then changes.
  focused.mockReturnValue(false);
  box.top = 650;
  await act(async () => {
    DeviceEventEmitter.emit("keyboardDidChangeFrame", { endCoordinates: { screenX: 0, screenY: 844, width: 390, height: 0 } });
    await Promise.resolve();
  });

  expect(scrollTo).not.toHaveBeenCalled();
});

test("the keyboard rising moves nothing while no description is being typed in", async () => {
  const { scrollTo, focus } = await withLayout({ top: 680, height: 120 });
  // A saved defect, opened — its box lays out, but nobody is typing in it.
  const { view } = await openScreen(UNIT, draft([{ key: "horn", label: "Horn", result: "fail", note: "Horn silent" }]));
  await laidOut(view, "check-defect-horn");

  await keyboardShown(500);
  await act(async () => { await Promise.resolve(); });

  expect(scrollTo).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
});

test("the keyboard cannot sit on a defect description", async () => {
  const { view } = await openScreen();
  const scroll = view.getByTestId("vehicle-check-scroll").props;

  expect(scroll.automaticallyAdjustKeyboardInsets).toBe(true);
  expect(scroll.keyboardDismissMode).toBe("on-drag");
  expect(scroll.keyboardShouldPersistTaps).toBe("handled");
});

// ═══════════════════════════════════════════════════════════════════════════
// The route: what reaches the phone
// ═══════════════════════════════════════════════════════════════════════════

async function dayWith(details: VehicleDetails = UNIT): Promise<LocalShift> {
  return startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle: details });
}

/**
 * The route with a driver signed in — the state the `(app)` gate guarantees
 * before this route is ever reached, and what a completion is attributed to.
 */
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

async function openRoute(): Promise<View> {
  const view = await signedIn(<VehicleCheckRoute />);
  await waitFor(() => { expect(view.queryByTestId("complete-check") ?? view.queryByTestId("check-completed-at")).not.toBeNull(); });
  return view;
}

test("OPENING a check stores nothing — Active Shift still reads Not completed", async () => {
  await dayWith();
  const writes = jest.spyOn(File.prototype, "write");

  const view = await openRoute();
  await press(view, "vehicle-check-back");

  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift"); });
  // Not a single write: 42 rows on screen, none of them on disk.
  expect(writes).not.toHaveBeenCalled();
  expect((await readOpenShift())?.vehicle?.checks).toEqual([]);
});

test("only the driver's CHANGES are stored, and leaving keeps the draft In progress", async () => {
  const shift = await dayWith();
  const view = await openRoute();

  // One row confirmed as it already stood (no change), one changed, one defect.
  await press(view, "check-front-view-pass");
  await press(view, "check-load-security-pass");
  await press(view, "check-oil-leaks-fail");
  await type(view, "check-note-oil-leaks", "Oil level low.");
  await press(view, "vehicle-check-back");

  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift"); });
  const checks = (await readOpenShift())?.vehicle?.checks ?? [];
  expect(checks).toHaveLength(1);
  expect(checks[0]).toMatchObject({ status: "draft", completedAt: null, checklist: "hgv-unit" });
  // `front-view` was already OK, so it is not a change and is not written.
  // Stored in checklist order: Fluids comes before Load / Equipment.
  expect(checks[0]?.items).toEqual([
    { key: "oil-leaks", label: "Oil leaks", result: "fail", note: "Oil level low." },
    { key: "load-security", label: "Load security", result: "pass", note: null },
  ]);
  // It belongs to THIS day's vehicle — the day is otherwise untouched.
  expect((await readOpenShift())?.startedAt).toBe(shift.startedAt);
});

test("after a RESTART, Active Shift reads In progress and the check reopens exactly", async () => {
  await dayWith();
  const first = await openRoute();
  await press(first, "check-horn-pass");
  await press(first, "check-steering-fail");
  await type(first, "check-note-steering", "Excess play");
  await press(first, "vehicle-check-back");
  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalled(); });
  await first.unmount();

  // Fresh mounts read only the file — what a relaunch has to work with.
  const active = await wrap(<ActiveShiftRoute />);
  await waitFor(() => { expect(active.queryByTestId("vehicle-checks-state")).not.toBeNull(); });
  expect(text(active, "vehicle-checks-state")).toBe("In progress");
  await active.unmount();

  const reopened = await openRoute();
  expect(stateOf(reopened, "check-horn-pass").selected).toBe(true);
  expect(stateOf(reopened, "check-steering-fail").selected).toBe(true);
  expect(reopened.getByTestId("check-note-steering").props.value).toBe("Excess play");
});

test("completing stores the completion time, returns to the shift, and Active Shift reads Completed", async () => {
  const shift = await dayWith();
  const vehicleUseId = shift.vehicle?.useId ?? "";
  // Every row but one already answered, as a driver part-way through.
  await saveVehicleCheckDraft({
    shiftId: shift.id, vehicleUseId, usageState: USAGE_STATE.inUse, checkId: "c1", startedAt: STARTED_AT,
    answers: keysOf("class1").filter(key => key !== "horn").map(key => ({ key, result: "pass", note: "" })),
  });
  const before = Date.now();

  const view = await openRoute();
  await press(view, "check-horn-fail");
  await type(view, "check-note-horn", "Horn silent");
  await press(view, "complete-check");

  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift"); });
  const check = (await readOpenShift())?.vehicle?.checks[0];
  expect(check?.status).toBe("completed");
  expect(Date.parse(check?.completedAt ?? "")).toBeGreaterThanOrEqual(before - 1000);
  expect(check?.items.find(entry => entry.key === "horn")).toEqual({
    key: "horn", label: "Horn", section: { id: "cab", title: "CAB / DRIVER VIEW" }, result: "fail", note: "Horn silent",
  });

  const active = await wrap(<ActiveShiftRoute />);
  await waitFor(() => { expect(active.queryByTestId("vehicle-checks-state")).not.toBeNull(); });
  expect(text(active, "vehicle-checks-state")).toBe("Completed");
});

test("a check certified through the route is attributed to the SIGNED-IN driver", async () => {
  await dayWith();
  const view = await openRoute();

  await press(view, "check-oil-leaks-fail");
  await type(view, "check-note-oil-leaks", "Oil level low.");
  await press(view, "complete-check");

  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift"); });
  const check = (await readOpenShift())?.vehicle?.checks[0];
  expect(check?.completedBy).toBe(DRIVER.user.id);
  expect(typeof check?.completedAt).toBe("string");
});

test("a draft carries no completion time and no driver — defaults on screen change nothing", async () => {
  await dayWith();
  const view = await openRoute();

  // 37 OK and 5 N/A are on screen from the moment it opens; none of that is a
  // certification, and leaving with one change stores a draft, not a check.
  await press(view, "check-horn-na");
  await press(view, "vehicle-check-back");

  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalled(); });
  const check = (await readOpenShift())?.vehicle?.checks[0];
  expect(check?.status).toBe("draft");
  expect(check?.completedAt).toBeNull();
  expect(check?.completedBy).toBeNull();
});

test("rapid Complete taps through the route store ONE completed check", async () => {
  const shift = await dayWith();
  await saveVehicleCheckDraft({
    shiftId: shift.id, vehicleUseId: shift.vehicle?.useId ?? "", usageState: USAGE_STATE.inUse, checkId: "c1", startedAt: STARTED_AT,
    answers: keysOf("class1").map(key => ({ key, result: "pass", note: "" })),
  });
  const view = await openRoute();

  const button = view.getByTestId("complete-check");
  await act(async () => {
    await fireEvent.press(button);
    await fireEvent.press(button);
  });

  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalled(); });
  expect(mockRouter.dismissTo).toHaveBeenCalledTimes(1);
  const checks = (await readOpenShift())?.vehicle?.checks ?? [];
  expect(checks).toHaveLength(1);
  expect(checks[0]?.status).toBe("completed");
});

test("the whole flow works with the network DEAD, and calls no server", async () => {
  const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(() => Promise.reject(new Error("offline")));
  await dayWith({ vehicleClass: "van", numberPlate: "KAT 123", startMileage: 640 });

  const view = await openRoute();
  for (const key of keysOf("van")) await press(view, `check-${key}-pass`);
  await press(view, "complete-check");

  await waitFor(async () => { expect((await readOpenShift())?.vehicle?.checks[0]?.status).toBe("completed"); });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("with no vehicle there is nothing to check — back to Active Shift; with no day, Home", async () => {
  await startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle: null });
  const noVehicle = await wrap(<VehicleCheckRoute />);
  await waitFor(() => { expect(noVehicle.queryByTestId("redirect")).not.toBeNull(); });
  expect(text(noVehicle, "redirect")).toBe("/active-shift");
  await noVehicle.unmount();

  await clearOpenShift();
  const noDay = await wrap(<VehicleCheckRoute />);
  await waitFor(() => { expect(noDay.queryByTestId("redirect")).not.toBeNull(); });
  expect(text(noDay, "redirect")).toBe("/today");
});

test("a COMPLETED check is still reachable from Active Shift — demoted, not disabled", async () => {
  const shift = await dayWith();
  await completeVehicleCheck({
    shiftId: shift.id, vehicleUseId: shift.vehicle?.useId ?? "", usageState: USAGE_STATE.inUse, checkId: "c1", startedAt: STARTED_AT,
    answers: keysOf("class1").map(key => ({ key, result: "pass", note: "" })), completedAt: new Date(), completedBy: "user_1",
  });

  const view = await wrap(<ActiveShiftRoute />);
  await waitFor(() => { expect(text(view, "vehicle-checks-state")).toBe("Completed"); });

  // It is no longer the filled next action, but the record stays openable.
  expect(stateOf(view, "vehicle-checks").disabled).toBe(false);
  await press(view, "vehicle-checks");
  // For EXACTLY the use in the card.
  expect(mockRouter.push).toHaveBeenCalledWith({ pathname: "/vehicle-check", params: { usage: shift.vehicle?.useId, usageState: "in-use" } });
});

test("Active Shift opens the check, and its row follows Not completed → In progress → Completed", async () => {
  const shift = await dayWith();
  const target = { shiftId: shift.id, vehicleUseId: shift.vehicle?.useId ?? "", usageState: USAGE_STATE.inUse, checkId: "c1", startedAt: STARTED_AT };

  const notYet = await wrap(<ActiveShiftRoute />);
  await waitFor(() => { expect(notYet.queryByTestId("vehicle-checks")).not.toBeNull(); });
  expect(text(notYet, "vehicle-checks-state")).toBe("Not completed");
  await press(notYet, "vehicle-checks");
  expect(mockRouter.push).toHaveBeenCalledWith({ pathname: "/vehicle-check", params: { usage: shift.vehicle?.useId, usageState: "in-use" } });
  await notYet.unmount();

  // A real change: Horn starts at OK. (OK would be no change at all, and a
  // draft of no changes is not work in progress.)
  await saveVehicleCheckDraft({ ...target, answers: [{ key: "horn", result: "na", note: "" }] });
  const inProgress = await wrap(<ActiveShiftRoute />);
  await waitFor(() => { expect(text(inProgress, "vehicle-checks-state")).toBe("In progress"); });
  await inProgress.unmount();

  await completeVehicleCheck({ ...target, answers: keysOf("class1").map(key => ({ key, result: "pass", note: "" })), completedAt: new Date(), completedBy: "user_1" });
  const done = await wrap(<ActiveShiftRoute />);
  await waitFor(() => { expect(text(done, "vehicle-checks-state")).toBe("Completed"); });
});
