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
 *
 * ORDER (S6 remediation, 2026-10-17): authorise, THEN look for the day
 * already kept, THEN validate. A day already kept is answered by its stored
 * hash alone — a replay of the identical bytes gets what was kept even if
 * today's rules would refuse those bytes (they were accepted under the rules
 * of their day, and are immutable); different bytes are a conflict. Only a
 * genuinely new day is validated, by today's rules, unweakened. A snapshot
 * refused is answered `TIMESHEET_REJECTED`: issued only AFTER the server
 * found nothing kept under this day id, so a phone may rely on it as proof
 * that nothing exists — the one 400 it may unlock a sent day for.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { IdentityContext } from "../lib/auth.js";
import { ClientEventId } from "../lib/clientEventId.js";
import { AppError } from "../lib/errors.js";
import { authorizeTimesheetSubmission, type SubmissionMembershipLookup } from "../lib/submissionAuthorization.js";
import type { SubmissionContext } from "../lib/submissionContext.js";
import { localCalendarDate } from "../lib/timezone.js";
import { SNAPSHOT_SCHEMA_VERSION, TimesheetSnapshotV1, canonicalJson, snapshotProblems, snapshotSha256, type TimesheetSnapshot } from "../lib/timesheetSnapshot.js";
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

/**
 * A NEW day's snapshot: its shape, then its meaning — each refusal said,
 * never guessed around. Reached only once no day is kept under the id.
 */
function validSnapshot(raw: unknown, userId: string): TimesheetSnapshot {
  const parsed = TimesheetSnapshotV1.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.slice(0, 20).map(issue => ({ path: issue.path.join("."), message: issue.message }));
    throw new AppError(400, "Invalid timesheet", "TIMESHEET_REJECTED", details);
  }
  const problems = snapshotProblems(parsed.data, userId);
  if (problems.length > 0) throw new AppError(400, "The timesheet does not hold together", "TIMESHEET_REJECTED", problems.slice(0, 20));
  return parsed.data;
}

/** The SHA-256 of what was sent, as sent — before anything reads it as a snapshot. A valid snapshot hashes the same parsed (no transforms). */
function sentSha256(raw: unknown): string {
  return createHash("sha256").update(canonicalJson(raw)).digest("hex");
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
  // 1. Who: the driver's own membership — before anything is looked up under it.
  const ctx = await authorizeTimesheetSubmission(identity, input.membershipId, memberships);

  // 2. A day already kept under this id is answered by its stored hash — never re-validated.
  const earlier = await submissions.existing(ctx, input.clientEventId);
  if (earlier !== null) {
    if (earlier.timesheet === null || earlier.payloadSha256 !== sentSha256(input.snapshot)) throw mismatch();
    return { created: false, timesheet: viewOf(earlier.timesheet) };
  }

  // 3. A new day: today's rules, in full.
  const snapshot = validSnapshot(input.snapshot, ctx.userId);
  const hash = snapshotSha256(snapshot);

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
