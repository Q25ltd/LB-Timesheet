/**
 * Trailer Checks (D35) — the checklist, the store, the route and Active Shift.
 *
 * A Trailer Check is the Vehicle Check's own model — defaults that are not a
 * check, a draft of overrides only, an explicit completion that writes an
 * immutable certificate — held on ONE EXACT TRAILER USE. These prove the list
 * is the trailer's share of the DVSA walkaround and nothing tractor-only, that
 * a check never crosses from one use to another (not even two uses of the same
 * trailer), that a stale screen writes nothing, and that the vehicle's checks
 * and the trailer's never touch.
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { File, Paths } from "expo-file-system";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Alert, Pressable, StyleSheet, Text, TextInput } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AuthenticatedAccount } from "../api/account";
import TrailerCheckRoute from "../../app/(app)/trailer-check";
import { ActiveShiftScreen } from "../screens/ActiveShiftScreen";
import { checklistFor, checklistItems, trailerChecklistFor, type Checklist } from "../shift/checklists";
import {
  OPEN_SHIFT_FILE,
  USAGE_STATE,
  addTrailerToOpenShift,
  changeTrailer,
  changeVehicle,
  clearOpenShift,
  completeTrailerCheck,
  completeVehicleCheck,
  newLocalId,
  readOpenShift,
  recordReeferDiesel,
  saveTrailerCheckDraft,
  startLocalShift,
  type LocalShift,
  type VehicleDetails,
} from "../shift/localShift";
import { TRAILER_TYPE, type TrailerDetails, type TrailerType } from "../shift/trailer";
import { CHECK_RESULT, checkStateOf, type CheckAnswer } from "../shift/vehicleCheck";
import { colors } from "../theme/index";
import { trailerUseAt, vehicleUseAt } from "./useIdAt";

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
const FRIDGE: TrailerDetails = { trailerNumber: "TR100", trailerType: TRAILER_TYPE.refrigerated };
const BOX: TrailerDetails = { trailerNumber: "TR200", trailerType: TRAILER_TYPE.standard };
const DRIVER: AuthenticatedAccount = {
  user: { id: "user_trailer_1", firstName: "Nerijus", lastName: "Kuizinas", email: "driver@example.com" },
  identityToken: "identity.token.value",
  refreshToken: "refresh-secret-value",
  memberships: [],
};

type View = Awaited<ReturnType<typeof render>>;
const bytes = () => new File(Paths.document, OPEN_SHIFT_FILE).textSync();
const text = (view: View, testID: string) => String(view.getByTestId(testID).props.children);
function isSelected(view: View, testID: string): boolean {
  const state: unknown = view.getByTestId(testID).props.accessibilityState;
  return typeof state === "object" && state !== null && "selected" in state && state.selected === true;
}
async function press(view: View, testID: string): Promise<void> {
  await act(async () => { await fireEvent.press(view.getByTestId(testID)); });
}

beforeEach(async () => {
  await clearOpenShift();
  delete params.trailer;
  delete params.usageState;
  for (const fn of Object.values(mockRouter)) fn.mockClear();
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.mocked(TextInput.prototype.isFocused).mockReset();
});

// ═══════════════════════════════════════════════════════════════════════════
// The checklist — the trailer's share of DVSA's 27 walkaround checks
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The official mapping, stated independently of the implementation (see
 * `checklists.ts` and D35): which of DVSA's 27 numbered HGV walkaround checks
 * a driver can only answer about the tractor, and which the trailer — or the
 * combination with it — must answer.
 */
const TRACTOR_ONLY = [1, 2, 3, 4, 5, 8, 9, 11, 13, 14, 15, 16, 17];
const TRAILER_OR_COMBINATION = [6, 10, 12, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27];
/**
 * Combination-related, but answered where the thing is: the height marker (7)
 * changes with the trailer and its load, and sits in the cab — so it is on the
 * towing vehicle's list, not repeated on the trailer's (owner review).
 */
