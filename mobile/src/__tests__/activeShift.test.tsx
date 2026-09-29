/**
 * Active Shift — the workspace, and the things it must never claim.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THESE CASES OWN, AND WHAT THEY DO NOT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * They own DATA and STATE: that what is rendered came from the persisted
 * shift, that the two real branches differ, that every unbuilt control is
 * genuinely inert, and that nothing is fabricated. They do NOT own spacing,
 * hierarchy or density — Jest has no geometry, and claiming otherwise here
 * would turn a design review into a pile of brittle pixel assertions. Real
 * pixels own the look.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE INVENTED-DATA CASES ARE THE POINT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * This screen renders a workspace whose actions do not exist yet, which is
 * exactly the situation in which a placeholder gets added "so the card does
 * not look empty". A trailer number, a current mileage, a distance, a fuel
 * total, a defect count, a completed check — any of them would be believed by
 * a driver, because the rest of the screen is true. So several cases below
 * assert the ABSENCE of things, scanning the whole rendered text rather than
 * one node, and they fail the moment a plausible-looking value appears.
 */
import { render, fireEvent, waitFor, within } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Alert, StyleSheet } from "react-native";
import { ActiveShiftScreen } from "../screens/ActiveShiftScreen";
import ActiveShiftRoute from "../../app/(app)/active-shift";
import { Directory, File, Paths } from "expo-file-system";
import { OPEN_SHIFT_TEMP_FILE, clearOpenShift, readOpenShift, startLocalShift } from "../shift/localShift";
import type { LocalShift, LocalVehicle, VehicleClass, WorkingContext } from "../shift/localShift";
import { checklistFor } from "../shift/checklists";
import { CHECK_RESULT, CHECK_STATUS, type VehicleCheck } from "../shift/vehicleCheck";
import { colors } from "../theme/index";

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn() };

jest.mock("expo-router", () => {
  const react = jest.requireActual<typeof import("react")>("react");
  const rn = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    __esModule: true,
    router: {
      replace: (href: string): void => { mockRouter.replace(href); },
      push:    (href: string): void => { mockRouter.push(href); },
      back:    (): void => { mockRouter.back(); },
      navigate: (href: string): void => { mockRouter.navigate(href); },
    },
    Redirect: ({ href }: { href: string }) =>
      react.createElement(rn.Text, { testID: "redirect" }, String(href)),
    // The route re-reads the day on focus; in a test, mounting is the focus.
    useFocusEffect: (effect: () => (() => void) | undefined) => { react.useEffect(effect, [effect]); },
  };
});

const METRICS = {
  frame:  { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const PERSONAL: WorkingContext = { kind: "personal" };
const NORTHGATE: WorkingContext = {
  kind: "company",
  membershipId: "mem_1",
  companyId: "co_1",
  companyName: "Northgate Logistics",
};

const LORRY: LocalVehicle = {
  vehicleClass: "class2", numberPlate: "AB24 XYZ", startMileage: 184_203,
  useId: "use-lorry", startedAt: new Date(2026, 8, 13, 5, 42).toISOString(),
  checks: [], fills: [],
};

function shiftWith(over: Partial<LocalShift> = {}): LocalShift {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    workingFor: PERSONAL,
    startedAt: new Date(2026, 8, 13, 5, 42).toISOString(),
    vehicle: null,
    previousVehicles: [],
    trailer: null,
    previousTrailers: [],
    status: "open",
    createdAt: new Date(2026, 8, 13, 5, 42).toISOString(),
    ...over,
  };
}

type View = Awaited<ReturnType<typeof render>>;

function show(shift: LocalShift, onDiscard: () => void = () => undefined, onFinish: () => void = () => undefined): Promise<View> {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ActiveShiftScreen
        shift={shift} onDiscard={onDiscard} onFinish={onFinish} onCorrectPlate={() => undefined} onCorrectTrailerNumber={() => undefined} onAddVehicle={() => undefined}
        onVehicleChecks={() => undefined} onChangeVehicle={() => undefined} onFill={() => undefined} onOpenUsage={() => undefined} onAddTrailer={() => undefined} onChangeTrailer={() => undefined} onFridgeDiesel={() => undefined} onTrailerChecks={() => undefined} onOpenTrailerUsage={() => undefined}
      />
    </SafeAreaProvider>,
  );
}

/**
 * Everything the screen actually puts on the glass, as one string.
 *
 * Walked off the rendered tree rather than queried node by node, because the
 * absence cases below are asserting that a word appears NOWHERE — a query for
 * one testID would miss a placeholder added anywhere else on the screen.
 */
function renderedText(view: View): string {
  const collected: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") { collected.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === "object" && node !== null && "children" in node) {
      walk(node.children);
    }
  };
  walk(view.toJSON());
  return collected.join(" ");
}

/**
 * Press a control and prove the SCREEN did nothing of its own — no
 * confirmation raised, no request made, no navigation. Whatever it asks for
 * goes through its callback, and the route decides.
 *
 * `props.onPress` cannot carry this: `Pressable` does not forward it to the
 * host node, so only consequences can be asserted.
 */
async function pressingDoesNothingItself(view: View, testID: string): Promise<void> {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const fetchSpy = jest.spyOn(global, "fetch");
  mockRouter.replace.mockClear();
  mockRouter.push.mockClear();

  await fireEvent.press(view.getByTestId(testID));

  expect(alert).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(mockRouter.replace).not.toHaveBeenCalled();
  expect(mockRouter.push).not.toHaveBeenCalled();
  alert.mockRestore();
  fetchSpy.mockRestore();
}

