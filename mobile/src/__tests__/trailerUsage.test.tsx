/**
 * Trailer Use — an ENDED trailer use opened from USED THIS SHIFT, its forgotten
 * Trailer Check and its fridge-diesel corrections (D34, D35).
 *
 * Everything here writes to ONE EXACT ENDED trailer use, named by `startedAt`:
 * never by trailer number, never to the trailer in use, never to another use
 * of the same number. These prove the targeting adversarially, that a check
 * completed after the trailer went back is dated when it was actually
 * completed, and that what cannot be edited is not offered.
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { File, Paths } from "expo-file-system";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Pressable, Text, TextInput } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AuthenticatedAccount } from "../api/account";
import ActiveShiftRoute from "../../app/(app)/active-shift";
import TrailerUsageRoute from "../../app/(app)/trailer-usage";
import TrailerCheckRoute from "../../app/(app)/trailer-check";
import TrailerDieselRoute from "../../app/(app)/trailer-diesel";
import { checklistItems, trailerChecklistFor } from "../shift/checklists";
import {
  OPEN_SHIFT_FILE,
  USAGE_STATE,
  addTrailerToOpenShift,
  changeTrailer,
  clearOpenShift,
  completeTrailerCheck,
  newLocalId,
  readOpenShift,
  recordReeferDiesel,
  removeReeferDiesel,
  saveTrailerCheckDraft,
  startLocalShift,
  type LocalShift,
  type UsageState,
  type VehicleDetails,
} from "../shift/localShift";
import { TRAILER_TYPE, type EndedTrailer, type TrailerDetails } from "../shift/trailer";
import { CHECK_RESULT, checkStateOf, type CheckAnswer } from "../shift/vehicleCheck";

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismissTo: jest.fn() };
const params: { usage?: string; trailer?: string; usageState?: string } = {};

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
// A day in the past, so "now" is unmistakably after any trailer's hours.
const STARTED_AT = new Date(2026, 8, 19, 5, 0);
const at = (hours: number, minutes = 0) => new Date(2026, 8, 19, hours, minutes);
const UNIT: VehicleDetails = { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 };
const TR23: TrailerDetails = { trailerNumber: "TR23", trailerType: TRAILER_TYPE.refrigerated };
const BOX: TrailerDetails = { trailerNumber: "GFD", trailerType: TRAILER_TYPE.standard };
const DRIVER: AuthenticatedAccount = {
  user: { id: "user_usage_1", firstName: "Nerijus", lastName: "Kuizinas", email: "driver@example.com" },
  identityToken: "identity.token.value",
  refreshToken: "refresh-secret-value",
  memberships: [],
};

type View = Awaited<ReturnType<typeof render>>;
const bytes = () => new File(Paths.document, OPEN_SHIFT_FILE).textSync();
const text = (view: View, testID: string) => String(view.getByTestId(testID).props.children);
async function press(view: View, testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(view.getByTestId(testID)); });
}
async function type(view: View, testID: string, value: string): Promise<void> {
  await act(async () => { await fireEvent.changeText(view.getByTestId(testID), value); });
}

beforeEach(async () => {
  await clearOpenShift();
  for (const key of ["usage", "trailer", "usageState"] as const) delete params[key];
  for (const fn of Object.values(mockRouter)) fn.mockClear();
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.mocked(TextInput.prototype.isFocused).mockReset();
});

/**
 * TR23 (fridge) 05:30–10:05 → GFD (standard) 10:05–10:13 → TR23 (fridge)
 * 10:13–11:00 → JGG (standard) in use. Two ended uses of TR23, told apart
 * only by when they ran.
 */
async function trailerDay(): Promise<{ shift: LocalShift; first: string; box: string; second: string; current: string }> {
  const shift = await startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle: UNIT });
  await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(5, 30) });
  const change = (from: Date, next: TrailerDetails, when: Date) =>
    changeTrailer({ shiftId: shift.id, endingStartedAt: from.toISOString(), next, changedAt: when });
  await change(at(5, 30), BOX, at(10, 5));
  await change(at(10, 5), TR23, at(10, 13));
  await change(at(10, 13), { trailerNumber: "JGG", trailerType: TRAILER_TYPE.standard }, at(11));
  return {
    shift, first: at(5, 30).toISOString(), box: at(10, 5).toISOString(),
    second: at(10, 13).toISOString(), current: at(11).toISOString(),
  };
}