const COMBINATION_ON_VEHICLE_LIST = [7];
const TYPES: readonly TrailerType[] = [TRAILER_TYPE.standard, TRAILER_TYPE.refrigerated];

test("the 27 DVSA checks are each classified once — tractor-only or trailer/combination", () => {
  const all = [...TRACTOR_ONLY, ...TRAILER_OR_COMBINATION, ...COMBINATION_ON_VEHICLE_LIST].sort((a, b) => a - b);
  expect(all).toEqual(Array.from({ length: 27 }, (_, index) => index + 1));
});

test.each(TYPES)("%s: every row has a unique, stable key and an explicit OK or N/A default — never DEFECT", type => {
  const items = checklistItems(trailerChecklistFor(type));

  expect(new Set(items.map(entry => entry.key)).size).toBe(items.length);
  for (const entry of items) {
    expect(entry.key).toMatch(/^[a-z0-9-]+$/);
    expect([CHECK_RESULT.ok, CHECK_RESULT.notApplicable]).toContain(entry.defaultResult);
  }
});

test.each(TYPES)("%s: every row traces to a trailer or combination DVSA check, and none to a tractor-only one", type => {
  for (const entry of checklistItems(trailerChecklistFor(type))) {
    expect(entry.dvsa.length).toBeGreaterThan(0);
    for (const number of entry.dvsa) {
      expect(TRAILER_OR_COMBINATION).toContain(number);
      expect(TRACTOR_ONLY).not.toContain(number);
    }
  }
});

test.each(TYPES)("%s: NOTHING trailer-relevant is omitted — every trailer/combination check has a row", type => {
  const covered = new Set(checklistItems(trailerChecklistFor(type)).flatMap(entry => entry.dvsa));

  for (const number of TRAILER_OR_COMBINATION) expect(covered).toContain(number);
});

test("the height marker (7) is answered on the unit's and the rigid's own lists, and is not repeated on the trailer's", () => {
  for (const type of TYPES) {
    expect(checklistItems(trailerChecklistFor(type)).some(entry => entry.dvsa.includes(7))).toBe(false);
  }
  for (const vehicleClass of ["class1", "class2"] as const) {
    expect(checklistItems(checklistFor(vehicleClass)).filter(entry => entry.dvsa.includes(7)).map(entry => entry.key)).toEqual(["height-marker"]);
  }
});

test("coupling (22) and brake lines & trailer parking brake (20) are on the TRAILER list and on no vehicle list", () => {
  const trailer = checklistItems(trailerChecklistFor(TRAILER_TYPE.standard));
  expect(trailer.filter(entry => entry.dvsa.includes(22)).map(entry => entry.key)).toEqual(["coupling-located", "secondary-lock"]);
  expect(trailer.some(entry => entry.dvsa.includes(20))).toBe(true);

  for (const vehicleClass of ["class1", "class2", "van"] as const) {
    const numbers = checklistItems(checklistFor(vehicleClass)).flatMap(entry => entry.dvsa);
    if (vehicleClass !== "van") {
      expect(numbers).not.toContain(20);
      expect(numbers).not.toContain(22);
    }
  }
});

test("Standard and Refrigerated share every row, and differ ONLY in the specialised-equipment default", () => {
  const standard = checklistItems(trailerChecklistFor(TRAILER_TYPE.standard));
  const fridge = checklistItems(trailerChecklistFor(TRAILER_TYPE.refrigerated));

  expect(fridge.map(entry => entry.key)).toEqual(standard.map(entry => entry.key));
  const differs = standard.filter((entry, index) => entry.defaultResult !== fridge[index]?.defaultResult).map(entry => entry.key);
  expect(differs).toEqual(["specialised-equipment"]);
  expect(standard.find(entry => entry.key === "specialised-equipment")?.defaultResult).toBe("na");
  expect(fridge.find(entry => entry.key === "specialised-equipment")?.defaultResult).toBe("pass");
  // No fridge detail the guidance does not ask for.
  const labels = fridge.map(entry => entry.label.toLowerCase()).join(" | ");
  for (const invented of ["temperature", "set point", "hours", "service interval", "atp "]) expect(labels).not.toContain(invented);
});

