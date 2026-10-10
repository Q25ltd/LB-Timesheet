/**
 * Finish Shift — the screens and the route (2026-09-28).
 *
 *   FLOW     with a vehicle in use: Final Mileage → Finish Details → Review →
 *            Finish Shift; with none: Finish Details → Review → Finish Shift.
 *            Back walks the steps and keeps what was entered.
 *   NOTHING WRITTEN until the final press — not by opening, typing, going
 *            back or reviewing.
 *   ROUTE    the exact day, once; a stale flow or a failed save is reported
 *            truthfully, never as a finish.
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { File } from "expo-file-system";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Alert, Pressable, Text } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AuthenticatedAccount } from "../api/account";
import FinishShiftRoute from "../../app/(app)/finish-shift";
import ActiveShiftRoute from "../../app/(app)/active-shift";
import { FinishShiftScreen } from "../screens/FinishShiftScreen";
import { SAFE_SAVE_FAILED } from "../screens/format";
import { checklistFor, checklistItems, trailerChecklistFor } from "../shift/checklists";
import {
  COMPLETED_SHIFT_FILE_PREFIX,
  OPEN_SHIFT_FILE,
  USAGE_STATE,
  addTrailerToOpenShift,
  changeTrailer,
  changeVehicle,
  clearOpenShift,
  completeTrailerCheck,
  completeVehicleCheck,
  endVehicleUse,
  readCompletedShift,
  readOpenShift,
  recordReeferDiesel,
  recordVehicleFill,
  reviseVehicleCheck,
  saveVehicleCheckDraft,
  startLocalShift,
  type LocalShift,
  type ShiftFinish,
  type VehicleDetails,
} from "../shift/localShift";
import { TRAILER_TYPE } from "../shift/trailer";
import { CHECK_RESULT } from "../shift/vehicleCheck";
import { FILL_TYPE } from "../shift/vehicleFill";
import { trailerUseAt, vehicleUseAt } from "./useIdAt";
import { accountDirectoryOf, scopeFor } from "./testScope";

/** The signed-in driver's records — F-31: every store call names its account. */
const SCOPE = scopeFor("user_finish_1");
// Screens act for this test's driver. The real hook's sign-in / sign-out
// behaviour is proven in accountSwitchRoute.test.tsx.
jest.mock("../shift/useAccountScope", () => ({ useAccountScope: () => mockScope }));
const mockScope = SCOPE;

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismissTo: jest.fn() };

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
    useLocalSearchParams: () => ({}),
  };
});

const METRICS = { frame: { x: 0, y: 0, width: 402, height: 874 }, insets: { top: 62, left: 0, right: 0, bottom: 34 } };
const STARTED_AT = new Date(2026, 8, 19, 5, 0);
const at = (hours: number, minutes = 0) => new Date(2026, 8, 19, hours, minutes);
/** When the Finish flow was opened, in the screen tests: 17:40 on the same day. */
const OPENED_AT = at(17, 40);
/** The device's clock as the screen reads it — changeable mid-test. */
let clockNow = OPENED_AT;
const UNIT: VehicleDetails = { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 };
const OTHER: VehicleDetails = { vehicleClass: "class2", numberPlate: "XY34 ZZZ", startMileage: 220_000 };

type View = Awaited<ReturnType<typeof render>>;
const live = () => new File(accountDirectoryOf(SCOPE), OPEN_SHIFT_FILE);
const bytes = () => live().textSync();
const text = (view: View, testID: string) => {
  const children = (view.getByTestId(testID).props as { children?: unknown }).children;
  return Array.isArray(children) ? children.join("") : String(children);
};
const isDisabled = (view: View, testID: string) =>
  (view.getByTestId(testID).props as { accessibilityState?: { disabled?: boolean } }).accessibilityState?.disabled === true;
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
const dayWith = (vehicle: VehicleDetails | null = UNIT) =>
  startLocalShift(SCOPE, { workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle });
async function open(): Promise<LocalShift> {
  const day = await readOpenShift(SCOPE);
  if (day === null) throw new Error("expected an open day");
  return day;
}

/** The screen alone, opened at OPENED_AT, with its confirmation captured. */
async function screen(shift: LocalShift, openedAt: Date = OPENED_AT) {
  const confirmed: ShiftFinish[] = [];
  const corrections: unknown[][] = [];
  const onLeave = jest.fn();
  clockNow = openedAt;
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <FinishShiftScreen
        shift={shift} openedAt={openedAt} now={() => clockNow} onLeave={onLeave}
        onConfirm={finish => { confirmed.push(finish); return Promise.resolve(); }}
        onEditShift={() => { corrections.push(["shift"]); }}
        onOpenVehicleUse={(usage, inUse) => { corrections.push(["vehicle", usage, inUse]); }}
        onOpenTrailerUse={(usage, inUse) => { corrections.push(["trailer", usage, inUse]); }}
      />
    </SafeAreaProvider>,
  );
  return { view, confirmed, onLeave, corrections };
}

/** Night Out answered, time left as opened, through to the Review. */
async function toReview(view: View, { nightOut = "no", notes = "" }: { nightOut?: "yes" | "no"; notes?: string } = {}): Promise<void> {
  await press(view, `night-out-${nightOut}`);
  if (notes !== "") await type(view, "shift-notes", notes);
  await press(view, "finish-details-continue");
}

