/**
 * D66 identifier lengths (owner decision, 2026-10-17): a vehicle registration
 * at most 16 characters, a trailer identifier at most 64 — counted as the
 * server counts them. A new entry over the limit is refused, said plainly and
 * never cut; one stored before the limits is kept exactly as it is.
 */
import type { ReactElement } from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { File } from "expo-file-system";
import {
  COMPLETED_SHIFT_FILE_PREFIX,
  IdentifierTooLongError,
  REGISTRATION_MAX_LENGTH,
  USAGE_STATE,
  addTrailerToOpenShift,
  clearOpenShift,
  correctNumberPlate,
  correctTrailerNumber,
  readCompletedShift,
  startLocalShift,
} from "../shift/localShift";
import { TRAILER_NUMBER_MAX_LENGTH } from "../shift/trailer";
import { CorrectNameScreen } from "../screens/CorrectNameScreen";
import { TrailerFields, trailerDetailsFrom } from "../screens/trailerForm";
import { VehicleFields, vehicleDetailsFrom } from "../screens/vehicleForm";
import { finishDeclared } from "./declared";
import { accountDirectoryOf, scopeFor } from "./testScope";

const SCOPE = scopeFor("user_limits_1");
const at = (hours: number) => new Date(2026, 9, 11, hours, 0);
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const onPhone = (element: ReactElement) => render(<SafeAreaProvider initialMetrics={METRICS}>{element}</SafeAreaProvider>);
const noop = () => undefined;

beforeEach(async () => {
  await clearOpenShift(SCOPE);
  for (const entry of accountDirectoryOf(SCOPE).list()) entry.delete();
});

test("IL1. the limits are the approved ones", () => {
  expect(REGISTRATION_MAX_LENGTH).toBe(16);
  expect(TRAILER_NUMBER_MAX_LENGTH).toBe(64);
});

test("IL2. the STORE takes a 16-character registration and refuses 17 — writing nothing; the same for a correction", async () => {
  await expect(startLocalShift(SCOPE, { workingFor: { kind: "personal" }, startedAt: at(6), vehicle: { vehicleClass: "class1", numberPlate: "B".repeat(17), startMileage: 1 } }))
    .rejects.toBeInstanceOf(IdentifierTooLongError);
  const open = await startLocalShift(SCOPE, { workingFor: { kind: "personal" }, startedAt: at(6), vehicle: { vehicleClass: "class1", numberPlate: "A".repeat(16), startMileage: 1 } });
  expect(open.vehicle?.numberPlate).toBe("A".repeat(16));
  const useId = open.vehicle?.useId ?? "";
  await expect(correctNumberPlate(SCOPE, { shiftId: open.id, useId, usageState: USAGE_STATE.inUse, value: "C".repeat(17) })).rejects.toBeInstanceOf(IdentifierTooLongError);
  // Spaces around it are not part of it: trimmed first, as stored.
  expect((await correctNumberPlate(SCOPE, { shiftId: open.id, useId, usageState: USAGE_STATE.inUse, value: ` ${"d".repeat(16)} ` }))?.vehicle?.numberPlate).toBe("D".repeat(16));
});

test("IL3. the STORE takes a 64-character trailer identifier and refuses 65 — writing nothing; the same for a correction", async () => {
  const open = await startLocalShift(SCOPE, { workingFor: { kind: "personal" }, startedAt: at(6), vehicle: { vehicleClass: "class1", numberPlate: "LY12 ABC", startMileage: 1 } });
  await expect(addTrailerToOpenShift(SCOPE, { shiftId: open.id, trailer: { trailerNumber: "U".repeat(65), trailerType: "standard" }, startedAt: at(7) }))
    .rejects.toBeInstanceOf(IdentifierTooLongError);
  const withTrailer = await addTrailerToOpenShift(SCOPE, { shiftId: open.id, trailer: { trailerNumber: "T".repeat(64), trailerType: "standard" }, startedAt: at(7) });
  expect(withTrailer?.trailer?.trailerNumber).toBe("T".repeat(64));
  await expect(correctTrailerNumber(SCOPE, { shiftId: open.id, useId: withTrailer?.trailer?.useId ?? "", usageState: USAGE_STATE.inUse, value: "V".repeat(65) }))
    .rejects.toBeInstanceOf(IdentifierTooLongError);
});

