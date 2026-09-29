/**
 * Finished days, surfaced (2026-09-28): Home's Recent Timesheets, the
 * Timesheets tab, and one finished day's page — all read from the phone.
 *
 *   HOME        the latest three, newest first; "No timesheets yet" only
 *               when there are none; re-read whenever Home comes into view
 *   TIMESHEETS  every readable finished day, newest first
 *   DETAIL      opened by the day's id, and a faithful rendering of it
 *   FINISH      a finished day is on Home as the driver lands there
 */
import { render, fireEvent, act, waitFor, within } from "@testing-library/react-native";
import { Directory, File, Paths } from "expo-file-system";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Alert, Pressable, Text } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AuthenticatedAccount } from "../api/account";
import Today from "../../app/(app)/(tabs)/today";
import Timesheets from "../../app/(app)/(tabs)/timesheets";
import TimesheetRoute from "../../app/(app)/timesheet";
import FinishShiftRoute from "../../app/(app)/finish-shift";
import { checklistFor, checklistItems, trailerChecklistFor } from "../shift/checklists";
import {
  COMPLETED_SHIFT_FILE_PREFIX,
  USAGE_STATE,
  addTrailerToOpenShift,
  changeTrailer,
  changeVehicle,
  clearOpenShift,
  completeTrailerCheck,
  completeVehicleCheck,
  saveTrailerCheckDraft,
  readOpenShift,
  recordReeferDiesel,
  recordVehicleFill,
  reviseVehicleCheck,
  saveVehicleCheckDraft,
  startLocalShift,
  type CompletedShift,
  type VehicleDetails,
  type WorkingContext,
} from "../shift/localShift";
import { TRAILER_TYPE } from "../shift/trailer";
import { CHECK_RESULT, type CheckAnswer } from "../shift/vehicleCheck";
import { FILL_TYPE } from "../shift/vehicleFill";
import { trailerUseAt, vehicleUseAt } from "./useIdAt";
import { finishDeclared } from "./declared";

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismissTo: jest.fn() };
const mockParams: { id?: string } = {};
/** Every focus effect currently mounted — `refocus()` runs them, as coming back into view does. */
const mockFocus = new Set<() => void>();

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
    useFocusEffect: (effect: () => (() => void) | undefined) => {
      react.useEffect(() => {
        let cleanup = effect();
        const again = () => { cleanup?.(); cleanup = effect(); };
        mockFocus.add(again);
        return () => { mockFocus.delete(again); cleanup?.(); };
      }, [effect]);
    },
    useLocalSearchParams: () => mockParams,
  };
});

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const DRIVER: AuthenticatedAccount = {
  user: { id: "user_hist_1", firstName: "Nerijus", lastName: "Kuizinas", email: "driver@example.com" },
  identityToken: "identity.token.value",
  refreshToken: "refresh-secret-value",
  memberships: [],
};
const day = (date: number, hours: number, minutes = 0) => new Date(2026, 8, date, hours, minutes);
const PERSONAL: WorkingContext = { kind: "personal" };
const NORTHGATE: WorkingContext = { kind: "company", membershipId: "m1", companyId: "c1", companyName: "Northgate Haulage & Distribution Services (Midlands) Ltd" };
const UNIT: VehicleDetails = { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 };
const RIGID: VehicleDetails = { vehicleClass: "class2", numberPlate: "XY34 ZZZ", startMileage: 220_000 };

type View = Awaited<ReturnType<typeof render>>;
const text = (view: View, testID: string) => {
  const children = (view.getByTestId(testID).props as { children?: unknown }).children;
  return Array.isArray(children) ? children.join("") : String(children);
};
async function press(view: View, testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(view.getByTestId(testID)); });
}
/** Declare the Review correct, then press its final action (D41). */
async function declareAndFinish(view: View): Promise<void> {
  await press(view, "finish-confirm-declaration");
  await press(view, "finish-confirm");
}
async function type(view: View, testID: string, value: string): Promise<void> {
  await act(async () => { await fireEvent.changeText(view.getByTestId(testID), value); });
}
async function refocus(): Promise<void> {
  await act(async () => { for (const again of [...mockFocus]) again(); await Promise.resolve(); });
}