test("N/A starts only where equipment genuinely may not be fitted — the declared optional rows", () => {
  const na = (type: TrailerType) =>
    checklistItems(trailerChecklistFor(type)).filter(entry => entry.defaultResult === "na").map(entry => entry.key);

  expect(na(TRAILER_TYPE.standard)).toEqual([
    "spray-suppression", "hazard-panels", "load-security", "securing-equipment", "curtains-sheets", "twist-locks", "specialised-equipment",
  ]);
  expect(na(TRAILER_TYPE.refrigerated)).toEqual([
    "spray-suppression", "hazard-panels", "load-security", "securing-equipment", "curtains-sheets", "twist-locks",
  ]);
});

test("what needs a LOAD on board starts N/A — an empty trailer is normal; permanent structure and landing legs start OK", () => {
  for (const type of TYPES) {
    const defaults = new Map(checklistItems(trailerChecklistFor(type)).map(entry => [entry.key, entry.defaultResult]));
    // True only with a load: the load itself, what secures it, dangerous-goods panels.
    for (const key of ["load-security", "securing-equipment", "hazard-panels"]) expect(defaults.get(key)).toBe("na");
    // Fitted to every load-carrying trailer, and checked before loading.
    expect(defaults.get("load-bed")).toBe("pass");
    // Standard on the common semi-trailer; a drawbar driver sets N/A.
    expect(defaults.get("landing-legs")).toBe("pass");
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// The store — drafts, completion, and one exact trailer use
// ═══════════════════════════════════════════════════════════════════════════

async function dayWithTrailer(trailer: TrailerDetails = FRIDGE): Promise<{ shift: LocalShift; use: string }> {
  const shift = await startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle: UNIT });
  await addTrailerToOpenShift({ shiftId: shift.id, trailer, startedAt: at(5, 30) });
  return { shift, use: at(5, 30).toISOString() };
}

/** Every row at its default, with the given overrides. */
function answersFor(checklist: Checklist, over: Record<string, CheckAnswer> = {}): CheckAnswer[] {
  return checklistItems(checklist).map(entry => over[entry.key] ?? { key: entry.key, result: entry.defaultResult, note: "" });
}
const defect = (key: string, note: string): CheckAnswer => ({ key, result: CHECK_RESULT.defect, note });

async function complete(shift: LocalShift, use: string, type: TrailerType, over: Record<string, CheckAnswer> = {}, checkId = newLocalId()) {
  return completeTrailerCheck({
    shiftId: shift.id, trailerUseId: trailerUseAt(use), usageState: USAGE_STATE.inUse, checkId, startedAt: at(5, 40),
    answers: answersFor(trailerChecklistFor(type), over), completedAt: at(5, 50), completedBy: DRIVER.user.id,
  });
}
async function draft(shift: LocalShift, use: string, answers: CheckAnswer[], checkId: string) {
  return saveTrailerCheckDraft({ shiftId: shift.id, trailerUseId: trailerUseAt(use), usageState: USAGE_STATE.inUse, checkId, startedAt: at(5, 40), answers });
}
const trailerChecks = async () => (await readOpenShift())?.trailer?.checks ?? [];

test("a draft stores ONLY the rows that differ from their defaults, and a row put back drops out", async () => {
  const { shift, use } = await dayWithTrailer();
  const checklist = trailerChecklistFor(TRAILER_TYPE.refrigerated);
  const id = newLocalId();

  await draft(shift, use, answersFor(checklist, { "landing-legs": { key: "landing-legs", result: "na", note: "" } }), id);
  expect((await trailerChecks())[0]?.items).toEqual([{ key: "landing-legs", label: "Landing legs", result: "na", note: null }]);

  await draft(shift, use, answersFor(checklist), id);
  expect((await trailerChecks())[0]?.items).toEqual([]);
  expect(checkStateOf(await trailerChecks())).toBe("not-started");
});

test("several defects are kept independently in a draft, and the draft survives a restart", async () => {
  const { shift, use } = await dayWithTrailer();
  const checklist = trailerChecklistFor(TRAILER_TYPE.refrigerated);

  await draft(shift, use, answersFor(checklist, {
    "marker-lights": defect("marker-lights", "Nearside marker out"),
    "tyre-condition": defect("tyre-condition", "Cut in sidewall, axle 2"),
  }), newLocalId());

  // Read again from the file alone.
  const [stored] = await trailerChecks();
  expect(stored?.status).toBe("draft");
  expect(stored?.items.map(entry => [entry.key, entry.note])).toEqual([
    ["marker-lights", "Nearside marker out"], ["tyre-condition", "Cut in sidewall, axle 2"],
  ]);
  expect(checkStateOf(await trailerChecks())).toBe("in-progress");
});

test.each([["an empty", ""], ["a whitespace-only", "   \n "]])("completing with %s defect description is REFUSED, writing nothing", async (_what, note) => {
  const { shift, use } = await dayWithTrailer();
  const before = bytes();

  await expect(complete(shift, use, TRAILER_TYPE.refrigerated, { "doors": defect("doors", note) })).rejects.toThrow(Error);

  expect(bytes()).toBe(before);
});

test("completion materialises EVERY row, with its section, a stable id, when, and who — and survives a restart", async () => {
  const { shift, use } = await dayWithTrailer(BOX);
  const id = newLocalId();

  await complete(shift, use, TRAILER_TYPE.standard, { "doors": defect("doors", "  Rear door seal torn  ") }, id);

  const [check] = await trailerChecks();
  const rows = checklistItems(trailerChecklistFor(TRAILER_TYPE.standard));
  expect(check?.id).toBe(id);
  expect(check?.status).toBe("completed");
  expect(check?.checklist).toBe("trailer-standard");
  expect(check?.completedAt).toBe(at(5, 50).toISOString());
  expect(check?.completedBy).toBe(DRIVER.user.id);
  expect(check?.items.map(entry => entry.key)).toEqual(rows.map(entry => entry.key));
  expect(check?.items.every(entry => entry.section !== undefined)).toBe(true);
  expect(check?.items.find(entry => entry.key === "doors")).toMatchObject({ result: "fail", note: "Rear door seal torn" });
  expect(check?.items.find(entry => entry.key === "twist-locks")).toMatchObject({ result: "na", note: null });
});

test("a completed check cannot be reopened: a later save or completion returns it unchanged", async () => {
  const { shift, use } = await dayWithTrailer();
  const id = newLocalId();
  await complete(shift, use, TRAILER_TYPE.refrigerated, {}, id);
  const before = bytes();

  await draft(shift, use, answersFor(trailerChecklistFor(TRAILER_TYPE.refrigerated), { "doors": defect("doors", "late") }), id);
  await complete(shift, use, TRAILER_TYPE.refrigerated, { "doors": defect("doors", "late") }, id);

  expect(bytes()).toBe(before);
});

test("a stored certificate is read from its OWN rows — later checklist wording or defaults cannot reinterpret it", async () => {
  const { shift, use } = await dayWithTrailer();
  await complete(shift, use, TRAILER_TYPE.refrigerated);
  // The certificate on disk, with its rows as the driver confirmed them.
  const onDisk = JSON.parse(bytes()) as { trailer: { checks: { items: { key: string; label: string; result: string }[] }[] } };
  const certified = onDisk.trailer.checks[0]?.items.find(entry => entry.key === "landing-legs");
  expect(certified).toMatchObject({ label: "Landing legs", result: "pass" });

  // Simulate a future checklist: rewrite the label on disk, as a later build's
  // definition would differ — the stored record, not today's list, is shown.
  new File(Paths.document, OPEN_SHIFT_FILE).write(bytes().replace('"label":"Landing legs"', '"label":"Landing legs (v1 wording)"'));
  const [check] = await trailerChecks();
  expect(check?.items.find(entry => entry.key === "landing-legs")?.label).toBe("Landing legs (v1 wording)");
});

// ─── One exact trailer use — never another ───────────────────────────────

test("a check stays on trailer A; changing to trailer B starts B with NO check; completing B leaves A alone", async () => {
  const { shift, use: a } = await dayWithTrailer(FRIDGE);
  await complete(shift, a, TRAILER_TYPE.refrigerated);
  const certificateA = JSON.stringify(await trailerChecks());

  await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(a), next: BOX, changedAt: at(10) });
  expect(await trailerChecks()).toEqual([]);
  await complete(shift, at(10).toISOString(), TRAILER_TYPE.standard);

  const day = await readOpenShift();
  expect(JSON.stringify(day?.previousTrailers[0]?.checks)).toBe(certificateA);
  expect(day?.trailer?.checks[0]?.checklist).toBe("trailer-standard");
});