function isDisabled(view: View, testID: string): boolean {
  const props = view.getByTestId(testID).props as { accessibilityState?: { disabled?: boolean } };
  return props.accessibilityState?.disabled === true;
}

// ═══════════════════════════════════════════════════════════════════════════
// The day, as it was actually started
// ═══════════════════════════════════════════════════════════════════════════

test("the screen is built from the PERSISTED shift, not from defaults", async () => {
  const view = await show(shiftWith({ workingFor: NORTHGATE, vehicle: LORRY }));

  expect(view.getByTestId("screen-title").props.children).toBe("Active Shift");
  expect(view.getByTestId("shift-started-at").props.children).toBe("05:42");
  expect(view.getByTestId("shift-working-for").props.children).toBe("Northgate Logistics");
});

test("Personal is carried as itself — no company is invented to fill the slot", async () => {
  const view = await show(shiftWith());

  expect(view.getByTestId("shift-working-for").props.children).toBe("Personal");
});

test("a LONG company name is shown IN FULL — never cut to an ellipsis", async () => {
  // Identifying information: two operators can share a prefix, and the driver
  // has nowhere else in the app to read the rest of the name.
  const long = "Northgate Heavy Haulage & Logistics International";
  const view = await show(shiftWith({ workingFor: { ...NORTHGATE, companyName: long } }));

  const shown = view.getByTestId("shift-working-for");
  expect(shown.props.children).toBe(long);
  // No clamp at all — the name wraps to as many lines as it needs, and the
  // card grows with it. A `numberOfLines` here is what truncated it before.
  expect(shown.props.numberOfLines).toBeUndefined();
  // Nor is it shrunk to fit a fixed height, which fails for the same reason.
  expect(shown.props.adjustsFontSizeToFit).toBeUndefined();
});

test("the start time is unaffected by however long the company name is", async () => {
  const short = await show(shiftWith({ workingFor: NORTHGATE }));
  const long  = await show(shiftWith({
    workingFor: { ...NORTHGATE, companyName: "Northgate Heavy Haulage & Logistics International" },
  }));

  // Separate columns of one row: the taller one sets the row height, and
  // neither displaces the other.
  expect(short.getByTestId("shift-started-at").props.children).toBe("05:42");
  expect(long.getByTestId("shift-started-at").props.children).toBe("05:42");
});

test("a DIFFERENT start time renders differently — the clock is not hard-coded", async () => {
  const view = await show(shiftWith({ startedAt: new Date(2026, 8, 13, 22, 7).toISOString() }));

  expect(view.getByTestId("shift-started-at").props.children).toBe("22:07");
});