const ended = async (startedAt: string): Promise<EndedTrailer | undefined> =>
  (await readOpenShift())?.previousTrailers.find(use => use.startedAt === startedAt);
const answers = (): CheckAnswer[] =>
  checklistItems(trailerChecklistFor(TRAILER_TYPE.refrigerated)).map(entry => ({ key: entry.key, result: entry.defaultResult, note: "" }));

async function dieselOn(shift: LocalShift, trailerStartedAt: string, usageState: UsageState, over: { fillId?: string; litres?: number | null } = {}) {
  return recordReeferDiesel({
    shiftId: shift.id, trailerStartedAt, usageState, fillId: over.fillId ?? newLocalId(),
    recordedAt: at(10, 0), litres: over.litres === undefined ? 50 : over.litres, note: "",
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// The store: exactly one ENDED use, or nothing
// ═══════════════════════════════════════════════════════════════════════════

test("historical fridge diesel lands on EXACTLY the ended use named — the other TR23 and the trailer in use are untouched", async () => {
  const { shift, first, second } = await trailerDay();
  const before = await readOpenShift();

  await dieselOn(shift, second, USAGE_STATE.ended, { litres: 300 });

  const after = await readOpenShift();
  expect((await ended(second))?.reeferDiesel.map(fill => fill.litres)).toEqual([300]);
  expect(JSON.stringify(await ended(first))).toBe(JSON.stringify(before?.previousTrailers.find(use => use.startedAt === first)));
  expect(JSON.stringify(after?.trailer)).toBe(JSON.stringify(before?.trailer));
});

test("an ended use's diesel can be added, corrected, set UNKNOWN (null, never 0) and removed — and survives a restart", async () => {
  const { shift, first } = await trailerDay();
  const id = newLocalId();

  await dieselOn(shift, first, USAGE_STATE.ended, { fillId: id, litres: 30 });
  await dieselOn(shift, first, USAGE_STATE.ended, { fillId: id, litres: null });
  expect((await ended(first))?.reeferDiesel).toMatchObject([{ id, litres: null }]);
  expect(bytes()).toContain('"litres":null');

  await removeReeferDiesel({ shiftId: shift.id, trailerStartedAt: first, usageState: USAGE_STATE.ended, fillId: id });
  expect((await ended(first))?.reeferDiesel).toEqual([]);
});

test("a STANDARD ended use still refuses fridge diesel", async () => {
  const { shift, box } = await trailerDay();
  const before = bytes();

  expect(await dieselOn(shift, box, USAGE_STATE.ended)).toBeNull();
  expect(bytes()).toBe(before);
});

test.each([
  ["the trailer IN USE named as ended", "current", USAGE_STATE.ended],
  ["an ended use named as in use", "first", USAGE_STATE.inUse],
  ["a trailer number", "TR23", USAGE_STATE.ended],
  ["a time no use began at", "2026-09-19T03:00:00.000Z", USAGE_STATE.ended],
  ["nothing", "", USAGE_STATE.ended],
] as const)("ADVERSARIAL: %s writes nothing — no diesel, no check, anywhere", async (_why, name, state) => {
  const days = await trailerDay();
  const target = name === "current" ? days.current : name === "first" ? days.first : name;
  const before = bytes();

  const diesel = await dieselOn(days.shift, target, state);
  const check = await completeTrailerCheck({
    shiftId: days.shift.id, trailerStartedAt: target, usageState: state, checkId: newLocalId(),
    startedAt: new Date(), answers: answers(), completedAt: new Date(), completedBy: DRIVER.user.id,
  });

  expect([diesel, check]).toEqual([null, null]);
  expect(bytes()).toBe(before);
});

test("ADVERSARIAL: a day saved with two trailer uses sharing one start is refused whole — nothing is ever written to it", async () => {
  const { first } = await trailerDay();
  const doubled = JSON.parse(bytes()) as { previousTrailers: unknown[] };
  new File(Paths.document, OPEN_SHIFT_FILE).write(JSON.stringify({ ...doubled, previousTrailers: [...doubled.previousTrailers, doubled.previousTrailers[0]] }));
  const before = bytes();

  expect(await readOpenShift()).toBeNull();
  const result = await recordReeferDiesel({
    shiftId: "any", trailerStartedAt: first, usageState: USAGE_STATE.ended, fillId: newLocalId(), recordedAt: at(10), litres: 5, note: "",
  });
  expect(result).toBeNull();
  expect(bytes()).toBe(before);
});

test("a forgotten check completed on ENDED usage A completes A only — B, the other TR23, stays as it was", async () => {
  const { shift, first, second } = await trailerDay();
  const b = JSON.stringify(await ended(second));

  await completeTrailerCheck({
    shiftId: shift.id, trailerStartedAt: first, usageState: USAGE_STATE.ended, checkId: newLocalId(),
    startedAt: new Date(), answers: answers(), completedAt: new Date(), completedBy: DRIVER.user.id,
  });

  expect(checkStateOf((await ended(first))?.checks ?? [])).toBe("completed");
  expect(JSON.stringify(await ended(second))).toBe(b);
  expect((await readOpenShift())?.trailer?.checks).toEqual([]);
});

test("the CURRENT trailer's protection is unchanged: a check begun in use cannot save once the trailer has ended", async () => {
  const { shift, current } = await trailerDay();
  await changeTrailer({ shiftId: shift.id, endingStartedAt: current, next: null, changedAt: at(12) });
  const before = bytes();

  const stale = await saveTrailerCheckDraft({
    shiftId: shift.id, trailerStartedAt: current, usageState: USAGE_STATE.inUse, checkId: newLocalId(), startedAt: at(11, 5),
    answers: [{ key: "doors", result: CHECK_RESULT.defect, note: "x" }],
  });

  expect(stale).toBeNull();
  expect(bytes()).toBe(before);
});

// ═══════════════════════════════════════════════════════════════════════════
// Active Shift → Trailer Use
// ═══════════════════════════════════════════════════════════════════════════

async function mount(node: React.ReactElement): Promise<View> {
  const view = await render(<SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>);
  await waitFor(() => { expect(view.queryByTestId("screen-title") ?? view.queryByTestId("redirect")).not.toBeNull(); });
  return view;
}
async function openUse(usage: string): Promise<View> {
  params.usage = usage;
  return mount(<TrailerUsageRoute />);
}

test("tapping a TRAILERS row opens that exact use — the two TR23 rows open two different uses", async () => {
  const { first, second } = await trailerDay();
  const view = await mount(<ActiveShiftRoute />);

  await press(view, `trailer-usage-${second}`);
  expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: "/trailer-usage", params: { usage: second } });
  await press(view, `trailer-usage-${first}`);
  expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: "/trailer-usage", params: { usage: first } });
  expect(view.queryByTestId(`trailer-usage-chevron-${first}`)).not.toBeNull();
});