test("TR100 taken AGAIN is a fresh use: its check starts empty — the morning's certificate and draft never carry over", async () => {
  const { shift, use: morning } = await dayWithTrailer(FRIDGE);
  await complete(shift, morning, TRAILER_TYPE.refrigerated);
  await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(morning), next: BOX, changedAt: at(10) });
  const middle = at(10).toISOString();
  await draft(shift, middle, answersFor(trailerChecklistFor(TRAILER_TYPE.standard), { "doors": defect("doors", "x") }), newLocalId());
  await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(middle), next: FRIDGE, changedAt: at(14) });

  const day = await readOpenShift();
  expect(day?.trailer?.trailerNumber).toBe("TR100");
  expect(day?.trailer?.checks).toEqual([]);
  expect(checkStateOf(day?.trailer?.checks ?? [])).toBe("not-started");
  // The morning's TR100 certificate is still on the morning's use.
  expect(checkStateOf(day?.previousTrailers[0]?.checks ?? [])).toBe("completed");
});

test("two uses of TR100 never share a draft or a certificate: the afternoon's own check lands on the afternoon's use", async () => {
  const { shift, use: morning } = await dayWithTrailer(FRIDGE);
  const morningId = newLocalId();
  await draft(shift, morning, answersFor(trailerChecklistFor(TRAILER_TYPE.refrigerated), { "doors": defect("doors", "morning") }), morningId);
  await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(morning), next: FRIDGE, changedAt: at(14) });
  const afternoon = at(14).toISOString();

  await complete(shift, afternoon, TRAILER_TYPE.refrigerated);

  const day = await readOpenShift();
  expect(day?.previousTrailers[0]?.checks).toMatchObject([{ id: morningId, status: "draft" }]);
  expect(day?.trailer?.checks).toHaveLength(1);
  expect(day?.trailer?.checks[0]?.id).not.toBe(morningId);
});

