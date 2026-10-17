/**
 * What a finished day's sending status IS, in the driver's words (D66 stage
 * S6) — the one place the timesheet list and detail take it from.
 *
 * `null` while sending is switched off (until S8) and for a Personal day:
 * nothing is shown, and nothing claims anything was sent. Every status is
 * read from the day's own record — never assumed: "Sent" only once the
 * server answered with its reference.
 */
import { declarationHolds, effectiveFacts, type CompletedShift } from "../shift/localShift";
import type { AccountScope } from "../shift/accountScope";
import { FAILURE } from "./submissionErrors";
import { UNCONFIRMED } from "./submissionQueue";
import { SEND_TIMESHEETS } from "./sending";
import { SUBMISSION_STATE, highestSentGeneration, isDayLocked, isLocking, readSubmission, type TimesheetSubmissionRecord } from "./submissionStore";

export interface SubmissionStatus {
  /** One line, for the list and the top of the detail. */
  label: string;
  /** What the driver can do, or the server's own words — `null` when there is nothing more to say. */
  detail: string | null;
  /** Something needs the driver. */
  actionNeeded: boolean;
  /** The day may not be changed (`isDayLocked`). */
  locked: boolean;
  /** Save & Send may be offered: declared, and nothing of it on its way or with the company. */
  canSend: boolean;
}

function details(record: TimesheetSubmissionRecord): string {
  const said = record.problem?.details.map(entry => entry.message) ?? [];
  return said.length > 0 ? said.join(" ") : record.problem?.message ?? "";
}

function statusOfRecord(record: TimesheetSubmissionRecord, declared: boolean): SubmissionStatus {
  const company = record.companyName;
  const locked = isLocking(record.state);
  switch (record.state) {
    case SUBMISSION_STATE.waiting:
      if (record.problem?.kind === UNCONFIRMED) {
        return {
          label: "Waiting to confirm",
          detail: `${company} may already have this timesheet. It is kept exactly as sent, and checked with ${company} again — it can't be changed until that is settled.`,
          actionNeeded: false, locked, canSend: false,
        };
      }
      return {
        label: "Waiting to send",
        detail: record.problem?.kind === FAILURE.session
          ? "Sign in again to send it — it is kept on this phone until then."
          : `It is sent to ${company} as soon as there is a connection.`,
        actionNeeded: record.problem?.kind === FAILURE.session, locked, canSend: false,
      };
    case SUBMISSION_STATE.sending:
      return { label: "Sending…", detail: `Being sent to ${company}.`, actionNeeded: false, locked, canSend: false };
    case SUBMISSION_STATE.submitted:
      return { label: `Sent to ${company}`, detail: record.result === null ? null : `Reference ${record.result.reference}.`, actionNeeded: false, locked, canSend: false };
    case SUBMISSION_STATE.pendingReview:
      return {
        label: `Sent — waiting for ${company}'s review`,
        detail: record.result === null ? null : `Reference ${record.result.reference}. ${company} decides whether to accept it.`,
        actionNeeded: false, locked, canSend: false,
      };
    case SUBMISSION_STATE.needsCorrection:
      return {
        label: "Action needed — not sent",
        detail: `${company} could not take it as it is: ${details(record)} Correct the timesheet, then send it again.`,
        actionNeeded: true, locked, canSend: declared,
      };
    case SUBMISSION_STATE.refused:
      return {
        label: "Action needed — not accepted",
        detail: `This timesheet cannot be sent to ${company} from your account. Check who it is for, then send it again.`,
        actionNeeded: true, locked, canSend: declared,
      };
    case SUBMISSION_STATE.conflict:
      return {
        label: "Action needed — already sent differently",
        detail: `${company} already has a different version of this timesheet. It is kept as sent; changes come with amendments.`,
        actionNeeded: true, locked, canSend: false,
      };
  }
}

/** The day's sending status — `null` when there is nothing to show. */
export function submissionStatusOf(scope: AccountScope, day: CompletedShift): SubmissionStatus | null {
  if (!SEND_TIMESHEETS) return null;
  const facts = effectiveFacts(day);
  if (facts.workingFor.kind !== "company") return null;
  const declared = declarationHolds(day);
  let read: ReturnType<typeof readSubmission>;
  try {
    read = readSubmission(scope, day.id);
  } catch {
    read = { kind: "unreadable" };
  }
  // No record, but evidence that a request may have left (a sent-marker): what the lock says, the status says.
  // The record cannot be read — or evidence the lock trusts says more than the record does: the status says what the lock says.
  const newer = read.kind === "ok" && (highestSentGeneration(scope, day.id) ?? 0) > read.record.generation;
  if (read.kind === "unreadable" || newer || (isDayLocked(scope, day.id) && (read.kind === "none" || !isLocking(read.record.state)))) {
    return { label: "Action needed — being checked", detail: "This timesheet's sending record needs checking. It is kept as it is and nothing more is sent until it is.", actionNeeded: true, locked: true, canSend: false };
  }
  if (read.kind === "none") {
    return { label: "Not sent", detail: declared ? null : "Review and confirm it before it can be sent.", actionNeeded: false, locked: false, canSend: declared };
  }
  return statusOfRecord(read.record, declared);
}