beforeEach(async () => {
  await clearOpenShift(SCOPE);
  for (const fn of Object.values(mockRouter)) fn.mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// The steps
// ═══════════════════════════════════════════════════════════════════════════

test("with a vehicle in use the flow starts at FINAL MILEAGE, naming the vehicle", async () => {
  const { view } = await screen(await dayWith());

  expect(text(view, "screen-title")).toBe("Finish Shift");
  expect(text(view, "finish-vehicle-plate")).toBe("AB12 CDE");
  expect(view.getByTestId("final-mileage")).toBeTruthy();
  expect(isDisabled(view, "finish-mileage-continue")).toBe(true);
});

test("a final mileage BELOW the start is explained and cannot continue; EQUAL to the start can", async () => {
  const { view } = await screen(await dayWith());

  await type(view, "final-mileage", "99999");
  expect(text(view, "final-mileage-error")).toContain("100,000 mi");
  expect(isDisabled(view, "finish-mileage-continue")).toBe(true);

  await type(view, "final-mileage", "100000");
  expect(view.queryByTestId("final-mileage-error")).toBeNull();
  expect(isDisabled(view, "finish-mileage-continue")).toBe(false);
});

test("with NO vehicle in use there is no mileage step — never asked, never invented", async () => {
  await dayWith();
  const shift = await open();
  await endVehicleUse(SCOPE, { shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_100, endedAt: at(12) });

  const { view } = await screen(await open());

  expect(view.queryByTestId("final-mileage")).toBeNull();
  expect(view.getByTestId("night-out-yes")).toBeTruthy();
});

test("Finish Details: the time is set to when the flow opened, and Night Out must be answered — Yes or No, never assumed", async () => {
  const { view } = await screen(await dayWith(null));

  expect(view.getByTestId("finish-time-hours").props.value).toBe("17");
  expect(view.getByTestId("finish-time-minutes").props.value).toBe("40");
  expect(isDisabled(view, "finish-details-continue")).toBe(true);

  await press(view, "night-out-no");
  expect(isDisabled(view, "finish-details-continue")).toBe(false);
});

test.each([
  ["the shift started", null, "04", "59", "Sat 19 Sep 2026, 05:00"],
  ["AB12 CDE was handed back", "handed-back", "11", "59", "Sat 19 Sep 2026, 12:00"],
])("a finish before %s is explained, and cannot continue — the time is not changed for the driver", async (reason, setup, hours, minutes, earliest) => {
  await dayWith(setup === null ? null : UNIT);
  if (setup === "handed-back") {
    await endVehicleUse(SCOPE, { shiftId: (await open()).id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_100, endedAt: at(12) });
  }
  const { view } = await screen(await open());
  await press(view, "night-out-no");

  await type(view, "finish-time-hours", hours);
  await type(view, "finish-time-minutes", minutes);

  expect(text(view, "finish-time-error")).toBe(`Can't be before ${earliest} — when ${reason}.`);
  expect(isDisabled(view, "finish-details-continue")).toBe(true);
  expect(view.getByTestId("finish-time-hours").props.value).toBe(hours);
});

test("a finish before the CURRENT trailer started names the trailer", async () => {
  const shift = await dayWith();
  await addTrailerToOpenShift(SCOPE, { shiftId: shift.id, trailer: { trailerNumber: "TR23", trailerType: TRAILER_TYPE.standard }, startedAt: at(10) });
  const { view } = await screen(await open());
  await type(view, "final-mileage", "100100");
  await press(view, "finish-mileage-continue");
  await press(view, "night-out-yes");

  await type(view, "finish-time-hours", "09");

  expect(text(view, "finish-time-error")).toBe("Can't be before Sat 19 Sep 2026, 10:00 — when trailer TR23 started.");
});

test("Back walks the steps and KEEPS what was entered; Back from the first step leaves without finishing", async () => {
  const { view, onLeave } = await screen(await dayWith());
  await type(view, "final-mileage", "100250");
  await press(view, "finish-mileage-continue");
  await press(view, "night-out-yes");
  await type(view, "shift-notes", "Waited at Tilbury");
  await press(view, "finish-details-continue");

  await press(view, "finish-back");
  expect(view.getByTestId("shift-notes").props.value).toBe("Waited at Tilbury");
  expect(view.getByTestId("night-out-yes").props.accessibilityState).toMatchObject({ selected: true });
  await press(view, "finish-back");
  expect(view.getByTestId("final-mileage").props.value).toBe("100250");
  await press(view, "finish-back");

  expect(onLeave).toHaveBeenCalledTimes(1);
});

test("the Finish Shift press sends exactly what was entered", async () => {
  const { view, confirmed } = await screen(await dayWith());
  await type(view, "final-mileage", "100250");
  await press(view, "finish-mileage-continue");
  await type(view, "finish-time-hours", "17");
  await type(view, "finish-time-minutes", "05");
  await toReview(view, { nightOut: "yes", notes: "Waited at Tilbury" });

  await declareAndFinish(view);

  expect(confirmed).toEqual([{ finalMileage: 100_250, endedAt: at(17, 5), nightOut: true, notes: "Waited at Tilbury" }]);
});

test("a DOUBLE tap on Finish Shift confirms once", async () => {
  const { view, confirmed } = await screen(await dayWith(null));
  await toReview(view);

  await press(view, "finish-confirm-declaration");
  await act(async () => {
    void fireEvent.press(view.getByTestId("finish-confirm"));
    void fireEvent.press(view.getByTestId("finish-confirm"));
    await Promise.resolve();
  });

  expect(confirmed).toHaveLength(1);
});

// ═══════════════════════════════════════════════════════════════════════════
// The Review: what was recorded, nothing invented
// ═══════════════════════════════════════════════════════════════════════════

async function busyDay(): Promise<LocalShift> {
  const shift = await startLocalShift(SCOPE, {
    workingFor: { kind: "company", membershipId: "m1", companyId: "c1", companyName: "Northgate Haulage" },
    startedAt: STARTED_AT, vehicle: UNIT,
  });
  const first = { shiftId: shift.id, vehicleUseId: vehicleUseAt(STARTED_AT.toISOString()), usageState: USAGE_STATE.inUse };
  const items = checklistItems(checklistFor("class1"));
  const tyre = items[0]?.key ?? "";
  await completeVehicleCheck(SCOPE, {
    ...first, checkId: "morning", startedAt: at(5, 5), completedAt: at(5, 20), completedBy: "driver",
    answers: items.map(entry => (entry.key === tyre
      ? { key: entry.key, result: CHECK_RESULT.defect, note: "Cut in the sidewall" }
      : { key: entry.key, result: entry.defaultResult, note: "" })),
  });
  await recordVehicleFill(SCOPE, { ...first, fillId: "f1", type: FILL_TYPE.fuel, recordedAt: at(7), litres: 300, note: "" });
  await changeVehicle(SCOPE, { shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_120, next: OTHER, changedAt: at(9) });
  await recordVehicleFill(SCOPE, { shiftId: shift.id, vehicleUseId: vehicleUseAt(at(9).toISOString()), usageState: USAGE_STATE.inUse, fillId: "f2", type: FILL_TYPE.adblue, recordedAt: at(10), litres: null, note: "" });
  await saveVehicleCheckDraft(SCOPE, { shiftId: shift.id, vehicleUseId: vehicleUseAt(at(9).toISOString()), usageState: USAGE_STATE.inUse, checkId: "c2", startedAt: at(9, 5), answers: [{ key: "horn", result: CHECK_RESULT.notApplicable, note: "" }] });
  await addTrailerToOpenShift(SCOPE, { shiftId: shift.id, trailer: { trailerNumber: "RF77", trailerType: TRAILER_TYPE.refrigerated }, startedAt: at(9, 30) });
  await recordReeferDiesel(SCOPE, { shiftId: shift.id, trailerUseId: trailerUseAt(at(9, 30).toISOString()), usageState: USAGE_STATE.inUse, fillId: "rd", recordedAt: at(11), litres: 40, note: "" });
  return open();
}

test("the Review shows the day as it will be saved — the current vehicle and trailer ending at the finish", async () => {
  const { view } = await screen(await busyDay());
  await type(view, "final-mileage", "220180");
  await press(view, "finish-mileage-continue");
  await type(view, "finish-time-hours", "17");
  await type(view, "finish-time-minutes", "00");
  await toReview(view, { nightOut: "yes", notes: "Waited at Tilbury" });

  expect(text(view, "review-working-for")).toBe("Northgate Haulage");
  expect(text(view, "review-started")).toBe("Sat 19 Sep 2026, 05:00");
  expect(text(view, "review-finished")).toBe("Sat 19 Sep 2026, 17:00");
  expect(text(view, "review-duration")).toBe("12 h");
  expect(text(view, "review-night-out")).toBe("Yes");
  expect(text(view, "review-notes")).toBe("Waited at Tilbury");

  expect(text(view, "review-vehicle-0-title")).toBe("AB12 CDE · Articulated truck");
  expect(text(view, "review-vehicle-0-mileage")).toBe("100,000 → 100,120 · 120 mi");
  expect(text(view, "review-vehicle-0-fuel")).toContain("300 L");
  expect(text(view, "review-vehicle-0-checks")).toBe("Completed");
  expect(text(view, "review-vehicle-0-defect-0")).toContain("Cut in the sidewall");

  expect(text(view, "review-vehicle-1-title")).toBe("XY34 ZZZ · Rigid truck");
  expect(text(view, "review-vehicle-1-times")).toBe("09:00 – 17:00");
  expect(text(view, "review-vehicle-1-mileage")).toBe("220,000 → 220,180 · 180 mi");
  expect(text(view, "review-vehicle-1-adblue")).toBe("AdBlue / DEF: 1 fill · Amount unknown");
  expect(text(view, "review-vehicle-1-checks")).toBe("In progress");

  expect(text(view, "review-trailer-0-title")).toBe("RF77 · Refrigerated");
  expect(text(view, "review-trailer-0-times")).toBe("09:30 – 17:00");
  expect(text(view, "review-trailer-0-fridge-diesel")).toContain("40 L");
  expect(text(view, "review-trailer-0-checks")).toBe("Not completed");

  // Not completed does not block; it is said, once, plainly.
  expect(text(view, "review-check-warning")).toBe("Checks not completed: XY34 ZZZ, trailer RF77. You can still finish.");
  await press(view, "finish-confirm-declaration");
  expect(isDisabled(view, "finish-confirm")).toBe(false);
});

test("the Review claims nothing that was not recorded: no notes line, no fuel, no trailers section, no warning when every check is done", async () => {
  await dayWith(null);
  const { view } = await screen(await open());

  await toReview(view);

  expect(view.queryByTestId("review-notes")).toBeNull();
  expect(view.queryByTestId("review-vehicle-0-title")).toBeNull();
  expect(view.queryByTestId("review-trailer-0-title")).toBeNull();
  expect(view.queryByTestId("review-check-warning")).toBeNull();
  expect(text(view, "review-night-out")).toBe("No");
  expect(text(view, "review-no-vehicles")).toBe("No vehicle used");
});

test("a Review of an overnight shift says the finish is the next day", async () => {
  const shift = await startLocalShift(SCOPE, { workingFor: { kind: "personal" }, startedAt: new Date(2026, 8, 18, 22, 0), vehicle: null });
  const { view } = await screen(shift);

  await toReview(view);

  expect(text(view, "review-finished")).toBe("Sat 19 Sep 2026, 17:40 (next day)");
  expect(text(view, "review-duration")).toBe("19 h 40 min");
});

// ═══════════════════════════════════════════════════════════════════════════
// Finish DATE and time, and never later than now (owner corrections)
// ═══════════════════════════════════════════════════════════════════════════

test("the finish DATE starts on the day the flow opened, said as Today, beside the time", async () => {
  const { view } = await screen(await dayWith(null));

  expect(text(view, "finish-date")).toBe("Sat 19 Sep 2026");
  expect(text(view, "finish-date-relative")).toBe("Today");
  expect(view.getByTestId("finish-time-hours").props.value).toBe("17");
});

test("a finish after midnight: opened at 00:10, stepped back a day and set to 23:50 — the Review shows the day it was given", async () => {
  const shift = await startLocalShift(SCOPE, { workingFor: { kind: "personal" }, startedAt: at(15), vehicle: null });
  const { view, confirmed } = await screen(shift, new Date(2026, 8, 20, 0, 10));

  await press(view, "finish-date-previous");
  expect(text(view, "finish-date")).toBe("Sat 19 Sep 2026");
  expect(text(view, "finish-date-relative")).toBe("Yesterday");
  await type(view, "finish-time-hours", "23");
  await type(view, "finish-time-minutes", "50");
  await toReview(view);

  expect(text(view, "review-finished")).toBe("Sat 19 Sep 2026, 23:50");
  expect(text(view, "review-duration")).toBe("8 h 50 min");
  await declareAndFinish(view);
  expect(confirmed[0]?.endedAt).toEqual(at(23, 50));
});

test("a shift that crossed midnight finishes today, and the Review says 'next day' so a wrong date stands out", async () => {
  const shift = await startLocalShift(SCOPE, { workingFor: { kind: "personal" }, startedAt: at(22), vehicle: null });
  const { view } = await screen(shift, new Date(2026, 8, 20, 6, 30));

  await type(view, "finish-time-hours", "06");
  await type(view, "finish-time-minutes", "00");
  await toReview(view);

  expect(text(view, "review-started")).toBe("Sat 19 Sep 2026, 22:00");
  expect(text(view, "review-finished")).toBe("Sun 20 Sep 2026, 06:00 (next day)");
  expect(text(view, "review-duration")).toBe("8 h");
});

test("a MULTI-DAY shift: the Review counts the days", async () => {
  const shift = await startLocalShift(SCOPE, { workingFor: { kind: "personal" }, startedAt: new Date(2026, 8, 17, 6, 0), vehicle: null });
  const { view } = await screen(shift);

  await toReview(view);

  expect(text(view, "review-finished")).toBe("Sat 19 Sep 2026, 17:40 (2 days later)");
});

// ── A declared finish ahead of now: confirmed past +15 minutes, never refused (D40)

type AheadButtons = { text?: string; style?: string; onPress?: () => void }[];
const aheadCalls = (alert: jest.SpyInstance) =>
  alert.mock.calls.filter(([title]) => title === "Finish time is ahead") as [string, string, AheadButtons][];

/** Through to the Review with the finish typed as given, then the clock set, then Finish Shift pressed. */
async function pressFinishAt(finish: { hours: string; minutes: string; nextDay?: boolean }, clock: Date) {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const { view, confirmed } = await screen(await dayWith(null));
  if (finish.nextDay === true) await press(view, "finish-date-next");
  await type(view, "finish-time-hours", finish.hours);
  await type(view, "finish-time-minutes", finish.minutes);
  await toReview(view);
  clockNow = clock;
  await declareAndFinish(view);
  return { view, confirmed, alert };
}

test.each([
  ["exactly now", "17", "40", at(17, 40)],
  ["one minute ahead", "17", "41", at(17, 40)],
  ["EXACTLY 15 minutes ahead", "17", "55", at(17, 40)],
])("a finish %s is confirmed with NO question", async (_what, hours, minutes, clock) => {
  const { confirmed, alert } = await pressFinishAt({ hours, minutes }, clock);

  expect(aheadCalls(alert)).toEqual([]);
  expect(confirmed).toHaveLength(1);
});

test.each([
  ["15 minutes and a millisecond ahead", "18", "00", new Date(at(17, 45).getTime() - 1)],
  ["16 minutes ahead", "17", "56", at(17, 40)],
  ["an hour ahead", "18", "40", at(17, 40)],
])("a finish %s ASKS first — and nothing is finished until the driver answers", async (_what, hours, minutes, clock) => {
  const { confirmed, alert } = await pressFinishAt({ hours, minutes }, clock);

  expect(aheadCalls(alert)).toHaveLength(1);
  expect(aheadCalls(alert)[0]?.[2].map(button => button.text)).toEqual(["Go Back", "Use This Time"]);
  expect(confirmed).toEqual([]);
});

test("the question says the time and how far ahead — friendly, never 'not allowed'", async () => {
  const { alert } = await pressFinishAt({ hours: "18", minutes: "58" }, at(17, 40));

  const [[title, message]] = aheadCalls(alert) as [[string, string, AheadButtons]];
  expect(title).toBe("Finish time is ahead");
  expect(message).toBe("You entered 18:58, which is 1 h 18 min from now. Is this the finish time you want to record?");
  expect(message).not.toMatch(/illegal|not allowed|invalid|violation/i);
});

test("a finish on a FUTURE DATE asks too — with its date — and Use This Time finishes with exactly that date and time", async () => {
  const { confirmed, alert } = await pressFinishAt({ hours: "06", minutes: "00", nextDay: true }, at(17, 40));

  const [[, message, buttons]] = aheadCalls(alert) as [[string, string, AheadButtons]];
  expect(message).toBe("You entered Sun 20 Sep 2026, 06:00, which is 12 h 20 min from now. Is this the finish time you want to record?");
  await act(async () => { buttons.find(button => button.text === "Use This Time")?.onPress?.(); await Promise.resolve(); });

  expect(confirmed).toHaveLength(1);
  expect(confirmed[0]?.endedAt).toEqual(new Date(2026, 8, 20, 6, 0));
});

test("GO BACK finishes nothing and keeps what was entered — the driver can correct it, or press again", async () => {
  const { view, confirmed, alert } = await pressFinishAt({ hours: "18", minutes: "40" }, at(17, 40));
  const [[, , buttons]] = aheadCalls(alert) as [[string, string, AheadButtons]];

  await act(async () => { buttons.find(button => button.text === "Go Back")?.onPress?.(); await Promise.resolve(); });

  expect(confirmed).toEqual([]);
  await press(view, "finish-back");
  expect(view.getByTestId("finish-time-hours").props.value).toBe("18");
  expect(view.getByTestId("finish-time-minutes").props.value).toBe("40");
  await press(view, "finish-details-continue");
  await declareAndFinish(view);
  expect(aheadCalls(alert)).toHaveLength(2);
});

test("USE THIS TIME finishes with the EXACT time declared — never pulled back to now, never rounded", async () => {
  const { confirmed, alert } = await pressFinishAt({ hours: "18", minutes: "40" }, at(17, 40));
  const [[, , buttons]] = aheadCalls(alert) as [[string, string, AheadButtons]];

  await act(async () => { buttons.find(button => button.text === "Use This Time")?.onPress?.(); await Promise.resolve(); });

  expect(confirmed.map(finish => finish.endedAt)).toEqual([at(18, 40)]);
});

test("the question is decided by the clock AT THE PRESS, not when the flow opened", async () => {
  // Opened at 17:40; 17:56 is 16 minutes ahead of THAT. By the press it is 17:44, and 17:56 is 12 ahead.
  const { confirmed, alert } = await pressFinishAt({ hours: "17", minutes: "56" }, at(17, 44));

  expect(aheadCalls(alert)).toEqual([]);
  expect(confirmed).toHaveLength(1);
});

test("a DOUBLE press asks once; a doubled Use This Time finishes once", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const { view, confirmed } = await screen(await dayWith(null));
  await type(view, "finish-time-hours", "19");
  await toReview(view);

  await press(view, "finish-confirm-declaration");
  await act(async () => {
    void fireEvent.press(view.getByTestId("finish-confirm"));
    void fireEvent.press(view.getByTestId("finish-confirm"));
    await Promise.resolve();
  });
  const calls = aheadCalls(alert);
  expect(calls).toHaveLength(1);
  const use = calls[0]?.[2].find(button => button.text === "Use This Time");
  await act(async () => { use?.onPress?.(); use?.onPress?.(); await Promise.resolve(); });

  expect(confirmed).toHaveLength(1);
});

test("a future finish still cannot be before the shift started", async () => {
  const shift = await startLocalShift(SCOPE, { workingFor: { kind: "personal" }, startedAt: at(20), vehicle: null });
  const { view } = await screen(shift);
  await press(view, "night-out-no");

  await type(view, "finish-time-hours", "19");

  expect(text(view, "finish-time-error")).toBe("Can't be before Sat 19 Sep 2026, 20:00 — when the shift started.");
  expect(isDisabled(view, "finish-details-continue")).toBe(true);
});

test("Back keeps the finish DATE and time as entered", async () => {
  const shift = await startLocalShift(SCOPE, { workingFor: { kind: "personal" }, startedAt: at(15), vehicle: null });
  const { view } = await screen(shift, new Date(2026, 8, 20, 0, 10));
  await press(view, "finish-date-previous");
  await type(view, "finish-time-hours", "23");
  await type(view, "finish-time-minutes", "50");
  await toReview(view);

  await press(view, "finish-back");

  expect(text(view, "finish-date")).toBe("Sat 19 Sep 2026");
  expect(view.getByTestId("finish-time-hours").props.value).toBe("23");
  expect(view.getByTestId("finish-time-minutes").props.value).toBe("50");
});

// ═══════════════════════════════════════════════════════════════════════════
// The route: nothing written until the press, then exactly once
// ═══════════════════════════════════════════════════════════════════════════

const DRIVER: AuthenticatedAccount = {
  user: { id: "user_finish_1", firstName: "Nerijus", lastName: "Kuizinas", email: "driver@example.com" },
  identityToken: "identity.token.value",
  refreshToken: "refresh-secret-value",
  memberships: [],
};
/** The route as the gate renders it: only for a signed-in driver, who declares what they finish (D42). */
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
async function route(): Promise<View> {
  const view = await render(<SafeAreaProvider initialMetrics={METRICS}><AuthProvider><SignedIn><FinishShiftRoute /></SignedIn></AuthProvider></SafeAreaProvider>);
  await waitFor(() => { expect(String(view.getByTestId("status").props.children)).toBe("unauthenticated"); });
  await press(view, "authenticate");
  await waitFor(() => { expect(view.queryByTestId("screen-title") ?? view.queryByTestId("redirect")).not.toBeNull(); });
  return view;
}
async function throughToReview(view: View): Promise<void> {
  if (view.queryByTestId("final-mileage") !== null) {
    await type(view, "final-mileage", "100150");
    await press(view, "finish-mileage-continue");
  }
  await toReview(view, { nightOut: "yes" });
}

test("with no open day the route goes Home", async () => {
  const view = await route();

  expect(text(view, "redirect")).toBe("/today");
});

test("opening, typing, going back and REVIEWING write nothing", async () => {
  await dayWith();
  const before = bytes();
  const view = await route();

  await throughToReview(view);
  expect(bytes()).toBe(before);
  await press(view, "finish-back");
  await press(view, "finish-back");
  await press(view, "finish-back");

  expect(bytes()).toBe(before);
  expect(mockRouter.back).toHaveBeenCalledTimes(1);
  expect((await readOpenShift(SCOPE))?.vehicle?.numberPlate).toBe("AB12 CDE");
});

test("changing the finish date and time writes nothing", async () => {
  await dayWith(null);
  const before = bytes();
  const view = await route();

  await press(view, "finish-date-previous");
  await press(view, "finish-date-next");
  await press(view, "finish-date-next");
  await type(view, "finish-time-hours", "03");
  await type(view, "finish-time-minutes", "15");

  expect(bytes()).toBe(before);
});

test("Finish Shift files the day, leaves no open shift, tells the driver nothing was sent, and goes Home", async () => {
  const shift = await dayWith();
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await route();
  await throughToReview(view);

  await declareAndFinish(view);

  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalledWith("/today"); });
  expect(await readOpenShift(SCOPE)).toBeNull();
  const done = await readCompletedShift(SCOPE, shift.id);
  expect(done).toMatchObject({ status: "completed", nightOut: true, previousVehicles: [{ endMileage: 100_150 }] });
  expect(alert).toHaveBeenCalledWith("Shift finished", "Your timesheet is saved on this phone. Nothing has been sent.");
});