test("STALE: a check opened for TR100 cannot save after the trailer changed — not to it, not to a replacement TR100", async () => {
  const { shift, use: opened } = await dayWithTrailer(FRIDGE);
  const id = newLocalId();
  await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(opened), next: FRIDGE, changedAt: at(9) });
  const before = bytes();

  const saved = await draft(shift, opened, answersFor(trailerChecklistFor(TRAILER_TYPE.refrigerated), { "doors": defect("doors", "x") }), id);
  const completed = await complete(shift, opened, TRAILER_TYPE.refrigerated, {}, id);

  expect([saved, completed]).toEqual([null, null]);
  expect(bytes()).toBe(before);
});

test.each([["a trailer number", "TR100"], ["nothing", ""]])("a Trailer Check named by %s lands nowhere", async (_why, name) => {
  const { shift } = await dayWithTrailer(FRIDGE);
  const before = bytes();

  expect(await complete(shift, name, TRAILER_TYPE.refrigerated)).toBeNull();
  expect(bytes()).toBe(before);
});

test("a VEHICLE change with the same trailer in use keeps the trailer's check exactly as it was", async () => {
  const { shift, use } = await dayWithTrailer(FRIDGE);
  await complete(shift, use, TRAILER_TYPE.refrigerated);
  const trailer = JSON.stringify((await readOpenShift())?.trailer);

  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_100, next: { ...UNIT, numberPlate: "CD34 EFG" }, changedAt: at(10) });

  expect(JSON.stringify((await readOpenShift())?.trailer)).toBe(trailer);
});