/** A day with no vehicle, started and finished through the real store. */
async function finished(startedAt: Date, endedAt: Date, options: { workingFor?: WorkingContext; nightOut?: boolean; notes?: string } = {}): Promise<CompletedShift> {
  const shift = await startLocalShift({ workingFor: options.workingFor ?? PERSONAL, startedAt, vehicle: null });
  const done = await finishDeclared({
    shiftId: shift.id, vehicleUseId: null, trailerUseId: null, finalMileage: null,
    endedAt, nightOut: options.nightOut ?? false, notes: options.notes ?? "",
  });
  if (done === null) throw new Error("expected the day to finish");
  return done;
}

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
async function home(): Promise<View> {
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}><AuthProvider><SignedIn><Today /></SignedIn></AuthProvider></SafeAreaProvider>,
  );
  await waitFor(() => { expect(text(view, "status")).toBe("unauthenticated"); });
  await press(view, "authenticate");
  await waitFor(() => { expect(view.queryByTestId("recent-timesheets-empty") ?? view.queryByTestId("recent-timesheets-list")).not.toBeNull(); });
  return view;
}
async function timesheets(): Promise<View> {
  const view = await render(<SafeAreaProvider initialMetrics={METRICS}><Timesheets /></SafeAreaProvider>);
  await waitFor(() => {
    expect(view.queryByTestId("timesheets-empty") ?? view.queryByTestId("timesheets-list") ?? view.queryByTestId("timesheets-damaged")).not.toBeNull();
  });
  return view;
}
async function detail(id: string): Promise<View> {
  mockParams.id = id;
  const view = await render(<SafeAreaProvider initialMetrics={METRICS}><TimesheetRoute /></SafeAreaProvider>);
  await waitFor(() => { expect(view.queryByTestId("timesheet-date") ?? view.queryByTestId("timesheet-missing")).not.toBeNull(); });
  return view;
}