test("a STALE flow — the vehicle changed behind it — finishes nothing, says so, and returns to the day", async () => {
  const shift = await dayWith();
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await route();
  await throughToReview(view);
  await changeVehicle(SCOPE, { shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_100, next: OTHER, changedAt: at(9) });
  const before = bytes();

  await declareAndFinish(view);

  await waitFor(() => { expect(alert).toHaveBeenCalledWith("Nothing was saved", "This shift changed after Finish Shift was opened. Check it, then finish again."); });
  expect(bytes()).toBe(before);
  expect(await readCompletedShift(SCOPE, shift.id)).toBeNull();
  expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift");
  expect(mockRouter.dismissTo).not.toHaveBeenCalledWith("/today");
});

test("a FAILED save is never reported as a finish: the safe-save message, the day still open, no navigation", async () => {
  const shift = await dayWith();
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await route();
  await throughToReview(view);
  jest.spyOn(File.prototype, "write").mockImplementation(() => { throw new Error("disk full"); });

  await declareAndFinish(view);

  await waitFor(() => { expect(alert).toHaveBeenCalledWith("Couldn't finish the shift", SAFE_SAVE_FAILED); });
  expect(alert).not.toHaveBeenCalledWith("Shift finished", expect.anything());
  expect(mockRouter.replace).not.toHaveBeenCalled();
  expect((await readOpenShift(SCOPE))?.id).toBe(shift.id);
  expect(await readCompletedShift(SCOPE, shift.id)).toBeNull();
  // The button is usable again: the driver can simply try again.
  expect(isDisabled(view, "finish-confirm")).toBe(false);
});