test("vehicle and trailer checks never touch: completing either leaves the other exactly as it was", async () => {
  const { shift, use } = await dayWithTrailer(FRIDGE);
  await completeVehicleCheck({
    shiftId: shift.id, vehicleUseId: vehicleUseAt(STARTED_AT.toISOString()), usageState: USAGE_STATE.inUse, checkId: newLocalId(), startedAt: at(5, 10),
    answers: answersFor(checklistFor("class1")), completedAt: at(5, 20), completedBy: DRIVER.user.id,
  });
  expect(await trailerChecks()).toEqual([]);
  const vehicleChecks = JSON.stringify((await readOpenShift())?.vehicle?.checks);

  await complete(shift, use, TRAILER_TYPE.refrigerated);

  expect(JSON.stringify((await readOpenShift())?.vehicle?.checks)).toBe(vehicleChecks);
  expect(checkStateOf(await trailerChecks())).toBe("completed");
});

test("Fridge Diesel and Trailer Checks are independent: neither creates, requires or changes the other", async () => {
  const { shift, use } = await dayWithTrailer(FRIDGE);
  await recordReeferDiesel({ shiftId: shift.id, trailerUseId: trailerUseAt(use), usageState: USAGE_STATE.inUse, fillId: newLocalId(), recordedAt: at(6), litres: 40, note: "" });
  expect(await trailerChecks()).toEqual([]);

  await complete(shift, use, TRAILER_TYPE.refrigerated);
  const checks = JSON.stringify(await trailerChecks());
  expect((await readOpenShift())?.trailer?.reeferDiesel).toHaveLength(1);

  await recordReeferDiesel({ shiftId: shift.id, trailerUseId: trailerUseAt(use), usageState: USAGE_STATE.inUse, fillId: newLocalId(), recordedAt: at(7), litres: null, note: "" });
  expect(JSON.stringify(await trailerChecks())).toBe(checks);
});

// ═══════════════════════════════════════════════════════════════════════════
// The Trailer Checks screen — the real route, signed in
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

