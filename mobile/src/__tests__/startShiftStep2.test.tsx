/**
 * Start Shift, step two: the minimum needed to begin a working day.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * A VEHICLE IS OPTIONAL, and that is a domain rule rather than a convenience
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A driver books on at 06:00 and may not be handed a truck until 08:00. That is
 * one working day beginning at 06:00 — not a day that has not started, and not
 * a day with a placeholder vehicle. So the shift can go ACTIVE with no vehicle
 * at all, and "shift started" is NOT a synonym for "vehicle checked": checks
 * belong to a vehicle, and a vehicle arrives from the Active Shift flow later.
 *
 * WHAT PRESSING START SHIFT DOES: it writes a local record. No request, no
 * `POST /shifts/start`, no waiting on a network that a loading bay does not
 * have. The cases below prove it with `fetch` rejecting outright.
 *
 * HIDDEN FIELDS MUST NOT LEAK. Answering "Yes", filling a plate, then changing
 * to "Not yet" must not smuggle that plate into the shift — the driver can no
 * longer see it, so it cannot be something they are agreeing to.
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Text, Pressable } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AccountMembership, AuthenticatedAccount } from "../api/account";
import { clearOpenShift, readOpenShift } from "../shift/localShift";
import StartShift from "../../app/(app)/start-shift";

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

const NORTHGATE: AccountMembership = {
  membershipId: "mem_1", companyId: "co_1", companyName: "Northgate Logistics", role: "driver",
};

function accountWith(memberships: AccountMembership[]): AuthenticatedAccount {
  return {
    user: { id: "user_1", firstName: "Nerijus", lastName: "Kuizinas", email: "driver@example.com" },
    identityToken: "identity.token.value",
    refreshToken:  "refresh-secret-value",
    memberships,
  };
}

const METRICS = {
  frame:  { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

type View = Awaited<ReturnType<typeof render>>;

function text(view: View, testID: string): string {
  return String(view.getByTestId(testID).props.children);
}

function allText(view: View): string {
  return JSON.stringify(view.toJSON()).toLowerCase();
}

function enabled(view: View, testID: string): boolean {
  const state: unknown = view.getByTestId(testID).props.accessibilityState;
  if (typeof state !== "object" || state === null) return false;
  return Reflect.get(state, "disabled") === false;
}

/** Mount the route with a driver signed in, without assuming what it renders. */
async function mountStartShift(memberships: AccountMembership[] = []): Promise<View> {
  function Harness() {
    const { signIn, status } = useAuth();
    return (
      <>
        <Text testID="status">{status}</Text>
        <Pressable testID="authenticate" onPress={() => { void signIn(accountWith(memberships)); }}>
          <Text>authenticate</Text>
        </Pressable>
        <StartShift />
      </>
    );
  }

  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AuthProvider><Harness /></AuthProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => { expect(text(view, "status")).toBe("unauthenticated"); });
  await act(async () => { await fireEvent.press(view.getByTestId("authenticate")); });
  return view;
}

/** The form, for the ordinary case where no day is already open. */
async function openStartShift(memberships: AccountMembership[] = []): Promise<View> {
  const view = await mountStartShift(memberships);
  await waitFor(() => { expect(view.queryByTestId("working-for")).not.toBeNull(); });
  return view;
}

async function press(view: View, testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(view.getByTestId(testID)); });
}

async function type(view: View, testID: string, value: string): Promise<void> {
  await act(async () => { await fireEvent.changeText(view.getByTestId(testID), value); });
}

/** Fill the "Yes" branch with a valid vehicle. */
async function withValidVehicle(view: View): Promise<void> {
  await press(view, "vehicle-yes");
  await press(view, "vehicle-class-class1");
  await type(view, "number-plate", "AB24 XYZ");
  await type(view, "start-mileage", "184203");
}

beforeEach(async () => { await clearOpenShift(); });
afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// Start time
// ═══════════════════════════════════════════════════════════════════════════

test("Start time is present and defaults to the current local time", async () => {
  const now = new Date();
  const view = await openStartShift();

  const hours = String(view.getByTestId("start-time-hours").props.value);
  const minutes = String(view.getByTestId("start-time-minutes").props.value);
  expect(hours).toBe(String(now.getHours()).padStart(2, "0"));
  expect(minutes).toBe(String(now.getMinutes()).padStart(2, "0"));
});

test("the default is taken ONCE and does not drift while the driver is filling the form", async () => {
  const view = await openStartShift();
  const before = String(view.getByTestId("start-time-hours").props.value);

  // Any number of re-renders: the time the driver saw on arrival is the time
  // that stays, because a working-day start must not creep while they type.
  await press(view, "vehicle-not-yet");
  await press(view, "vehicle-yes");
  await press(view, "vehicle-not-yet");

  expect(String(view.getByTestId("start-time-hours").props.value)).toBe(before);
});