test("the completed record is filed under the day's own id, and nothing else is written beside it", async () => {
  const shift = await dayWith(null);
  jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await route();
  await throughToReview(view);

  await declareAndFinish(view);

  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalledWith("/today"); });
  expect(new File(accountDirectoryOf(SCOPE), `${COMPLETED_SHIFT_FILE_PREFIX}${shift.id}.json`).exists).toBe(true);
  expect(live().exists).toBe(false);
});

// ═══════════════════════════════════════════════════════════════════════════
// Active Shift: Finish Shift is live
// ═══════════════════════════════════════════════════════════════════════════

test("Active Shift's Finish Shift is enabled and opens the Finish flow — and pressing it writes nothing", async () => {
  await dayWith(null);
  const before = bytes();
  const view = await render(<SafeAreaProvider initialMetrics={METRICS}><ActiveShiftRoute /></SafeAreaProvider>);
  await waitFor(() => { expect(view.queryByTestId("finish-shift")).not.toBeNull(); });

  expect(isDisabled(view, "finish-shift")).toBe(false);
  await press(view, "finish-shift");

  expect(mockRouter.push).toHaveBeenCalledWith("/finish-shift");
  expect(bytes()).toBe(before);
});

// ═══════════════════════════════════════════════════════════════════════════
// Checks not completed: said BEFORE the Finish flow opens (owner correction)
// ═══════════════════════════════════════════════════════════════════════════