async function openRoute(use: string, usageState: string = USAGE_STATE.inUse): Promise<View> {
  params.trailer = trailerUseAt(use);
  params.usageState = usageState;
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

test("the screen names the trailer it checks — 'Trailer Checks', its number and type — and opening it writes NOTHING", async () => {
  const { use } = await dayWithTrailer(FRIDGE);
  const before = bytes();

  const view = await openRoute(use);

  expect(text(view, "screen-title")).toBe("Trailer Checks");
  expect(text(view, "check-plate")).toBe("TR100");
  expect(text(view, "check-mileage")).toBe("Refrigerated");
  expect(bytes()).toBe(before);
  expect(checkStateOf(await trailerChecks())).toBe("not-started");
});

test("a fresh screen shows every row at its declared default, and NOTHING as completed", async () => {
  const { use } = await dayWithTrailer(BOX);

  const view = await openRoute(use);

  for (const entry of checklistItems(trailerChecklistFor(TRAILER_TYPE.standard))) {
    expect(isSelected(view, `check-${entry.key}-${entry.defaultResult}`)).toBe(true);
  }
  expect(view.queryByTestId("check-completed-at")).toBeNull();
  expect(text(view, "summary-na")).toBe("7 N/A");
});

test("changing one row stores ONLY that override, from the screen", async () => {
  const { use } = await dayWithTrailer(FRIDGE);
  const view = await openRoute(use);

  await press(view, "check-landing-legs-na");

  await waitFor(async () => { expect((await trailerChecks())[0]?.items).toEqual([{ key: "landing-legs", label: "Landing legs", result: "na", note: null }]); });
});

test("Complete Check from the screen writes the certificate, attributed to the signed-in driver, and returns to the day", async () => {
  const { use } = await dayWithTrailer(FRIDGE);
  const view = await openRoute(use);

  await press(view, "complete-check");

  await waitFor(async () => { expect(checkStateOf(await trailerChecks())).toBe("completed"); });
  expect((await trailerChecks())[0]?.completedBy).toBe(DRIVER.user.id);
  expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift");
});

test("a completed Trailer Check opens READ-ONLY, from its stored certificate", async () => {
  const { shift, use } = await dayWithTrailer(FRIDGE);
  await complete(shift, use, TRAILER_TYPE.refrigerated, { "doors": defect("doors", "Seal torn") });
  const before = bytes();

  const view = await openRoute(use);

  expect(view.queryByTestId("check-completed-at")).not.toBeNull();
  expect(view.queryByTestId("complete-check")).toBeNull();
  expect(text(view, "check-note-doors")).toBe("Seal torn");
  await press(view, "check-doors-pass");
  expect(bytes()).toBe(before);
});

test("STALE on screen: the trailer changes while the check is open — the save writes nothing, and the driver is told", async () => {
  const { shift, use } = await dayWithTrailer(FRIDGE);
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const view = await openRoute(use);
  await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(use), next: FRIDGE, changedAt: at(9) });
  const before = bytes();

  await press(view, "complete-check");

  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift"); });
  expect(bytes()).toBe(before);
  expect(alert).toHaveBeenCalled();
});

test.each([["a trailer number", "TR100"], ["a use that has ended", "ended"]])("the screen is not opened for %s", async (_why, name) => {
  const { shift, use } = await dayWithTrailer(FRIDGE);
  if (name === "ended") await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(use), next: null, changedAt: at(9) });

  const view = await openRoute(name === "ended" ? use : name);

  expect(text(view, "redirect")).toBe("/active-shift");
});

// ═══════════════════════════════════════════════════════════════════════════
// Active Shift — the trailer card's check state
// ═══════════════════════════════════════════════════════════════════════════

function screen(shift: LocalShift, onTrailerChecks: jest.Mock = jest.fn()): React.ReactElement {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ActiveShiftScreen
        shift={shift} onDiscard={() => undefined} onFinish={() => undefined} onCorrectPlate={() => undefined} onCorrectTrailerNumber={() => undefined} onAddVehicle={() => undefined} onVehicleChecks={() => undefined}
        onChangeVehicle={() => undefined} onFill={() => undefined} onOpenUsage={() => undefined}
        onAddTrailer={() => undefined} onChangeTrailer={() => undefined} onFridgeDiesel={() => undefined}
        onTrailerChecks={onTrailerChecks} onOpenTrailerUsage={() => undefined}
      />
    </SafeAreaProvider>
  );
}
const stored = async (): Promise<LocalShift> => {
  const day = await readOpenShift();
  if (day === null) throw new Error("expected an open day");
  return day;
};
function cardGround(view: View): unknown {
  const style = StyleSheet.flatten(view.getByTestId("current-trailer-card").props.style) as { backgroundColor?: unknown };
  return style.backgroundColor;
}