test("the detail states number, type, start, end and duration of THAT use", async () => {
  const { first, second } = await trailerDay();

  const morning = await openUse(first);
  expect(text(morning, "trailer-usage-number")).toBe("TR23");
  expect(text(morning, "trailer-usage-type-hours")).toBe("Refrigerated · 05:30–10:05");
  expect(text(morning, "trailer-usage-started")).toBe("05:30");
  expect(text(morning, "trailer-usage-ended")).toBe("10:05");
  expect(text(morning, "trailer-usage-duration")).toBe("4 h 35 min");
  await morning.unmount();

  const later = await openUse(second);
  expect(text(later, "trailer-usage-type-hours")).toBe("Refrigerated · 10:13–11:00");
  expect(text(later, "trailer-usage-duration")).toBe("47 min");
});

test("a STANDARD use shows no Fridge Diesel and offers no Edit — there is nothing it may edit", async () => {
  const { box } = await trailerDay();

  const view = await openUse(box);

  expect(text(view, "trailer-usage-type-hours")).toBe("Standard · 10:05–10:13");
  expect(view.queryByTestId("trailer-usage-diesel")).toBeNull();
  expect(view.queryByTestId("trailer-usage-diesel-none")).toBeNull();
  expect(view.queryByTestId("trailer-usage-edit")).toBeNull();
});