test("the driver can change the start time, and the change sticks", async () => {
  const view = await openStartShift();

  await type(view, "start-time-hours", "06");
  await type(view, "start-time-minutes", "15");

  expect(String(view.getByTestId("start-time-hours").props.value)).toBe("06");
  expect(String(view.getByTestId("start-time-minutes").props.value)).toBe("15");
});

test("an impossible time blocks the start", async () => {
  const view = await openStartShift();
  await press(view, "vehicle-not-yet");
  expect(enabled(view, "start-shift-submit")).toBe(true);

  await type(view, "start-time-hours", "44");
  expect(enabled(view, "start-shift-submit")).toBe(false);

  await type(view, "start-time-hours", "06");
  await type(view, "start-time-minutes", "77");
  expect(enabled(view, "start-shift-submit")).toBe(false);
});

test("the entered time is what gets persisted, not the clock", async () => {
  const view = await openStartShift();

  await type(view, "start-time-hours", "04");
  await type(view, "start-time-minutes", "45");
  await press(view, "vehicle-not-yet");
  await press(view, "start-shift-submit");

  const started = await readOpenShift();
  const persisted = new Date(String(started?.startedAt));
  expect(persisted.getHours()).toBe(4);
  expect(persisted.getMinutes()).toBe(45);
});

// ═══════════════════════════════════════════════════════════════════════════
// Do you have a vehicle?
// ═══════════════════════════════════════════════════════════════════════════

test("the vehicle question is asked, with Yes and Not yet", async () => {
  const view = await openStartShift();

  expect(view.getByTestId("vehicle-question")).toBeTruthy();
  expect(view.getByTestId("vehicle-yes")).toBeTruthy();
  expect(view.getByTestId("vehicle-not-yet")).toBeTruthy();
  // "Not yet", never "No": a vehicle may still arrive later in the day.
  expect(allText(view)).not.toContain(">no<");
});

test("no vehicle fields are shown until the driver answers Yes", async () => {
  const view = await openStartShift();

  expect(view.queryByTestId("number-plate")).toBeNull();
  expect(view.queryByTestId("start-mileage")).toBeNull();
  expect(view.queryByTestId("vehicle-class-class1")).toBeNull();
});

test("Not yet hides the vehicle fields", async () => {
  const view = await openStartShift();
  await press(view, "vehicle-yes");
  expect(view.getByTestId("number-plate")).toBeTruthy();

  await press(view, "vehicle-not-yet");

  expect(view.queryByTestId("number-plate")).toBeNull();
  expect(view.queryByTestId("start-mileage")).toBeNull();
});

test("Yes reveals exactly class, plate and mileage — and nothing else", async () => {
  const view = await openStartShift();
  await press(view, "vehicle-yes");

  expect(view.getByTestId("vehicle-class-class1")).toBeTruthy();
  expect(view.getByTestId("vehicle-class-class2")).toBeTruthy();
  expect(view.getByTestId("vehicle-class-van")).toBeTruthy();
  expect(view.getByTestId("number-plate")).toBeTruthy();
  expect(view.getByTestId("start-mileage")).toBeTruthy();

  // Everything Start Shift deliberately does not ask for.
  const rendered = allText(view);
  for (const absent of ["trailer", "check", "defect", "adblue", "fuel", "signature", "note"]) {
    expect(rendered).not.toContain(absent);
  }
});

test("exactly one vehicle answer is active at a time", async () => {
  const view = await openStartShift();

  await press(view, "vehicle-yes");
  expect(view.getByTestId("vehicle-yes").props.accessibilityState).toMatchObject({ selected: true });
  expect(view.getByTestId("vehicle-not-yet").props.accessibilityState).toMatchObject({ selected: false });

  await press(view, "vehicle-not-yet");
  expect(view.getByTestId("vehicle-yes").props.accessibilityState).toMatchObject({ selected: false });
  expect(view.getByTestId("vehicle-not-yet").props.accessibilityState).toMatchObject({ selected: true });
});

test("exactly one vehicle class is selected at a time", async () => {
  const view = await openStartShift();
  await press(view, "vehicle-yes");

  await press(view, "vehicle-class-class1");
  await press(view, "vehicle-class-van");

  expect(view.getByTestId("vehicle-class-van").props.accessibilityState).toMatchObject({ selected: true });
  expect(view.getByTestId("vehicle-class-class1").props.accessibilityState).toMatchObject({ selected: false });
  expect(view.getByTestId("vehicle-class-class2").props.accessibilityState).toMatchObject({ selected: false });
});

// ═══════════════════════════════════════════════════════════════════════════
// Number plate and mileage
// ═══════════════════════════════════════════════════════════════════════════

