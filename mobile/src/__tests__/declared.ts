/**
 * Test helpers: finish or correct a day as a driver who declared it on the
 * Review — the declaration bound to the version the store will write (D42),
 * computed the way the screens compute it (`timesheetVersion` of the day as
 * it will read). An input that states its own `declared` — even `null` —
 * keeps it: that is how a test asks the store about a missing or wrong one.
 */
import {
  completedFrom,
  correctCompletedShift,
  effectiveFacts,
  finishOpenShift,
  readCompletedShift,
  readOpenShift,
  timesheetVersion,
  type CompletedShift,
  type CorrectCompletedShiftInput,
  type Declared,
  type FinishShiftInput,
} from "../shift/localShift";
import type { AccountScope } from "../shift/accountScope";

export const DECLARED_BY = "driver-under-test";

type Undeclared<T> = Omit<T, "declared"> & { declared?: Declared | null };

const declaredAs = (version: string): Declared => ({ at: new Date(), by: DECLARED_BY, version });

/**
 * The finish as the Review would send it, declared as the day it would file.
 * A finish the open day would refuse (a stale one) is declared as a version
 * no day has: the store must refuse it for what it is, not for the declaration.
 */
export async function declaredFinish(scope: AccountScope, input: Undeclared<FinishShiftInput>): Promise<FinishShiftInput> {
  if (input.declared !== undefined) return { ...input, declared: input.declared };
  const open = await readOpenShift(scope);
  if (open === null) return { ...input, declared: null };
  let version = "no-such-version";
  try {
    version = timesheetVersion(completedFrom(open, input));
  } catch {
    // A finish this day refuses; the store says so itself.
  }
  return { ...input, declared: declaredAs(version) };
}

export async function finishDeclared(scope: AccountScope, input: Undeclared<FinishShiftInput>): Promise<CompletedShift | null> {
  return finishOpenShift(scope, await declaredFinish(scope, input));
}

/** The version a correction would leave the day at — as Edit Timesheet's Review shows it. */
export function correctedVersion(day: CompletedShift, input: Omit<CorrectCompletedShiftInput, "declared">): string {
  const written = input.notes.trim();
  const facts = {
    workingFor: input.workingFor,
    startedAt: input.startedAt.toISOString(),
    endedAt: input.endedAt.toISOString(),
    nightOut: input.nightOut,
    notes: written === "" ? null : written,
  };
  // Facts as they already are: nothing is appended, the day is declared as it reads.
  if (JSON.stringify(facts) === JSON.stringify(effectiveFacts(day))) return timesheetVersion(day);
  return timesheetVersion({
    ...day,
    corrections: [...(day.corrections ?? []), { id: input.correctionId, correctedAt: input.correctedAt.toISOString(), correctedBy: input.correctedBy, ...facts }],
  });
}

export async function correctDeclared(scope: AccountScope, input: Undeclared<CorrectCompletedShiftInput>): Promise<CompletedShift | null> {
  if (input.declared !== undefined) return correctCompletedShift(scope, { ...input, declared: input.declared });
  const day = await readCompletedShift(scope, input.shiftId);
  const declared = day === null ? null : declaredAs(correctedVersion(day, input));
  return correctCompletedShift(scope, { ...input, declared });
}
