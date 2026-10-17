/**
 * The timesheet snapshot a company's day is sent as (D66, schema version 1) —
 * built from the version the driver DECLARED, and nothing else.
 *
 * Only a company's day, only once its declaration holds (D42): a Personal day
 * is never a submission, and a day changed since it was declared is declared
 * again first. What it carries is the server's schema exactly — the day's
 * final facts, every use with its readings in their recorded unit, every
 * fill with its quantity and unit (or none), every check with the labels the
 * driver saw and every correction of it — and never anything else on the
 * phone: no account, no company, no private record.
 *
 * Pure and deterministic: the same declared day always builds the same
 * snapshot, byte for byte — so a record lost to a damaged disk can be rebuilt
 * from the locked, unchanged day without a different snapshot ever existing
 * under the same id.
 *
 * Before anything is queued it says what the driver must correct for the
 * server to take it — an identifier stored before the limits (D66: never
 * truncated, corrected instead), a certified defect with no readable
 * description. The server validates everything again.
 */
import {
  REGISTRATION_MAX_LENGTH,
  declarationState,
  effectiveFacts,
  effectiveUses,
  type CompletedShift,
  type EndedVehicle,
} from "../shift/localShift";
import { TRAILER_NUMBER_MAX_LENGTH, type EndedTrailer } from "../shift/trailer";
import { USE_ENDED_BY } from "../shift/useEnd";
import { CHECK_RESULT, CHECK_STATUS, type CheckItem, type VehicleCheck } from "../shift/vehicleCheck";
import { fillAmount, type FillRecord, type VehicleFill } from "../shift/vehicleFill";

const SNAPSHOT_SCHEMA_VERSION = 1;

/** A description someone can read — the server's rule (security review R1). */
const READABLE = /[\p{L}\p{N}\p{P}\p{S}]/u;

export type BuiltSnapshot =
  | { kind: "ok"; snapshot: Record<string, unknown>; membershipId: string; companyName: string; declaredVersion: string }
  | { kind: "personal" }
  /** Not declared, or changed since it was (D42): review and declare first. */
  | { kind: "undeclared" }
  /** What the driver must correct first, in their words. */
  | { kind: "needs-correction"; problems: string[] };

function fill(record: FillRecord): Record<string, unknown> {
  const amount = fillAmount(record);
  return {
    id: record.id,
    recordedAt: record.recordedAt,
    quantity: amount.quantity,
    unit: amount.unit,
    unitSource: amount.source,
    note: record.note,
  };
}

/**
 * A check's rows. A DRAFT's defect description is kept as it is being typed
 * (`localShift.ts`), so it is sent trimmed — and as none when only blanks were
 * typed: whitespace is all that changes. A certified row was trimmed when it
 * was certified, and is sent exactly as stored.
 */
function items(rows: readonly CheckItem[], draft: boolean): Record<string, unknown>[] {
  return rows.map(row => {
    const note = draft && row.note !== null ? row.note.trim() : row.note;
    return {
      key: row.key,
      label: row.label,
      section: row.section === undefined ? null : { id: row.section.id, title: row.section.title },
      result: row.result,
      note: note === "" ? null : note,
    };
  });
}

function check(value: VehicleCheck): Record<string, unknown> {
  return {
    id: value.id,
    checklist: value.checklist,
    checklistVersion: value.checklistVersion,
    status: value.status,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    completedBy: value.completedBy,
    items: items(value.items, value.status !== CHECK_STATUS.completed),
    revisions: (value.revisions ?? []).map(revision => ({
      id: revision.id,
      revisedAt: revision.revisedAt,
      revisedBy: revision.revisedBy,
      items: items(revision.items, false),
    })),
  };
}

function vehicle(use: EndedVehicle): Record<string, unknown> {
  return {
    useId: use.useId,
    startedAt: use.startedAt,
    endedAt: use.endedAt,
    endedBy: use.endedBy === USE_ENDED_BY.finish ? "finish" : null,
    vehicleClass: use.vehicleClass,
    registration: use.numberPlate,
    odometerStart: use.startMileage,
    odometerEnd: use.endMileage,
    odometerUnit: use.odometerUnit ?? null,
    fills: use.fills.map((entry: VehicleFill) => ({ ...fill(entry), type: entry.type })),
    checks: use.checks.map(check),
  };
}

function trailer(use: EndedTrailer): Record<string, unknown> {
  return {
    useId: use.useId,
    startedAt: use.startedAt,
    endedAt: use.endedAt,
    endedBy: use.endedBy === USE_ENDED_BY.finish ? "finish" : null,
    trailerType: use.trailerType,
    trailerNumber: use.trailerNumber,
    fridgeDiesel: use.reeferDiesel.map(fill),
    checks: use.checks.map(check),
  };
}

/** A certified check, or a correction of one, with a defect nobody can read. */
function undescribedDefect(value: VehicleCheck): boolean {
  if (value.status !== CHECK_STATUS.completed) return false;
  const certificates = [value.items, ...(value.revisions ?? []).map(revision => revision.items)];
  return certificates.some(rows => rows.some(row => row.result === CHECK_RESULT.defect && (row.note === null || !READABLE.test(row.note))));
}

/** What the driver must correct before the server can take the day — none when it can be sent. */
function correctionsNeeded(vehicles: readonly EndedVehicle[], trailers: readonly EndedTrailer[]): string[] {
  const problems: string[] = [];
  for (const use of vehicles) {
    if (use.numberPlate.length > REGISTRATION_MAX_LENGTH) {
      problems.push(`The registration ${use.numberPlate} is longer than ${String(REGISTRATION_MAX_LENGTH)} characters — correct it before sending.`);
    }
    if (use.checks.some(undescribedDefect)) problems.push(`A defect on ${use.numberPlate}'s check has no description — add one before sending.`);
  }
  for (const use of trailers) {
    if (use.trailerNumber.length > TRAILER_NUMBER_MAX_LENGTH) {
      problems.push(`The trailer number ${use.trailerNumber} is longer than ${String(TRAILER_NUMBER_MAX_LENGTH)} characters — correct it before sending.`);
    }
    if (use.checks.some(undescribedDefect)) problems.push(`A defect on trailer ${use.trailerNumber}'s check has no description — add one before sending.`);
  }
  return problems;
}

/** The snapshot of a declared company's day — or why there is none. */
export function buildSnapshot(day: CompletedShift): BuiltSnapshot {
  const facts = effectiveFacts(day);
  if (facts.workingFor.kind !== "company") return { kind: "personal" };
  if (declarationState(day) !== "confirmed" || day.declaration === undefined) return { kind: "undeclared" };
  const uses = effectiveUses(day);
  const problems = correctionsNeeded(uses.previousVehicles, uses.previousTrailers);
  if (problems.length > 0) return { kind: "needs-correction", problems };

  return {
    kind: "ok",
    membershipId: facts.workingFor.membershipId,
    companyName: facts.workingFor.companyName,
    declaredVersion: day.declaration.version,
    snapshot: {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      day: { startedAt: facts.startedAt, endedAt: facts.endedAt, nightOut: facts.nightOut, notes: facts.notes },
      vehicles: uses.previousVehicles.map(vehicle),
      trailers: uses.previousTrailers.map(trailer),
      declaration: { version: day.declaration.version, declaredAt: day.declaration.declaredAt },
    },
  };
}
