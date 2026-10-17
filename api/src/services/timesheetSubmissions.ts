/**
 * A driver submits a timesheet to a company (D66, stage S4) — revision 1.
 *
 * Identity posture, through `authorizeTimesheetSubmission`: the named
 * membership is the signed-in driver's own — active, deactivated or
 * removed. Nothing about the company is taken from the request.
 *
 * WHO MAY BE ACCEPTED AUTOMATICALLY, decided by SERVER time only:
 *   membership active now                    → verified, accepted
 *   a start receipt received before its      → verified (start receipt), accepted
 *     latest withdrawal
 *   otherwise                                → unverified, PENDING COMPANY REVIEW —
 *                                              never discarded, never rejected or
 *                                              accepted automatically
 * The driver's declared times are their data (D20) and never evidence.
 *
 * IDEMPOTENT: one company timesheet per (membership, day id). The same
 * snapshot again (same SHA-256) is the same answer; a different one under
 * the same id is refused and changes nothing.
 */
import { z } from "zod";
import type { IdentityContext } from "../lib/auth.js";
import { ClientEventId } from "../lib/clientEventId.js";
import { AppError } from "../lib/errors.js";
import { authorizeTimesheetSubmission, type SubmissionMembershipLookup } from "../lib/submissionAuthorization.js";
import type { SubmissionContext } from "../lib/submissionContext.js";
import { localCalendarDate } from "../lib/timezone.js";
import { SNAPSHOT_SCHEMA_VERSION, TimesheetSnapshotV1, snapshotProblems, snapshotSha256, type TimesheetSnapshot } from "../lib/timesheetSnapshot.js";
import type { TimesheetVerification } from "../generated/enums.js";
import type { SubmittedTimesheet, TimesheetSubmissionRepository } from "../repositories/timesheetSubmissionRepository.js";

/**
 * The envelope. Strict: the company, user, standing and dates are the
 * server's. The snapshot is validated on its own (`TimesheetSnapshotV1`).
 * Revision 1 only, until amendments (stage S9).
 */
export const SubmitTimesheetBody = z.object({
  membershipId:  z.string().min(1).max(64),
  clientEventId: ClientEventId,
  revision:      z.literal(1),
  snapshot:      z.unknown(),
}).strict();

export type SubmitTimesheetInput = z.infer<typeof SubmitTimesheetBody>;

/** New submissions one membership may make in any 24 hours; replays are never counted (D66). */
const SUBMISSIONS_PER_MEMBERSHIP_PER_DAY = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

interface TimesheetView {
  reference: string;
  revision: number;
  standing: SubmittedTimesheet["standing"];
  verification: TimesheetVerification;
  receivedAt: string;
}

export interface SubmitResult {
  created: boolean;
  timesheet: TimesheetView;
}

function viewOf(timesheet: SubmittedTimesheet): TimesheetView {
  return { ...timesheet, receivedAt: timesheet.receivedAt.toISOString() };
}

function mismatch(): AppError {
  return new AppError(409, "This timesheet was already submitted with different content", "SUBMISSION_MISMATCH");
}

/** The snapshot's shape, then its meaning — each refusal said, never guessed around. */
function validSnapshot(raw: unknown, userId: string): TimesheetSnapshot {
  const parsed = TimesheetSnapshotV1.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.slice(0, 20).map(issue => ({ path: issue.path.join("."), message: issue.message }));
    throw new AppError(400, "Invalid timesheet", "VALIDATION", details);
  }
  const problems = snapshotProblems(parsed.data, userId);
  if (problems.length > 0) throw new AppError(400, "The timesheet does not hold together", "TIMESHEET_INVALID", problems.slice(0, 20));
  return parsed.data;
}

/** How the start is evidenced — by the membership now, or a receipt the server received before the latest withdrawal. */
async function evidence(ctx: SubmissionContext, clientEventId: string, submissions: TimesheetSubmissionRepository): Promise<{ verification: TimesheetVerification; receiptId: string | null }> {
  if (ctx.membershipActive) return { verification: "membership_active", receiptId: null };
  const receipt = await submissions.receipt(ctx, clientEventId);
  if (receipt === null) return { verification: "unverified", receiptId: null };
  const withdrawn = await submissions.latestWithdrawal(ctx);
  // A receipt is issued only while active, so one existing means it came
  // before the latest withdrawal — and that is checked, not assumed.
  if (withdrawn !== null && receipt.receivedAt.getTime() >= withdrawn.getTime()) return { verification: "unverified", receiptId: null };
  return { verification: "start_receipt", receiptId: receipt.id };
}

export async function submitTimesheet(
  identity: IdentityContext,
  input: SubmitTimesheetInput,
  memberships: SubmissionMembershipLookup,
  submissions: TimesheetSubmissionRepository,
  now: Date = new Date(),
): Promise<SubmitResult> {
  const ctx = await authorizeTimesheetSubmission(identity, input.membershipId, memberships);
  const snapshot = validSnapshot(input.snapshot, ctx.userId);
  const hash = snapshotSha256(snapshot);

  const earlier = await submissions.existing(ctx, input.clientEventId);
  if (earlier !== null) {
    if (earlier.timesheet === null || earlier.payloadSha256 !== hash) throw mismatch();
    return { created: false, timesheet: viewOf(earlier.timesheet) };
  }

  const { verification, receiptId } = await evidence(ctx, input.clientEventId, submissions);
  const facts = await submissions.facts(ctx);
  const startedAt = new Date(snapshot.day.startedAt);
  const created = await submissions.createRevisionOne(ctx, {
    clientEventId:   input.clientEventId,
    shiftDate:       localCalendarDate(startedAt, facts.companyTimezone),
    startedAt,
    endedAt:         new Date(snapshot.day.endedAt),
    nightOut:        snapshot.day.nightOut,
    notes:           snapshot.day.notes,
    declaredAt:      new Date(snapshot.declaration.declaredAt),
    declaredVersion: snapshot.declaration.version,
    schemaVersion:   SNAPSHOT_SCHEMA_VERSION,
    payload:         snapshot,
    payloadSha256:   hash,
    verification,
    receiptId,
    standing:        verification === "unverified" ? "pending_review" : "accepted",
    facts,
    now,
  }, { max: SUBMISSIONS_PER_MEMBERSHIP_PER_DAY, since: new Date(now.getTime() - DAY_MS) });
  // The replay and the cap are decided under the membership's lock (R2).
  if (created.kind === "over_limit") throw new AppError(429, "Too many requests, try again shortly", "RATE_LIMITED");
  if (created.kind === "created") return { created: true, timesheet: viewOf(created.timesheet) };

  // A concurrent copy of the same day won: answer it — or refuse, if it differs.
  const winner = await submissions.existing(ctx, input.clientEventId);
  if (winner?.timesheet === null || winner === null || winner.payloadSha256 !== hash) throw mismatch();
  return { created: false, timesheet: viewOf(winner.timesheet) };
}