beforeEach(async () => {
  await clearOpenShift();
  for (const entry of new Directory(Paths.document).list()) {
    if (entry instanceof File && entry.uri.includes(COMPLETED_SHIFT_FILE_PREFIX)) entry.delete();
  }
  delete mockParams.id;
  for (const fn of Object.values(mockRouter)) fn.mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// Home — Recent Timesheets
// ═══════════════════════════════════════════════════════════════════════════

test("Home with NO finished day says 'No timesheets yet' — and nothing else in the section", async () => {
  const view = await home();

  expect(view.getByTestId("recent-timesheets-empty")).toBeTruthy();
  expect(view.queryByTestId("recent-timesheet-0")).toBeNull();
});

test("Home lists a finished day: its date, who it was for, its hours and length", async () => {
  await finished(day(19, 5), day(19, 17, 30), { workingFor: NORTHGATE });

  const view = await home();

  expect(view.queryByTestId("recent-timesheets-empty")).toBeNull();
  expect(text(view, "recent-timesheet-0-date")).toBe("Sat 19 Sep 2026");
  expect(text(view, "recent-timesheet-0-working-for")).toBe(NORTHGATE.kind === "company" ? NORTHGATE.companyName : "");
  expect(text(view, "recent-timesheet-0-hours")).toBe("05:00 → 17:30 · 12 h 30 min");
});

test("Home shows the latest THREE, newest first — the Timesheets tab has the rest", async () => {
  for (const date of [15, 18, 16, 19, 17]) await finished(day(date, 6), day(date, 14));

  const view = await home();

  expect(["recent-timesheet-0-date", "recent-timesheet-1-date", "recent-timesheet-2-date"].map(id => text(view, id)))
    .toEqual(["Sat 19 Sep 2026", "Fri 18 Sep 2026", "Thu 17 Sep 2026"]);
  expect(view.queryByTestId("recent-timesheet-3")).toBeNull();
});

test("Home never lists the OPEN day", async () => {
  await startLocalShift({ workingFor: PERSONAL, startedAt: day(19, 5), vehicle: UNIT });

  const view = await home();

  expect(view.getByTestId("recent-timesheets-empty")).toBeTruthy();
});

test("tapping a Recent Timesheet opens EXACTLY that day, by its id", async () => {
  await finished(day(18, 6), day(18, 14));
  const newest = await finished(day(19, 6), day(19, 14));
  const view = await home();

  await press(view, "recent-timesheet-0");

  expect(mockRouter.push).toHaveBeenCalledWith({ pathname: "/timesheet", params: { id: newest.id } });
});

test("Home re-reads as it comes back into view: a day finished meanwhile is listed without a restart", async () => {
  const view = await home();
  expect(view.getByTestId("recent-timesheets-empty")).toBeTruthy();

  const done = await finished(day(19, 5), day(19, 17));
  await refocus();

  await waitFor(() => { expect(text(view, "recent-timesheet-0-date")).toBe("Sat 19 Sep 2026"); });
  await press(view, "recent-timesheet-0");
  expect(mockRouter.push).toHaveBeenCalledWith({ pathname: "/timesheet", params: { id: done.id } });
});

// ═══════════════════════════════════════════════════════════════════════════
// Timesheets tab
// ═══════════════════════════════════════════════════════════════════════════

test("Timesheets with none finished shows its empty state and no rows", async () => {
  const view = await timesheets();

  expect(text(view, "screen-title")).toBe("Timesheets");
  expect(view.getByTestId("timesheets-empty")).toBeTruthy();
  expect(view.queryByTestId("timesheet-0")).toBeNull();
});

test("Timesheets lists EVERY finished day, newest first — Personal and company, hours across midnight, Night Out", async () => {
  await finished(day(15, 6), day(15, 14));
  await finished(day(16, 6), day(16, 14));
  await finished(day(17, 6), day(17, 14));
  await finished(day(18, 22), day(19, 6, 15), { workingFor: NORTHGATE, nightOut: true });
  await finished(day(19, 20), day(19, 21));

  const view = await timesheets();

  expect([0, 1, 2, 3, 4].map(index => text(view, `timesheet-${String(index)}-date`)))
    .toEqual(["Sat 19 Sep 2026", "Fri 18 Sep 2026", "Thu 17 Sep 2026", "Wed 16 Sep 2026", "Tue 15 Sep 2026"]);
  expect(text(view, "timesheet-0-working-for")).toBe("Personal");
  expect(view.queryByTestId("timesheet-0-night-out")).toBeNull();
  expect(text(view, "timesheet-1-working-for")).toBe(NORTHGATE.kind === "company" ? NORTHGATE.companyName : "");
  expect(text(view, "timesheet-1-hours")).toBe("22:00 → 06:15 (+1 day) · 8 h 15 min");
  expect(text(view, "timesheet-1-night-out")).toBe("Night out");
});

test("two days that LOOK the same open their OWN ids", async () => {
  const first = await finished(day(19, 6), day(19, 14));
  const second = await finished(day(19, 6), day(19, 14));
  const view = await timesheets();

  await press(view, "timesheet-0");
  await press(view, "timesheet-1");

  const opened = mockRouter.push.mock.calls.map(([href]) => (href as { params: { id: string } }).params.id);
  expect(opened.sort()).toEqual([first.id, second.id].sort());
  expect(opened[0]).not.toBe(opened[1]);
});

test("Timesheets re-reads when it comes back into view", async () => {
  const view = await timesheets();
  await finished(day(19, 5), day(19, 17));

  await refocus();

  await waitFor(() => { expect(view.getByTestId("timesheet-0")).toBeTruthy(); });
});

test("the list shows nothing that was not recorded: no status, no 'submitted', no mileage", async () => {
  await finished(day(19, 5), day(19, 17));
  const view = await timesheets();
  const shown = view.getByTestId("timesheets-list");

  expect(within(shown).queryAllByText(/submitted|sent|miles|\bmi\b/i)).toEqual([]);
});

// ── Saved timesheets that cannot be read (owner correction) ────────────────

/** Damage a finished day's record on disk, as a failing storage might. */
function damage(shift: CompletedShift): void {
  new File(Paths.document, `${COMPLETED_SHIFT_FILE_PREFIX}${shift.id}.json`).write("{ damaged");
}

test("Timesheets says how many saved timesheets could not be read — and still lists every readable one", async () => {
  const good = await finished(day(18, 6), day(18, 14));
  damage(await finished(day(19, 6), day(19, 14)));

  const view = await timesheets();

  expect(text(view, "timesheets-damaged")).toBe("1 saved timesheet could not be read.");
  expect(text(view, "timesheet-0-date")).toBe("Fri 18 Sep 2026");
  expect(view.queryByTestId("timesheet-1")).toBeNull();
  await press(view, "timesheet-0");
  expect(mockRouter.push).toHaveBeenCalledWith({ pathname: "/timesheet", params: { id: good.id } });
});

test("with ONLY unreadable timesheets, Timesheets does not claim there are none", async () => {
  damage(await finished(day(18, 6), day(18, 14)));
  damage(await finished(day(19, 6), day(19, 14)));

  const view = await timesheets();

  expect(text(view, "timesheets-damaged")).toBe("2 saved timesheets could not be read.");
  expect(view.queryByTestId("timesheets-empty")).toBeNull();
});

test("Home stays clean: readable days are listed, with no warning about unreadable ones", async () => {
  await finished(day(18, 6), day(18, 14));
  damage(await finished(day(19, 6), day(19, 14)));

  const view = await home();

  expect(text(view, "recent-timesheet-0-date")).toBe("Fri 18 Sep 2026");
  expect(view.queryByTestId("recent-timesheet-1")).toBeNull();
  expect(view.queryByText(/could not be read/)).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// Timesheet detail
// ═══════════════════════════════════════════════════════════════════════════

const answers = (keys: readonly { key: string; defaultResult: CheckAnswer["result"] }[], defect?: string): CheckAnswer[] =>
  keys.map(entry => (entry.key === defect
    ? { key: entry.key, result: CHECK_RESULT.defect, note: "Cut in the sidewall" }
    : { key: entry.key, result: entry.defaultResult, note: "" }));

/** A full day: two uses of the same unit around a rigid, a trailer twice and a fridge trailer. */
async function busyDay(): Promise<CompletedShift> {
  const shift = await startLocalShift({ workingFor: NORTHGATE, startedAt: day(18, 22), vehicle: UNIT });
  const unitItems = checklistItems(checklistFor("class1"));
  const tyre = unitItems[0]?.key;
  await completeVehicleCheck({
    shiftId: shift.id, vehicleUseId: vehicleUseAt(day(18, 22).toISOString()), usageState: USAGE_STATE.inUse, checkId: "vc",
    startedAt: day(18, 22, 5), answers: answers(unitItems, tyre), completedAt: day(18, 22, 20), completedBy: DRIVER.user.id,
  });
  await recordVehicleFill({ shiftId: shift.id, vehicleUseId: vehicleUseAt(day(18, 22).toISOString()), usageState: USAGE_STATE.inUse, fillId: "f1", type: FILL_TYPE.fuel, recordedAt: day(18, 23), litres: 312.5, note: "Tilbury" });
  await recordVehicleFill({ shiftId: shift.id, vehicleUseId: vehicleUseAt(day(18, 22).toISOString()), usageState: USAGE_STATE.inUse, fillId: "f2", type: FILL_TYPE.adblue, recordedAt: day(19, 1), litres: null, note: "" });
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: { trailerNumber: "TR23", trailerType: TRAILER_TYPE.standard }, startedAt: day(18, 22, 30) });
  const trailerItems = checklistItems(trailerChecklistFor(TRAILER_TYPE.standard));
  await completeTrailerCheck({
    shiftId: shift.id, trailerUseId: trailerUseAt(day(18, 22, 30).toISOString()), usageState: USAGE_STATE.inUse, checkId: "tc",
    startedAt: day(18, 22, 35), answers: answers(trailerItems, trailerItems[0]?.key), completedAt: day(18, 22, 45), completedBy: DRIVER.user.id,
  });
  await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(day(18, 22, 30).toISOString()), next: { trailerNumber: "RF77", trailerType: TRAILER_TYPE.refrigerated }, changedAt: day(19, 2) });
  await recordReeferDiesel({ shiftId: shift.id, trailerUseId: trailerUseAt(day(19, 2).toISOString()), usageState: USAGE_STATE.inUse, fillId: "rd", recordedAt: day(19, 3), litres: 40, note: "" });
  await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(day(19, 2).toISOString()), next: { trailerNumber: "TR23", trailerType: TRAILER_TYPE.standard }, changedAt: day(19, 4) });
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(day(18, 22).toISOString()), endMileage: 100_180, next: { ...UNIT, vehicleClass: "class1", numberPlate: "CD56 EFG", startMileage: 5_000 }, changedAt: day(19, 4, 30) });
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(day(19, 4, 30).toISOString()), endMileage: 5_040, next: { ...UNIT, startMileage: 100_180 }, changedAt: day(19, 5) });
  await saveVehicleCheckDraft({ shiftId: shift.id, vehicleUseId: vehicleUseAt(day(19, 5).toISOString()), usageState: USAGE_STATE.inUse, checkId: "draft", startedAt: day(19, 5, 5), answers: [{ key: "horn", result: CHECK_RESULT.notApplicable, note: "" }] });
  const done = await finishDeclared({
    shiftId: shift.id, vehicleUseId: vehicleUseAt(day(19, 5).toISOString()), trailerUseId: trailerUseAt(day(19, 4).toISOString()),
    finalMileage: 100_300, endedAt: day(19, 9, 30), nightOut: true, notes: "Waited 2h at Tilbury — gate queue",
  });
  if (done === null) throw new Error("expected the day to finish");
  return done;
}

