/**
 * The submitted timesheet SNAPSHOT, schema version 1 (D66) — what a driver
 * declares and sends, validated in full by the server before anything is
 * stored. The phone builds it from its own record; nothing in it is trusted
 * because the phone sent it.
 *
 * What it holds: the day's FINAL declared facts (not the driver's earlier
 * corrections of them), every vehicle and trailer use with its readings and
 * their recorded unit, every fuel / AdBlue / DEF / fridge-diesel event with
 * its quantity and recorded unit, and every check — draft or completed —
 * with the checklist and labels the driver saw and every revision of a
 * certified one. Never the driver's private diary, and nothing that names a
 * company, a user or a membership: those are the server's.
 *
 * Two layers: the SHAPE (Zod, strict — an unknown key is refused) and the
 * MEANING (`snapshotProblems` — chronology, the checklist, who certified).
 * A snapshot is stored only when both hold.
 *
 * Bounds marked "refusal bound" are not product rules: they stop a request
 * no real day could make from costing the server; no driver reaches them.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { CHECKLIST_FOR_TRAILER, CHECKLIST_FOR_VEHICLE, checklistKeys } from "./checklistKeys.js";
import { DistanceUnitField, VolumeUnitField } from "./units.js";

export const SNAPSHOT_SCHEMA_VERSION = 1;

/** An instant with its offset (D18: no zone is ever guessed). */
const Instant = z.iso.datetime({ offset: true });
/** An id the phone made: a UUID, or a legacy use id derived from its start (D42). */
const LocalId = z.string().min(1).max(64);
/** Free text the driver typed: trimmed on the phone, at most 500 there; null when none. */
const DriverText = z.string().min(1).max(500).refine(value => value === value.trim(), "not trimmed").nullable();
/** A fill quantity: positive, two decimal places at most; null when not known — never 0. */
const Quantity = z.number().positive().max(9999.99).refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, "more than two decimal places").nullable();

const Fill = z.object({
  id:         LocalId,
  recordedAt: Instant,
  quantity:   Quantity,
  /** The unit the form showed — null only when none was set when it was recorded (D66). */
  unit:       VolumeUnitField.nullable(),
  /** Where the unit came from: as recorded, or the pre-units LITRES label (D66). */
  unitSource: z.enum(["recorded", "legacy-litres-label"]),
  note:       DriverText,
}).strict();

const VehicleFill = Fill.extend({ type: z.enum(["fuel", "adblue"]) }).strict();

const CheckItem = z.object({
  key:     z.string().min(1).max(64),
  /** The label the driver SAW — kept as it was, whatever the phone says today (D52). */
  label:   z.string().min(1).max(200),
  section: z.object({ id: z.string().min(1).max(64), title: z.string().min(1).max(200) }).strict().nullable(),
  result:  z.enum(["pass", "na", "fail"]),
  /** The defect description; null unless the result is a defect. */
  note:    DriverText,
}).strict();

const CheckItems = z.array(CheckItem).max(80); // refusal bound

const Check = z.object({
  id:               LocalId,
  checklist:        z.string().min(1).max(64),
  checklistVersion: z.number().int().positive(),
  status:           z.enum(["draft", "completed"]),
  startedAt:        Instant,
  completedAt:      Instant.nullable(),
  /** The driver who certified it — must be the driver submitting. */
  completedBy:      z.string().min(1).max(64).nullable(),
  items:            CheckItems,
  revisions:        z.array(z.object({
    id:        LocalId,
    revisedAt: Instant,
    revisedBy: z.string().min(1).max(64),
    items:     CheckItems,
  }).strict()).max(50), // refusal bound
}).strict();

const UseTimes = {
  useId:     LocalId,
  startedAt: Instant,
  endedAt:   Instant,
  /** Present when the day's Finish ended it (D40). */
  endedBy:   z.literal("finish").nullable(),
};

const VehicleUse = z.object({
  ...UseTimes,
  vehicleClass: z.enum(["class1", "class2", "van"]),
  /** Trimmed and upper-cased on the phone; CLAUDE.md's 16 for a vehicle registration. */
  registration: z.string().min(1).max(16),
  odometerStart: z.number().int().min(0).max(99_999_999),
  odometerEnd:   z.number().int().min(0).max(99_999_999),
  /** The unit the readings were recorded in — null for readings from before units (D66). */
  odometerUnit:  DistanceUnitField.nullable(),
  fills:  z.array(VehicleFill).max(200), // refusal bound
  checks: z.array(Check).max(30),        // refusal bound
}).strict();

const TrailerUse = z.object({
  ...UseTimes,
  trailerType:   z.enum(["standard", "refrigerated"]),
  /** A reference or code (CLAUDE.md): at most 64. */
  trailerNumber: z.string().min(1).max(64),
  fridgeDiesel:  z.array(Fill).max(200), // refusal bound
  checks:        z.array(Check).max(30), // refusal bound
}).strict();

export const TimesheetSnapshotV1 = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
  day: z.object({
    startedAt: Instant,
    endedAt:   Instant,
    nightOut:  z.boolean(),
    /** The day's finish notes — company-facing on a company's day (F-20, D66). */
    notes:     DriverText,
  }).strict(),
  vehicles: z.array(VehicleUse).max(50), // refusal bound
  trailers: z.array(TrailerUse).max(50), // refusal bound
  declaration: z.object({
    /** The version the driver confirmed on the phone (D42's fingerprint). */
    version:    z.string().min(1).max(64),
    declaredAt: Instant,
  }).strict(),
}).strict();

