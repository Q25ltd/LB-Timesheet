/**
 * Active Shift hardening — the pre-Finish-Shift audit (2026-09-28).
 *
 * Adversarial proofs of boundaries the audit found unguarded, each written to
 * fail against the code as it stood:
 *
 *   STORE      the store refuses what the reader would refuse, so no write can
 *              make the driver's day unreadable — Start Shift's vehicle, and a
 *              check answer that is not OK / N/A / DEFECT
 *   READER     a day whose vehicle mileage or creation time is not what this app
 *              writes fails closed, as every other malformed field does
 *   ROUTES     a screen whose target changed while it was open says nothing
 *              was saved — it never reports success for a write that did not
 *              happen, and never goes on to act on the asset that replaced it
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { Directory, File } from "expo-file-system";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Alert, Pressable, Text, TextInput } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AuthenticatedAccount } from "../api/account";
import ChangeVehicleRoute from "../../app/(app)/change-vehicle";
import ChangeTrailerRoute from "../../app/(app)/change-trailer";
import AddTrailerRoute from "../../app/(app)/add-trailer";
import AddVehicleRoute from "../../app/(app)/add-vehicle";
import VehicleCheckRoute from "../../app/(app)/vehicle-check";
import StartShiftRoute from "../../app/(app)/start-shift";
import { checklistFor, checklistItems } from "../shift/checklists";
import { SAFE_SAVE_FAILED, saveFailureMessage } from "../screens/format";
import {
  OPEN_SHIFT_FILE,
  OPEN_SHIFT_TEMP_FILE,
  SafeSaveFailedError,
  USAGE_STATE,
  addTrailerToOpenShift,
  addVehicleToOpenShift,
  changeTrailer,
  changeVehicle,
  clearOpenShift,
  completeVehicleCheck,
  endVehicleUse,
  readOpenShift,
  saveVehicleCheckDraft,
  startLocalShift,
  type VehicleDetails,
} from "../shift/localShift";
import { TRAILER_TYPE, type TrailerDetails } from "../shift/trailer";
import type { CheckAnswer } from "../shift/vehicleCheck";
import { trailerUseAt, vehicleUseAt } from "./useIdAt";
import { accountDirectoryOf, scopeFor } from "./testScope";

/** The signed-in driver's records — F-31: every store call names its account. */
const SCOPE = scopeFor("user_harden_1");
// Screens act for this test's driver. The real hook's sign-in / sign-out
// behaviour is proven in accountSwitchRoute.test.tsx.
jest.mock("../shift/useAccountScope", () => ({ useAccountScope: () => mockScope }));
const mockScope = SCOPE;

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismissTo: jest.fn() };
const params: { usage?: string; usageState?: string } = {};

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
const OTHER: VehicleDetails = { vehicleClass: "class1", numberPlate: "XY34 ZZZ", startMileage: 220_000 };
const TR23: TrailerDetails = { trailerNumber: "TR23", trailerType: TRAILER_TYPE.standard };
const DRIVER: AuthenticatedAccount = {
  user: { id: "user_harden_1", firstName: "Nerijus", lastName: "Kuizinas", email: "driver@example.com" },
  identityToken: "identity.token.value",
  refreshToken: "refresh-secret-value",
  memberships: [],
};

type View = Awaited<ReturnType<typeof render>>;
const file = () => new File(accountDirectoryOf(SCOPE), OPEN_SHIFT_FILE);
const bytes = () => file().textSync();
const text = (view: View, testID: string) => String(view.getByTestId(testID).props.children);
async function press(view: View, testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(view.getByTestId(testID)); });
}
async function type(view: View, testID: string, value: string): Promise<void> {
  await act(async () => { await fireEvent.changeText(view.getByTestId(testID), value); });
}
async function mount(node: React.ReactElement): Promise<View> {
  const view = await render(<SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>);
  await waitFor(() => { expect(view.queryByTestId("screen-title") ?? view.queryByTestId("redirect")).not.toBeNull(); });
  return view;
}
const dayWith = (vehicle: VehicleDetails | null = UNIT) =>
  startLocalShift(SCOPE, { workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle });

beforeEach(async () => {
  await clearOpenShift(SCOPE);
  delete params.usage;
  delete params.usageState;
  for (const fn of Object.values(mockRouter)) fn.mockClear();
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.mocked(TextInput.prototype.isFocused).mockReset();
});

// ═══════════════════════════════════════════════════════════════════════════
// STORE: nothing the reader would refuse is ever written
// ═══════════════════════════════════════════════════════════════════════════