test("the SHIFT section: date, who for, start and finish with dates across midnight, duration, Night Out, notes", async () => {
  const done = await busyDay();

  const view = await detail(done.id);

  expect(text(view, "timesheet-date")).toBe("Fri 18 Sep 2026");
  expect(text(view, "timesheet-working-for")).toBe(NORTHGATE.kind === "company" ? NORTHGATE.companyName : "");
  expect(text(view, "timesheet-started")).toBe("Fri 18 Sep 2026, 22:00");
  expect(text(view, "timesheet-finished")).toBe("Sat 19 Sep 2026, 09:30 (next day)");
  expect(text(view, "timesheet-duration")).toBe("11 h 30 min");
  expect(text(view, "timesheet-night-out")).toBe("Yes");
  expect(text(view, "timesheet-notes")).toBe("Waited 2h at Tilbury — gate queue");
});

test("VEHICLE uses: each separately, in order — the same unit twice stays two uses, each with its own mileage", async () => {
  const view = await detail((await busyDay()).id);

  expect([0, 1, 2].map(index => text(view, `timesheet-vehicle-${String(index)}-title`)))
    .toEqual(["Class 1 · AB12 CDE", "Class 1 · CD56 EFG", "Class 1 · AB12 CDE"]);
  expect(text(view, "timesheet-vehicle-0-started")).toBe("22:00");
  expect(text(view, "timesheet-vehicle-0-ended")).toBe("Sat 19 Sep 2026, 04:30");
  expect(text(view, "timesheet-vehicle-0-start-mileage")).toBe("100,000 mi");
  expect(text(view, "timesheet-vehicle-0-end-mileage")).toBe("100,180 mi");
  expect(text(view, "timesheet-vehicle-0-travelled")).toBe("180 mi");
  expect(text(view, "timesheet-vehicle-1-travelled")).toBe("40 mi");
  expect(text(view, "timesheet-vehicle-2-start-mileage")).toBe("100,180 mi");
  expect(text(view, "timesheet-vehicle-2-end-mileage")).toBe("100,300 mi");
  expect(text(view, "timesheet-vehicle-2-travelled")).toBe("120 mi");
});

