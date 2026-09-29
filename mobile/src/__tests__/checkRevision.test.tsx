/**
 * Correcting a completed walkaround check — Vehicle / Unit Checks and Trailer
 * Checks alike (D36) — and completing a Vehicle / Unit Check forgotten before
 * the vehicle was handed back.
 *
 * A correction never edits the certificate: the original rows, `completedAt`
 * and `completedBy` stay as certified, earlier corrections stay as they were,
 * and a new revision — a complete snapshot, with when and by whom — is
 * appended and becomes the effective result. Every write names one exact use
 * by its `startedAt`; the same plate or trailer number used twice is two uses
 * whose checks never touch. Each store proof below runs for BOTH assets.
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";
import { File, Paths } from "expo-file-system";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Pressable, Text, TextInput } from "react-native";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AuthenticatedAccount } from "../api/account";
import VehicleCheckRoute from "../../app/(app)/vehicle-check";
import TrailerCheckRoute from "../../app/(app)/trailer-check";
import VehicleUsageRoute from "../../app/(app)/vehicle-usage";
import TrailerUsageRoute from "../../app/(app)/trailer-usage";
import ActiveShiftRoute from "../../app/(app)/active-shift";
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
  recordVehicleFill,
  reviseTrailerCheck,
  reviseVehicleCheck,
  saveTrailerCheckDraft,
  saveVehicleCheckDraft,
  startLocalShift,
  type CheckRevisionWrite,
  type LocalShift,
  type UsageState,
  type VehicleDetails,
} from "../shift/localShift";
import { TRAILER_TYPE, type TrailerDetails } from "../shift/trailer";
import { CHECK_RESULT, checkStateOf, effectiveItems, type CheckAnswer, type VehicleCheck } from "../shift/vehicleCheck";
import { FILL_TYPE } from "../shift/vehicleFill";
import { trailerUseAt, vehicleUseAt } from "./useIdAt";

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
const STARTED_AT = new Date(2026, 8, 19, 5, 0);
const at = (hours: number, minutes = 0) => new Date(2026, 8, 19, hours, minutes);
const UNIT: VehicleDetails = { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 100_000 };
const OTHER: VehicleDetails = { vehicleClass: "class1", numberPlate: "XY34 ZZZ", startMileage: 220_000 };
const TR23: TrailerDetails = { trailerNumber: "TR23", trailerType: TRAILER_TYPE.refrigerated };
const GFD: TrailerDetails = { trailerNumber: "GFD", trailerType: TRAILER_TYPE.refrigerated };
const DRIVER: AuthenticatedAccount = {
  user: { id: "user_revise_1", firstName: "Nerijus", lastName: "Kuizinas", email: "driver@example.com" },
  identityToken: "identity.token.value",
  refreshToken: "refresh-secret-value",
  memberships: [],
};
const CERTIFIER = "user_original";

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

// ═══════════════════════════════════════════════════════════════════════════
// One adapter per asset: the same proofs run for both
// ═══════════════════════════════════════════════════════════════════════════

interface Day {
  shift: LocalShift;
  /** The morning use — ENDED, its check completed. */
  first: string;
  /** Another asset in between — ENDED. */
  middle: string;
  /** The SAME plate / trailer number again — IN USE, its own completed check. */
  current: string;
}

interface Asset {
  name: string;
  checklist: Checklist;
  /** A day of three uses: A (ended, checked), B (ended), A again (in use, checked). */
  day: () => Promise<Day>;
  revise: (input: CheckRevisionWrite) => Promise<VehicleCheck | null>;
  /** Save a draft check on one use. */
  draft: (shift: LocalShift, startedAt: string, state: UsageState, checkId: string) => Promise<VehicleCheck | null>;
  /** The checks of one use, by its start — ended or in use. */
  checksOf: (startedAt: string) => Promise<VehicleCheck[]>;
  /** Everything about the use except its checks, as stored. */
  factsOf: (startedAt: string) => Promise<string>;
  /** The stored identity of the use of this kind that started at an instant. */
  useAt: (startedAt: string) => string;
}

const defaults = (checklist: Checklist): CheckAnswer[] =>
  checklistItems(checklist).map(entry => ({ key: entry.key, result: entry.defaultResult, note: "" }));

