/**
 * D66 S6 — the snapshot a company's day is sent as: built from the version
 * the driver declared, in the server's schema exactly, deterministic, and
 * never for a Personal day. Identifiers stored before the limits are never
 * cut — the day says what to correct.
 */
import { checklistFor, checklistItems, trailerChecklistFor } from "../shift/checklists";
import { timesheetVersion, type CompletedShift, type WorkingContext } from "../shift/localShift";
import type { VehicleCheck } from "../shift/vehicleCheck";
import { buildSnapshot } from "../sync/timesheetSnapshot";

const COMPANY: WorkingContext = { kind: "company", membershipId: "m_north", companyId: "c_north", companyName: "Northgate Haulage" };
const START = "2026-10-11T04:00:00.000Z";
const END = "2026-10-11T14:00:00.000Z";

function certified(over: Partial<VehicleCheck> = {}): VehicleCheck {
  const checklist = checklistFor("class1");
  return {
    id: "c1", checklist: checklist.id, checklistVersion: checklist.version, startedAt: START, status: "completed",
    completedAt: "2026-10-11T04:10:00.000Z", completedBy: "u1",
    items: checklistItems(checklist).map(entry => ({
      key: entry.key, label: entry.label, result: entry.key === "wipers" ? "fail" : "pass",
      note: entry.key === "wipers" ? "Nearside blade split" : null,
    })),
    ...over,
  };
}

function day(over: Partial<CompletedShift> = {}, workingFor: WorkingContext = COMPANY): CompletedShift {
  const base: CompletedShift = {
    ownerUserId: "u1", id: "a1111111-2222-4333-8444-555555555555", workingFor, startedAt: START, endedAt: END,
    nightOut: true, notes: "Waited at the depot", status: "completed", createdAt: END,
    previousVehicles: [{
      useId: "v1", vehicleClass: "class1", numberPlate: "LY12 ABC", startMileage: 120_000, odometerUnit: "kilometre",
      startedAt: START, endMileage: 120_350, endedAt: END, endedBy: "finish",
      fills: [
        { id: "f1", type: "fuel", recordedAt: "2026-10-11T09:00:00.000Z", note: null, quantity: 310.5, volumeUnit: "litre" },
        { id: "f2", type: "adblue", recordedAt: "2026-10-11T09:05:00.000Z", note: "Pump 4", litres: 20 },
      ],
      checks: [certified()],
    }],
    previousTrailers: [{
      useId: "t1", trailerNumber: "TR-23", trailerType: "refrigerated", startedAt: "2026-10-11T05:00:00.000Z", endedAt: END, endedBy: "finish",
      reeferDiesel: [{ id: "d1", recordedAt: "2026-10-11T11:00:00.000Z", note: null, quantity: null, volumeUnit: "litre" }],
      checks: [{
        id: "c2", checklist: trailerChecklistFor("refrigerated").id, checklistVersion: 1, startedAt: "2026-10-11T05:05:00.000Z",
        status: "draft", completedAt: null, completedBy: null,
        items: [{ key: "lights", label: "Lights", result: "fail", note: "  Offside out  " }],
      }],
    }],
    ...over,
  };
  return { ...base, declaration: { version: timesheetVersion(base), declaredAt: END, declaredBy: "u1" } };
}

test("SB1. a declared company's day is the server's schema exactly: facts, uses, readings in their unit, fills with unit and provenance, checks, the declaration", () => {
  const built = buildSnapshot(day());
  expect(built.kind).toBe("ok");
  if (built.kind !== "ok") return;
  expect(built.membershipId).toBe("m_north");
  expect(built.companyName).toBe("Northgate Haulage");
  const snapshot = built.snapshot as {
    schemaVersion: number; day: unknown; declaration: unknown;
    vehicles: { registration: string; odometerUnit: unknown; endedBy: unknown; fills: unknown[]; checks: { items: { section: unknown }[] }[] }[];
    trailers: { trailerNumber: string; fridgeDiesel: unknown[]; checks: { status: string; items: { note: unknown }[] }[] }[];
  };
  expect(snapshot.schemaVersion).toBe(1);
  expect(snapshot.day).toEqual({ startedAt: START, endedAt: END, nightOut: true, notes: "Waited at the depot" });
  expect(snapshot.declaration).toEqual({ version: day().declaration?.version, declaredAt: END });
  const [unit] = snapshot.vehicles;
  expect(unit?.registration).toBe("LY12 ABC");
  expect(unit?.odometerUnit).toBe("kilometre");
  expect(unit?.endedBy).toBe("finish");
  expect(unit?.fills).toEqual([
    { id: "f1", recordedAt: "2026-10-11T09:00:00.000Z", quantity: 310.5, unit: "litre", unitSource: "recorded", note: null, type: "fuel" },
    { id: "f2", recordedAt: "2026-10-11T09:05:00.000Z", quantity: 20, unit: "litre", unitSource: "legacy-litres-label", note: "Pump 4", type: "adblue" },
  ]);
  expect(unit?.checks[0]?.items[0]?.section).toBeNull();
  const [trailer] = snapshot.trailers;
  expect(trailer?.fridgeDiesel).toEqual([{ id: "d1", recordedAt: "2026-10-11T11:00:00.000Z", quantity: null, unit: "litre", unitSource: "recorded", note: null }]);
  // A draft's description is sent trimmed — whitespace is all that changes.
  expect(trailer?.checks[0]?.items[0]?.note).toBe("Offside out");
});

test("SB2. a Personal day is never a submission; a company day not declared, or changed since, is declared first", () => {
  expect(buildSnapshot(day({}, { kind: "personal" })).kind).toBe("personal");
  const undeclared: CompletedShift = { ...day() };
  delete undeclared.declaration;
  expect(buildSnapshot(undeclared).kind).toBe("undeclared");
  expect(buildSnapshot({ ...day(), nightOut: false }).kind).toBe("undeclared");
});

test("SB3. an identifier stored before the limits is NEVER cut: 17 / 65 say what to correct, with the full value; 16 / 64 go", () => {
  const plate = (numberPlate: string) => day({ previousVehicles: day().previousVehicles.map(use => ({ ...use, numberPlate })) });
  const trailer = (trailerNumber: string) => day({ previousTrailers: day().previousTrailers.map(use => ({ ...use, trailerNumber })) });

  expect(buildSnapshot(plate("A".repeat(16))).kind).toBe("ok");
  const long = buildSnapshot(plate("B".repeat(17)));
  expect(long).toEqual({ kind: "needs-correction", problems: [expect.stringContaining("B".repeat(17))] });

  expect(buildSnapshot(trailer("T".repeat(64))).kind).toBe("ok");
  const longer = buildSnapshot(trailer("U".repeat(65)));
  expect(longer).toEqual({ kind: "needs-correction", problems: [expect.stringContaining("U".repeat(65))] });
});

test("SB4. a certified defect with no readable description is corrected before sending — a draft's is not held to it", () => {
  const blank = certified({ items: certified().items.map(item => (item.key === "wipers" ? { ...item, note: "​" } : item)) });
  const built = buildSnapshot(day({ previousVehicles: day().previousVehicles.map(use => ({ ...use, checks: [blank] })) }));
  expect(built.kind).toBe("needs-correction");
});

test("SB5. deterministic: the same declared day builds the same bytes, every time", () => {
  expect(JSON.stringify(buildSnapshot(day()))).toBe(JSON.stringify(buildSnapshot(day())));
});