test("Fuel and AdBlue entries are shown as recorded — an unknown amount is said, never 0", async () => {
  const view = await detail((await busyDay()).id);

  expect(text(view, "timesheet-vehicle-0-fuel-0-amount")).toBe("23:00 · 312.5 L");
  expect(text(view, "timesheet-vehicle-0-adblue-0-amount")).toBe("Sat 19 Sep 2026, 01:00 · Amount unknown");
  expect(view.getByTestId("timesheet-vehicle-1-fuel-none")).toBeTruthy();
});

test("TRAILER uses: each separately — the same trailer twice is two uses; a refrigerated one shows its Fridge Diesel", async () => {
  const view = await detail((await busyDay()).id);

  expect([0, 1, 2].map(index => text(view, `timesheet-trailer-${String(index)}-title`)))
    .toEqual(["TR23 · Standard", "RF77 · Refrigerated", "TR23 · Standard"]);
  expect(text(view, "timesheet-trailer-1-fridge-diesel-0-amount")).toBe("Sat 19 Sep 2026, 03:00 · 40 L");
  expect(view.queryByTestId("timesheet-trailer-0-fridge-diesel-none")).toBeNull();
  expect(text(view, "timesheet-trailer-2-ended")).toBe("Sat 19 Sep 2026, 09:30");
});