const TR23 = { trailerNumber: "TR23", trailerType: TRAILER_TYPE.standard };
type AlertButtons = { text?: string; style?: string; onPress?: () => void }[];

/** Complete the walkaround on a vehicle use, every row at its default. */
async function checkVehicle(startedAt: Date, vehicleClass: VehicleDetails["vehicleClass"] = "class1", usageState: "in-use" | "ended" = USAGE_STATE.inUse): Promise<void> {
  const shift = await open();
  await completeVehicleCheck(SCOPE, {
    shiftId: shift.id, vehicleUseId: vehicleUseAt(startedAt.toISOString()), usageState, checkId: `vc-${startedAt.toISOString()}`,
    startedAt, completedAt: startedAt, completedBy: "driver",
    answers: checklistItems(checklistFor(vehicleClass)).map(entry => ({ key: entry.key, result: entry.defaultResult, note: "" })),
  });
}
async function checkTrailer(startedAt: Date, usageState: "in-use" | "ended" = USAGE_STATE.inUse): Promise<void> {
  const shift = await open();
  await completeTrailerCheck(SCOPE, {
    shiftId: shift.id, trailerUseId: trailerUseAt(startedAt.toISOString()), usageState, checkId: `tc-${startedAt.toISOString()}`,
    startedAt, completedAt: startedAt, completedBy: "driver",
    answers: checklistItems(trailerChecklistFor(TRAILER_TYPE.standard)).map(entry => ({ key: entry.key, result: entry.defaultResult, note: "" })),
  });
}

