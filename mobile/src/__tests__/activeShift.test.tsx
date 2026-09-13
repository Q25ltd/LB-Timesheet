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
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Alert } from "react-native";
import { ActiveShiftScreen } from "../screens/ActiveShiftScreen";
import ActiveShiftRoute from "../../app/(app)/active-shift";
import { clearOpenShift, readOpenShift, startLocalShift } from "../shift/localShift";
import type { LocalShift, LocalVehicle, VehicleClass, WorkingContext } from "../shift/localShift";

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

const LORRY: LocalVehicle = { vehicleClass: "class2", numberPlate: "AB24 XYZ", startMileage: 184_203 };

function shiftWith(over: Partial<LocalShift> = {}): LocalShift {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    workingFor: PERSONAL,
    startedAt: new Date(2026, 8, 13, 5, 42).toISOString(),
    vehicle: null,
    status: "open",
    createdAt: new Date(2026, 8, 13, 5, 42).toISOString(),
    ...over,
  };
}

type View = Awaited<ReturnType<typeof render>>;

function show(shift: LocalShift, onDiscard: () => void = () => undefined): Promise<View> {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ActiveShiftScreen shift={shift} onDiscard={onDiscard} />
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
 * Press a control and prove NOTHING happened.
 *
 * `props.onPress` cannot carry this: `Pressable` does not forward it to the
 * host node, so `expect(props.onPress).toBeUndefined()` passes even for a
 * fully wired control and proves nothing at all. Only consequences can be
 * asserted — no confirmation raised, no request made, no navigation.
 */
async function pressingDoesNothing(view: View, testID: string): Promise<void> {
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

test("the no-vehicle state offers Add Vehicle — and it does nothing yet", async () => {
  const view = await show(shiftWith());

  expect(view.getByTestId("add-vehicle")).toBeTruthy();
  expect(isDisabled(view, "add-vehicle")).toBe(true);
  await pressingDoesNothing(view, "add-vehicle");
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
    vehicle: { vehicleClass: "van", numberPlate: "KAT 123", startMileage: 640 },
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

test("Vehicle Checks is present for a vehicle, and is not wired", async () => {
  const view = await show(shiftWith({ vehicle: LORRY }));

  expect(isDisabled(view, "vehicle-checks")).toBe(true);
  await pressingDoesNothing(view, "vehicle-checks");
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

test("NO trailer is fabricated — not a number, not a state, not an empty row", async () => {
  // Class 1 is the tempting case: it pulls a trailer, and none was recorded.
  const text = renderedText(await show(shiftWith({ vehicle: { ...LORRY, vehicleClass: "class1" } })));

  expect(text).not.toContain("Trailer");
  expect(text).not.toContain("No trailer");
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

test.each([
  ["vehicle-checks",  "Vehicle Checks"],
  ["change-vehicle",  "Change Vehicle"],
  ["fuel",            "Fuel"],
  ["adblue",          "AdBlue"],
  ["finish-shift",    "Finish Shift"],
])("%s is present but does nothing", async (testID, label) => {
  const view = await show(shiftWith({ vehicle: LORRY }));
  const control = view.getByTestId(testID);

  expect(control.props.accessibilityLabel).toBe(label);
  expect(isDisabled(view, testID)).toBe(true);
  await pressingDoesNothing(view, testID);
});

test("Fuel, AdBlue and Finish Shift are offered with or without a vehicle", async () => {
  const view = await show(shiftWith());

  for (const testID of ["fuel", "adblue", "finish-shift"]) {
    expect(isDisabled(view, testID)).toBe(true);
  }
});

test("no fuel or AdBlue TOTALS are shown, because no entry has ever been made", async () => {
  const text = renderedText(await show(shiftWith({ vehicle: LORRY })));

  for (const invented of ["Last fuel", "Fuel total", "AdBlue total", "litres", "Litres"]) {
    expect(text).not.toContain(invented);
  }
});

test("Discard is the ONE real action here — everything else is still a stub", async () => {
  const view = await show(shiftWith({ vehicle: LORRY }));

  // This replaces the Step 3A contract that Discard must be absent. It was
  // absent because it did nothing, and a control that does nothing is worse
  // than none; it is here now because it does something, and because a driver
  // who books on by mistake has no other way out of the day.
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  await fireEvent.press(view.getByTestId("discard-shift"));
  expect(alert).toHaveBeenCalled();
  alert.mockRestore();
  // The rest of the workspace is unchanged — still rendered, still inert.
  expect(isDisabled(view, "finish-shift")).toBe(true);
  expect(isDisabled(view, "vehicle-checks")).toBe(true);
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

describe("the Active Shift route", () => {
  beforeEach(async () => {
    await clearOpenShift();
    mockRouter.replace.mockClear();
  });

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

  test("after discarding, Start Shift is free to begin a NEW day", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    const first = await startLocalShift({ workingFor: PERSONAL, startedAt: new Date(), vehicle: null });

    const view = await openRoute();
    await fireEvent.press(view.getByTestId("discard-shift"));
    confirmButton(alert)?.onPress?.();
    await waitFor(async () => { expect(await readOpenShift()).toBeNull(); });

    // The one-open-shift rule blocked this before the discard; it must not
    // keep blocking it afterwards, or discard has fixed nothing.
    const second = await startLocalShift({ workingFor: NORTHGATE, startedAt: new Date(), vehicle: LORRY });
    expect(second.id).not.toBe(first.id);
    expect(second.vehicle).toEqual(LORRY);
    alert.mockRestore();
  });
});