test("the plate is trimmed and upper-cased when the shift is created", async () => {
  const view = await openStartShift();
  await press(view, "vehicle-yes");
  await press(view, "vehicle-class-class2");
  await type(view, "number-plate", "  ab24 xyz  ");
  await type(view, "start-mileage", "1000");
  await press(view, "start-shift-submit");

  expect((await readOpenShift())?.vehicle?.numberPlate).toBe("AB24 XYZ");
});

test("an international plate is accepted — no UK format is imposed", async () => {
  const view = await openStartShift();
  await press(view, "vehicle-yes");
  await press(view, "vehicle-class-van");
  await type(view, "number-plate", "LT-ABC-123");
  await type(view, "start-mileage", "0");
  await press(view, "start-shift-submit");

  expect((await readOpenShift())?.vehicle?.numberPlate).toBe("LT-ABC-123");
});

test("a blank or whitespace-only plate blocks the start", async () => {
  const view = await openStartShift();
  await press(view, "vehicle-yes");
  await press(view, "vehicle-class-class1");
  await type(view, "start-mileage", "1000");

  await type(view, "number-plate", "   ");
  expect(enabled(view, "start-shift-submit")).toBe(false);

  await type(view, "number-plate", "AB24 XYZ");
  expect(enabled(view, "start-shift-submit")).toBe(true);
});

test("mileage must be a non-negative number — nothing else starts the shift", async () => {
  const view = await openStartShift();
  await press(view, "vehicle-yes");
  await press(view, "vehicle-class-class1");
  await type(view, "number-plate", "AB24 XYZ");

  for (const rejected of ["", "   ", "abc", "-5", "12.5", "1e4"]) {
    await type(view, "start-mileage", rejected);
    expect(enabled(view, "start-shift-submit")).toBe(false);
  }

  // Zero is a real reading on a new vehicle, and must be accepted.
  await type(view, "start-mileage", "0");
  expect(enabled(view, "start-shift-submit")).toBe(true);
});

test("mileage is never invented — the shift carries exactly what was typed", async () => {
  const view = await openStartShift();
  await withValidVehicle(view);
  await press(view, "start-shift-submit");

  expect((await readOpenShift())?.vehicle?.startMileage).toBe(184203);
});

// ═══════════════════════════════════════════════════════════════════════════
// When may the day begin
// ═══════════════════════════════════════════════════════════════════════════

test("Start Shift is unavailable until the vehicle question is answered", async () => {
  const view = await openStartShift();

  expect(enabled(view, "start-shift-submit")).toBe(false);
});

test("Not yet alone is a complete, valid answer", async () => {
  const view = await openStartShift();

  await press(view, "vehicle-not-yet");

  expect(enabled(view, "start-shift-submit")).toBe(true);
});

