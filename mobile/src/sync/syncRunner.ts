/**
 * The phone's sync runner (D66) — sends what the account has queued, in the
 * foreground, when it can: start receipts (S3), then submitted timesheets
 * (S6, `submissionQueue.ts`) — only while sending is switched on.
 *
 *   ONE run at a time per account: a second request while one is running
 *     waits for it, so nothing is sent twice by the phone itself.
 *   RECONCILES first: the open company day always has its receipt queued, so
 *     a queue write that failed at Start Shift is put right on the next run.
 *   NOTHING QUEUED, NOTHING SENT: a run with no work makes no request.
 *   EVERY RETRY IS THE SAME REQUEST: the payload was fixed when queued, and
 *     the server answers a replay with what it already kept.
 *   AN UNKNOWN OUTCOME (no connection, a timeout, a server fault) leaves the
 *     receipt waiting; a refusal the server means (not active, not yours)
 *     is final and never retried.
 *
 * Background execution is not promised (D66): the runner works while the
 * app is open.
 */
import { sendStartReceipt } from "../api/account";
import { readOpenShift } from "../shift/localShift";
import type { AccountScope } from "../shift/accountScope";
import { RECEIPT_STATE, listReceipts, queueStartReceipt, saveReceipt, type QueuedReceipt } from "./receiptQueue";
import { SEND_TIMESHEETS } from "./sending";
import { recoverRecord, sendSubmission, type WithIdentity } from "./submissionQueue";
import { SUBMISSION_STATE, isSendable, readSubmission, submissionDayIds } from "./submissionStore";

export type { WithIdentity } from "./submissionQueue";

export interface SyncReport {
  /** Receipts the server answered with its receipt now. */
  received: number;
  /** Receipts the server will not give — final. */
  refused: number;
  /** Still waiting after this run. */
  waiting: number;
  /** Whether something could not be decided this time — a reason to try again later. */
  retryLater: boolean;
  /** Timesheets the company now has (accepted, or waiting for its review). */
  timesheetsSent: number;
  /** Timesheets the server answered finally without taking: to correct, not ours, or a conflict. */
  timesheetsHeld: number;
  /** Timesheets still waiting after this run. */
  timesheetsWaiting: number;
}

const running = new Map<string, Promise<SyncReport>>();

/** Run for this account — or join the run already going. */
export function runSync(scope: AccountScope, withIdentity: WithIdentity, now: () => Date = () => new Date()): Promise<SyncReport> {
  const current = running.get(scope.userId);
  if (current !== undefined) return current;
  const run = syncOnce(scope, withIdentity, now).finally(() => { running.delete(scope.userId); });
  running.set(scope.userId, run);
  return run;
}

async function syncOnce(scope: AccountScope, withIdentity: WithIdentity, now: () => Date): Promise<SyncReport> {
  let retryLater = false;
  try {
    const open = await readOpenShift(scope);
    if (open !== null && open.workingFor.kind === "company") {
      queueStartReceipt(scope, { dayId: open.id, membershipId: open.workingFor.membershipId, startedAt: open.startedAt }, now());
    }
  } catch {
    // The open day could not be read or its receipt not queued: nothing is
    // lost — the next run tries again — and the receipts already queued go now.
    retryLater = true;
  }

  const report: SyncReport = { received: 0, refused: 0, waiting: 0, retryLater, timesheetsSent: 0, timesheetsHeld: 0, timesheetsWaiting: 0 };
  for (const receipt of listReceipts(scope)) {
    if (receipt.state !== RECEIPT_STATE.waiting) continue;
    const outcome = await send(receipt, withIdentity, now());
    saveReceipt(scope, outcome);
    if (outcome.state === RECEIPT_STATE.received) report.received += 1;
    else if (outcome.state === RECEIPT_STATE.refused) report.refused += 1;
    else {
      report.waiting += 1;
      report.retryLater = true;
    }
  }
  if (SEND_TIMESHEETS) await sendTimesheets(scope, withIdentity, now, report);
  return report;
}

/** Every queued timesheet of this account, oldest day first — after the receipts that evidence them. */
async function sendTimesheets(scope: AccountScope, withIdentity: WithIdentity, now: () => Date, report: SyncReport): Promise<void> {
  for (const dayId of submissionDayIds(scope)) {
    try {
      let read = readSubmission(scope, dayId);
      // Damaged, or gone while a request may have left: restored from its seal, never rebuilt.
      if (read.kind !== "ok" && await recoverRecord(scope, dayId, now())) read = readSubmission(scope, dayId);
      if (read.kind !== "ok") {
        // Still unreadable: kept, locked, never sent as a guess.
        if (read.kind === "unreadable") report.retryLater = true;
        continue;
      }
      if (!isSendable(read.record.state)) continue;
      const after = await sendSubmission(scope, read.record, withIdentity, now());
      const state = after?.state ?? SUBMISSION_STATE.sending;
      if (state === SUBMISSION_STATE.submitted || state === SUBMISSION_STATE.pendingReview) report.timesheetsSent += 1;
      else if (isSendable(state)) {
        report.timesheetsWaiting += 1;
        report.retryLater = true;
      } else report.timesheetsHeld += 1;
    } catch {
      // This record could not be read or written now: it is kept as it is, and tried again.
      report.timesheetsWaiting += 1;
      report.retryLater = true;
    }
  }
}

/** What one attempt decides about one receipt. */
async function send(receipt: QueuedReceipt, withIdentity: WithIdentity, at: Date): Promise<QueuedReceipt> {
  const attempted = { ...receipt, attempts: receipt.attempts + 1, lastAttemptAt: at.toISOString() };
  const result = await withIdentity(token => sendStartReceipt(token, {
    membershipId:  receipt.membershipId,
    clientEventId: receipt.dayId,
    startedAt:     receipt.startedAt,
  }));
  if (result.kind === "ok") return { ...attempted, state: RECEIPT_STATE.received, receivedAt: result.value.receipt.receivedAt };
  if (result.kind === "api" && isFinalRefusal(result.status)) return { ...attempted, state: RECEIPT_STATE.refused };
  return attempted;
}

/**
 * The server MEANT it: not active or not this driver's (403, 404), a payload
 * it can never accept (400), or the same day already received with another
 * start (409). Anything else — 401 after renewal, 429, a server fault — may
 * be different next time.
 */
function isFinalRefusal(status: number): boolean {
  return status === 400 || status === 403 || status === 404 || status === 409;
}