/** Press Active Shift's Finish Shift; the warning raised, if any. */
async function pressFinish(): Promise<{ view: View; alert: jest.SpyInstance; warning: { title: string; message: string; buttons: AlertButtons } | null }> {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await render(<SafeAreaProvider initialMetrics={METRICS}><ActiveShiftRoute /></SafeAreaProvider>);
  await waitFor(() => { expect(view.queryByTestId("finish-shift")).not.toBeNull(); });
  await press(view, "finish-shift");
  const call = alert.mock.calls[0] as [string, string, AlertButtons] | undefined;
  return { view, alert, warning: call === undefined ? null : { title: call[0], message: call[1], buttons: call[2] } };
}

test("every use CHECKED: Finish opens straight away, with no warning", async () => {
  const shift = await dayWith();
  await checkVehicle(STARTED_AT);
  await addTrailerToOpenShift(SCOPE, { shiftId: shift.id, trailer: TR23, startedAt: at(6) });
  await checkTrailer(at(6));

  const { warning } = await pressFinish();

  expect(warning).toBeNull();
  expect(mockRouter.push).toHaveBeenCalledWith("/finish-shift");
});

test("a day that never used a vehicle or trailer has nothing to warn about", async () => {
  await dayWith(null);

  const { warning } = await pressFinish();

  expect(warning).toBeNull();
  expect(mockRouter.push).toHaveBeenCalledWith("/finish-shift");
});