test("CHECKS: completed with its defect on the right use; a draft and a missing check say NOT completed", async () => {
  const view = await detail((await busyDay()).id);

  expect(text(view, "timesheet-vehicle-0-checks")).toBe("Checks completed");
  expect(view.getByTestId("timesheet-vehicle-0-defect-0")).toBeTruthy();
  expect(text(view, "timesheet-vehicle-1-checks")).toBe("Check not completed");
  expect(text(view, "timesheet-vehicle-2-checks")).toBe("Check not completed · started");
  expect(view.queryByTestId("timesheet-vehicle-2-defect-0")).toBeNull();
  expect(text(view, "timesheet-trailer-0-checks")).toBe("Checks completed");
  expect(view.getByTestId("timesheet-trailer-0-defect-0")).toBeTruthy();
  expect(text(view, "timesheet-trailer-1-checks")).toBe("Check not completed");
});

test("a CORRECTED check says so and shows what it says NOW — the corrected-away defect is gone from view", async () => {
  const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: day(19, 5), vehicle: RIGID });
  const items = checklistItems(checklistFor("class2"));
  const use = { shiftId: shift.id, vehicleUseId: vehicleUseAt(day(19, 5).toISOString()), usageState: USAGE_STATE.inUse };
  await completeVehicleCheck({ ...use, checkId: "c", startedAt: day(19, 5, 5), answers: answers(items, items[0]?.key), completedAt: day(19, 5, 20), completedBy: DRIVER.user.id });
  await reviseVehicleCheck({ shiftId: shift.id, useId: vehicleUseAt(day(19, 5).toISOString()), usageState: USAGE_STATE.inUse, checkId: "c", revisionId: "r1", answers: answers(items), revisedAt: day(19, 6), revisedBy: DRIVER.user.id });
  const done = await finishDeclared({ shiftId: shift.id, vehicleUseId: vehicleUseAt(day(19, 5).toISOString()), trailerUseId: null, finalMileage: 220_060, endedAt: day(19, 13), nightOut: false, notes: "" });

  const view = await detail(done?.id ?? "");

  expect(text(view, "timesheet-vehicle-0-title")).toBe("Class 2 · XY34 ZZZ");
  expect(text(view, "timesheet-vehicle-0-checks")).toBe("Checks completed · corrected");
  expect(view.getByTestId("timesheet-vehicle-0-no-defects")).toBeTruthy();
  // The original certificate, defect and all, is still in the record.
  expect(done?.previousVehicles[0]?.checks[0]?.items.some(item => item.result === CHECK_RESULT.defect)).toBe(true);
});

