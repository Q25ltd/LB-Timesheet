/**
 * D66, stage S1 — measurement units on the phone (D52).
 *
 * Every odometer reading and every fuel quantity is stored WITH the unit it
 * was recorded in: a company's day the company's, a Personal day the
 * driver's own. Fixed when recorded; never converted, never relabelled. A
 * reading from before units has NO unit and is shown as the bare number. A
 * fuel quantity from before units was entered under a field labelled LITRES,
 * so it reads as litres — and is never rewritten, so a timesheet declared
 * before units keeps exactly the version it was declared at (D42).
 */
import { render, fireEvent, act } from "@testing-library/react-native";
import { File } from "expo-file-system";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { isAuthenticatedAccount, type AccountMembership } from "../api/account";
import { PersonalUnits } from "../components/PersonalUnits";
import { fillSummaryText, formatOdometer, formatQuantity } from "../screens/format";
import { StartShiftScreen } from "../screens/StartShiftScreen";
import { VehicleFillScreen, type FillEntry } from "../screens/VehicleFillScreen";
import {
  OPEN_SHIFT_FILE,
  USAGE_STATE,
  clearOpenShift,
  correctOpenShift,
  newLocalId,
  readOpenShift,
  recordVehicleFill,
  startLocalShift,
  type VehicleDetails,
  type WorkingContext,
} from "../shift/localShift";
import { recordingUnits, unsetUnitsText } from "../shift/recordingUnits";
import { UNIT_PREFERENCES_FILE, readUnitPreferences, saveUnitPreferences } from "../shift/unitPreferences";
import { FILL_TYPE, fillAmount, summariseFills, type FillRecord, type VehicleFill } from "../shift/vehicleFill";
import type { VolumeUnit } from "../shift/units";
import { accountDirectoryOf, scopeFor } from "./testScope";

const SCOPE = scopeFor("user_units_1");
const OTHER = scopeFor("user_units_2");
jest.mock("../shift/useAccountScope", () => ({ useAccountScope: () => mockScope }));
const mockScope = SCOPE;

const METRICS = { frame: { x: 0, y: 0, width: 402, height: 874 }, insets: { top: 62, left: 0, right: 0, bottom: 34 } };
const KM_CO: AccountMembership = { membershipId: "m_km", companyId: "c_km", companyName: "Baltic Freight", role: "driver", distanceUnit: "kilometre", volumeUnit: "litre" };
const US_CO: AccountMembership = { membershipId: "m_us", companyId: "c_us", companyName: "Ohio Haulers", role: "driver", distanceUnit: "mile", volumeUnit: "us_gallon" };
const UNSET_CO: AccountMembership = { membershipId: "m_none", companyId: "c_none", companyName: "Unset Ltd", role: "driver", distanceUnit: null, volumeUnit: null };
const forCompany = (m: AccountMembership): WorkingContext => ({ kind: "company", membershipId: m.membershipId, companyId: m.companyId, companyName: m.companyName });
const PERSONAL: WorkingContext = { kind: "personal" };
const at = (hours: number) => new Date(2026, 9, 11, hours, 0);
const LORRY = { vehicleClass: "class1" as const, numberPlate: "LY12 ABC", startMileage: 120_000 };

const openFile = () => new File(accountDirectoryOf(SCOPE), OPEN_SHIFT_FILE);
function storeRaw(document: unknown): string {
  const file = openFile();
  file.create({ overwrite: true });
  const bytes = JSON.stringify(document);
  file.write(bytes);
  return bytes;
}