test("Yes is incomplete until class, plate and mileage are all given", async () => {
  const view = await openStartShift();

  await press(view, "vehicle-yes");
  expect(enabled(view, "start-shift-submit")).toBe(false);

  await press(view, "vehicle-class-class1");
  expect(enabled(view, "start-shift-submit")).toBe(false);

  await type(view, "number-plate", "AB24 XYZ");
  expect(enabled(view, "start-shift-submit")).toBe(false);

  await type(view, "start-mileage", "184203");
  expect(enabled(view, "start-shift-submit")).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// Creating the day
// ═══════════════════════════════════════════════════════════════════════════

test("Not yet creates an open shift with NO vehicle", async () => {
  const view = await openStartShift();
  await press(view, "vehicle-not-yet");
  await press(view, "start-shift-submit");

  const started = await readOpenShift();
  expect(started?.status).toBe("open");
  expect(started?.vehicle).toBeNull();
});

test("Yes creates an open shift carrying exactly the vehicle entered", async () => {
  const view = await openStartShift([NORTHGATE]);
  await press(view, `working-for-${NORTHGATE.membershipId}`);
  await withValidVehicle(view);
  await press(view, "start-shift-submit");

  const started = await readOpenShift();
  expect(started?.vehicle).toEqual({
    vehicleClass: "class1", numberPlate: "AB24 XYZ", startMileage: 184203,
  });
  expect(started?.workingFor).toMatchObject({ kind: "company", membershipId: "mem_1" });
});

test("switching Yes → Not yet leaves NO vehicle behind in the created shift", async () => {
  const view = await openStartShift();

  await withValidVehicle(view);
  await press(view, "vehicle-not-yet");
  await press(view, "start-shift-submit");

  // The driver cannot see those fields any more, so they cannot be agreeing
  // to them. The shift must carry nothing of them.
  expect((await readOpenShift())?.vehicle).toBeNull();
});

test("switching Not yet → Yes requires the vehicle details again", async () => {
  const view = await openStartShift();

  await press(view, "vehicle-not-yet");
  expect(enabled(view, "start-shift-submit")).toBe(true);

  await press(view, "vehicle-yes");
  expect(enabled(view, "start-shift-submit")).toBe(false);
});

test("pressing Start Shift repeatedly creates exactly ONE shift", async () => {
  const view = await openStartShift();
  await press(view, "vehicle-not-yet");

  await press(view, "start-shift-submit");
  const first = await readOpenShift();
  await press(view, "start-shift-submit");
  await press(view, "start-shift-submit");

  expect(await readOpenShift()).toEqual(first);
});

// ═══════════════════════════════════════════════════════════════════════════
// The keyboard must not sit on top of the field being typed into
// ═══════════════════════════════════════════════════════════════════════════
//
// WHAT THESE CASES CAN AND CANNOT PROVE. Jest has no keyboard and no
// geometry, so none of this measures whether a field is visible — that was
// verified in real pixels on a physical iPhone, and is the actual evidence.
// What is worth guarding here is the STRUCTURE that produces the behaviour:
// the props are easy to drop in a later edit, and dropping them silently
// reintroduces a defect nobody notices until a driver is standing in a yard
// unable to see what they are typing.

test("the form declares the keyboard-safe scrolling contract", async () => {
  const view = await openStartShift();
  const scroll = view.getByTestId("start-shift-scroll").props;

  // iOS insets the scroll content by the keyboard's height and brings the
  // focused field into view. This is the prop that stops the keyboard
  // covering Number plate and Start mileage.
  expect(scroll.automaticallyAdjustKeyboardInsets).toBe(true);
  // Dragging the form dismisses the keyboard — the platform convention, and
  // the same one the Login and Registration screens use.
  expect(scroll.keyboardDismissMode).toBe("on-drag");
  // A tap that no control handles closes the keyboard rather than being
  // swallowed, so the first tap on a choice row still selects it.
  expect(scroll.keyboardShouldPersistTaps).toBe("handled");
});

test("the form stays scrollable, which is what makes the shrunken viewport usable", async () => {
  const view = await openStartShift();
  await press(view, "vehicle-yes");

  // Never disabled: with the keyboard up the visible area is short, and
  // scrolling is the only way the lower fields and Start Shift stay reachable.
  expect(view.getByTestId("start-shift-scroll").props.scrollEnabled).not.toBe(false);
});

test("each field keeps the keyboard a driver needs for it", async () => {
  const view = await openStartShift();
  await press(view, "vehicle-yes");

  // A plate is text — international registrations contain letters.
  expect(view.getByTestId("number-plate").props.keyboardType).toBeUndefined();
  // Mileage is digits, so the numeric pad opens rather than a full keyboard.
  expect(view.getByTestId("start-mileage").props.keyboardType).toBe("number-pad");
  expect(view.getByTestId("start-time-hours").props.keyboardType).toBe("number-pad");
  expect(view.getByTestId("start-time-minutes").props.keyboardType).toBe("number-pad");
});

// ═══════════════════════════════════════════════════════════════════════════
// Offline, and the handoff
// ═══════════════════════════════════════════════════════════════════════════

test("the shift starts with the network DEAD", async () => {
  const fetchSpy = jest.spyOn(global, "fetch")
    .mockImplementation(() => Promise.reject(new Error("Network request failed")));

  const view = await openStartShift();
  await press(view, "vehicle-not-yet");
  await press(view, "start-shift-submit");

  expect((await readOpenShift())?.status).toBe("open");
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("starting a shift calls no server route at all", async () => {
  const fetchSpy = jest.spyOn(global, "fetch");

  const view = await openStartShift([NORTHGATE]);
  await withValidVehicle(view);
  await press(view, "start-shift-submit");

  // No `POST /shifts/start`, no `POST /auth/switch-company`, nothing.
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("a started shift hands off to Active Shift", async () => {
  const view = await openStartShift();
  await press(view, "vehicle-not-yet");
  await press(view, "start-shift-submit");

  await waitFor(() => { expect(mockRouter.replace).toHaveBeenCalledWith("/active-shift"); });
});

test("arriving with a shift ALREADY open continues it instead of starting another", async () => {
  const view = await openStartShift();
  await press(view, "vehicle-not-yet");
  await press(view, "start-shift-submit");
  const started = await readOpenShift();

  mockRouter.replace.mockClear();
  // Mounted WITHOUT waiting for the form, because the whole point is that the
  // form must never appear for a driver who is already mid-shift.
  const returning = await mountStartShift();

  await waitFor(() => { expect(mockRouter.replace).toHaveBeenCalledWith("/active-shift"); });
  expect(returning.queryByTestId("start-shift-submit")).toBeNull();
  expect(returning.queryByTestId("working-for")).toBeNull();
  // And the open day is untouched.
  expect(await readOpenShift()).toEqual(started);
});