test("a day with NO vehicle says so; Night Out No; no notes line", async () => {
  const done = await finished(day(19, 7), day(19, 15));

  const view = await detail(done.id);

  expect(text(view, "timesheet-no-vehicles")).toBe("No vehicle used");
  expect(text(view, "timesheet-night-out")).toBe("No");
  expect(view.queryByTestId("timesheet-notes")).toBeNull();
  expect(view.queryByTestId("timesheet-trailer-0-title")).toBeNull();
});

test("a VAN day and a MULTI-DAY day read correctly", async () => {
  const van = await startLocalShift({ workingFor: PERSONAL, startedAt: day(16, 6), vehicle: { vehicleClass: "van", numberPlate: "VN11 AAA", startMileage: 40_000 } });
  const done = await finishDeclared({ shiftId: van.id, vehicleUseId: vehicleUseAt(day(16, 6).toISOString()), trailerUseId: null, finalMileage: 40_900, endedAt: day(18, 18), nightOut: true, notes: "" });

  const view = await detail(done?.id ?? "");

  expect(text(view, "timesheet-vehicle-0-title")).toBe("Van · VN11 AAA");
  expect(text(view, "timesheet-finished")).toBe("Fri 18 Sep 2026, 18:00 (2 days later)");
  expect(text(view, "timesheet-duration")).toBe("60 h");
  expect(text(view, "timesheet-vehicle-0-travelled")).toBe("900 mi");
});

test("an id no readable day has is said plainly — nothing else is shown in its place", async () => {
  await finished(day(19, 7), day(19, 15));

  const view = await detail("not-a-day");

  expect(text(view, "timesheet-missing")).toBe("This timesheet can't be found on this phone.");
  expect(view.queryByTestId("timesheet-date")).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// Finish → Home
// ═══════════════════════════════════════════════════════════════════════════

test("Finish Shift goes Home, and Home — coming into view — lists the finished day; the open day is gone", async () => {
  const homeView = await home();
  expect(homeView.getByTestId("recent-timesheets-empty")).toBeTruthy();
  await startLocalShift({ workingFor: PERSONAL, startedAt: day(19, 5), vehicle: UNIT });
  jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  // The gate renders Finish only for the signed-in driver, who declares the day (D42).
  const finish = await render(<SafeAreaProvider initialMetrics={METRICS}><AuthProvider><SignedIn><FinishShiftRoute /></SignedIn></AuthProvider></SafeAreaProvider>);
  await waitFor(() => { expect(text(finish, "status")).not.toBe("restoring"); });
  if (text(finish, "status") !== "authenticated") await press(finish, "authenticate");
  await waitFor(() => { expect(finish.queryByTestId("final-mileage")).not.toBeNull(); });
  await type(finish, "final-mileage", "100150");
  await press(finish, "finish-mileage-continue");
  await press(finish, "night-out-no");
  await press(finish, "finish-details-continue");

  await declareAndFinish(finish);
  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalledWith("/today"); });
  await refocus();

  await waitFor(() => { expect(text(homeView, "recent-timesheet-0-date")).toBe("Sat 19 Sep 2026"); });
  expect(await readOpenShift()).toBeNull();
});

test("a FAILED Finish shows no timesheet anywhere", async () => {
  const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: day(19, 5), vehicle: null });
  jest.spyOn(File.prototype, "write").mockImplementation(() => { throw new Error("disk full"); });
  await expect(finishDeclared({ shiftId: shift.id, vehicleUseId: null, trailerUseId: null, finalMileage: null, endedAt: day(19, 17), nightOut: false, notes: "" }))
    .rejects.toThrow(Error);
  jest.restoreAllMocks();

  const homeView = await home();
  const list = await timesheets();

  expect(homeView.getByTestId("recent-timesheets-empty")).toBeTruthy();
  expect(list.getByTestId("timesheets-empty")).toBeTruthy();
});

// ── Draft checks: what was entered, never certified (owner correction) ─────