test("the CURRENT VEHICLE unchecked: warned before Finish opens, with Go Back and Continue to Finish", async () => {
  await dayWith();

  const { warning } = await pressFinish();

  expect(warning?.title).toBe("Checks not completed");
  expect(warning?.message).toBe("1 check was not completed during this shift: AB12 CDE. You can still finish — nothing will be marked as completed.");
  expect(warning?.buttons.map(button => button.text)).toEqual(["Go Back", "Continue to Finish"]);
  expect(mockRouter.push).not.toHaveBeenCalled();
});

test("the CURRENT TRAILER unchecked is warned about, though the vehicle is checked", async () => {
  const shift = await dayWith();
  await checkVehicle(STARTED_AT);
  await addTrailerToOpenShift(SCOPE, { shiftId: shift.id, trailer: TR23, startedAt: at(6) });

  const { warning } = await pressFinish();

  expect(warning?.message).toContain("1 check was not completed during this shift: trailer TR23.");
});

test("an EARLIER vehicle unchecked is warned about — even with No vehicle now", async () => {
  const shift = await dayWith();
  await endVehicleUse(SCOPE, { shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_100, endedAt: at(12) });

  const { warning } = await pressFinish();

  expect(warning?.message).toContain("1 check was not completed during this shift: AB12 CDE.");
});