test("choosing a company is an INTENTION — nothing claims it was sent (D28)", async () => {
  const text = renderedText(await show(shiftWith({ workingFor: NORTHGATE, vehicle: LORRY })));

  for (const claim of ["Synced", "Sent", "Submitted", "Uploaded", "Received", "Connected"]) {
    expect(text).not.toContain(claim);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// No vehicle — a complete state, not a half-start (D29)
// ═══════════════════════════════════════════════════════════════════════════

test("a shift with no vehicle says so, plainly", async () => {
  const view = await show(shiftWith());

  expect(view.getByTestId("no-vehicle")).toBeTruthy();
  expect(renderedText(view)).toContain("No active vehicle");
  expect(view.queryByTestId("active-vehicle")).toBeNull();
});

test("the no-vehicle state offers Add Vehicle, and it is LIVE", async () => {
  // This replaces the Step 3A contract that Add Vehicle does nothing. The flow
  // it opens, and what it stores, are proven in `addVehicle.test.tsx`.
  const view = await show(shiftWith());

  expect(view.getByTestId("add-vehicle")).toBeTruthy();
  expect(isDisabled(view, "add-vehicle")).toBe(false);
});

test("Add Vehicle belongs to the no-vehicle state ALONE", async () => {
  const view = await show(shiftWith({ vehicle: LORRY }));

  // A driver already in a truck is offered Change, never Add.
  expect(view.queryByTestId("add-vehicle")).toBeNull();
  expect(view.getByTestId("change-vehicle")).toBeTruthy();
});

test("no vehicle means NO vehicle detail is rendered from anywhere", async () => {
  const text = renderedText(await show(shiftWith()));

  expect(text).not.toContain("Start mileage");
  expect(text).not.toContain("Vehicle checks");
});

// ═══════════════════════════════════════════════════════════════════════════
// The vehicle, exactly as the driver entered it
// ═══════════════════════════════════════════════════════════════════════════

test("class, plate and start mileage all come from the shift", async () => {
  const view = await show(shiftWith({ vehicle: LORRY }));

  expect(view.getByTestId("vehicle-class-value").props.children).toBe("Class 2");
  expect(view.getByTestId("vehicle-plate-value").props.children).toBe("AB24 XYZ");
  expect(view.getByTestId("vehicle-mileage-value").props.children).toBe("184,203 mi");
});

test("the plate is shown VERBATIM — never reformatted into a UK shape", async () => {
  // Plates are international. A Lithuanian one must survive intact.
  const view = await show(shiftWith({
    vehicle: { vehicleClass: "van", numberPlate: "KAT 123", startMileage: 640, useId: "use-kat", startedAt: LORRY.startedAt, checks: [], fills: [] },
  }));

  expect(view.getByTestId("vehicle-plate-value").props.children).toBe("KAT 123");
  // Small readings are not padded or grouped into something they are not.
  expect(view.getByTestId("vehicle-mileage-value").props.children).toBe("640 mi");
});

test("no CURRENT or END mileage is invented — only the start reading exists", async () => {
  const text = renderedText(await show(shiftWith({ vehicle: LORRY })));

  expect(text).toContain("Start mileage");
  for (const invented of ["Current mileage", "End mileage", "Distance", "Miles today", "Odometer"]) {
    expect(text).not.toContain(invented);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Checks have not happened, and the screen never suggests otherwise
// ═══════════════════════════════════════════════════════════════════════════

test("vehicle checks read as NOT COMPLETED, because that is the truth", async () => {
  const view = await show(shiftWith({ vehicle: LORRY }));

  expect(view.getByTestId("vehicle-checks-state").props.children).toBe("Not completed");
});

test("nothing on the screen claims a vehicle has PASSED a check", async () => {
  const text = renderedText(await show(shiftWith({ vehicle: LORRY })));

  for (const lie of ["Completed", "Passed", "Roadworthy", "Safe", "Checked", "Defect-free"]) {
    expect(text).not.toContain(lie);
  }
  // "Not completed" survives that sweep only because of its capital N.
  expect(text).toContain("Not completed");
});

test("Vehicle Checks is present for a vehicle, and is LIVE", async () => {
  // Replaces the Step 3A contract that it does nothing. What it opens, and
  // the states this row shows, are proven in `vehicleCheck.test.tsx`.
  const view = await show(shiftWith({ vehicle: LORRY }));

  expect(isDisabled(view, "vehicle-checks")).toBe(false);
});

// ═══════════════════════════════════════════════════════════════════════════
// Unit and trailer are separate assets — and always will be
// ═══════════════════════════════════════════════════════════════════════════

test("a Class 1 is a UNIT; a van is not, because drivers do not call it one", async () => {
  const unit = await show(shiftWith({ vehicle: { ...LORRY, vehicleClass: "class1" } }));
  expect(unit.getByTestId("current-asset-label").props.children).toBe("CURRENT UNIT");
  expect(unit.getByTestId("change-vehicle").props.accessibilityLabel).toBe("Change Unit");

  const van = await show(shiftWith({ vehicle: { ...LORRY, vehicleClass: "van" } }));
  expect(van.getByTestId("current-asset-label").props.children).toBe("CURRENT VEHICLE");
  expect(van.getByTestId("change-vehicle").props.accessibilityLabel).toBe("Change Vehicle");
});

test("NO trailer is fabricated — a unit with none says 'No trailer', never a number, a type or a state", async () => {
  // Class 1 is the tempting case: it pulls a trailer, and none was recorded.
  // D34 replaced "nothing at all" with an honest "No trailer" and Add Trailer.
  const view = await show(shiftWith({ vehicle: { ...LORRY, vehicleClass: "class1" } }));
  const text = renderedText(view);

  expect(view.queryByTestId("no-trailer")).not.toBeNull();
  expect(view.queryByTestId("trailer-number-value")).toBeNull();
  expect(view.queryByTestId("trailer-type-value")).toBeNull();
  for (const invented of ["Trailer: None", "Standard", "Refrigerated", "Fridge Diesel", "Trailer checks", "Checks not completed"]) {
    expect(text).not.toContain(invented);
  }
});

test("there is no COMBINED vehicle-and-trailer check workflow", async () => {
  const view = await show(shiftWith({ vehicle: { ...LORRY, vehicleClass: "class1" } }));
  const text = renderedText(view);

  // Two assets, two independent inspections, two screens — never one control
  // that pretends to cover both.
  expect(text).not.toContain("Vehicle & Trailer");
  expect(text).not.toContain("Vehicle and Trailer");
  expect(view.queryByTestId("trailer-checks")).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// Everything unbuilt is visible, ranked, and inert
// ═══════════════════════════════════════════════════════════════════════════

test("Change Vehicle is present for a vehicle, and is LIVE", async () => {
  // Replaces the Step 3A contract that it does nothing. What it opens is
  // proven in `changeVehicle.test.tsx`.
  const view = await show(shiftWith({ vehicle: LORRY }));

  expect(view.getByTestId("change-vehicle").props.accessibilityLabel).toBe("Change Vehicle");
  expect(isDisabled(view, "change-vehicle")).toBe(false);
});

test("Finish Shift is LIVE: pressing it only asks for the Finish flow — it finishes nothing itself", async () => {
  const onFinish = jest.fn();
  // A day that used no vehicle has no check to warn about, so the press goes
  // straight through; the warning itself is proven in `finishShift.test.tsx`.
  const view = await show(shiftWith(), () => undefined, onFinish);

  expect(view.getByTestId("finish-shift").props.accessibilityLabel).toBe("Finish Shift");
  expect(isDisabled(view, "finish-shift")).toBe(false);
  await pressingDoesNothingItself(view, "finish-shift");
  expect(onFinish).toHaveBeenCalledTimes(1);
});

test.each([["fuel", "Fuel"], ["adblue", "AdBlue"]])("%s is LIVE once there is a vehicle to put it in", async (testID, label) => {
  // Replaces the Step 3A contract that these do nothing. What they open is
  // proven in `vehicleFill.test.tsx`.
  const view = await show(shiftWith({ vehicle: LORRY }));

  expect(view.getByTestId(testID).props.accessibilityLabel).toBe(label);
  expect(isDisabled(view, testID)).toBe(false);
});

test("with NO vehicle there is no Fuel or AdBlue at all — nothing to put it into", async () => {
  const view = await show(shiftWith());

  // Not disabled tiles: absent. A fill needs a vehicle in use (D31, D32).
  expect(view.queryByTestId("fuel")).toBeNull();
  expect(view.queryByTestId("adblue")).toBeNull();
  // A day with no vehicle can still be finished (no mileage is asked).
  expect(isDisabled(view, "finish-shift")).toBe(false);
});

test("Fuel and AdBlue sit INSIDE the current vehicle card, not in a section of their own", async () => {
  const view = await show(shiftWith({ vehicle: LORRY }));

  const card = view.getByTestId("active-vehicle");
  expect(within(card).queryByTestId("fuel")).not.toBeNull();
  expect(within(card).queryByTestId("adblue")).not.toBeNull();
  expect(renderedText(view)).not.toContain("DURING THE SHIFT");
});

test("no fuel or AdBlue TOTALS are shown, because no entry has ever been made", async () => {
  const text = renderedText(await show(shiftWith({ vehicle: LORRY })));

  for (const invented of ["Last fuel", "Fuel total", "AdBlue total", "litres", "Litres"]) {
    expect(text).not.toContain(invented);
  }
});

test("Discard is live, and asks before it acts", async () => {
  const view = await show(shiftWith({ vehicle: LORRY }));

  // This replaces the Step 3A contract that Discard must be absent. It was
  // absent because it did nothing, and a control that does nothing is worse
  // than none; it is here now because it does something, and because a driver
  // who books on by mistake has no other way out of the day.
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  await fireEvent.press(view.getByTestId("discard-shift"));
  expect(alert).toHaveBeenCalled();
  alert.mockRestore();
});

// ═══════════════════════════════════════════════════════════════════════════
// An operational workspace, not an office dashboard
// ═══════════════════════════════════════════════════════════════════════════

test("NO driving, break, POA or pay statistics are fabricated", async () => {
  const text = renderedText(await show(shiftWith({ workingFor: NORTHGATE, vehicle: LORRY })));

  for (const invented of [
    "Driving time", "Driving", "Break", "POA", "Period of availability",
    "Other work", "Earnings", "Pay", "Hours worked", "Defects",
  ]) {
    expect(text).not.toContain(invented);
  }
});

test("the shift's own identifiers stay off the screen", async () => {
  const shift = shiftWith({ workingFor: NORTHGATE, vehicle: LORRY });
  const text = renderedText(await show(shift));

  // A local id and a membership id mean nothing to a driver and are not theirs
  // to read; a company id is tenant plumbing.
  expect(text).not.toContain(shift.id);
  expect(text).not.toContain("mem_1");
  expect(text).not.toContain("co_1");
});

// ═══════════════════════════════════════════════════════════════════════════
// The screen asks nobody anything
// ═══════════════════════════════════════════════════════════════════════════

test("rendering the workspace makes NO request", async () => {
  const fetchSpy = jest.spyOn(global, "fetch");

  await show(shiftWith({ workingFor: NORTHGATE, vehicle: LORRY }));

  // Not `/shifts/start`, not `/auth/switch-company`, nothing.
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

test("the whole workspace scrolls, so nothing is stranded below the fold", async () => {
  const view = await show(shiftWith({ vehicle: LORRY }));

  // Finish Shift is the last thing on the screen; on a short phone it is
  // reachable only because the content scrolls.
  expect(view.getByTestId("active-shift-scroll").props.scrollEnabled).not.toBe(false);
});

// ═══════════════════════════════════════════════════════════════════════════
// Every vehicle class renders — none is a special case that breaks
// ═══════════════════════════════════════════════════════════════════════════

test.each<[VehicleClass, string]>([
  ["class1", "Class 1"],
  ["class2", "Class 2"],
  ["van",    "Van"],
])("a %s shift renders its class as %s", async (vehicleClass, label) => {
  const view = await show(shiftWith({ vehicle: { ...LORRY, vehicleClass } }));

  expect(view.getByTestId("vehicle-class-value").props.children).toBe(label);
  expect(view.getByTestId("vehicle-plate-value").props.children).toBe("AB24 XYZ");
});

// ═══════════════════════════════════════════════════════════════════════════
// Discard Shift — abandoning a day that should never have started
// ═══════════════════════════════════════════════════════════════════════════
//
// THE ONLY IRREVERSIBLE THING IN THE APP. A driver who books on by mistake at
// 05:00 — wrong company, wrong day, thumb on the wrong button — is otherwise
// stuck with that day forever, because a shift cannot be finished yet either.
// So discard exists. But it destroys the record outright, and the record is
// the driver's own working time, so the cases below are as much about what it
// REFUSES to do on one tap as about what it does on two.
//
// It is deliberately NOT beside Finish Shift. "End my real day" and "destroy
// my day" must not be neighbours a cold thumb can confuse.

/**
 * The buttons of the confirmation the control raised.
 *
 * Typed off `Alert.alert`'s own signature rather than cast to a hand-written
 * shape, so a change to the platform's button type shows up here as a type
 * error instead of being papered over.
 */
type AlertSpy = jest.SpyInstance<void, Parameters<typeof Alert.alert>>;

function confirmButton(spy: AlertSpy) {
  return spy.mock.calls[0]?.[2]?.find(button => button.style === "destructive");
}

function cancelButton(spy: AlertSpy) {
  return spy.mock.calls[0]?.[2]?.find(button => button.style === "cancel");
}

test("the discard action is reachable while a shift is open", async () => {
  const view = await show(shiftWith({ vehicle: LORRY }));

  expect(view.getByTestId("discard-shift")).toBeTruthy();
  // Quiet, and nowhere near the end-of-day action.
  expect(isDisabled(view, "discard-shift")).toBe(false);
});

test("it is offered whether or not a vehicle was ever taken", async () => {
  const withVehicle = await show(shiftWith({ vehicle: LORRY }));
  const without     = await show(shiftWith());

  expect(withVehicle.getByTestId("discard-shift")).toBeTruthy();
  expect(without.getByTestId("discard-shift")).toBeTruthy();
});

test("ONE TAP DISCARDS NOTHING — it asks first", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const onDiscard = jest.fn();
  const view = await show(shiftWith({ vehicle: LORRY }), onDiscard);

  await fireEvent.press(view.getByTestId("discard-shift"));

  // The load-bearing case. Losing a working day to a single stray press in a
  // cab is exactly the accident this feature is supposed to undo.
  expect(onDiscard).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalled();
  alert.mockRestore();
});

test("the question names what is lost and says it cannot be undone", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await show(shiftWith({ vehicle: LORRY }));

  await fireEvent.press(view.getByTestId("discard-shift"));

  const [title, message] = alert.mock.calls[0] ?? [];
  expect(String(title)).toContain("Discard");
  // No euphemism: the driver is told the day goes, and that it is final.
  expect(String(message)).toMatch(/cannot be undone|can't be undone/i);
  alert.mockRestore();
});

test("the confirmation offers a way OUT, and cancelling discards nothing", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const onDiscard = jest.fn();
  const view = await show(shiftWith({ vehicle: LORRY }), onDiscard);

  await fireEvent.press(view.getByTestId("discard-shift"));
  const cancel = cancelButton(alert);

  expect(cancel).toBeDefined();
  cancel?.onPress?.();
  expect(onDiscard).not.toHaveBeenCalled();
  alert.mockRestore();
});

test("confirming — and only confirming — discards the day", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const onDiscard = jest.fn();
  const view = await show(shiftWith({ vehicle: LORRY }), onDiscard);

  await fireEvent.press(view.getByTestId("discard-shift"));
  const confirm = confirmButton(alert);

  // Marked destructive so the platform renders it as the dangerous choice,
  // rather than as the comfortable default.
  expect(confirm).toBeDefined();
  confirm?.onPress?.();
  expect(onDiscard).toHaveBeenCalledTimes(1);
  alert.mockRestore();
});

test("discarding asks no server for permission", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const fetchSpy = jest.spyOn(global, "fetch");
  const view = await show(shiftWith({ vehicle: LORRY }));

  await fireEvent.press(view.getByTestId("discard-shift"));
  confirmButton(alert)?.onPress?.();

  // The day was never sent anywhere (D28), so there is nothing to withdraw.
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  alert.mockRestore();
});

// ═══════════════════════════════════════════════════════════════════════════
// The route: what actually happens to the stored day
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// The current vehicle card folds away (owner correction, 2026-09-27)
// ═══════════════════════════════════════════════════════════════════════════

const UNIT: LocalVehicle = { ...LORRY, vehicleClass: "class1", numberPlate: "AB12 CDE" };
const VAN: LocalVehicle = { ...LORRY, vehicleClass: "van", numberPlate: "DG" };
const ENDED = { ...LORRY, useId: "use-ended", numberPlate: "ABSB", vehicleClass: "class1" as const, startMileage: 12, endMileage: 18,
  startedAt: new Date(2026, 8, 13, 4, 0).toISOString(), endedAt: new Date(2026, 8, 13, 5, 42).toISOString() };

/** Every detail and action the open card carries — none of which a folded card may show. */
const CARD_DETAIL = ["vehicle-class-value", "vehicle-mileage-value", "vehicle-checks-state", "vehicle-checks", "change-vehicle", "fuel", "adblue"];

function showWith(shift: LocalShift, handlers: Partial<{
  onVehicleChecks: () => void; onChangeVehicle: () => void; onFill: (type: string, usage: string) => void; onOpenUsage: (usage: string) => void;
}> = {}): Promise<View> {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ActiveShiftScreen
        shift={shift} onDiscard={() => undefined} onFinish={() => undefined} onCorrectPlate={() => undefined} onCorrectTrailerNumber={() => undefined} onAddVehicle={() => undefined}
        onVehicleChecks={handlers.onVehicleChecks ?? (() => undefined)}
        onChangeVehicle={handlers.onChangeVehicle ?? (() => undefined)}
        onFill={handlers.onFill ?? (() => undefined)}
        onOpenUsage={handlers.onOpenUsage ?? (() => undefined)} onAddTrailer={() => undefined} onChangeTrailer={() => undefined} onFridgeDiesel={() => undefined} onTrailerChecks={() => undefined} onOpenTrailerUsage={() => undefined}
      />
    </SafeAreaProvider>,
  );
}

function isExpanded(view: View): boolean {
  const state: unknown = view.getByTestId("current-vehicle-toggle").props.accessibilityState;
  return typeof state === "object" && state !== null && "expanded" in state && state.expanded === true;
}

async function toggle(view: View): Promise<void> {
  await fireEvent.press(view.getByTestId("current-vehicle-toggle"));
}

test("the current vehicle card starts OPEN, with every detail and action", async () => {
  const view = await showWith(shiftWith({ vehicle: LORRY }));

  expect(isExpanded(view)).toBe(true);
  for (const testID of CARD_DETAIL) expect(view.queryByTestId(testID)).not.toBeNull();
  expect(renderedText(view)).toContain("184,203 mi");
});

test("pressing the plate panel FOLDS the card to its plate alone", async () => {
  const view = await showWith(shiftWith({ vehicle: LORRY }));

  await toggle(view);

  expect(isExpanded(view)).toBe(false);
  expect(view.getByTestId("vehicle-plate-value").props.children).toBe("AB24 XYZ");
  for (const testID of CARD_DETAIL) expect(view.queryByTestId(testID)).toBeNull();
  const said = renderedText(view);
  for (const hidden of ["184,203", "Not completed", "Vehicle Checks", "Change Vehicle", "Fuel", "AdBlue"]) {
    expect(said).not.toContain(hidden);
  }
});

test("the WHOLE folded card is one control, and pressing it opens the card again", async () => {
  const view = await showWith(shiftWith({ vehicle: LORRY }));
  await toggle(view);

  // The plate text is INSIDE the one pressable — not a target of its own.
  const control = view.getByTestId("current-vehicle-toggle");
  expect(within(control).queryByTestId("vehicle-plate-value")).not.toBeNull();
  expect(control.props.accessibilityRole).toBe("button");
  await toggle(view);

  expect(isExpanded(view)).toBe(true);
  for (const testID of CARD_DETAIL) expect(view.queryByTestId(testID)).not.toBeNull();
});

test.each([
  ["a Class 1", UNIT, "CURRENT UNIT", "Change Unit"],
  ["a Class 2", LORRY, "CURRENT VEHICLE", "Change Vehicle"],
  ["a van", VAN, "CURRENT VEHICLE", "Change Vehicle"],
] as const)("%s keeps its own wording, open or folded", async (_what, vehicle, section, change) => {
  const view = await showWith(shiftWith({ vehicle }));

  expect(view.getByTestId("current-asset-label").props.children).toBe(section);
  expect(view.getByTestId("change-vehicle").props.accessibilityLabel).toBe(change);
  await toggle(view);
  expect(view.getByTestId("current-asset-label").props.children).toBe(section);
  expect(view.getByTestId("vehicle-plate-value").props.children).toBe(vehicle.numberPlate);
});

test("the card's actions do their own jobs and NEVER fold the card", async () => {
  const onVehicleChecks = jest.fn();
  const onChangeVehicle = jest.fn();
  const onFill = jest.fn();
  const view = await showWith(shiftWith({ vehicle: LORRY }), { onVehicleChecks, onChangeVehicle, onFill });

  for (const testID of ["vehicle-checks", "change-vehicle", "fuel", "adblue"]) {
    await fireEvent.press(view.getByTestId(testID));
    expect(isExpanded(view)).toBe(true);
  }

  expect(onVehicleChecks).toHaveBeenCalledTimes(1);
  expect(onChangeVehicle).toHaveBeenCalledTimes(1);
  expect(onFill.mock.calls).toEqual([["fuel", LORRY.useId], ["adblue", LORRY.useId]]);
});

test("folding is screen state only: it survives a re-render of the same day, and writes nothing", async () => {
  const shift = shiftWith({ vehicle: LORRY });
  const view = await showWith(shift);
  await toggle(view);

  await view.rerender(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ActiveShiftScreen
        shift={{ ...shift }} onDiscard={() => undefined} onFinish={() => undefined} onCorrectPlate={() => undefined} onCorrectTrailerNumber={() => undefined} onAddVehicle={() => undefined}
        onVehicleChecks={() => undefined} onChangeVehicle={() => undefined} onFill={() => undefined} onOpenUsage={() => undefined} onAddTrailer={() => undefined} onChangeTrailer={() => undefined} onFridgeDiesel={() => undefined} onTrailerChecks={() => undefined} onOpenTrailerUsage={() => undefined}
      />
    </SafeAreaProvider>,
  );

  expect(isExpanded(view)).toBe(false);
  // Nothing about the card reached the day it renders.
  expect(Object.keys(shift).sort()).toEqual(["createdAt", "id", "previousTrailers", "previousVehicles", "startedAt", "status", "trailer", "vehicle", "workingFor"]);
  expect(Object.keys(LORRY).sort()).toEqual(["checks", "fills", "numberPlate", "startMileage", "startedAt", "useId", "vehicleClass"]);
});

test("a NEW vehicle use opens its card again, so its checks are the first thing seen", async () => {
  const view = await showWith(shiftWith({ vehicle: LORRY }));
  await toggle(view);

  const next: LocalVehicle = { ...UNIT, useId: "use-next", startedAt: new Date(2026, 8, 13, 11, 0).toISOString() };
  await view.rerender(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ActiveShiftScreen
        shift={shiftWith({ vehicle: next })} onDiscard={() => undefined} onFinish={() => undefined} onCorrectPlate={() => undefined} onCorrectTrailerNumber={() => undefined} onAddVehicle={() => undefined}
        onVehicleChecks={() => undefined} onChangeVehicle={() => undefined} onFill={() => undefined} onOpenUsage={() => undefined} onAddTrailer={() => undefined} onChangeTrailer={() => undefined} onFridgeDiesel={() => undefined} onTrailerChecks={() => undefined} onOpenTrailerUsage={() => undefined}
      />
    </SafeAreaProvider>,
  );

  expect(isExpanded(view)).toBe(true);
  expect(view.queryByTestId("vehicle-checks-state")).not.toBeNull();
});

test("NO vehicle: nothing to fold — the Add Vehicle state is unchanged", async () => {
  const view = await showWith(shiftWith({ previousVehicles: [ENDED] }));

  expect(view.queryByTestId("current-vehicle-toggle")).toBeNull();
  expect(view.queryByTestId("no-vehicle")).not.toBeNull();
  expect(view.queryByTestId("add-vehicle")).not.toBeNull();
  expect(view.queryByTestId("still-on-shift")).not.toBeNull();
});

test("USED THIS SHIFT rows are unchanged by a folded card: same rows, same exact targets", async () => {
  const onOpenUsage = jest.fn();
  const view = await showWith(shiftWith({ vehicle: LORRY, previousVehicles: [ENDED] }), { onOpenUsage });

  await toggle(view);

  expect(view.getByTestId(`usage-mileage-${ENDED.startedAt}`).props.children).toBe("12 → 18 mi · 6 mi");
  await fireEvent.press(view.getByTestId(`usage-${ENDED.startedAt}`));
  expect(onOpenUsage).toHaveBeenCalledWith(ENDED.useId);
  expect(isExpanded(view)).toBe(false);
});

test("pressing a USED THIS SHIFT row FOLDS the open card, and still opens exactly that use", async () => {
  const onOpenUsage = jest.fn();
  const view = await showWith(shiftWith({ vehicle: LORRY, previousVehicles: [ENDED] }), { onOpenUsage });
  expect(isExpanded(view)).toBe(true);

  await fireEvent.press(view.getByTestId(`usage-${ENDED.startedAt}`));

  expect(onOpenUsage).toHaveBeenCalledWith(ENDED.useId);
  expect(isExpanded(view)).toBe(false);
  for (const testID of CARD_DETAIL) expect(view.queryByTestId(testID)).toBeNull();
});

test("a card folded by another section opens again with one press of its row", async () => {
  const view = await showWith(shiftWith({ vehicle: LORRY, previousVehicles: [ENDED] }));
  await fireEvent.press(view.getByTestId(`usage-${ENDED.startedAt}`));

  await toggle(view);

  expect(isExpanded(view)).toBe(true);
  for (const testID of CARD_DETAIL) expect(view.queryByTestId(testID)).not.toBeNull();
});

test("with NO vehicle, pressing a USED THIS SHIFT row still opens it — there is no card to fold", async () => {
  const onOpenUsage = jest.fn();
  const view = await showWith(shiftWith({ previousVehicles: [ENDED] }), { onOpenUsage });

  await fireEvent.press(view.getByTestId(`usage-${ENDED.startedAt}`));

  expect(onOpenUsage).toHaveBeenCalledWith(ENDED.useId);
  expect(view.queryByTestId("no-vehicle")).not.toBeNull();
});

// ─── The folded card says whether THIS use's checks are done ────────────────

function check(status: "completed" | "draft", answered: boolean): VehicleCheck {
  const list = checklistFor("class2");
  return {
    id: `check-${status}`, checklist: list.id, checklistVersion: list.version,
    startedAt: LORRY.startedAt, status,
    completedAt: status === CHECK_STATUS.completed ? LORRY.startedAt : null,
    completedBy: status === CHECK_STATUS.completed ? "user_1" : null,
    items: answered ? [{ key: "anything", label: "Anything", result: CHECK_RESULT.ok, note: null }] : [],
  };
}
const CHECKED: LocalVehicle = { ...LORRY, checks: [check(CHECK_STATUS.completed, true)] };
const HALF_CHECKED: LocalVehicle = { ...LORRY, checks: [check(CHECK_STATUS.draft, true)] };

/** The folded card's ground and border, as rendered. */
function cardColours(view: View): { background: unknown; border: unknown } {
  const style = StyleSheet.flatten(view.getByTestId("current-vehicle-card").props.style) as { backgroundColor?: unknown; borderColor?: unknown };
  return { background: style.backgroundColor, border: style.borderColor };
}

async function folded(vehicle: LocalVehicle): Promise<View> {
  const view = await showWith(shiftWith({ vehicle }));
  await toggle(view);
  return view;
}

test.each([
  ["no check at all", LORRY],
  ["a check still in progress", HALF_CHECKED],
] as const)("FOLDED with %s: the plate, 'Checks not completed', and the subtle error ground", async (_what, vehicle) => {
  const view = await folded(vehicle);

  expect(view.getByTestId("vehicle-plate-value").props.children).toBe("AB24 XYZ");
  expect(view.getByTestId("collapsed-checks-state").props.children).toBe("Checks not completed");
  expect(cardColours(view)).toEqual({ background: colors.dangerBg, border: colors.danger });
});

test("FOLDED with a COMPLETED check: the plate, 'Checks completed', and the subtle success ground", async () => {
  const view = await folded(CHECKED);

  expect(view.getByTestId("vehicle-plate-value").props.children).toBe("AB24 XYZ");
  expect(view.getByTestId("collapsed-checks-state").props.children).toBe("Checks completed");
  expect(cardColours(view)).toEqual({ background: colors.successBg, border: colors.success });
});

test("the status is THIS use's alone — an earlier use's completed check does not count", async () => {
  const earlier = { ...ENDED, checks: [check(CHECK_STATUS.completed, true)] };
  const view = await showWith(shiftWith({ vehicle: LORRY, previousVehicles: [earlier] }));
  await toggle(view);

  expect(view.getByTestId("collapsed-checks-state").props.children).toBe("Checks not completed");
});

test("the plate keeps its own ink — the status colour is on the ground and the status line, not the plate", async () => {
  for (const vehicle of [LORRY, CHECKED]) {
    const view = await folded(vehicle);
    const plate = StyleSheet.flatten(view.getByTestId("vehicle-plate-value").props.style) as { color?: unknown };
    expect(plate.color).toBe(colors.brandDark);
    await view.unmount();
  }
});

test("FOLDED: the chevron stays, laid over the edge so the plate centres on the CARD", async () => {
  const view = await folded(LORRY);

  const control = view.getByTestId("current-vehicle-toggle");
  const chevron = StyleSheet.flatten(within(control).getByTestId("current-vehicle-chevron").props.style) as { position?: unknown };
  expect(chevron.position).toBe("absolute");
  const box = StyleSheet.flatten(control.props.style) as { paddingHorizontal?: unknown; paddingLeft?: unknown; paddingRight?: unknown; alignItems?: unknown };
  expect(box.alignItems).toBe("center");
  expect(box.paddingLeft ?? box.paddingHorizontal).toBe(box.paddingRight ?? box.paddingHorizontal);
});

test("the whole folded card, status and all, still opens with one press — and open, it has no status ground", async () => {
  const view = await folded(CHECKED);
  const control = view.getByTestId("current-vehicle-toggle");
  expect(within(control).queryByTestId("collapsed-checks-state")).not.toBeNull();
  expect(String(control.props.accessibilityLabel)).toBe("AB24 XYZ. Checks completed");

  await toggle(view);

  expect(isExpanded(view)).toBe(true);
  expect(view.queryByTestId("collapsed-checks-state")).toBeNull();
  expect(view.getByTestId("vehicle-checks-state").props.children).toBe("Completed");
  expect(cardColours(view).background).toBe(colors.surface);
});

describe("the Active Shift route", () => {
  beforeEach(async () => {
    await clearOpenShift();
    mockRouter.replace.mockClear();
  });
  afterEach(() => { jest.restoreAllMocks(); });

  async function openRoute() {
    const view = await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ActiveShiftRoute />
      </SafeAreaProvider>,
    );
    await waitFor(() => { expect(view.queryByTestId("discard-shift")).not.toBeNull(); });
    return view;
  }

  test("a confirmed discard REMOVES the stored shift and leaves the workspace", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    await startLocalShift({ workingFor: PERSONAL, startedAt: new Date(), vehicle: LORRY });

    const view = await openRoute();
    await fireEvent.press(view.getByTestId("discard-shift"));
    confirmButton(alert)?.onPress?.();

    await waitFor(async () => { expect(await readOpenShift()).toBeNull(); });
    await waitFor(() => { expect(mockRouter.replace).toHaveBeenCalledWith("/today"); });
    alert.mockRestore();
  });

  test("a CANCELLED discard leaves the day exactly as it was", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    const started = await startLocalShift({ workingFor: NORTHGATE, startedAt: new Date(), vehicle: LORRY });

    const view = await openRoute();
    await fireEvent.press(view.getByTestId("discard-shift"));
    cancelButton(alert)?.onPress?.();

    expect(await readOpenShift()).toEqual(started);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  test("a Discard that fails before anything is removed says nothing was changed — and stays on the day", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    await startLocalShift({ workingFor: PERSONAL, startedAt: new Date(), vehicle: LORRY });
    const view = await openRoute();
    jest.spyOn(File.prototype, "delete").mockImplementationOnce(() => { throw new Error("busy"); });

    await fireEvent.press(view.getByTestId("discard-shift"));
    confirmButton(alert)?.onPress?.();

    await waitFor(() => { expect(alert).toHaveBeenCalledWith("Couldn't discard the shift", "Nothing was changed. Please try again."); });
    expect(mockRouter.replace).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    expect(await readOpenShift()).not.toBeNull();
  });

  test("a Discard that fails PART-WAY never says nothing was changed — the driver is told to check the shift", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    await startLocalShift({ workingFor: PERSONAL, startedAt: new Date(), vehicle: LORRY });
    const temp = new File(Paths.document, OPEN_SHIFT_TEMP_FILE);
    temp.create({ overwrite: true });
    temp.write("leftover");
    const view = await openRoute();
    // The live day file goes; the temporary file then cannot be dealt with.
    jest.spyOn(File.prototype, "exists", "get").mockImplementation(function (this: File) {
      if (this.uri.endsWith(OPEN_SHIFT_TEMP_FILE)) throw new Error("busy");
      return new Directory(Paths.document).list().some(entry => entry.uri === this.uri);
    });

    await fireEvent.press(view.getByTestId("discard-shift"));
    confirmButton(alert)?.onPress?.();

    await waitFor(() => {
      expect(alert).toHaveBeenCalledWith("Couldn't discard the shift", "The shift could not be discarded safely. Check your current shift before trying again.");
    });
    expect(alert.mock.calls.some(([, body]) => typeof body === "string" && /nothing was changed/i.test(body))).toBe(false);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    expect(await readOpenShift()).toBeNull();
  });

  test("after discarding, Start Shift is free to begin a NEW day", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    const first = await startLocalShift({ workingFor: PERSONAL, startedAt: new Date(), vehicle: null });

    const view = await openRoute();
    await fireEvent.press(view.getByTestId("discard-shift"));
    confirmButton(alert)?.onPress?.();
    await waitFor(async () => { expect(await readOpenShift()).toBeNull(); });

    // The one-open-shift rule blocked this before the discard; it must not
    // keep blocking it afterwards, or discard has fixed nothing.
    const secondStart = new Date();
    const second = await startLocalShift({ workingFor: NORTHGATE, startedAt: secondStart, vehicle: LORRY });
    expect(second.id).not.toBe(first.id);
    expect(second.vehicle).toMatchObject({ numberPlate: LORRY.numberPlate, startedAt: secondStart.toISOString() });
    alert.mockRestore();
  });
});
