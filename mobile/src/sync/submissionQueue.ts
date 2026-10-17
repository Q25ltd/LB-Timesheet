/**
 * Save & Send (D66 stage S6): queue a declared company's day, and send what
 * is queued.
 *
 * QUEUEING runs inside the store's one write queue (`withFinishedDay`), so the
 * snapshot frozen is the version on disk and no edit can slip between the
 * read and the record that locks the day. A day is queued ONCE per identity:
 * a record already on its way is answered as it is; only a snapshot the
 * server definitively refused — and stored nothing for — is replaced, as the
 * next generation, the refused one kept with it.
 *
 * THE SEAL. The frozen snapshot's bytes are written once, to a seal, BEFORE
 * the record that locks the day (`submissionStore.ts`). Every send carries
 * the seal's bytes, and refuses to send when the record disagrees with them;
 * a damaged record is restored from its seal — never rebuilt from the day.
 * A seal with no record was never sent (a record is always `sending` before a
 * request), so it may be replaced; behind all of this the server refuses a
 * different snapshot under an id it already holds (409, kept locked).
 *
 * SENDING marks the record `sending` before the request and writes the answer
 * after it. A crash, a kill or a lost answer in between leaves it `sending`:
 * the next run sends the SAME bytes again and the server answers with what it
 * kept (a replay), never a second timesheet. What a failure means is decided
 * by `submissionErrors.ts`; nothing recoverable ever discards a record.
 */
import { sendTimesheet } from "../api/account";
import type { ApiResult } from "../api/client";
import { withFinishedDay } from "../shift/localShift";
import type { AccountScope } from "../shift/accountScope";
import { FAILURE, classifyFailure, type Failure } from "./submissionErrors";
import {
  SUBMISSION_STATE,
  SubmissionSaveError,
  isLocking,
  readSeal,
  readSubmission,
  sealExists,
  setAsideUnreadable,
  writeSeal,
  writeSubmission,
  type SubmissionProblem,
  type TimesheetSubmissionRecord,
} from "./submissionStore";
import { SEND_TIMESHEETS } from "./sending";
import { buildSnapshot } from "./timesheetSnapshot";

export type WithIdentity = <T>(call: (identityToken: string) => Promise<ApiResult<T>>) => Promise<ApiResult<T>>;

export type QueueOutcome =
  /** On its way, or already with the company — this record is the lock. */
  | { kind: "queued"; record: TimesheetSubmissionRecord }
  /** Sending is not switched on yet (until S8). Nothing was queued. */
  | { kind: "disabled" }
  | { kind: "missing" }
  /** A Personal day is never sent. */
  | { kind: "personal" }
  /** Not declared, or changed since: review and declare first (D42). */
  | { kind: "undeclared" }
  | { kind: "needs-correction"; problems: string[] }
  /** Its record cannot be read: the day stays locked until the runner recovers it. */
  | { kind: "locked" }
  /** The record could not be saved: nothing is queued and the day is as it was. */
  | { kind: "failed" };

function firstRecord(scope: AccountScope, dayId: string, built: { snapshot: Record<string, unknown>; membershipId: string; companyName: string; declaredVersion: string }, now: Date, earlier: TimesheetSubmissionRecord | null): TimesheetSubmissionRecord {
  return {
    ownerUserId: scope.userId,
    dayId,
    membershipId: built.membershipId,
    companyName: built.companyName,
    revision: 1,
    snapshot: built.snapshot,
    declaredVersion: built.declaredVersion,
    generation: earlier === null ? 1 : earlier.generation + 1,
    seq: earlier === null ? 1 : earlier.seq + 1,
    queuedAt: now.toISOString(),
    state: SUBMISSION_STATE.waiting,
    attempts: 0,
    lastAttemptAt: null,
    result: null,
    problem: null,
    earlier: earlier === null ? [] : [
      ...earlier.earlier,
      {
        generation: earlier.generation, snapshot: earlier.snapshot, declaredVersion: earlier.declaredVersion,
        refusedAt: earlier.lastAttemptAt ?? earlier.queuedAt, state: earlier.state, problem: earlier.problem,
      },
    ],
  };
}

/** Queue a declared company's day to send — once. */
export function queueTimesheet(scope: AccountScope, dayId: string, now: Date = new Date()): Promise<QueueOutcome> {
  return withFinishedDay(scope, dayId, (day): QueueOutcome => {
    if (!SEND_TIMESHEETS) return { kind: "disabled" };
    if (day === null) return { kind: "missing" };
    const existing = readSubmission(scope, dayId);
    if (existing.kind === "unreadable") return { kind: "locked" };
    if (existing.kind === "ok" && isLocking(existing.record.state)) return { kind: "queued", record: existing.record };

    const built = buildSnapshot(day);
    if (built.kind !== "ok") return built;
    // Only a snapshot the server stored nothing for is ever replaced: the record above is not locking.
    const next = firstRecord(scope, dayId, built, now, existing.kind === "ok" ? existing.record : null);
    try {
      // The seal first: no record — no lock, nothing sent — without its exact bytes.
      // A seal of this generation with no record was never sent, so it may be replaced.
      writeSeal(scope, {
        ownerUserId: scope.userId, dayId, generation: next.generation, membershipId: next.membershipId,
        companyName: next.companyName, declaredVersion: next.declaredVersion, snapshotJson: JSON.stringify(next.snapshot),
      }, true);
      writeSubmission(scope, next);
    } catch (error: unknown) {
      if (!(error instanceof SubmissionSaveError)) throw error;
      // The verified copy may still have landed (`readSubmission` promotes it): say what is true.
      const after = readSubmission(scope, dayId);
      return after.kind === "ok" && after.record.generation === next.generation && isLocking(after.record.state)
        ? { kind: "queued", record: after.record }
        : { kind: "failed" };
    }
    return { kind: "queued", record: next };
  });
}