beforeEach(async () => {
  await clearOpenShift(SCOPE);
  for (const scope of [SCOPE, OTHER]) {
    const preferences = new File(accountDirectoryOf(scope), UNIT_PREFERENCES_FILE);
    if (preferences.exists) preferences.delete();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Where a unit comes from
// ═══════════════════════════════════════════════════════════════════════════

test("MU1. the account's memberships carry their company's units; a unit the app does not know is refused, never guessed; absent (an older server) is none", () => {
  const account = (membership: object) => ({ user: { id: "u", firstName: "A", lastName: "B", email: "a@b.c" }, identityToken: "t", refreshToken: "r", memberships: [membership] });
  expect(isAuthenticatedAccount(account(KM_CO))).toBe(true);
  expect(isAuthenticatedAccount(account(UNSET_CO))).toBe(true);
  expect(isAuthenticatedAccount(account({ membershipId: "m", companyId: "c", companyName: "Old", role: "driver" }))).toBe(true);
  expect(isAuthenticatedAccount(account({ ...KM_CO, distanceUnit: "furlong" }))).toBe(false);
  expect(isAuthenticatedAccount(account({ ...KM_CO, volumeUnit: "gallon" }))).toBe(false);
});

test("MU2. a company's day records in the COMPANY's units; a Personal day in the driver's own; otherwise none — and says why", () => {
  const preferences = { distanceUnit: "mile" as const, volumeUnit: "imperial_gallon" as const };
  expect(recordingUnits(forCompany(KM_CO), [KM_CO, US_CO], preferences)).toEqual({ distanceUnit: "kilometre", volumeUnit: "litre", unset: null });
  expect(recordingUnits(forCompany(US_CO), [KM_CO, US_CO], preferences)).toEqual({ distanceUnit: "mile", volumeUnit: "us_gallon", unset: null });
  expect(recordingUnits(PERSONAL, [KM_CO], preferences)).toEqual({ distanceUnit: "mile", volumeUnit: "imperial_gallon", unset: null });

  const unsetCompany = recordingUnits(forCompany(UNSET_CO), [UNSET_CO], preferences);
  expect(unsetCompany).toMatchObject({ distanceUnit: null, volumeUnit: null });
  expect(unsetUnitsText(unsetCompany.unset)).toMatch(/Unset Ltd has not chosen its units/);
  // A company no longer among the account's companies: its units are not known — never the driver's own.
  expect(recordingUnits(forCompany(KM_CO), [US_CO], preferences)).toMatchObject({ distanceUnit: null, volumeUnit: null });
  const unsetPersonal = recordingUnits(PERSONAL, [], { distanceUnit: null, volumeUnit: null });
  expect(unsetPersonal).toMatchObject({ distanceUnit: null, volumeUnit: null });
  expect(unsetUnitsText(unsetPersonal.unset)).toMatch(/Choose them in Settings/);
});

test("MU3. the driver's own units belong to THEIR account only; an unreadable file is unset, never a guessed unit", () => {
  expect(readUnitPreferences(SCOPE)).toEqual({ distanceUnit: null, volumeUnit: null });
  saveUnitPreferences(SCOPE, { distanceUnit: "kilometre", volumeUnit: "litre" });
  expect(readUnitPreferences(SCOPE)).toEqual({ distanceUnit: "kilometre", volumeUnit: "litre" });
  // Another driver on the same phone has none.
  expect(readUnitPreferences(OTHER)).toEqual({ distanceUnit: null, volumeUnit: null });

  const file = new File(accountDirectoryOf(SCOPE), UNIT_PREFERENCES_FILE);
  file.write("{ not json");
  expect(readUnitPreferences(SCOPE)).toEqual({ distanceUnit: null, volumeUnit: null });
  expect(() => { saveUnitPreferences(SCOPE, { distanceUnit: "furlong" as never, volumeUnit: "litre" }); }).toThrow();
});

// ═══════════════════════════════════════════════════════════════════════════
// Odometer readings
// ═══════════════════════════════════════════════════════════════════════════

test("MU4. a vehicle use keeps the unit it was RECORDED in — a later change of who the day is for never relabels it", async () => {
  const shift = await startLocalShift(SCOPE, { workingFor: forCompany(KM_CO), startedAt: at(6), vehicle: { ...LORRY, odometerUnit: "kilometre" } });
  expect((await readOpenShift(SCOPE))?.vehicle?.odometerUnit).toBe("kilometre");

  await correctOpenShift(SCOPE, { shiftId: shift.id, workingFor: forCompany(US_CO), startedAt: at(6) });

  const day = await readOpenShift(SCOPE);
  expect(day?.workingFor).toMatchObject({ membershipId: US_CO.membershipId });
  expect(day?.vehicle?.odometerUnit).toBe("kilometre");
});

test("MU5. a reading with no unit set is stored WITHOUT one — absent, never null and never a default", async () => {
  await startLocalShift(SCOPE, { workingFor: PERSONAL, startedAt: at(6), vehicle: LORRY });

  const stored = JSON.parse(openFile().textSync()) as { vehicle: Record<string, unknown> };
  expect(Object.keys(stored.vehicle)).not.toContain("odometerUnit");
  expect((await readOpenShift(SCOPE))?.vehicle).not.toHaveProperty("odometerUnit");
});

test("MU6. a day saved BEFORE units reads with no unit, shows the bare number, and is not rewritten by reading", async () => {
  const bytes = storeRaw({
    ownerUserId: SCOPE.userId, id: "11111111-2222-4333-8444-555555555555", workingFor: PERSONAL,
    startedAt: at(6).toISOString(), status: "open", createdAt: at(6).toISOString(),
    vehicle: { ...LORRY, useId: "use-old", startedAt: at(6).toISOString(), checks: [], fills: [] },
    previousVehicles: [], trailer: null, previousTrailers: [],
  });

  const day = await readOpenShift(SCOPE);

  expect(day?.vehicle?.odometerUnit).toBeUndefined();
  expect(formatOdometer(day?.vehicle?.startMileage ?? -1, day?.vehicle?.odometerUnit)).toBe("120,000");
  expect(openFile().textSync()).toBe(bytes);
});

test("MU7. a stored unit that is not one is a broken record — the day fails closed rather than guessing", async () => {
  storeRaw({
    ownerUserId: SCOPE.userId, id: "11111111-2222-4333-8444-555555555556", workingFor: PERSONAL,
    startedAt: at(6).toISOString(), status: "open", createdAt: at(6).toISOString(),
    vehicle: { ...LORRY, odometerUnit: "verst", useId: "use-x", startedAt: at(6).toISOString(), checks: [], fills: [] },
    previousVehicles: [], trailer: null, previousTrailers: [],
  });
  expect(await readOpenShift(SCOPE)).toBeNull();
});

test("MU8. readings show the unit they carry: km, mi — never another's", () => {
  expect(formatOdometer(184_203, "kilometre")).toBe("184,203 km");
  expect(formatOdometer(184_203, "mile")).toBe("184,203 mi");
  expect(formatOdometer(184_203, undefined)).toBe("184,203");
});

// ═══════════════════════════════════════════════════════════════════════════
// Fuel quantities
// ═══════════════════════════════════════════════════════════════════════════

async function dayWithLorry(details: VehicleDetails = { ...LORRY, odometerUnit: "kilometre" }) {
  const shift = await startLocalShift(SCOPE, { workingFor: PERSONAL, startedAt: at(6), vehicle: details });
  const open = await readOpenShift(SCOPE);
  return { shiftId: shift.id, vehicleUseId: open?.vehicle?.useId ?? "", usageState: USAGE_STATE.inUse };
}

test("MU9. a new fill is stored as a QUANTITY with its unit — US gallons as readily as litres; an unknown amount is null, never 0", async () => {
  const named = await dayWithLorry();
  await recordVehicleFill(SCOPE, { ...named, fillId: newLocalId(), type: FILL_TYPE.fuel, recordedAt: at(9), quantity: 52.5, volumeUnit: "us_gallon", note: "" });
  await recordVehicleFill(SCOPE, { ...named, fillId: newLocalId(), type: FILL_TYPE.adblue, recordedAt: at(10), quantity: null, volumeUnit: "us_gallon", note: "" });

  const stored = (JSON.parse(openFile().textSync()) as { vehicle: { fills: Record<string, unknown>[] } }).vehicle.fills;
  expect(stored.map(fill => ({ quantity: fill["quantity"], volumeUnit: fill["volumeUnit"], litres: fill["litres"] }))).toEqual([
    { quantity: 52.5, volumeUnit: "us_gallon", litres: undefined },
    { quantity: null, volumeUnit: "us_gallon", litres: undefined },
  ]);
  await expect(recordVehicleFill(SCOPE, { ...named, fillId: newLocalId(), type: FILL_TYPE.fuel, recordedAt: at(11), quantity: 10, volumeUnit: "gallon" as never, note: "" })).rejects.toThrow();
});

test("MU10. a fill from BEFORE units reads as litres — the form said LITRES — with that provenance, and the file is not rewritten by reading", async () => {
  const legacy = { id: "fill-old", type: "fuel", recordedAt: at(9).toISOString(), litres: 300, note: null };
  const bytes = storeRaw({
    ownerUserId: SCOPE.userId, id: "11111111-2222-4333-8444-555555555557", workingFor: PERSONAL,
    startedAt: at(6).toISOString(), status: "open", createdAt: at(6).toISOString(),
    vehicle: { ...LORRY, useId: "use-old", startedAt: at(6).toISOString(), checks: [], fills: [legacy] },
    previousVehicles: [], trailer: null, previousTrailers: [],
  });

  const [fill] = (await readOpenShift(SCOPE))?.vehicle?.fills ?? [];
  if (fill === undefined) throw new Error("the legacy fill was not read");

  expect(fillAmount(fill)).toEqual({ quantity: 300, unit: "litre", source: "legacy-litres-label" });
  expect(fill).toEqual(legacy);
  expect(openFile().textSync()).toBe(bytes);
});

test("MU11. a fill carrying BOTH shapes, or neither, is a broken record — the day fails closed", async () => {
  for (const broken of [
    { id: "f1", type: "fuel", recordedAt: at(9).toISOString(), litres: 300, quantity: 300, volumeUnit: "litre", note: null },
    { id: "f2", type: "fuel", recordedAt: at(9).toISOString(), note: null },
    { id: "f3", type: "fuel", recordedAt: at(9).toISOString(), quantity: 300, note: null },
  ]) {
    storeRaw({
      ownerUserId: SCOPE.userId, id: "11111111-2222-4333-8444-555555555558", workingFor: PERSONAL,
      startedAt: at(6).toISOString(), status: "open", createdAt: at(6).toISOString(),
      vehicle: { ...LORRY, useId: "use-old", startedAt: at(6).toISOString(), checks: [], fills: [broken] },
      previousVehicles: [], trailer: null, previousTrailers: [],
    });
    expect(await readOpenShift(SCOPE)).toBeNull();
  }
});

test("MU12. totals are PER UNIT and never converted; unknown amounts are counted, never valued", () => {
  const fill = (over: { quantity: number | null; volumeUnit: VolumeUnit | null }): VehicleFill => ({ id: newLocalId(), recordedAt: at(9).toISOString(), note: null, type: "fuel", ...over });
  const mixed = [
    fill({ quantity: 300, volumeUnit: "litre" }),
    { id: "old", recordedAt: at(8).toISOString(), note: null, type: "fuel" as const, litres: 50 },
    fill({ quantity: 20, volumeUnit: "us_gallon" }),
    fill({ quantity: null, volumeUnit: "litre" }),
  ];
  const summary = summariseFills(mixed, FILL_TYPE.fuel);
  expect(summary).toEqual({ count: 4, known: [{ unit: "litre", total: 350 }, { unit: "us_gallon", total: 20 }], unknownCount: 1 });
  expect(fillSummaryText(summary)).toEqual({ amount: "350 L + 20 US gal known", detail: "1 amount unknown" });
  expect(formatQuantity(12.5, null)).toBe("12.5 (no unit set)");
  expect(formatQuantity(12.5, "imperial_gallon")).toBe("12.5 imp gal");
});

// ═══════════════════════════════════════════════════════════════════════════
// The screens
// ═══════════════════════════════════════════════════════════════════════════

type View = Awaited<ReturnType<typeof render>>;
const wrap = (node: React.ReactElement) => render(<SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>);
const press = async (view: View, id: string) => { await act(async () => { await fireEvent.press(view.getByTestId(id)); }); };

test("MU13. the fuel form is labelled in the day's unit, and a new entry is stored in it", async () => {
  const saved: FillEntry[] = [];
  const view = await wrap(
    <VehicleFillScreen label="Fuel" asset="vehicle" usage={{ name: "LY12 ABC", hours: null, fills: [] }} volumeUnit="us_gallon" unitNote={null}
      onLeave={() => undefined} onSave={entry => { saved.push(entry); return Promise.resolve(); }} onRemove={() => Promise.resolve()} />,
  );
  await press(view, "amount-known");
  expect(view.getByText("US GALLONS")).toBeTruthy();
  await act(async () => { await fireEvent.changeText(view.getByTestId("quantity"), "52,5"); });
  await press(view, "fill-save");
  expect(saved).toMatchObject([{ quantity: 52.5, volumeUnit: "us_gallon" }]);
});

test("MU14. with no unit set the form says QUANTITY and why — and a correction keeps the FILL's own unit, a legacy one litres", async () => {
  const saved: FillEntry[] = [];
  const legacy: FillRecord = { id: "old", recordedAt: at(9).toISOString(), note: null, litres: 300 };
  const view = await wrap(
    <VehicleFillScreen label="Fuel" asset="vehicle" usage={{ name: "LY12 ABC", hours: null, fills: [legacy] }} volumeUnit={null}
      unitNote="You have not chosen your units for Personal days, so this is recorded without a unit. Choose them in Settings."
      onLeave={() => undefined} onSave={entry => { saved.push(entry); return Promise.resolve(); }} onRemove={() => Promise.resolve()} />,
  );
  await press(view, "amount-known");
  expect(view.getByText("QUANTITY")).toBeTruthy();
  expect(String(view.getByTestId("quantity-unit-hint").props.children)).toMatch(/Choose them in Settings/);
  expect(view.getByText("300 L")).toBeTruthy();

  await press(view, "fill-old");
  expect(view.getByText("LITRES")).toBeTruthy();
  await act(async () => { await fireEvent.changeText(view.getByTestId("quantity"), "310"); });
  await press(view, "fill-save");
  expect(saved).toMatchObject([{ fillId: "old", quantity: 310, volumeUnit: "litre" }]);
});

test("MU15. Start Shift records the start reading in the units of whoever the day is for — chosen there and then", async () => {
  const started: { workingFor: WorkingContext; vehicle: VehicleDetails | null }[] = [];
  const view = await wrap(
    <StartShiftScreen memberships={[KM_CO]} onBack={() => undefined}
      unitsFor={working => recordingUnits(working, [KM_CO], { distanceUnit: null, volumeUnit: null })}
      onStart={input => { started.push(input); }} />,
  );
  await press(view, `working-for-${KM_CO.membershipId}`);
  await press(view, "vehicle-yes");
  expect(view.getByText("START MILEAGE (KM)")).toBeTruthy();
  await press(view, "vehicle-class-class1");
  await act(async () => { await fireEvent.changeText(view.getByTestId("number-plate"), "ly12 abc"); });
  await act(async () => { await fireEvent.changeText(view.getByTestId("start-mileage"), "120000"); });

  // Personal, with no units of the driver's own: no unit, and the driver is told how to set one.
  await press(view, "working-for-personal");
  expect(view.getByText("START MILEAGE")).toBeTruthy();
  expect(String(view.getByTestId("start-mileage-unit-hint").props.children)).toMatch(/Personal days/);
  await press(view, `working-for-${KM_CO.membershipId}`);
  await press(view, "start-shift-submit");

  expect(started[0]?.vehicle).toEqual({ vehicleClass: "class1", numberPlate: "LY12 ABC", startMileage: 120_000, odometerUnit: "kilometre" });
});

test("MU16. Settings: the driver chooses units for Personal days — saved once both are chosen, for this account only", async () => {
  const view = await wrap(<PersonalUnits />);
  await press(view, "personal-distance-kilometre");
  expect(String(view.getByTestId("personal-units-message").props.children)).toMatch(/choose both/i);
  expect(readUnitPreferences(SCOPE)).toEqual({ distanceUnit: null, volumeUnit: null });

  await press(view, "personal-volume-imperial_gallon");

  expect(readUnitPreferences(SCOPE)).toEqual({ distanceUnit: "kilometre", volumeUnit: "imperial_gallon" });
  expect(String(view.getByTestId("personal-units-message").props.children)).toMatch(/saved/i);
  expect(readUnitPreferences(OTHER)).toEqual({ distanceUnit: null, volumeUnit: null });
});