export type TimesheetSnapshot = z.infer<typeof TimesheetSnapshotV1>;
type Use = { useId: string; startedAt: string; endedAt: string };

const ms = (instant: string): number => Date.parse(instant);

/** Two uses of a kind at once: overlapping, or starting at the same instant (D42). Touching is a change. */
function overlapProblem(uses: readonly Use[], kind: string): string | null {
  const sorted = [...uses].sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const next = sorted[index];
    if (previous === undefined || next === undefined) continue;
    if (ms(next.startedAt) === ms(previous.startedAt) || ms(next.startedAt) < ms(previous.endedAt)) {
      return `two ${kind} uses at once`;
    }
  }
  return null;
}

function uniqueProblem(ids: readonly string[], what: string): string | null {
  return new Set(ids).size === ids.length ? null : `a repeated ${what} id`;
}

function checkProblems(check: TimesheetSnapshot["vehicles"][number]["checks"][number], expected: string, userId: string, where: string): string[] {
  const problems: string[] = [];
  if (check.checklist !== expected) problems.push(`${where}: checked against the wrong checklist`);
  const keys = checklistKeys(check.checklist, check.checklistVersion);
  if (keys === null) {
    problems.push(`${where}: an unknown checklist or version`);
    return problems;
  }
  const itemSets = [check.items, ...check.revisions.map(revision => revision.items)];
  for (const items of itemSets) {
    const seen = new Set<string>();
    for (const item of items) {
      if (!keys.includes(item.key)) problems.push(`${where}: an item this checklist does not have`);
      if (seen.has(item.key)) problems.push(`${where}: an item answered twice`);
      seen.add(item.key);
      if (item.result !== "fail" && item.note !== null) problems.push(`${where}: a description on an item that is not a defect`);
    }
  }
  if (check.status === "completed") {
    if (check.completedAt === null || check.completedBy === null) problems.push(`${where}: a completed check without who and when`);
    if (check.completedBy !== null && check.completedBy !== userId) problems.push(`${where}: certified by someone else`);
    if (check.items.length === 0) problems.push(`${where}: a completed check with no items`);
  } else {
    if (check.completedAt !== null || check.completedBy !== null) problems.push(`${where}: a draft said to be certified`);
    if (check.revisions.length > 0) problems.push(`${where}: a draft with corrections`);
  }
  for (const revision of check.revisions) {
    if (revision.revisedBy !== userId) problems.push(`${where}: corrected by someone else`);
    if (revision.items.length === 0) problems.push(`${where}: an empty correction`);
  }
  return problems;
}

/**
 * What the snapshot SAYS that cannot be true — empty when it holds. Each
 * problem is said in words a support person can act on; none carries data
 * from the snapshot.
 */
export function snapshotProblems(snapshot: TimesheetSnapshot, userId: string): string[] {
  const problems: string[] = [];
  const { day } = snapshot;
  if (ms(day.endedAt) < ms(day.startedAt)) problems.push("the finish is before the start");

  const allUses: (Use & { kind: string })[] = [
    ...snapshot.vehicles.map(use => ({ ...use, kind: "vehicle" })),
    ...snapshot.trailers.map(use => ({ ...use, kind: "trailer" })),
  ];
  for (const use of allUses) {
    if (ms(use.endedAt) < ms(use.startedAt)) problems.push(`a ${use.kind} use ends before it began`);
    if (ms(use.startedAt) < ms(day.startedAt)) problems.push(`a ${use.kind} use begins before the shift`);
    if (ms(use.endedAt) > ms(day.endedAt)) problems.push(`a ${use.kind} use ends after the shift`);
  }
  for (const problem of [
    overlapProblem(snapshot.vehicles, "vehicle"),
    overlapProblem(snapshot.trailers, "trailer"),
    uniqueProblem(snapshot.vehicles.map(use => use.useId), "vehicle use"),
    uniqueProblem(snapshot.trailers.map(use => use.useId), "trailer use"),
  ]) if (problem !== null) problems.push(problem);

  snapshot.vehicles.forEach((use, index) => {
    const where = `vehicle use ${String(index + 1)}`;
    if (use.odometerEnd < use.odometerStart) problems.push(`${where}: the end reading is below the start`);
    const fillProblem = uniqueProblem(use.fills.map(fill => fill.id), "fill");
    if (fillProblem !== null) problems.push(`${where}: ${fillProblem}`);
    const expected = CHECKLIST_FOR_VEHICLE[use.vehicleClass] ?? "";
    for (const check of use.checks) problems.push(...checkProblems(check, expected, userId, where));
  });
  snapshot.trailers.forEach((use, index) => {
    const where = `trailer use ${String(index + 1)}`;
    if (use.trailerType !== "refrigerated" && use.fridgeDiesel.length > 0) problems.push(`${where}: fridge diesel on a trailer with no fridge`);
    const fillProblem = uniqueProblem(use.fridgeDiesel.map(fill => fill.id), "fill");
    if (fillProblem !== null) problems.push(`${where}: ${fillProblem}`);
    const expected = CHECKLIST_FOR_TRAILER[use.trailerType] ?? "";
    for (const check of use.checks) problems.push(...checkProblems(check, expected, userId, where));
  });
  return problems;
}

/**
 * Canonical JSON (RFC 8785, for the values a snapshot holds): object keys in
 * code-point order at every depth, no whitespace, numbers and strings as
 * ECMAScript serialises them. The same snapshot always has the same bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/** The SHA-256 of a snapshot's canonical JSON — what tells a replay from a different submission. */
export function snapshotSha256(snapshot: TimesheetSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}
