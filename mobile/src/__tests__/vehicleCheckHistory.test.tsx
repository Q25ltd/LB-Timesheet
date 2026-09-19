/**
 * A completed vehicle check is history.
 *
 * These cases certify a check under the checklist the app carries today, then
 * replace that checklist — for the store, the route and the screen alike —
 * with a later version that changes every kind of thing a checklist revision
 * can: a row added, a row retired, a row renamed, a row moved to another
 * section, a section retitled, a default changed. The certificate must read
 * exactly as it did when the driver signed it.
 *
 * The CONTROL case proves the later checklist really is live — a fresh check
 * IS laid out by it — so the historical cases cannot pass merely because the
 * substitution never took effect.
 */
import { render, fireEvent, act, waitFor, within } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Text, Pressable } from "react-native";
import { File, Paths } from "expo-file-system";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import type { AuthenticatedAccount } from "../api/account";
import VehicleCheckRoute from "../../app/(app)/vehicle-check";
import ActiveShiftRoute from "../../app/(app)/active-shift";
import { checklistFor, checklistItems, type Checklist } from "../shift/checklists";
import { clearOpenShift, OPEN_SHIFT_FILE, readOpenShift, startLocalShift } from "../shift/localShift";

/** The checklist every part of the app sees in place of today's, while set. */
let mockTomorrow: Checklist | null = null;

jest.mock("../shift/checklists", () => {
  const actual = jest.requireActual<typeof import("../shift/checklists")>("../shift/checklists");
  return {
    __esModule: true,
    ...actual,
    checklistFor: (vehicleClass: Parameters<typeof actual.checklistFor>[0]) =>
      (vehicleClass === "class1" && mockTomorrow !== null ? mockTomorrow : actual.checklistFor(vehicleClass)),
  };
});

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
    useFocusEffect: (effect: () => (() => void) | undefined) => { react.useEffect(effect, [effect]); },
  };
});

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const STARTED_AT = new Date(2026, 8, 13, 5, 42);

const DRIVER: AuthenticatedAccount = {
  user: { id: "user_1", firstName: "Nerijus", lastName: "Kuizinas", email: "driver@example.com" },
  identityToken: "identity.token.value",
  refreshToken: "refresh-secret-value",
  memberships: [],
};

type View = Awaited<ReturnType<typeof render>>;
type Queries = Pick<ReturnType<typeof within>, "queryAllByTestId">;

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

/** The rows listed, top to bottom, by key. */
const rowKeys = (queries: Queries) =>
  queries.queryAllByTestId(/^check-row-/).map(node => String(node.props.testID).slice("check-row-".length));
/** The sections listed, top to bottom, by id. */
const sectionIds = (queries: Queries) =>
  queries.queryAllByTestId(/^check-section-(?!toggle-|title-)/).map(node => String(node.props.testID).slice("check-section-".length));

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

async function openRoute(): Promise<View> {
  const view = await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AuthProvider><SignedIn><VehicleCheckRoute /></SignedIn></AuthProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => { expect(text(view, "status")).toBe("unauthenticated"); });
  await act(async () => { await fireEvent.press(view.getByTestId("authenticate")); });
  await waitFor(() => { expect(view.queryByTestId("complete-check") ?? view.queryByTestId("check-completed-at")).not.toBeNull(); });
  return view;
}

async function dayWithUnit(): Promise<void> {
  await startLocalShift({
    workingFor: { kind: "personal" },
    startedAt: STARTED_AT,
    vehicle: { vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 124_560 },
  });
}

/**
 * Certify a unit check today: one defect described, and one row the class
 * starts at N/A set to OK because this unit has the equipment. Everything else
 * is confirmed at its default. Returns the record as stored.
 */
async function certifyToday() {
  await dayWithUnit();
  const view = await openRoute();
  await press(view, "check-wipers-fail");
  await type(view, "check-note-wipers", "Nearside blade split.");
  await press(view, "check-hv-cut-off-pass");
  await press(view, "complete-check");
  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift"); });
  await view.unmount();
  const signed = (await readOpenShift())?.vehicle?.checks[0];
  if (signed?.status !== "completed") throw new Error("expected a completed check");
  return signed;
}

/**
 * The next revision of a checklist, changing every kind of thing a revision
 * can change.
 */