test("IL4. an identifier stored BEFORE the limits is kept exactly — read back whole, never cut", async () => {
  const open = await startLocalShift(SCOPE, { workingFor: { kind: "personal" }, startedAt: at(6), vehicle: { vehicleClass: "class1", numberPlate: "A".repeat(16), startMileage: 1 } });
  const done = await finishDeclared(SCOPE, { shiftId: open.id, vehicleUseId: open.vehicle?.useId ?? null, trailerUseId: null, finalMileage: 2, endedAt: at(16), nightOut: false, notes: "" });
  const file = new File(accountDirectoryOf(SCOPE), `${COMPLETED_SHIFT_FILE_PREFIX}${done?.id ?? ""}.json`);
  const legacy = "OLDPLATE-1234567890-XYZ";
  file.write(file.textSync().replace("A".repeat(16), legacy));

  const read = await readCompletedShift(SCOPE, done?.id ?? "");
  expect(read?.previousVehicles[0]?.numberPlate).toBe(legacy);
  expect(file.textSync()).toContain(legacy);
});

test("IL5. the FORMS: 16 / 64 go; 17 / 65 say so under the field and cannot be saved — the text the driver typed is left as typed", async () => {
  expect(vehicleDetailsFrom("class1", "A".repeat(16), "1", null)).not.toBeNull();
  expect(vehicleDetailsFrom("class1", "A".repeat(17), "1", null)).toBeNull();
  expect(trailerDetailsFrom("T".repeat(64), "standard")).not.toBeNull();
  expect(trailerDetailsFrom("T".repeat(65), "standard")).toBeNull();

  const plateProps = { vehicleClass: "class1" as const, onVehicleClass: noop, onNumberPlate: noop, mileage: "1", onMileage: noop, odometerUnit: null, unitNote: null };
  expect((await onPhone(<VehicleFields {...plateProps} numberPlate={"A".repeat(16)} />)).queryByTestId("number-plate-too-long")).toBeNull();
  const longPlate = await onPhone(<VehicleFields {...plateProps} numberPlate={"A".repeat(17)} />);
  expect(longPlate.getByTestId("number-plate-too-long").props.children).toBe("At most 16 characters — this has 17.");
  expect(longPlate.getByTestId("number-plate").props.value).toBe("A".repeat(17));

  expect((await onPhone(<TrailerFields trailerNumber={"T".repeat(64)} onTrailerNumber={noop} trailerType="standard" onTrailerType={noop} />)).queryByTestId("trailer-number-too-long")).toBeNull();
  const longTrailer = await onPhone(<TrailerFields trailerNumber={"T".repeat(65)} onTrailerNumber={noop} trailerType="standard" onTrailerType={noop} />);
  expect(longTrailer.getByTestId("trailer-number-too-long").props.children).toBe("At most 64 characters — this has 65.");
});

test("IL6. CORRECTING a name: over the limit cannot be saved, and says why; at the limit it can", async () => {
  const saved: string[] = [];
  const view = await onPhone(<CorrectNameScreen asset="vehicle" current="AB12 CDE" onLeave={noop} onSave={value => { saved.push(value); return Promise.resolve(); }} />);
  await fireEvent.changeText(view.getByTestId("correct-name-input"), "Z".repeat(17));
  expect(view.getByTestId("correct-name-too-long")).toBeTruthy();
  expect(view.getByTestId("correct-name-save").props).toMatchObject({ accessibilityState: { disabled: true } });
  await fireEvent.press(view.getByTestId("correct-name-save"));
  expect(saved).toEqual([]);

  await fireEvent.changeText(view.getByTestId("correct-name-input"), "Z".repeat(16));
  expect(view.queryByTestId("correct-name-too-long")).toBeNull();
  await fireEvent.press(view.getByTestId("correct-name-save"));
  expect(saved).toEqual(["Z".repeat(16)]);
});