/**
 * A record that cannot be read — the disk damaged it. Its bytes are moved
 * aside, never lost, and the record is restored from its SEAL: the exact
 * snapshot frozen, the same identity and revision. Its outcome is unknown,
 * so it is restored as `sending`: the next run sends the same bytes again and
 * the server answers with what it holds. Nothing is rebuilt from the day.
 * With no readable seal the day stays locked and nothing is sent.
 */
export function recoverUnreadable(scope: AccountScope, dayId: string, now: Date = new Date()): Promise<boolean> {
  return withFinishedDay(scope, dayId, (): boolean => {
    if (readSubmission(scope, dayId).kind !== "unreadable") return false;
    let generation = 0;
    while (sealExists(scope, dayId, generation + 1)) generation += 1;
    const seal = generation === 0 ? null : readSeal(scope, dayId, generation);
    if (seal === null) return false;
    setAsideUnreadable(scope, dayId, now);
    const snapshot: unknown = JSON.parse(seal.snapshotJson);
    writeSubmission(scope, {
      ownerUserId: scope.userId, dayId, membershipId: seal.membershipId, companyName: seal.companyName, revision: 1,
      snapshot, declaredVersion: seal.declaredVersion, generation: seal.generation,
      seq: 1, queuedAt: now.toISOString(), state: SUBMISSION_STATE.sending, attempts: 0, lastAttemptAt: null,
      result: null, problem: null, earlier: [],
    });
    return true;
  });
}

/**
 * The bytes to send for a record: its seal's — and only when the record still
 * agrees with them. `null`: do not send (the seal cannot be read, or the two
 * disagree); the day stays locked. A record whose seal is missing — never
 * written by this app, but possible on a damaged disk — is sealed from the
 * record itself, the only copy of what was frozen.
 */
function sealedBytes(scope: AccountScope, record: TimesheetSubmissionRecord): string | null {
  const frozen = JSON.stringify(record.snapshot);
  if (!sealExists(scope, record.dayId, record.generation)) {
    writeSeal(scope, {
      ownerUserId: scope.userId, dayId: record.dayId, generation: record.generation, membershipId: record.membershipId,
      companyName: record.companyName, declaredVersion: record.declaredVersion, snapshotJson: frozen,
    }, false);
  }
  const seal = readSeal(scope, record.dayId, record.generation);
  if (seal === null || seal.snapshotJson !== frozen || seal.membershipId !== record.membershipId) return null;
  return seal.snapshotJson;
}

const STATE_FOR: Record<Exclude<Failure, "session" | "temporary">, TimesheetSubmissionRecord["state"]> = {
  [FAILURE.invalid]:  SUBMISSION_STATE.needsCorrection,
  [FAILURE.refused]:  SUBMISSION_STATE.refused,
  [FAILURE.conflict]: SUBMISSION_STATE.conflict,
};

function problemOf(result: Exclude<ApiResult<unknown>, { kind: "ok" }>, failure: Failure): SubmissionProblem {
  if (result.kind === "network") return { kind: failure, status: null, code: null, message: result.message, details: [] };
  return { kind: failure, status: result.status, code: result.body.code ?? null, message: result.body.error, details: result.body.details ?? [] };
}

/** Write the next state — unless the record moved on since this run read it. */
function advance(scope: AccountScope, from: TimesheetSubmissionRecord, next: TimesheetSubmissionRecord): TimesheetSubmissionRecord | null {
  const now = readSubmission(scope, from.dayId);
  if (now.kind !== "ok" || now.record.seq !== from.seq || now.record.generation !== from.generation) return null;
  writeSubmission(scope, next);
  return next;
}

/** Send one queued record; the record as it now stands, or `null` when it could not be advanced. */
export async function sendSubmission(scope: AccountScope, record: TimesheetSubmissionRecord, withIdentity: WithIdentity, at: Date): Promise<TimesheetSubmissionRecord | null> {
  const bytes = sealedBytes(scope, record);
  if (bytes === null) return null;
  const sealed: unknown = JSON.parse(bytes);
  const sending = advance(scope, record, {
    ...record, state: SUBMISSION_STATE.sending, attempts: record.attempts + 1, lastAttemptAt: at.toISOString(), seq: record.seq + 1,
  });
  if (sending === null) return null;

  const result = await withIdentity(token => sendTimesheet(token, {
    membershipId:  sending.membershipId,
    clientEventId: sending.dayId,
    revision:      sending.revision,
    // The SEAL's bytes — exactly what was frozen, every time.
    snapshot:      sealed,
  }));

  let next: TimesheetSubmissionRecord;
  if (result.kind === "ok") {
    const { timesheet } = result.value;
    next = {
      ...sending, seq: sending.seq + 1, problem: null,
      state: timesheet.standing === "pending_review" ? SUBMISSION_STATE.pendingReview : SUBMISSION_STATE.submitted,
      result: { reference: timesheet.reference, revision: timesheet.revision, standing: timesheet.standing, verification: timesheet.verification, receivedAt: timesheet.receivedAt },
    };
  } else {
    const failure = classifyFailure(result);
    const state = failure === FAILURE.session || failure === FAILURE.temporary ? SUBMISSION_STATE.waiting : STATE_FOR[failure];
    next = { ...sending, seq: sending.seq + 1, state, problem: problemOf(result, failure) };
  }
  // If this write fails the record stays `sending`: the next run replays it.
  return advance(scope, sending, next);
}