test("a DRAFT vehicle check and a DRAFT trailer check show only the rows the driver changed — as draft, never as a certificate", async () => {
  const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: day(19, 5), vehicle: UNIT });
  const unitItems = checklistItems(checklistFor("class1"));
  const [tyreRow, secondRow] = unitItems;
  if (tyreRow === undefined || secondRow === undefined) throw new Error("expected checklist rows");
  // One defect and one row set to N/A (or OK, whichever is NOT its default); every other row untouched.
  const secondOverride = secondRow.defaultResult === CHECK_RESULT.notApplicable ? CHECK_RESULT.ok : CHECK_RESULT.notApplicable;
  await saveVehicleCheckDraft({
    shiftId: shift.id, vehicleUseId: vehicleUseAt(day(19, 5).toISOString()), usageState: USAGE_STATE.inUse, checkId: "vd", startedAt: day(19, 5, 5),
    answers: [{ key: tyreRow.key, result: CHECK_RESULT.defect, note: "Cut in sidewall" }, { key: secondRow.key, result: secondOverride, note: "" }],
  });
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: { trailerNumber: "TR23", trailerType: TRAILER_TYPE.standard }, startedAt: day(19, 6) });
  const [trailerRow] = checklistItems(trailerChecklistFor(TRAILER_TYPE.standard));
  if (trailerRow === undefined) throw new Error("expected a trailer row");
  await saveTrailerCheckDraft({
    shiftId: shift.id, trailerUseId: trailerUseAt(day(19, 6).toISOString()), usageState: USAGE_STATE.inUse, checkId: "td", startedAt: day(19, 6, 5),
    answers: [{ key: trailerRow.key, result: CHECK_RESULT.defect, note: "Landing leg bent" }],
  });
  const done = await finishDeclared({ shiftId: shift.id, vehicleUseId: vehicleUseAt(day(19, 5).toISOString()), trailerUseId: trailerUseAt(day(19, 6).toISOString()), finalMileage: 100_050, endedAt: day(19, 12), nightOut: false, notes: "" });

  const view = await detail(done?.id ?? "");

  expect(text(view, "timesheet-vehicle-0-checks")).toBe("Check not completed · started");
  expect(text(view, "timesheet-vehicle-0-draft-0")).toBe(`Draft defect: ${tyreRow.label} — Cut in sidewall`);
  expect(text(view, "timesheet-vehicle-0-draft-1")).toBe(`Draft: ${secondRow.label} — ${secondOverride === CHECK_RESULT.ok ? "OK" : "N/A"}`);
  // Only what was changed: the untouched rows are not results, and are not shown.
  expect(view.queryByTestId("timesheet-vehicle-0-draft-2")).toBeNull();
  expect(unitItems.length).toBeGreaterThan(2);
  expect(text(view, "timesheet-trailer-0-checks")).toBe("Check not completed · started");
  expect(text(view, "timesheet-trailer-0-draft-0")).toBe(`Draft defect: ${trailerRow.label} — Landing leg bent`);
  expect(view.queryByTestId("timesheet-trailer-0-draft-1")).toBeNull();
  // Never a certificate: no "completed", no "No defects", no certified defect rows.
  for (const prefix of ["timesheet-vehicle-0", "timesheet-trailer-0"]) {
    expect(view.queryByTestId(`${prefix}-no-defects`)).toBeNull();
    expect(view.queryByTestId(`${prefix}-defect-0`)).toBeNull();
  }
  expect(view.queryByText(/Checks completed/)).toBeNull();
});

test("a check never started shows no draft rows at all", async () => {
  const shift = await startLocalShift({ workingFor: PERSONAL, startedAt: day(19, 5), vehicle: UNIT });
  const done = await finishDeclared({ shiftId: shift.id, vehicleUseId: vehicleUseAt(day(19, 5).toISOString()), trailerUseId: null, finalMileage: 100_050, endedAt: day(19, 12), nightOut: false, notes: "" });

  const view = await detail(done?.id ?? "");

  expect(text(view, "timesheet-vehicle-0-checks")).toBe("Check not completed");
  expect(view.queryByTestId("timesheet-vehicle-0-draft")).toBeNull();
});
