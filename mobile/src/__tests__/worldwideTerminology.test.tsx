/**
 * Worldwide vehicle terminology (D52, 2026-10-03).
 *
 * The product is for haulage and transport companies in any country, so the
 * driver sees no UK-only vocabulary:
 *
 *   vehicle types   "Articulated truck", "Rigid truck", "Van"
 *                   — not the UK licence categories "Class 1" / "Class 2"
 *   registration    "Vehicle registration" for the field, "Registration
 *                   number" for the value — not "number plate"
 *   the fluid       "AdBlue / DEF" — recognisable in Europe and North America
 *
 * These are LABELS. The three vehicle types keep their stored ids, so a
 * record written before the change still reads, as the new label. The fill
 * type keeps its stored id `adblue`. Checklist item wording is check content
 * and is deliberately out of scope here.
 */
import type { ReactElement } from "react";
import { render } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { VEHICLE_CLASSES, type VehicleClass } from "../shift/localShift";
import { FILL_TYPE, FILL_TYPES, fillTypeLabel } from "../shift/vehicleFill";
import { classLabel } from "../screens/format";
import { VehicleFields } from "../screens/vehicleForm";
import { CorrectNameScreen } from "../screens/CorrectNameScreen";

type View = Awaited<ReturnType<typeof render>>;

function allText(view: View): string {
  return JSON.stringify(view.toJSON());
}

const noop = (): void => undefined;

const METRICS = {
  frame:  { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function onPhone(element: ReactElement): ReturnType<typeof render> {
  return render(<SafeAreaProvider initialMetrics={METRICS}>{element}</SafeAreaProvider>);
}

describe("vehicle types", () => {
  test("the same three types, under the same stored ids, with worldwide names", () => {
    expect(VEHICLE_CLASSES.map(option => option.id)).toEqual(["class1", "class2", "van"]);
    expect(VEHICLE_CLASSES.map(option => option.label)).toEqual(["Articulated truck", "Rigid truck", "Van"]);
  });

  test("a record stored before the change reads under the new name", () => {
    const stored: VehicleClass[] = ["class1", "class2", "van"];
    expect(stored.map(classLabel)).toEqual(["Articulated truck", "Rigid truck", "Van"]);
  });

  test("the vehicle form offers the new names and no UK licence category", async () => {
    const view = await render(
      <VehicleFields vehicleClass={null} onVehicleClass={noop} numberPlate="" onNumberPlate={noop} mileage="" onMileage={noop} />,
    );
    for (const label of ["Articulated truck", "Rigid truck", "Van"]) expect(view.getByText(label)).toBeTruthy();
    expect(allText(view)).not.toMatch(/Class [12]/);
  });
});

describe("vehicle registration", () => {
  test("the vehicle form asks for the VEHICLE REGISTRATION, not a number plate", async () => {
    const view = await render(
      <VehicleFields vehicleClass={null} onVehicleClass={noop} numberPlate="" onNumberPlate={noop} mileage="" onMileage={noop} />,
    );
    expect(view.getByText("VEHICLE REGISTRATION")).toBeTruthy();
    expect(view.getByLabelText("Vehicle registration")).toBeTruthy();
    expect(allText(view)).not.toMatch(/number plate/i);
  });

  test("correcting a vehicle's value says REGISTRATION NUMBER", async () => {
    const view = await onPhone(
      <CorrectNameScreen asset="vehicle" current="AB12 CDE" onLeave={noop} onSave={() => Promise.resolve()} />,
    );
    expect(view.getByText("Correct registration number")).toBeTruthy();
    expect(view.getByLabelText("Registration number")).toBeTruthy();
    // Nor the bare word, in the hint under the field.
    expect(allText(view)).not.toMatch(/plate/i);
    expect(allText(view)).toMatch(/Only the registration number changes/);
  });

  test("a trailer is still corrected by its TRAILER number", async () => {
    const view = await onPhone(
      <CorrectNameScreen asset="trailer" current="C827" onLeave={noop} onSave={() => Promise.resolve()} />,
    );
    expect(view.getByText("Correct trailer number")).toBeTruthy();
  });
});

describe("AdBlue / DEF", () => {
  test("named for Europe and North America alike; stored under the same id", () => {
    expect(FILL_TYPE.adblue).toBe("adblue");
    expect(fillTypeLabel(FILL_TYPE.adblue)).toBe("AdBlue / DEF");
    expect(FILL_TYPES.find(entry => entry.id === FILL_TYPE.adblue)?.action).toBe("Add AdBlue / DEF");
    expect(fillTypeLabel(FILL_TYPE.fuel)).toBe("Fuel");
  });
});