test("a REFRIGERATED use lists its diesel, and Edit offers only its Fridge Diesel — opened for THIS ended use", async () => {
  const { shift, second } = await trailerDay();
  await dieselOn(shift, second, USAGE_STATE.ended, { litres: 120 });
  const view = await openUse(second);

  expect(JSON.stringify(view.toJSON())).toContain("120 L");
  await press(view, "trailer-usage-edit");
  expect(text(view, "screen-title")).toBe("Edit Trailer Use");
  // Nothing to type: number, type and times are stated, never inputs.
  expect(JSON.stringify(view.toJSON())).not.toContain('"type":"TextInput"');
  await press(view, "trailer-usage-edit-diesel");
  expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: "/trailer-diesel", params: { trailer: second, usageState: "ended" } });
});

test.each([["a trailer number", "TR23"], ["the trailer in use", "current"], ["nothing", ""]])("Trailer Use is not a screen for %s", async (_why, name) => {
  const { current } = await trailerDay();

  const view = await openUse(name === "current" ? current : name);

  expect(text(view, "redirect")).toBe("/active-shift");
});

// ─── Fridge Diesel on an ended use, through its real form ──────────────────

test("the Fridge Diesel form for an ENDED use names it by number AND hours, and adds to it alone", async () => {
  const { first, second } = await trailerDay();
  params.trailer = second;
  params.usageState = USAGE_STATE.ended;
  const view = await mount(<TrailerDieselRoute />);

  expect(text(view, "fill-vehicle")).toBe("TR23 · 10:13–11:00");
  await press(view, "amount-unknown");
  await press(view, "fill-save");

  expect((await ended(second))?.reeferDiesel).toMatchObject([{ litres: null }]);
  expect((await ended(first))?.reeferDiesel).toEqual([]);
  expect((await readOpenShift())?.trailer?.reeferDiesel).toEqual([]);
});

test("an existing ended entry is corrected and removed on its form, keeping its id", async () => {
  const { shift, second } = await trailerDay();
  const id = newLocalId();
  await dieselOn(shift, second, USAGE_STATE.ended, { fillId: id, litres: 30 });
  params.trailer = second;
  params.usageState = USAGE_STATE.ended;
  const view = await mount(<TrailerDieselRoute />);

  await press(view, `fill-${id}`);
  await type(view, "litres", "300");
  await press(view, "fill-save");
  expect((await ended(second))?.reeferDiesel).toMatchObject([{ id, litres: 300 }]);

  await press(view, `fill-${id}`);
  await press(view, "fill-remove");
  expect((await ended(second))?.reeferDiesel).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════
// The forgotten Trailer Check
// ═══════════════════════════════════════════════════════════════════════════

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
async function openEndedCheck(usage: string): Promise<View> {
  params.trailer = usage;
  params.usageState = USAGE_STATE.ended;
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AuthProvider><SignedIn><TrailerCheckRoute /></SignedIn></AuthProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => { expect(text(view, "status")).toBe("unauthenticated"); });
  await act(async () => { await fireEvent.press(view.getByTestId("authenticate")); });
  await waitFor(() => {
    expect(view.queryByTestId("complete-check") ?? view.queryByTestId("check-completed-at") ?? view.queryByTestId("redirect")).not.toBeNull();
  });
  return view;
}

test("an ended use with no completed check says so, and Trailer Checks opens THAT use's check", async () => {
  const { first } = await trailerDay();
  const view = await openUse(first);

  expect(text(view, "trailer-usage-checks")).toBe("Not completed");
  expect(text(view, "trailer-usage-check-missing")).toBe("Not completed");
  await press(view, "trailer-usage-checks-open");

  expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: "/trailer-check", params: { trailer: first, usageState: "ended" } });
});

test("a fresh forgotten check opens at its defaults, writing nothing", async () => {
  const { first } = await trailerDay();
  const before = bytes();

  const view = await openEndedCheck(first);

  expect(text(view, "check-plate")).toBe("TR23");
  expect(view.queryByTestId("complete-check")).not.toBeNull();
  expect(bytes()).toBe(before);
});