test("an EARLIER trailer unchecked is warned about", async () => {
  const shift = await dayWith();
  await checkVehicle(STARTED_AT);
  await addTrailerToOpenShift(SCOPE, { shiftId: shift.id, trailer: TR23, startedAt: at(6) });
  await changeTrailer(SCOPE, { shiftId: shift.id, endingUseId: trailerUseAt(at(6).toISOString()), next: null, changedAt: at(8) });

  const { warning } = await pressFinish();

  expect(warning?.message).toContain("1 check was not completed during this shift: trailer TR23.");
});

test("SEVERAL unchecked uses are counted and named; the same plate twice is told apart by its start", async () => {
  const shift = await dayWith();
  await changeVehicle(SCOPE, { shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_100, next: OTHER, changedAt: at(9) });
  await checkVehicle(at(9), "class2");
  await changeVehicle(SCOPE, { shiftId: shift.id, endingUseId: vehicleUseAt(at(9).toISOString()), endMileage: 220_050, next: { ...UNIT, startMileage: 100_100 }, changedAt: at(11) });
  await addTrailerToOpenShift(SCOPE, { shiftId: shift.id, trailer: TR23, startedAt: at(11, 30) });

  const { warning } = await pressFinish();

  expect(warning?.message).toBe(
    "3 checks were not completed during this shift: AB12 CDE (from 05:00), AB12 CDE (from 11:00), trailer TR23. "
    + "You can still finish — nothing will be marked as completed.",
  );
});

test("a DRAFT is not a completed check — it is warned about", async () => {
  const shift = await dayWith();
  await saveVehicleCheckDraft(SCOPE, { shiftId: shift.id, vehicleUseId: vehicleUseAt(STARTED_AT.toISOString()), usageState: USAGE_STATE.inUse, checkId: "d", startedAt: at(5, 5), answers: [{ key: "horn", result: CHECK_RESULT.defect, note: "Weak" }] });

  const { warning } = await pressFinish();

  expect(warning?.message).toContain("1 check was not completed");
});

test("a CORRECTED completed check is a completed check — no warning", async () => {
  const shift = await dayWith();
  await checkVehicle(STARTED_AT);
  const items = checklistItems(checklistFor("class1"));
  await reviseVehicleCheck(SCOPE, {
    shiftId: shift.id, useId: vehicleUseAt(STARTED_AT.toISOString()), usageState: USAGE_STATE.inUse, checkId: `vc-${STARTED_AT.toISOString()}`,
    revisionId: "r1", revisedAt: at(6), revisedBy: "driver",
    answers: items.map((entry, index) => ({ key: entry.key, result: index === 0 ? CHECK_RESULT.defect : entry.defaultResult, note: index === 0 ? "Found later" : "" })),
  });

  const { warning } = await pressFinish();

  expect(warning).toBeNull();
  expect(mockRouter.push).toHaveBeenCalledWith("/finish-shift");
});

test("GO BACK writes nothing and opens nothing", async () => {
  await dayWith();
  const before = bytes();
  const { warning } = await pressFinish();

  await act(async () => { warning?.buttons.find(button => button.text === "Go Back")?.onPress?.(); await Promise.resolve(); });

  expect(mockRouter.push).not.toHaveBeenCalled();
  expect(bytes()).toBe(before);
});

test("CONTINUE TO FINISH opens the flow and writes nothing — a draft stays a draft, and the Review warns again", async () => {
  const shift = await dayWith();
  await saveVehicleCheckDraft(SCOPE, { shiftId: shift.id, vehicleUseId: vehicleUseAt(STARTED_AT.toISOString()), usageState: USAGE_STATE.inUse, checkId: "d", startedAt: at(5, 5), answers: [{ key: "horn", result: CHECK_RESULT.defect, note: "Weak" }] });
  const before = bytes();
  const { warning } = await pressFinish();

  await act(async () => { warning?.buttons.find(button => button.text === "Continue to Finish")?.onPress?.(); await Promise.resolve(); });

  expect(mockRouter.push).toHaveBeenCalledWith("/finish-shift");
  expect(bytes()).toBe(before);
  expect((await open()).vehicle?.checks[0]).toMatchObject({ status: "draft", completedAt: null });
  // The second warning, on the Review.
  const flow = await route();
  await throughToReview(flow);
  expect(text(flow, "review-check-warning")).toBe("Checks not completed: AB12 CDE. You can still finish.");
});