test.each([
  ["an empty plate", { ...UNIT, numberPlate: "   " }],
  ["a fractional start mileage", { ...UNIT, startMileage: 12.5 }],
  ["a negative start mileage", { ...UNIT, startMileage: -1 }],
  ["an unknown class", { ...UNIT, vehicleClass: "tractor" as VehicleDetails["vehicleClass"] }],
])("Start Shift refuses a vehicle with %s, writing NO day — the store, not just the form", async (_why, vehicle) => {
  await expect(dayWith(vehicle)).rejects.toThrow(Error);

  expect(file().exists).toBe(false);
  expect(await readOpenShift(SCOPE)).toBeNull();
});

test("Start Shift stores the plate trimmed and upper-cased, as every other vehicle write does", async () => {
  await dayWith({ ...UNIT, numberPlate: "  ab12 cde " });

  expect((await readOpenShift(SCOPE))?.vehicle?.numberPlate).toBe("AB12 CDE");
});

test("a check answer that is not OK / N/A / DEFECT is refused — a certificate is never written that the reader would drop", async () => {
  const shift = await dayWith();
  const before = bytes();
  const answers: CheckAnswer[] = checklistItems(checklistFor("class1")).map(entry => ({ key: entry.key, result: entry.defaultResult, note: "" }));
  const bad = answers.map(answer => (answer.key === "horn" ? { ...answer, result: "maybe" as CheckAnswer["result"] } : answer));
  const target = { shiftId: shift.id, vehicleUseId: vehicleUseAt(STARTED_AT.toISOString()), usageState: USAGE_STATE.inUse, checkId: "c1", startedAt: at(5, 5) };

  await expect(completeVehicleCheck(SCOPE, { ...target, answers: bad, completedAt: at(5, 10), completedBy: "user_1" })).rejects.toThrow(Error);
  await expect(saveVehicleCheckDraft(SCOPE, { ...target, answers: [{ key: "horn", result: "maybe" as CheckAnswer["result"], note: "" }] })).rejects.toThrow(Error);

  expect(bytes()).toBe(before);
});