test("an existing DRAFT on the ended use is resumed — the same check, its answers intact", async () => {
  const { first } = await trailerDay();
  const draftId = newLocalId();
  // A draft left on TR23 before it was handed back — written as the store would have.
  const day = JSON.parse(bytes()) as { previousTrailers: { startedAt: string; checks: unknown[] }[] };
  const list = trailerChecklistFor(TRAILER_TYPE.refrigerated);
  const target = day.previousTrailers.find(use => use.startedAt === first);
  if (target === undefined) throw new Error("expected the first TR23 use");
  target.checks = [{ id: draftId, checklist: list.id, checklistVersion: list.version, startedAt: at(5, 40).toISOString(), status: "draft", completedAt: null, completedBy: null,
    items: [{ key: "doors", label: "Doors & fastenings", result: "fail", note: "Seal torn" }] }];
  new File(Paths.document, OPEN_SHIFT_FILE).write(JSON.stringify(day));

  const view = await openEndedCheck(first);
  expect(String(view.getByTestId("check-note-doors").props.value)).toBe("Seal torn");
  await press(view, "complete-check");

  await waitFor(async () => { expect(checkStateOf((await ended(first))?.checks ?? [])).toBe("completed"); });
  const [check] = (await ended(first))?.checks ?? [];
  expect(check?.id).toBe(draftId);
  expect(check?.items.find(item => item.key === "doors")).toMatchObject({ result: "fail", note: "Seal torn" });
});

test("a forgotten check completed AFTER the trailer ended is dated when it was actually completed — never backdated", async () => {
  const { first } = await trailerDay();
  const view = await openEndedCheck(first);
  const before = Date.now();

  await press(view, "complete-check");

  await waitFor(async () => { expect(checkStateOf((await ended(first))?.checks ?? [])).toBe("completed"); });
  const [check] = (await ended(first))?.checks ?? [];
  const completedAt = Date.parse(check?.completedAt ?? "");
  expect(completedAt).toBeGreaterThanOrEqual(before);
  expect(completedAt).toBeLessThanOrEqual(Date.now());
  expect(completedAt).toBeGreaterThan(at(10, 5).getTime());
  expect(check?.completedBy).toBe(DRIVER.user.id);
  expect(check?.items).toHaveLength(checklistItems(trailerChecklistFor(TRAILER_TYPE.refrigerated)).length);
  // Back to the use it was opened from.
  expect(mockRouter.back).toHaveBeenCalled();
});

test("once completed, the historical check is read-only and cannot be completed again", async () => {
  const { shift, first } = await trailerDay();
  await completeTrailerCheck({
    shiftId: shift.id, trailerStartedAt: first, usageState: USAGE_STATE.ended, checkId: "forgotten", startedAt: new Date(),
    answers: answers(), completedAt: new Date(), completedBy: DRIVER.user.id,
  });
  const before = bytes();

  const again = await completeTrailerCheck({
    shiftId: shift.id, trailerStartedAt: first, usageState: USAGE_STATE.ended, checkId: newLocalId(), startedAt: new Date(),
    answers: answers(), completedAt: new Date(), completedBy: "someone_else",
  });
  expect(again?.id).toBe("forgotten");
  expect(bytes()).toBe(before);

  const view = await openEndedCheck(first);
  expect(view.queryByTestId("check-completed-at")).not.toBeNull();
  expect(view.queryByTestId("complete-check")).toBeNull();
  await press(view, "check-doors-fail");
  expect(bytes()).toBe(before);
});

test("after completion the detail shows it completed, and Active Shift marks ONLY that row", async () => {
  const { shift, first, second } = await trailerDay();
  await completeTrailerCheck({
    shiftId: shift.id, trailerStartedAt: first, usageState: USAGE_STATE.ended, checkId: newLocalId(), startedAt: new Date(),
    answers: answers().map(answer => (answer.key === "doors" ? { ...answer, result: CHECK_RESULT.defect, note: "Seal torn" } : answer)),
    completedAt: new Date(), completedBy: DRIVER.user.id,
  });

  const detail = await openUse(first);
  expect(text(detail, "trailer-usage-checks")).toBe("Completed");
  expect(detail.queryByTestId("trailer-usage-defect-doors")).not.toBeNull();
  await detail.unmount();

  const active = await mount(<ActiveShiftRoute />);
  expect(text(active, `trailer-usage-checks-${first}`)).toBe("Checks completed");
  expect(text(active, `trailer-usage-checks-${second}`)).toBe("Checks not completed");
});

test.each([["a trailer number", "TR23"], ["the trailer in use, as ended", "current"]])("the forgotten-check screen is not opened for %s", async (_why, name) => {
  const { current } = await trailerDay();

  const view = await openEndedCheck(name === "current" ? current : name);

  expect(text(view, "redirect")).toBe("/active-shift");
});