test.each([["a Standard", BOX], ["a Refrigerated", FRIDGE]] as const)("%s trailer has Trailer Checks, opening THIS use", async (_what, trailer) => {
  const { use } = await dayWithTrailer(trailer);
  const onTrailerChecks = jest.fn();
  const view = await render(screen(await stored(), onTrailerChecks));

  await fireEvent.press(view.getByTestId("trailer-checks"));

  expect(onTrailerChecks).toHaveBeenCalledWith(trailerUseAt(use));
  // Fridge Diesel stays the refrigerated trailer's alone.
  expect(view.queryByTestId("fridge-diesel") !== null).toBe(trailer.trailerType === TRAILER_TYPE.refrigerated);
});

test("fresh: 'Not completed' open, and folded a red 'Checks not completed' with the number still shown", async () => {
  await dayWithTrailer(FRIDGE);
  const view = await render(screen(await stored()));

  expect(text(view, "trailer-checks-state")).toBe("Not completed");
  await fireEvent.press(view.getByTestId("current-trailer-toggle"));
  expect(text(view, "trailer-number-value")).toBe("TR100");
  expect(text(view, "collapsed-trailer-checks-state")).toBe("Checks not completed");
  expect(cardGround(view)).toBe(colors.dangerBg);
});

test("a DRAFT is still not completed — 'In progress' open, red and 'Checks not completed' folded", async () => {
  const { shift, use } = await dayWithTrailer(FRIDGE);
  await draft(shift, use, answersFor(trailerChecklistFor(TRAILER_TYPE.refrigerated), { "doors": defect("doors", "x") }), newLocalId());
  const view = await render(screen(await stored()));

  expect(text(view, "trailer-checks-state")).toBe("In progress");
  await fireEvent.press(view.getByTestId("current-trailer-toggle"));
  expect(text(view, "collapsed-trailer-checks-state")).toBe("Checks not completed");
  expect(cardGround(view)).toBe(colors.dangerBg);
});

test("ONLY an explicit completion turns the card green — 'Completed' open, 'Checks completed' folded", async () => {
  const { shift, use } = await dayWithTrailer(FRIDGE);
  await complete(shift, use, TRAILER_TYPE.refrigerated);
  const view = await render(screen(await stored()));

  expect(text(view, "trailer-checks-state")).toBe("Completed");
  await fireEvent.press(view.getByTestId("current-trailer-toggle"));
  expect(text(view, "collapsed-trailer-checks-state")).toBe("Checks completed");
  expect(cardGround(view)).toBe(colors.successBg);
});

test("a completed UNIT check does not make the trailer green, and a completed trailer check does not make the unit green", async () => {
  const { shift } = await dayWithTrailer(FRIDGE);
  await completeVehicleCheck({
    shiftId: shift.id, vehicleUseId: vehicleUseAt(STARTED_AT.toISOString()), usageState: USAGE_STATE.inUse, checkId: newLocalId(), startedAt: at(5, 10),
    answers: answersFor(checklistFor("class1")), completedAt: at(5, 20), completedBy: DRIVER.user.id,
  });
  const view = await render(screen(await stored()));

  expect(text(view, "vehicle-checks-state")).toBe("Completed");
  expect(text(view, "trailer-checks-state")).toBe("Not completed");
});

test("no trailer, no Trailer Checks — and the day cannot hold a trailer behind a van or no vehicle to render one", async () => {
  const shift = await startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle: UNIT });
  const view = await render(screen(shift));
  expect(view.queryByTestId("trailer-checks")).toBeNull();
  await view.unmount();

  // A van cannot take one, and neither can a day with no vehicle.
  for (const vehicle of [{ ...UNIT, vehicleClass: "van" as const }, null]) {
    await clearOpenShift();
    const day = await startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle });
    await expect(addTrailerToOpenShift({ shiftId: day.id, trailer: FRIDGE, startedAt: at(6) })).rejects.toThrow(Error);
    expect((await stored()).trailer).toBeNull();
  }
});