function tomorrowOf(today: Checklist): Checklist {
  const battery = checklistItems(today).find(entry => entry.key === "battery");
  if (battery === undefined) throw new Error("expected a battery row");
  return {
    ...today,
    version: today.version + 1,
    sections: today.sections.map(section => {
      const items = section.items
        .filter(entry => entry.key !== "horn")        // retired
        .filter(entry => entry.key !== "battery")     // moved out of POWER…
        .map(entry => (entry.key === "front-view" ? { ...entry, label: "Forward visibility" } : entry))  // renamed
        .map(entry => (entry.key === "other-equipment" ? { ...entry, defaultResult: "pass" as const } : entry)); // re-defaulted
      if (section.id === "cab") items.push({ key: "cab-heater", label: "Cab heater", defaultResult: "pass", dvsa: [27] }); // added
      if (section.id === "body") items.push(battery); // …and into BODY
      return { ...section, title: section.id === "brakes" ? "BRAKING SYSTEM" : section.title, items };
    }),
  };
}

beforeEach(async () => {
  mockTomorrow = null;
  await clearOpenShift();
  for (const fn of Object.values(mockRouter)) fn.mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });

test("CONTROL: tomorrow's checklist really is live — a fresh check is laid out by it", async () => {
  mockTomorrow = tomorrowOf(checklistFor("class1"));
  await dayWithUnit();

  const view = await openRoute();

  expect(view.getByTestId("check-row-cab-heater")).toBeTruthy();
  expect(view.queryByTestId("check-row-horn")).toBeNull();
  expect(view.getByText("Forward visibility")).toBeTruthy();
  expect(text(view, "check-section-title-brakes")).toBe("BRAKING SYSTEM");
  expect(within(view.getByTestId("check-section-body")).getByTestId("check-row-battery")).toBeTruthy();
  expect(stateOf(view, "check-other-equipment-pass").selected).toBe(true);
});

test("a check certified under today's checklist reads EXACTLY the same under tomorrow's", async () => {
  const today = checklistFor("class1");
  const signed = await certifyToday();

  mockTomorrow = tomorrowOf(today);
  const writes = jest.spyOn(File.prototype, "write");
  const view = await openRoute();

  // Only the rows certified, in the order certified: the retired row is still
  // there, the added row is not.
  expect(rowKeys(view)).toEqual(checklistItems(today).map(entry => entry.key));
  expect(view.getByTestId("check-row-horn")).toBeTruthy();
  expect(view.queryByTestId("check-row-cab-heater")).toBeNull();

  // Its sections, in their order, under their titles, holding what they held:
  // BRAKES is not retitled, and the battery has not moved.
  expect(sectionIds(view)).toEqual(today.sections.map(section => section.id));
  for (const section of today.sections) {
    expect(text(view, `check-section-title-${section.id}`)).toBe(section.title);
    expect(rowKeys(within(view.getByTestId(`check-section-${section.id}`)))).toEqual(section.items.map(entry => entry.key));
  }

  // The label the driver read, not tomorrow's.
  expect(within(view.getByTestId("check-row-front-view")).getByText("Front view")).toBeTruthy();
  expect(view.queryByText("Forward visibility")).toBeNull();

  // The results given — including a row left at a default tomorrow's
  // checklist has since changed — and the description as typed.
  expect(stateOf(view, "check-wipers-fail").selected).toBe(true);
  expect(text(view, "check-note-wipers")).toBe("Nearside blade split.");
  expect(stateOf(view, "check-hv-cut-off-pass").selected).toBe(true);
  expect(stateOf(view, "check-other-equipment-na").selected).toBe(true);
  for (const item of signed.items) expect(stateOf(view, `check-${item.key}-${item.result}`).selected).toBe(true);

  // Totals from the record alone: 37 OK became 38 with the high-voltage row,
  // then 37 with the wipers; 5 N/A became 4.
  expect(text(view, "summary-ok")).toBe("37 OK");
  expect(text(view, "summary-na")).toBe("4 N/A");
  expect(text(view, "summary-defects")).toBe("1 Defect");
  expect(text(view, "summary-total")).toBe("42 checks");
  expect(text(view, "check-status")).toBe("Completed");

  // Reading history wrote nothing, and the record is still the one signed.
  expect(writes).not.toHaveBeenCalled();
  expect((await readOpenShift())?.vehicle?.checks[0]).toEqual(signed);
});

test("under tomorrow's checklist, Active Shift still reads today's certificate as Completed", async () => {
  const today = checklistFor("class1");
  await certifyToday();

  mockTomorrow = tomorrowOf(today);
  const active = await render(<SafeAreaProvider initialMetrics={METRICS}><ActiveShiftRoute /></SafeAreaProvider>);

  await waitFor(() => { expect(active.queryByTestId("vehicle-checks-state")).not.toBeNull(); });
  expect(text(active, "vehicle-checks-state")).toBe("Completed");
});