function withChanges(checklist: Checklist, changes: Record<string, { result: CheckAnswer["result"]; note?: string }>): CheckAnswer[] {
  return defaults(checklist).map(answer => {
    const change = changes[answer.key];
    return change === undefined ? answer : { key: answer.key, result: change.result, note: change.note ?? "" };
  });
}

async function findUse(startedAt: string) {
  const day = await readOpenShift();
  return day?.vehicle?.startedAt === startedAt ? day.vehicle
    : day?.trailer?.startedAt === startedAt ? day.trailer
    : [...(day?.previousVehicles ?? []), ...(day?.previousTrailers ?? [])].find(use => use.startedAt === startedAt);
}

const VEHICLE: Asset = {
  name: "Vehicle / Unit Check",
  useAt: vehicleUseAt,
  checklist: checklistFor("class1"),
  day: async () => {
    const shift = await startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle: UNIT });
    const first = STARTED_AT.toISOString();
    await completeVehicleCheck({
      shiftId: shift.id, vehicleUseId: vehicleUseAt(first), usageState: USAGE_STATE.inUse, checkId: "check-first", startedAt: at(5, 5),
      answers: defaults(checklistFor("class1")), completedAt: at(5, 10), completedBy: CERTIFIER,
    });
    await recordVehicleFill({
      shiftId: shift.id, vehicleUseId: vehicleUseAt(first), usageState: USAGE_STATE.inUse, fillId: "fuel-1",
      type: FILL_TYPE.fuel, recordedAt: at(6), litres: 300, note: "",
    });
    await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(first), endMileage: 100_100, next: OTHER, changedAt: at(9) });
    const middle = at(9).toISOString();
    await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(middle), endMileage: 220_050, next: { ...UNIT, startMileage: 100_200 }, changedAt: at(11) });
    const current = at(11).toISOString();
    await completeVehicleCheck({
      shiftId: shift.id, vehicleUseId: vehicleUseAt(current), usageState: USAGE_STATE.inUse, checkId: "check-current", startedAt: at(11, 5),
      answers: defaults(checklistFor("class1")), completedAt: at(11, 10), completedBy: CERTIFIER,
    });
    return { shift, first, middle, current };
  },
  revise: reviseVehicleCheck,
  draft: (shift, startedAt, state, checkId) => saveVehicleCheckDraft({
    shiftId: shift.id, vehicleUseId: vehicleUseAt(startedAt), usageState: state, checkId, startedAt: new Date(),
    answers: [{ key: "tyre-condition", result: CHECK_RESULT.defect, note: "draft" }],
  }),
  checksOf: async startedAt => (await findUse(startedAt))?.checks ?? [],
  factsOf: async startedAt => JSON.stringify({ ...(await findUse(startedAt)), checks: null }),
};

const TRAILER: Asset = {
  name: "Trailer Check",
  useAt: trailerUseAt,
  checklist: trailerChecklistFor(TRAILER_TYPE.refrigerated),
  day: async () => {
    const shift = await startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle: UNIT });
    await addTrailerToOpenShift({ shiftId: shift.id, trailer: TR23, startedAt: at(5, 30) });
    const first = at(5, 30).toISOString();
    await completeTrailerCheck({
      shiftId: shift.id, trailerUseId: trailerUseAt(first), usageState: USAGE_STATE.inUse, checkId: "check-first", startedAt: at(5, 35),
      answers: defaults(trailerChecklistFor(TRAILER_TYPE.refrigerated)), completedAt: at(5, 40), completedBy: CERTIFIER,
    });
    await recordReeferDiesel({ shiftId: shift.id, trailerUseId: trailerUseAt(first), usageState: USAGE_STATE.inUse, fillId: "diesel-1", recordedAt: at(6), litres: 40, note: "" });
    await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(first), next: GFD, changedAt: at(9) });
    const middle = at(9).toISOString();
    await changeTrailer({ shiftId: shift.id, endingUseId: trailerUseAt(middle), next: TR23, changedAt: at(11) });
    const current = at(11).toISOString();
    await completeTrailerCheck({
      shiftId: shift.id, trailerUseId: trailerUseAt(current), usageState: USAGE_STATE.inUse, checkId: "check-current", startedAt: at(11, 5),
      answers: defaults(trailerChecklistFor(TRAILER_TYPE.refrigerated)), completedAt: at(11, 10), completedBy: CERTIFIER,
    });
    return { shift, first, middle, current };
  },
  revise: reviseTrailerCheck,
  draft: (shift, startedAt, state, checkId) => saveTrailerCheckDraft({
    shiftId: shift.id, trailerUseId: trailerUseAt(startedAt), usageState: state, checkId, startedAt: new Date(),
    answers: [{ key: "tyre-condition", result: CHECK_RESULT.defect, note: "draft" }],
  }),
  checksOf: async startedAt => (await findUse(startedAt))?.checks ?? [],
  factsOf: async startedAt => JSON.stringify({ ...(await findUse(startedAt)), checks: null }),
};