test.each([0, 1, 2, 3, 5])("DISCARD racing a write already queued (%i ticks in) stays discarded — the write never resurrects the day", async ticks => {
  const shift = await dayWith();
  const save = saveVehicleCheckDraft(SCOPE, {
    shiftId: shift.id, vehicleUseId: vehicleUseAt(STARTED_AT.toISOString()), usageState: USAGE_STATE.inUse, checkId: "c1",
    startedAt: at(5, 5), answers: [{ key: "horn", result: "na", note: "" }],
  });
  for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();

  await Promise.all([save, clearOpenShift(SCOPE)]);

  expect(file().exists).toBe(false);
  expect(await readOpenShift(SCOPE)).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// READER: what this app never writes is not read as a day
// ═══════════════════════════════════════════════════════════════════════════

test.each([
  ["a fractional start mileage on the vehicle in use", (day: Record<string, unknown>) => ({ ...day, vehicle: { ...(day["vehicle"] as object), startMileage: 12.5 } })],
  ["a creation time that is not a time", (day: Record<string, unknown>) => ({ ...day, createdAt: "yesterday" })],
])("a saved day with %s fails CLOSED", async (_why, corrupt) => {
  await dayWith();
  const day = JSON.parse(bytes()) as Record<string, unknown>;

  file().write(JSON.stringify(corrupt(day)));

  expect(await readOpenShift(SCOPE)).toBeNull();
});

test("a check of the WRONG asset never reads as that asset's check — a trailer's on a vehicle, a unit's on a trailer", async () => {
  const shift = await dayWith();
  await addTrailerToOpenShift(SCOPE, { shiftId: shift.id, trailer: TR23, startedAt: at(5, 30) });
  const certificate = (checklist: string) => ({
    id: `c-${checklist}`, checklist, checklistVersion: 1, startedAt: at(5, 40).toISOString(), status: "completed",
    completedAt: at(5, 50).toISOString(), completedBy: "user_1",
    items: [{ key: "body", label: "Body", section: { id: "body", title: "BODY" }, result: "pass", note: null }],
  });
  const day = JSON.parse(bytes()) as { vehicle: { checks: unknown[] }; trailer: { checks: unknown[] } };
  day.vehicle.checks = [certificate("trailer-standard")];
  day.trailer.checks = [certificate("hgv-unit")];
  file().write(JSON.stringify(day));

  const read = await readOpenShift(SCOPE);

  // The day itself is intact; neither misplaced certificate is read.
  expect(read?.vehicle?.checks).toEqual([]);
  expect(read?.trailer?.checks).toEqual([]);
});

test("CONTROL: the same day, as written, loads", async () => {
  await dayWith();

  expect(await readOpenShift(SCOPE)).not.toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTES: a stale screen never reports success, and never acts on a replacement
// ═══════════════════════════════════════════════════════════════════════════

test("Change Vehicle whose vehicle was changed behind it: nothing saved, the driver is told, and NO check opens on the replacement", async () => {
  const shift = await dayWith();
  // Earlier today: XY34, so it is offered back.
  await changeVehicle(SCOPE, { shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_100, next: OTHER, changedAt: at(6) });
  await changeVehicle(SCOPE, { shiftId: shift.id, endingUseId: vehicleUseAt(at(6).toISOString()), endMileage: 220_050, next: { ...UNIT, startMileage: 100_100 }, changedAt: at(7) });
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await mount(<ChangeVehicleRoute />);
  await type(view, "end-mileage", "100200");
  await press(view, "change-continue");
  await press(view, "candidate-XY34 ZZZ");
  await type(view, "next-start-mileage", "220100");
  await press(view, "perform-checks-yes");

  // Behind the screen, the unit it was opened for is handed back.
  await changeVehicle(SCOPE, { shiftId: shift.id, endingUseId: vehicleUseAt(at(7).toISOString()), endMileage: 100_150, next: { ...OTHER, numberPlate: "ZZ99 ZZZ" }, changedAt: at(8) });
  const before = bytes();
  await press(view, "change-confirm");

  expect(bytes()).toBe(before);
  expect(alert).toHaveBeenCalled();
  expect(mockRouter.replace).not.toHaveBeenCalledWith("/vehicle-check");
  expect(mockRouter.replace.mock.calls.some(([href]) => JSON.stringify(href).includes("vehicle-check"))).toBe(false);
  expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift");
});

test("CONTROL: a real change with checks opens the check for EXACTLY the new vehicle use", async () => {
  const shift = await dayWith();
  await changeVehicle(SCOPE, { shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_100, next: OTHER, changedAt: at(6) });
  await changeVehicle(SCOPE, { shiftId: shift.id, endingUseId: vehicleUseAt(at(6).toISOString()), endMileage: 220_050, next: { ...UNIT, startMileage: 100_100 }, changedAt: at(7) });
  const view = await mount(<ChangeVehicleRoute />);
  await type(view, "end-mileage", "100200");
  await press(view, "change-continue");
  await press(view, "candidate-XY34 ZZZ");
  await type(view, "next-start-mileage", "220100");
  await press(view, "perform-checks-yes");

  await press(view, "change-confirm");

  const now = (await readOpenShift(SCOPE))?.vehicle?.startedAt ?? "";
  expect((await readOpenShift(SCOPE))?.vehicle?.numberPlate).toBe("XY34 ZZZ");
  expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: "/vehicle-check", params: { usage: vehicleUseAt(now), usageState: "in-use" } });
});

test("No vehicle whose vehicle was changed behind it: nothing saved, and the driver is told", async () => {
  const shift = await dayWith();
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await mount(<ChangeVehicleRoute />);
  await type(view, "end-mileage", "100200");
  await press(view, "change-continue");
  await press(view, "use-no-vehicle");

  await changeVehicle(SCOPE, { shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_150, next: OTHER, changedAt: at(8) });
  const before = bytes();
  await press(view, "no-vehicle-confirm");

  expect(bytes()).toBe(before);
  expect(alert).toHaveBeenCalled();
});

test("Change Trailer whose trailer was changed behind it: nothing saved, and the driver is told", async () => {
  const shift = await dayWith();
  await addTrailerToOpenShift(SCOPE, { shiftId: shift.id, trailer: TR23, startedAt: at(5, 30) });
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await mount(<ChangeTrailerRoute />);
  await press(view, "use-no-trailer");

  await changeTrailer(SCOPE, { shiftId: shift.id, endingUseId: trailerUseAt(at(5, 30).toISOString()), next: { trailerNumber: "GFD", trailerType: TRAILER_TYPE.standard }, changedAt: at(8) });
  const before = bytes();
  await press(view, "no-trailer-confirm");

  expect(bytes()).toBe(before);
  expect(alert).toHaveBeenCalled();
  expect((await readOpenShift(SCOPE))?.trailer?.trailerNumber).toBe("GFD");
});

test("Add Trailer when a trailer arrived behind it: the typed trailer is NOT silently dropped as if added", async () => {
  const shift = await dayWith();
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await mount(<AddTrailerRoute />);
  await type(view, "trailer-number", "NEW1");
  await press(view, "trailer-type-standard");

  await addTrailerToOpenShift(SCOPE, { shiftId: shift.id, trailer: TR23, startedAt: at(8) });
  const before = bytes();
  await press(view, "add-trailer-submit");

  expect(bytes()).toBe(before);
  expect(alert).toHaveBeenCalled();
  expect((await readOpenShift(SCOPE))?.trailer?.trailerNumber).toBe("TR23");
});

test("Add Vehicle when a vehicle arrived behind it: the typed vehicle is NOT silently dropped as if added", async () => {
  await dayWith(null);
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await mount(<AddVehicleRoute />);
  await press(view, "vehicle-class-class2");
  await type(view, "number-plate", "NEW 1");
  await type(view, "start-mileage", "5000");

  await addVehicleToOpenShift(SCOPE, { vehicle: UNIT, startedAt: at(8) });
  const before = bytes();
  await press(view, "add-vehicle-submit");

  expect(bytes()).toBe(before);
  expect(alert).toHaveBeenCalled();
  expect((await readOpenShift(SCOPE))?.vehicle?.numberPlate).toBe("AB12 CDE");
});

// ─── Vehicle Checks: exact use, and a stale screen says so ─────────────────

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
  await waitFor(() => {
    expect(view.queryByTestId("complete-check") ?? view.queryByTestId("check-completed-at") ?? view.queryByTestId("redirect")).not.toBeNull();
  });
  return view;
}

test("Vehicle Checks named for a use that is no longer the one in use is not a screen — the vehicle in use is not substituted", async () => {
  const shift = await dayWith();
  await changeVehicle(SCOPE, { shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_100, next: OTHER, changedAt: at(6) });
  params.usage = vehicleUseAt(STARTED_AT.toISOString());
  params.usageState = USAGE_STATE.inUse;

  const view = await signedIn(<VehicleCheckRoute />);

  expect(text(view, "redirect")).toBe("/active-shift");
});

test("a Vehicle Check whose vehicle was changed while open: completing saves nothing, the driver is told, and they return to the day — not Home", async () => {
  const shift = await dayWith();
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await signedIn(<VehicleCheckRoute />);

  await changeVehicle(SCOPE, { shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_100, next: OTHER, changedAt: at(6) });
  const before = bytes();
  await press(view, "complete-check");

  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift"); });
  expect(mockRouter.replace).not.toHaveBeenCalledWith("/today");
  expect(alert).toHaveBeenCalled();
  expect(bytes()).toBe(before);
});

test("a stale No vehicle cannot leave a day it would make unreadable, whatever the screen thought", async () => {
  // The invariant at the store, once more from the route's angle: a trailer
  // arrives behind an open No vehicle confirmation.
  const shift = await dayWith();
  const view = await mount(<ChangeVehicleRoute />);
  await type(view, "end-mileage", "100200");
  await press(view, "change-continue");
  await press(view, "use-no-vehicle");
  jest.spyOn(Alert, "alert").mockImplementation(() => undefined);

  await addTrailerToOpenShift(SCOPE, { shiftId: shift.id, trailer: TR23, startedAt: at(8) });
  const before = bytes();
  await press(view, "no-vehicle-confirm");

  expect(bytes()).toBe(before);
  expect(await readOpenShift(SCOPE)).not.toBeNull();
  // The ended-without-trailer path through the store still refuses directly.
  await expect(endVehicleUse(SCOPE, { shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_200, endedAt: at(9) })).rejects.toThrow(Error);
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTES: a phone clock that went back is explained, and nothing is written
// (persistence hardening, 2026-09-28)
// ═══════════════════════════════════════════════════════════════════════════

/** Later than any real press, so the press's clock reads BEFORE these uses began. */
const FUTURE = (hours: number) => new Date(2099, 0, 1, hours, 0);
const clockMessage = (alert: jest.SpyInstance) =>
  alert.mock.calls.some(([, message]) => typeof message === "string" && message.includes("clock is earlier"));

test("Change Vehicle with the phone clock before the unit's start: refused, explained, nothing written, stays on screen", async () => {
  const shift = await startLocalShift(SCOPE, { workingFor: { kind: "personal" }, startedAt: FUTURE(5), vehicle: UNIT });
  await changeVehicle(SCOPE, { shiftId: shift.id, endingUseId: vehicleUseAt(FUTURE(5).toISOString()), endMileage: 100_100, next: OTHER, changedAt: FUTURE(6) });
  await changeVehicle(SCOPE, { shiftId: shift.id, endingUseId: vehicleUseAt(FUTURE(6).toISOString()), endMileage: 220_050, next: { ...UNIT, startMileage: 100_100 }, changedAt: FUTURE(7) });
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await mount(<ChangeVehicleRoute />);
  await type(view, "end-mileage", "100200");
  await press(view, "change-continue");
  await press(view, "candidate-XY34 ZZZ");
  await type(view, "next-start-mileage", "220100");
  await press(view, "perform-checks-no");
  const before = bytes();

  await press(view, "change-confirm");

  expect(bytes()).toBe(before);
  expect(clockMessage(alert)).toBe(true);
  expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

test("No vehicle with the phone clock before the unit's start: refused, explained, nothing written", async () => {
  await startLocalShift(SCOPE, { workingFor: { kind: "personal" }, startedAt: FUTURE(5), vehicle: UNIT });
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await mount(<ChangeVehicleRoute />);
  await type(view, "end-mileage", "100200");
  await press(view, "change-continue");
  await press(view, "use-no-vehicle");
  const before = bytes();

  await press(view, "no-vehicle-confirm");

  expect(bytes()).toBe(before);
  expect(clockMessage(alert)).toBe(true);
  expect(mockRouter.dismissTo).not.toHaveBeenCalled();
});

test.each([["No trailer", null], ["Change Trailer", "GFD"]] as const)("%s with the phone clock before the trailer's start: refused, explained, nothing written", async (_what, nextNumber) => {
  const shift = await startLocalShift(SCOPE, { workingFor: { kind: "personal" }, startedAt: FUTURE(5), vehicle: UNIT });
  await addTrailerToOpenShift(SCOPE, { shiftId: shift.id, trailer: TR23, startedAt: FUTURE(6) });
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await mount(<ChangeTrailerRoute />);
  if (nextNumber === null) {
    await press(view, "use-no-trailer");
  } else {
    await press(view, "use-different-trailer");
    await type(view, "trailer-number", nextNumber);
    await press(view, "trailer-type-standard");
  }
  const before = bytes();

  await press(view, nextNumber === null ? "no-trailer-confirm" : "change-trailer-confirm");

  expect(bytes()).toBe(before);
  expect(clockMessage(alert)).toBe(true);
  expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  expect((await readOpenShift(SCOPE))?.trailer?.trailerNumber).toBe("TR23");
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTES: a save that failed on the disk never claims "nothing was changed"
// (closeout, 2026-09-28) — the old day file may already be gone
// ═══════════════════════════════════════════════════════════════════════════

const temporary = () => new File(accountDirectoryOf(SCOPE), OPEN_SHIFT_TEMP_FILE);
const alertBodies = (alert: jest.SpyInstance): string[] =>
  alert.mock.calls.map(([, body]) => (typeof body === "string" ? body : ""));

/** Change Trailer's No trailer, as the driver presses it, with `failing` installed just before the press. */
async function pressNoTrailer(failing: () => void): Promise<string> {
  const shift = await dayWith();
  await addTrailerToOpenShift(SCOPE, { shiftId: shift.id, trailer: TR23, startedAt: at(5, 30) });
  const view = await mount(<ChangeTrailerRoute />);
  await press(view, "use-no-trailer");
  const before = bytes();
  failing();
  await press(view, "no-trailer-confirm");
  return before;
}

test("the message is decided by the error's TYPE: a failed save says it was preserved; any other refusal keeps what the screen says", () => {
  expect(saveFailureMessage(new SafeSaveFailedError(new Error("disk full")))).toBe(SAFE_SAVE_FAILED);
  expect(saveFailureMessage(new SafeSaveFailedError(new Error("x")), "Your last answer was not saved. Please try again.")).toBe(SAFE_SAVE_FAILED);
  expect(saveFailureMessage(new Error("The change could not be saved safely"))).toBe("Nothing was changed. Please try again.");
  expect(saveFailureMessage(new Error("x"), "Your last answer was not saved. Please try again.")).toBe("Your last answer was not saved. Please try again.");
  expect(SAFE_SAVE_FAILED).not.toMatch(/nothing was changed/i);
});

test("STALE target keeps its truthful message: 'Nothing was saved', and never the save-failure one", async () => {
  const shift = await dayWith();
  await addTrailerToOpenShift(SCOPE, { shiftId: shift.id, trailer: TR23, startedAt: at(5, 30) });
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await mount(<ChangeTrailerRoute />);
  await press(view, "use-no-trailer");
  await changeTrailer(SCOPE, { shiftId: shift.id, endingUseId: trailerUseAt(at(5, 30).toISOString()), next: null, changedAt: at(8) });

  await press(view, "no-trailer-confirm");

  expect(alert).toHaveBeenCalledWith("Nothing was saved", "That trailer is no longer the one in use.");
  expect(alertBodies(alert)).not.toContain(SAFE_SAVE_FAILED);
});

test("a TEMPORARY-WRITE failure says the change could not be saved safely — and the live day is exactly as it was", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const before = await pressNoTrailer(() => {
    jest.spyOn(File.prototype, "write").mockImplementation(() => { throw new Error("disk full"); });
  });

  expect(alertBodies(alert)).toEqual([SAFE_SAVE_FAILED]);
  expect(bytes()).toBe(before);
  expect(temporary().exists).toBe(false);
  expect(mockRouter.dismissTo).not.toHaveBeenCalled();
});

test("a REPLACEMENT failure that already removed the old day file never claims 'Nothing was changed' — the verified next day is kept", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  await pressNoTrailer(() => {
    // Expo's replace on iOS: the target is deleted, then the move fails.
    jest.spyOn(File.prototype, "moveSync").mockImplementation((destination: File | Directory) => {
      if (destination instanceof File && destination.exists) destination.delete();
      throw new Error("rename failed");
    });
  });

  expect(alertBodies(alert)).toEqual([SAFE_SAVE_FAILED]);
  expect(alertBodies(alert).some(body => /nothing was changed/i.test(body))).toBe(false);
  // Persistence itself unchanged: no live day, the complete next state kept aside, never read as the day.
  expect(file().exists).toBe(false);
  expect(JSON.parse(temporary().textSync())).toMatchObject({ trailer: null, previousTrailers: [{ trailerNumber: "TR23" }] });
  expect(await readOpenShift(SCOPE)).toBeNull();
  expect(mockRouter.dismissTo).not.toHaveBeenCalled();
});

test("a REPLACEMENT failure with the old day still in place gets the same message, and the day reads as before", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const before = await pressNoTrailer(() => {
    jest.spyOn(File.prototype, "moveSync").mockImplementation(() => { throw new Error("rename failed"); });
  });

  expect(alertBodies(alert)).toEqual([SAFE_SAVE_FAILED]);
  expect(bytes()).toBe(before);
  expect((await readOpenShift(SCOPE))?.trailer?.trailerNumber).toBe("TR23");
});

async function startShiftScreen(): Promise<View> {
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AuthProvider><SignedIn><StartShiftRoute /></SignedIn></AuthProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => { expect(text(view, "status")).toBe("unauthenticated"); });
  await act(async () => { await fireEvent.press(view.getByTestId("authenticate")); });
  await waitFor(() => { expect(view.queryByTestId("start-shift-submit")).not.toBeNull(); });
  return view;
}

test("Start Shift that cannot move an unreadable day aside TELLS the driver, starts nothing, and leaves the file exactly as it was", async () => {
  const unreadable = '{"id":"yesterday","status":"open"}';
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await startShiftScreen();
  file().create({ overwrite: true });
  file().write(unreadable);
  jest.spyOn(File.prototype, "moveSync").mockImplementation(() => { throw new Error("disk full"); });
  await press(view, "vehicle-not-yet");

  await press(view, "start-shift-submit");

  await waitFor(() => { expect(alert).toHaveBeenCalledWith("Couldn't start the shift", "Nothing was changed. Please try again."); });
  expect(bytes()).toBe(unreadable);
  expect(mockRouter.replace).not.toHaveBeenCalledWith("/active-shift");
});

test("Start Shift whose save fails says the change could not be saved safely", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await startShiftScreen();
  jest.spyOn(File.prototype, "write").mockImplementation(() => { throw new Error("disk full"); });
  await press(view, "vehicle-not-yet");

  await press(view, "start-shift-submit");

  await waitFor(() => { expect(alert).toHaveBeenCalledWith("Couldn't start the shift", SAFE_SAVE_FAILED); });
  expect(file().exists).toBe(false);
  expect(mockRouter.replace).not.toHaveBeenCalledWith("/active-shift");
});