test("a reopened certificate cannot be changed — and reopening it rewrites nothing", async () => {
  const signed = await certifyToday();
  const writes = jest.spyOn(File.prototype, "write");

  const view = await openRoute();

  expect(text(view, "check-status")).toBe("Completed");
  expect(view.queryByTestId("complete-check")).toBeNull();
  // Every choice on every row refuses a press…
  for (const item of signed.items) {
    for (const result of ["pass", "na", "fail"]) expect(stateOf(view, `check-${item.key}-${result}`).disabled).toBe(true);
  }
  await press(view, "check-wipers-pass");
  await press(view, "check-horn-fail");
  expect(stateOf(view, "check-wipers-fail").selected).toBe(true);
  expect(stateOf(view, "check-horn-pass").selected).toBe(true);
  // …and the description is text on the page, not a field.
  expect(view.getByTestId("check-note-wipers").type).toBe("Text");

  await press(view, "vehicle-check-back");
  await waitFor(() => { expect(mockRouter.dismissTo).toHaveBeenCalledWith("/active-shift"); });

  expect(writes).not.toHaveBeenCalled();
  const after = (await readOpenShift())?.vehicle?.checks[0];
  expect(after?.id).toBe(signed.id);
  expect(after?.completedAt).toBe(signed.completedAt);
  expect(after?.completedBy).toBe(signed.completedBy);
  expect(after).toEqual(signed);
});

// ═══════════════════════════════════════════════════════════════════════════
// Records completed before sections were stored
// ═══════════════════════════════════════════════════════════════════════════

/** Every row, label and result an earlier build wrote — and no layout. */
function recordedBeforeSections() {
  return checklistItems(checklistFor("class1")).map(entry => ({
    key: entry.key,
    label: entry.label,
    result: entry.key === "oil-leaks" ? "fail" : entry.defaultResult,
    note: entry.key === "oil-leaks" ? "Oil drip under engine." : null,
  }));
}

function storeDayWith(items: unknown[]): void {
  const file = new File(Paths.document, OPEN_SHIFT_FILE);
  file.create({ overwrite: true });
  file.write(JSON.stringify({
    id: "11111111-2222-4333-8444-555555555555", workingFor: { kind: "personal" },
    startedAt: STARTED_AT.toISOString(),
    vehicle: {
      vehicleClass: "class1", numberPlate: "AB12 CDE", startMileage: 124_560, startedAt: STARTED_AT.toISOString(),
      checks: [{
        id: "earlier-build", checklist: "hgv-unit", checklistVersion: 1, startedAt: STARTED_AT.toISOString(),
        status: "completed", completedAt: new Date(2026, 8, 13, 6, 2).toISOString(), completedBy: "user_1", items,
      }],
    },
    status: "open", createdAt: STARTED_AT.toISOString(),
  }));
}

test.each([
  ["today's checklist", false],
  ["tomorrow's checklist", true],
])("a record from before sections were stored is listed AS RECORDED under %s — no borrowed headings", async (_when, later) => {
  const today = checklistFor("class1");
  const recorded = recordedBeforeSections();
  storeDayWith(recorded);
  if (later) mockTomorrow = tomorrowOf(today);

  const view = await openRoute();

  // One list, under a heading that names no section.
  expect(sectionIds(view)).toEqual(["recorded"]);
  expect(text(view, "check-section-title-recorded")).toBe("ALL CHECKS");
  for (const section of [...today.sections, ...tomorrowOf(today).sections]) {
    expect(view.queryByTestId(`check-section-${section.id}`)).toBeNull();
    expect(view.queryByText(section.title)).toBeNull();
  }
  // Its rows, in its order, with its labels, results and description.
  expect(rowKeys(view)).toEqual(recorded.map(entry => entry.key));
  expect(within(view.getByTestId("check-row-front-view")).getByText("Front view")).toBeTruthy();
  expect(stateOf(view, "check-oil-leaks-fail").selected).toBe(true);
  expect(text(view, "check-note-oil-leaks")).toBe("Oil drip under engine.");
  expect(text(view, "summary-ok")).toBe("36 OK");
  expect(text(view, "summary-na")).toBe("5 N/A");
  expect(text(view, "summary-defects")).toBe("1 Defect");
  expect(text(view, "summary-total")).toBe("42 checks");
  expect(text(view, "check-status")).toBe("Completed");
});