function revision(asset: Asset, day: Day, over: Partial<CheckRevisionWrite> & { changes?: Record<string, { result: CheckAnswer["result"]; note?: string }> } = {}): CheckRevisionWrite {
  const { changes = { "tyre-condition": { result: CHECK_RESULT.defect, note: "Cut in sidewall" } }, ...rest } = over;
  return {
    shiftId: day.shift.id, useId: asset.useAt(day.first), usageState: USAGE_STATE.ended, checkId: "check-first",
    revisionId: newLocalId(), answers: withChanges(asset.checklist, changes), revisedAt: new Date(), revisedBy: DRIVER.user.id,
    ...rest,
  };
}
const rowOf = (items: VehicleCheck["items"], key: string) => items.find(item => item.key === key);
function effective(check: VehicleCheck | undefined): VehicleCheck["items"] {
  if (check === undefined) throw new Error("expected a check");
  return effectiveItems(check);
}

// ═══════════════════════════════════════════════════════════════════════════
// The store — for BOTH vehicle and trailer checks
// ═══════════════════════════════════════════════════════════════════════════

describe.each([VEHICLE, TRAILER])("$name — corrections", asset => {
  test("a completed check from BEFORE corrections loads with zero revisions, and reading it rewrites nothing", async () => {
    const day = await asset.day();
    const before = bytes();

    const [check] = await asset.checksOf(day.first);

    expect(check?.status).toBe("completed");
    expect(check?.revisions).toBeUndefined();
    expect(bytes()).toBe(before);
    expect(before).not.toContain("revisions");
  });

  test("OK → DEFECT with a description: the original stays EXACTLY as certified, and the revision is the effective result", async () => {
    const day = await asset.day();
    const [original] = await asset.checksOf(day.first);
    const before = Date.now();

    await asset.revise(revision(asset, day));

    const [check] = await asset.checksOf(day.first);
    // The certificate itself: untouched.
    expect(JSON.stringify(check?.items)).toBe(JSON.stringify(original?.items));
    expect(check?.completedAt).toBe(original?.completedAt);
    expect(check?.completedBy).toBe(CERTIFIER);
    // One revision, dated now, by the driver who made it, complete.
    expect(check?.revisions).toHaveLength(1);
    const [first] = check?.revisions ?? [];
    expect(Date.parse(first?.revisedAt ?? "")).toBeGreaterThanOrEqual(before);
    expect(first?.revisedBy).toBe(DRIVER.user.id);
    expect(first?.items).toHaveLength(checklistItems(asset.checklist).length);
    expect(first?.items.every(item => item.section !== undefined)).toBe(true);
    // What the check says now.
    expect(rowOf(effective(check), "tyre-condition")).toMatchObject({ result: "fail", note: "Cut in sidewall" });
    expect(checkStateOf(await asset.checksOf(day.first))).toBe("completed");
  });

  test("a SECOND correction keeps the first: DEFECT → OK, OK → N/A, and a description reworded", async () => {
    const day = await asset.day();
    await asset.revise(revision(asset, day));
    const firstRevision = JSON.stringify((await asset.checksOf(day.first))[0]?.revisions?.[0]);

    await asset.revise(revision(asset, day, { changes: {
      "tyre-condition": { result: CHECK_RESULT.ok },
      "tread-depth": { result: CHECK_RESULT.notApplicable },
    } }));
    await asset.revise(revision(asset, day, { changes: {
      "tread-depth": { result: CHECK_RESULT.notApplicable },
      "tyre-condition": { result: CHECK_RESULT.defect, note: "Bulge, nearside axle 2" },
    } }));

    const [check] = await asset.checksOf(day.first);
    expect(check?.revisions).toHaveLength(3);
    expect(JSON.stringify(check?.revisions?.[0])).toBe(firstRevision);
    expect(rowOf(check?.revisions?.[1]?.items ?? [], "tyre-condition")).toMatchObject({ result: "pass", note: null });
    expect(rowOf(check?.revisions?.[1]?.items ?? [], "tread-depth")).toMatchObject({ result: "na" });
    expect(rowOf(effective(check), "tyre-condition")).toMatchObject({ result: "fail", note: "Bulge, nearside axle 2" });
  });

  test("the whole history survives a restart — read from the file alone", async () => {
    const day = await asset.day();
    await asset.revise(revision(asset, day));
    await asset.revise(revision(asset, day, { changes: { "tyre-condition": { result: CHECK_RESULT.ok } } }));

    const onDisk = bytes();
    const [check] = await asset.checksOf(day.first);
    expect(check?.revisions?.map(entry => rowOf(entry.items, "tyre-condition")?.result)).toEqual(["fail", "pass"]);
    expect(onDisk).toContain("Cut in sidewall");
  });

  test("correcting usage A never touches A-again (same plate / number, in use) or anything else of either use", async () => {
    const day = await asset.day();
    const current = JSON.stringify(await asset.checksOf(day.current));
    const facts = await asset.factsOf(day.first);

    await asset.revise(revision(asset, day));

    expect(JSON.stringify(await asset.checksOf(day.current))).toBe(current);
    // Identity, class / type, times, mileage and fills of the corrected use: as they were.
    expect(await asset.factsOf(day.first)).toBe(facts);
  });

  test("the use IN USE is corrected when named as in use — and only it", async () => {
    const day = await asset.day();
    const first = JSON.stringify(await asset.checksOf(day.first));

    await asset.revise(revision(asset, day, { useId: asset.useAt(day.current), usageState: USAGE_STATE.inUse, checkId: "check-current" }));

    expect((await asset.checksOf(day.current))[0]?.revisions).toHaveLength(1);
    expect(JSON.stringify(await asset.checksOf(day.first))).toBe(first);
  });

  test.each([
    ["a use named as in use when it has ended", "first-as-in-use"],
    ["the use in use named as ended", "current-as-ended"],
    ["a plate / trailer number", "number"],
    ["a time no use began at", "2026-09-19T03:00:00.000Z"],
    ["nothing", ""],
  ])("ADVERSARIAL: %s corrects nothing, anywhere", async (_why, name) => {
    const day = await asset.day();
    const before = bytes();
    const target: Pick<CheckRevisionWrite, "useId" | "usageState"> =
      name === "first-as-in-use" ? { useId: asset.useAt(day.first), usageState: USAGE_STATE.inUse }
      : name === "current-as-ended" ? { useId: asset.useAt(day.current), usageState: USAGE_STATE.ended }
      : name === "number" ? { useId: asset === VEHICLE ? "AB12 CDE" : "TR23", usageState: USAGE_STATE.ended }
      : { useId: name, usageState: USAGE_STATE.ended };

    // The id of the check that DOES exist on the use in use: a lookup that fell
    // back to it would find something to write to.
    const result = await asset.revise(revision(asset, day, { ...target, checkId: "check-current" }));

    expect(result).toBeNull();
    expect(bytes()).toBe(before);
  });

  test("a correction that changes nothing, or is confirmed twice, writes ONE revision at most", async () => {
    const day = await asset.day();
    const before = bytes();

    await asset.revise(revision(asset, day, { changes: {} }));
    expect(bytes()).toBe(before);

    const once = revision(asset, day);
    await Promise.all([asset.revise(once), asset.revise(once), asset.revise(once)]);
    expect((await asset.checksOf(day.first))[0]?.revisions).toHaveLength(1);
  });

  test("a revision id already recorded is never recorded again — even with different answers, which would leave two revisions sharing an id and the certificate unreadable", async () => {
    const day = await asset.day();
    const first = revision(asset, day);
    await asset.revise(first);
    const before = bytes();

    await asset.revise({ ...first, answers: withChanges(asset.checklist, { "tread-depth": { result: CHECK_RESULT.notApplicable } }) });

    expect(bytes()).toBe(before);
    expect((await asset.checksOf(day.first))[0]?.revisions).toHaveLength(1);
    expect(checkStateOf(await asset.checksOf(day.first))).toBe("completed");
  });

  test("an undescribed defect, an unanswered row, or no driver is REFUSED — writing nothing", async () => {
    const day = await asset.day();
    const before = bytes();

    await expect(asset.revise(revision(asset, day, { changes: { "tyre-condition": { result: CHECK_RESULT.defect, note: "   " } } }))).rejects.toThrow(Error);
    await expect(asset.revise({ ...revision(asset, day), answers: defaults(asset.checklist).slice(1) })).rejects.toThrow(Error);
    await expect(asset.revise({ ...revision(asset, day), revisedBy: "" })).rejects.toThrow(Error);

    expect(bytes()).toBe(before);
  });

  test("a DRAFT is not corrected, and neither is a check that is not there — only a completed check has something to correct", async () => {
    const day = await asset.day();
    await asset.draft(day.shift, day.middle, USAGE_STATE.ended, "middle-draft");
    const before = bytes();

    const onDraft = await asset.revise(revision(asset, day, { useId: asset.useAt(day.middle), checkId: "middle-draft" }));
    const onNothing = await asset.revise(revision(asset, day, { checkId: "no-such-check" }));

    expect(onDraft?.status).toBe("draft");
    expect(onNothing).toBeNull();
    expect(bytes()).toBe(before);
  });

  test("malformed revision data fails CLOSED: the check is dropped and reads as not completed — never as a pass", async () => {
    const day = await asset.day();
    const broken = bytes().replace('"check-first",', '"check-first","revisions":[{"id":"r1","revisedAt":"not a time","revisedBy":"x","items":[]}],');
    new File(Paths.document, OPEN_SHIFT_FILE).write(broken);

    expect(checkStateOf(await asset.checksOf(day.first))).toBe("not-started");
    // The other, well-formed use of the same plate / number is unaffected.
    expect(checkStateOf(await asset.checksOf(day.current))).toBe("completed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The screens — Correct Check, Corrected, history, forgotten vehicle checks
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
async function mount(node: React.ReactElement): Promise<View> {
  const view = await render(<SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>);
  await waitFor(() => { expect(view.queryByTestId("screen-title") ?? view.queryByTestId("redirect")).not.toBeNull(); });
  return view;
}

function openCheck(asset: Asset, usage: string, usageState: UsageState): Promise<View> {
  if (asset === VEHICLE) {
    params.usage = vehicleUseAt(usage);
    params.usageState = usageState;
    return signedIn(<VehicleCheckRoute />);
  }
  params.trailer = trailerUseAt(usage);
  params.usageState = usageState;
  return signedIn(<TrailerCheckRoute />);
}

describe.each([VEHICLE, TRAILER])("$name — Correct Check on screen", asset => {
  test("a completed check offers Correct Check; correcting starts from its EFFECTIVE result and appends a revision", async () => {
    const day = await asset.day();
    await asset.revise(revision(asset, day));
    const view = await openCheck(asset, day.first, USAGE_STATE.ended);

    expect(view.queryByTestId("check-corrected")).not.toBeNull();
    await press(view, "correct-check");
    // Starts from the correction, not from the original or today's defaults.
    expect(String(view.getByTestId("check-note-tyre-condition").props.value)).toBe("Cut in sidewall");
    // Nothing changed yet: nothing to confirm.
    expect(view.getByTestId("confirm-correction").props.accessibilityState).toMatchObject({ disabled: true });

    await press(view, "check-tyre-condition-pass");
    await press(view, "confirm-correction");

    await waitFor(async () => { expect((await asset.checksOf(day.first))[0]?.revisions).toHaveLength(2); });
    const [check] = await asset.checksOf(day.first);
    expect(check?.revisions?.[1]?.revisedBy).toBe(DRIVER.user.id);
    expect(rowOf(effective(check), "tyre-condition")).toMatchObject({ result: "pass" });
    // Back to the read-only certificate, saying it was corrected, with its history.
    await waitFor(() => { expect(view.queryByTestId("correct-check")).not.toBeNull(); });
    expect(view.queryByTestId("check-history-original")).not.toBeNull();
    expect(view.queryByTestId("check-history-revision-1")).not.toBeNull();
    expect(text(view, "check-history-change-2-tyre-condition")).toContain("DEFECT → OK");
  });

  test("Cancel leaves the certificate exactly as it was", async () => {
    const day = await asset.day();
    const before = bytes();
    const view = await openCheck(asset, day.first, USAGE_STATE.ended);

    await press(view, "correct-check");
    await press(view, "check-tyre-condition-fail");
    await press(view, "cancel-correction");

    expect(bytes()).toBe(before);
    expect(view.queryByTestId("check-corrected")).toBeNull();
  });

  test("the use IN USE is corrected from its own check screen", async () => {
    const day = await asset.day();
    const view = asset === VEHICLE ? await signedIn(<VehicleCheckRoute />) : await openCheck(asset, day.current, USAGE_STATE.inUse);

    await press(view, "correct-check");
    await press(view, "check-tyre-condition-fail");
    await type(view, "check-note-tyre-condition", "Cut in sidewall");
    await press(view, "confirm-correction");

    await waitFor(async () => { expect((await asset.checksOf(day.current))[0]?.revisions).toHaveLength(1); });
    expect((await asset.checksOf(day.first))[0]?.revisions).toBeUndefined();
  });
});

test("Active Shift keeps saying the checks are COMPLETED after a correction — the detail screens say corrected", async () => {
  const vehicleDay = await VEHICLE.day();
  await VEHICLE.revise(revision(VEHICLE, vehicleDay, { useId: vehicleUseAt(vehicleDay.current), usageState: USAGE_STATE.inUse, checkId: "check-current" }));
  await VEHICLE.revise(revision(VEHICLE, vehicleDay));

  const active = await mount(<ActiveShiftRoute />);
  expect(text(active, "vehicle-checks-state")).toBe("Completed");
  await active.unmount();

  params.usage = vehicleUseAt(vehicleDay.first);
  const detail = await mount(<VehicleUsageRoute />);
  expect(text(detail, "usage-checks")).toBe("Completed · corrected");
});

test("a corrected ended trailer use still reads 'Checks completed' on its USED THIS SHIFT row, and 'corrected' in its detail", async () => {
  const day = await TRAILER.day();
  await TRAILER.revise(revision(TRAILER, day));

  const active = await mount(<ActiveShiftRoute />);
  expect(text(active, `trailer-usage-checks-${day.first}`)).toBe("Checks completed");
  await active.unmount();

  params.usage = trailerUseAt(day.first);
  const detail = await mount(<TrailerUsageRoute />);
  expect(text(detail, "trailer-usage-checks")).toBe("Completed · corrected");
  // Its defect list is the EFFECTIVE result.
  expect(detail.queryByTestId("trailer-usage-defect-tyre-condition")).not.toBeNull();
});

// ─── A Vehicle / Unit Check forgotten before the vehicle was handed back ────

async function vehicleDayUnchecked(): Promise<{ shift: LocalShift; first: string; second: string }> {
  const shift = await startLocalShift({ workingFor: { kind: "personal" }, startedAt: STARTED_AT, vehicle: UNIT });
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(STARTED_AT.toISOString()), endMileage: 100_100, next: OTHER, changedAt: at(9) });
  await changeVehicle({ shiftId: shift.id, endingUseId: vehicleUseAt(at(9).toISOString()), endMileage: 220_050, next: { ...UNIT, startMileage: 100_200 }, changedAt: at(11) });
  return { shift, first: STARTED_AT.toISOString(), second: at(9).toISOString() };
}

test("an ended vehicle use without a completed check offers it from its detail — for THAT use", async () => {
  const { first } = await vehicleDayUnchecked();
  params.usage = vehicleUseAt(first);
  const view = await mount(<VehicleUsageRoute />);

  expect(text(view, "usage-checks")).toBe("Not completed");
  await press(view, "usage-vehicle-checks");

  expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: "/vehicle-check", params: { usage: vehicleUseAt(first), usageState: "ended" } });
});

test("the forgotten Unit Check opens FRESH, writing nothing, and completes dated NOW — never backdated", async () => {
  const { first } = await vehicleDayUnchecked();
  const before = bytes();
  const view = await openCheck(VEHICLE, first, USAGE_STATE.ended);

  expect(text(view, "screen-title")).toBe("Unit Check");
  expect(text(view, "check-plate")).toBe("AB12 CDE");
  expect(bytes()).toBe(before);
  const pressedAt = Date.now();
  await press(view, "complete-check");

  await waitFor(async () => { expect(checkStateOf(await VEHICLE.checksOf(first))).toBe("completed"); });
  const [check] = await VEHICLE.checksOf(first);
  expect(Date.parse(check?.completedAt ?? "")).toBeGreaterThanOrEqual(pressedAt);
  expect(Date.parse(check?.completedAt ?? "")).toBeGreaterThan(at(9).getTime());
  expect(check?.completedBy).toBe(DRIVER.user.id);
  expect(mockRouter.back).toHaveBeenCalled();
  // The same plate's later use, in use now, is untouched.
  expect((await readOpenShift())?.vehicle?.checks).toEqual([]);
});

test("a DRAFT left on an ended vehicle use is resumed there, and a completed one reopens read-only with Correct Check", async () => {
  const { first } = await vehicleDayUnchecked();
  // A draft written while the unit was in use — then the unit was handed back.
  const day = JSON.parse(bytes()) as { previousVehicles: { startedAt: string; checks: unknown[] }[] };
  const list = checklistFor("class1");
  const target = day.previousVehicles.find(use => use.startedAt === first);
  if (target === undefined) throw new Error("expected the first use");
  target.checks = [{ id: "draft-1", checklist: list.id, checklistVersion: list.version, startedAt: at(5, 5).toISOString(),
    status: "draft", completedAt: null, completedBy: null, items: [{ key: "horn", label: "Horn", result: "fail", note: "Silent" }] }];
  new File(Paths.document, OPEN_SHIFT_FILE).write(JSON.stringify(day));

  const view = await openCheck(VEHICLE, first, USAGE_STATE.ended);
  expect(String(view.getByTestId("check-note-horn").props.value)).toBe("Silent");
  await press(view, "complete-check");
  await waitFor(async () => { expect(checkStateOf(await VEHICLE.checksOf(first))).toBe("completed"); });
  expect((await VEHICLE.checksOf(first))[0]?.id).toBe("draft-1");
  await view.unmount();

  const reopened = await openCheck(VEHICLE, first, USAGE_STATE.ended);
  expect(reopened.queryByTestId("complete-check")).toBeNull();
  expect(reopened.queryByTestId("correct-check")).not.toBeNull();
});

test("a forgotten vehicle check is never written to another use: a stale or wrong name writes nothing", async () => {
  const { shift, first, second } = await vehicleDayUnchecked();
  const before = bytes();

  const asInUse = await saveVehicleCheckDraft({
    shiftId: shift.id, vehicleUseId: vehicleUseAt(first), usageState: USAGE_STATE.inUse, checkId: "x", startedAt: new Date(),
    answers: [{ key: "horn", result: CHECK_RESULT.defect, note: "x" }],
  });
  const byPlate = await saveVehicleCheckDraft({
    shiftId: shift.id, vehicleUseId: vehicleUseAt("AB12 CDE"), usageState: USAGE_STATE.ended, checkId: "x", startedAt: new Date(),
    answers: [{ key: "horn", result: CHECK_RESULT.defect, note: "x" }],
  });
  expect([asInUse, byPlate]).toEqual([null, null]);
  expect(bytes()).toBe(before);

  // Completing the middle use leaves both AB12 uses alone.
  await completeVehicleCheck({
    shiftId: shift.id, vehicleUseId: vehicleUseAt(second), usageState: USAGE_STATE.ended, checkId: newLocalId(), startedAt: new Date(),
    answers: defaults(checklistFor("class1")), completedAt: new Date(), completedBy: DRIVER.user.id,
  });
  expect(await VEHICLE.checksOf(first)).toEqual([]);
  expect((await readOpenShift())?.vehicle?.checks).toEqual([]);
});

test.each([["a plate", "AB12 CDE"], ["the vehicle in use, as ended", "current"]])("the forgotten-check screen is not opened for %s", async (_why, name) => {
  await vehicleDayUnchecked();

  const view = await openCheck(VEHICLE, name === "current" ? at(11).toISOString() : name, USAGE_STATE.ended);

  expect(text(view, "redirect")).toBe("/active-shift");
});
