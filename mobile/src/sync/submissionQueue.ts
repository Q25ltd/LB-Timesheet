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
 * A seal is never replaced: a later snapshot is a later generation beside it.
 * A record LOST whose generation has a sent-marker (written before any of its
 * requests leaves) may have reached the server: the day stays locked and the
 * record is restored from the seal and replayed. Behind all of this the
 * server refuses a different snapshot under an id it already keeps (409).
 *
 * UNCERTAINTY. Once a transmission's outcome is unknown, the record is
 * `uncertain`, and only the server's proof that it keeps nothing
 * (TIMESHEET_REJECTED) may unlock the day; any other refusal keeps the
 * frozen bytes and the lock, and the next replay settles it.
 *
 * SENDING marks the record `sending` before the request and writes the answer
 * after it. A crash, a kill or a lost answer in between leaves it `sending`:
 * the next run sends the SAME bytes again and the server answers with what it
 * kept (a replay), never a second timesheet. What a failure means is decided
 * by `submissionErrors.ts`; nothing recoverable ever discards a record.
 */
import { fetchCapabilities, sendTimesheet } from "../api/account";
import type { ApiResult } from "../api/client";
import { apiBaseUrl } from "../api/config";
import { withFinishedDay } from "../shift/localShift";
import type { AccountScope } from "../shift/accountScope";
import { FAILURE, classifyFailure, outcomeUnknown, provesNothingKept, type Failure } from "./submissionErrors";
import {
  SUBMISSION_STATE,
  SubmissionSaveError,
  highestEvidenceGeneration,
  highestSealGeneration,
  highestSentGeneration,
  isLocking,
  markSent,
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

function firstRecord(scope: AccountScope, dayId: string, built: { snapshot: Record<string, unknown>; membershipId: string; companyName: string; declaredVersion: string }, now: Date, earlier: TimesheetSubmissionRecord | null, generation: number): TimesheetSubmissionRecord {
  return {
    ownerUserId: scope.userId,
    dayId,
    membershipId: built.membershipId,
    companyName: built.companyName,
    revision: 1,
    snapshot: built.snapshot,
    declaredVersion: built.declaredVersion,
    generation,
    seq: earlier === null ? 1 : earlier.seq + 1,
    queuedAt: now.toISOString(),
    state: SUBMISSION_STATE.waiting,
    attempts: 0,
    lastAttemptAt: null,
    result: null,
    problem: null,
    uncertain: false,
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
    // ALL evidence first: an older record never answers for a newer generation.
    const resolution = resolveDay(scope, dayId, now);
    if (resolution.kind === "blocked") return { kind: "locked" };
    if (resolution.kind === "recovered") return { kind: "queued", record: resolution.submission.record };
    const current = resolution.kind === "current" ? resolution.submission.record : null;
    if (current !== null && isLocking(current.state)) return { kind: "queued", record: current };

    const built = buildSnapshot(day);
    if (built.kind !== "ok") return built;
    // Only a snapshot the server proved it keeps nothing of is followed — as the NEXT generation,
    // beside every earlier seal, which is never replaced.
    const previous = current;
    const generation = Math.max(previous?.generation ?? 0, highestEvidenceGeneration(scope, dayId)) + 1;
    const next = firstRecord(scope, dayId, built, now, previous, generation);
    try {
      // The seal first: no record — no lock, nothing sent — without its exact bytes.
      writeSeal(scope, {
        ownerUserId: scope.userId, dayId, generation: next.generation, membershipId: next.membershipId,
        companyName: next.companyName, declaredVersion: next.declaredVersion, snapshotJson: JSON.stringify(next.snapshot),
      });
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
 * A record the recovery layer has VERIFIED may be sent — its generation is
 * the authoritative one. Made only here (`resolveDay`): the private field
 * makes the type nominal, so no other code can pass a raw record — a stale
 * one least of all — to `sendSubmission`.
 */
class Verified {
  readonly #verified = true;
  constructor(readonly record: TimesheetSubmissionRecord) {}
  isVerified(): boolean { return this.#verified; }
}
export type VerifiedSubmission = Verified;

/** What the recovery layer says about a day — explicit, never a bare boolean. */
export type Resolution =
  /** No record, and no evidence one ever existed. */
  | { kind: "nothing" }
  /** The record on disk is the authoritative generation, safe as it stands. */
  | { kind: "current"; submission: VerifiedSubmission }
  /** The authoritative generation was restored from its own seal, safe now. */
  | { kind: "recovered"; submission: VerifiedSubmission }
  /** Recovery is needed and impossible: NOTHING of this day may be sent, and the day stays locked. */
  | { kind: "blocked"; reason: "seal-unavailable" };

/**
 * Decide the authoritative generation from ALL surviving evidence, inside the
 * store's write queue:
 *   - the newest generation that may have been sent (a sent-marker) takes
 *     precedence over any record of an older one — a stale record is never a
 *     candidate;
 *   - it is restored ONLY from that generation's own seal: missing or
 *     unreadable → blocked, never an older generation, never the day;
 *   - an unreadable record with no sent evidence is restored from the latest
 *     seal (never sent, so nothing to contradict);
 *   - a record at or above every sent generation is current.
 */
function resolveDay(scope: AccountScope, dayId: string, now: Date): Resolution {
  const read = readSubmission(scope, dayId);
  const sent = highestSentGeneration(scope, dayId);
  if (read.kind === "ok" && (sent === null || sent <= read.record.generation)) return { kind: "current", submission: new Verified(read.record) };
  if (read.kind === "none" && sent === null) return { kind: "nothing" };

  const generation = sent ?? highestSealGeneration(scope, dayId);
  const seal = generation === 0 ? null : readSeal(scope, dayId, generation);
  if (seal === null) return { kind: "blocked", reason: "seal-unavailable" };
  if (read.kind === "unreadable") setAsideUnreadable(scope, dayId, now);
  const snapshot: unknown = JSON.parse(seal.snapshotJson);
  const restored: TimesheetSubmissionRecord = {
    ownerUserId: scope.userId, dayId, membershipId: seal.membershipId, companyName: seal.companyName, revision: 1,
    snapshot, declaredVersion: seal.declaredVersion, generation: seal.generation,
    seq: (read.kind === "ok" ? read.record.seq : 0) + 1, queuedAt: now.toISOString(),
    // A generation that may have been sent comes back `sending` and uncertain: replayed, the server settles it.
    state: sent === null ? SUBMISSION_STATE.waiting : SUBMISSION_STATE.sending, attempts: 0,
    lastAttemptAt: null, result: null, problem: null, uncertain: sent !== null, earlier: [],
  };
  writeSubmission(scope, restored);
  return { kind: "recovered", submission: new Verified(restored) };
}

/** `resolveDay`, in the store's one write queue — what every dispatch must go through. */
export function resolveSubmission(scope: AccountScope, dayId: string, now: Date = new Date()): Promise<Resolution> {
  return withFinishedDay(scope, dayId, (): Resolution => resolveDay(scope, dayId, now));
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
    });
  }
  const seal = readSeal(scope, record.dayId, record.generation);
  if (seal === null || seal.snapshotJson !== frozen || seal.membershipId !== record.membershipId) return null;
  return seal.snapshotJson;
}

/** The problem a refusal is recorded as while it proves nothing (`submissionStatus.ts` explains it). */
export const UNCONFIRMED = "unconfirmed";

/** The problem a refusal is recorded as when the API answering it did not name the contract: it proves nothing either. */
export const INCOMPATIBLE = "incompatible";

/**
 * The one submission contract this app speaks (`api/src/lib/submissionContract.ts`):
 * authorise, then a replay is answered before anything is validated, and only
 * `400 TIMESHEET_REJECTED` proves nothing is kept. Any change to that is a new name.
 */
const SUBMISSION_CONTRACT = "replay-first-1";

/**
 * The API, asked this run, said it speaks `SUBMISSION_CONTRACT`. Made only by
 * `discoverCompatibility` — the private field makes the TYPE nominal — and
 * honoured at RUN TIME only while `issued` holds it: for the account that
 * asked, at the API address it asked, until `retireCompatibility` (the runner
 * retires it when its run ends). An object made anywhere else, another
 * account's token, or one kept past its run sends nothing. A guard on this
 * app's own sending, never authority: the server authorises every request
 * by its identity token alone.
 */
class Compatible {
  readonly #compatible = true;
  /** Whether `value` was made by this class — a structural look-alike never is. */
  static made(value: object): boolean { return #compatible in value; }
}
export type CompatibleApi = Compatible;

/** Every token still live, with the account and API address its discovery was for. */
const issued = new WeakMap<object, { userId: string; api: string }>();

function isLive(scope: AccountScope, compatible: CompatibleApi): boolean {
  if (!Compatible.made(compatible)) return false;
  const bound = issued.get(compatible);
  return bound !== undefined && bound.userId === scope.userId && bound.api === apiBaseUrl();
}

/** End a token's run: it sends nothing more. */
export function retireCompatibility(compatible: CompatibleApi): void {
  issued.delete(compatible);
}

/**
 * What the API says it is — asked before anything is sent:
 *   compatible    it advertises `SUBMISSION_CONTRACT`
 *   incompatible  it answered, and does not (an older API's 404, another protocol)
 *   unknown       no usable answer (no connection, a session not renewed, a fault)
 * Neither of the last two sends anything, and neither touches a record.
 */
export type Compatibility =
  | { kind: "compatible"; api: CompatibleApi }
  | { kind: "incompatible" }
  | { kind: "unknown"; failure: Exclude<ApiResult<unknown>, { kind: "ok" }> };

export async function discoverCompatibility(scope: AccountScope, withIdentity: WithIdentity): Promise<Compatibility> {
  const api = apiBaseUrl();
  const result = await withIdentity(token => fetchCapabilities(token));
  if (result.kind === "ok") {
    if (result.value.timesheetSubmissionProtocol !== SUBMISSION_CONTRACT) return { kind: "incompatible" };
    const compatible = new Compatible();
    issued.set(compatible, { userId: scope.userId, api });
    return { kind: "compatible", api: compatible };
  }
  return result.kind === "api" && result.status === 404 ? { kind: "incompatible" } : { kind: "unknown", failure: result };
}

/**
 * Discovery could not ask because the driver must sign in again: a WAITING
 * record says so — its state, snapshot, seal and uncertainty untouched, and
 * nothing sent. Any other record, or any other failure, is left exactly as it is.
 */
export function noteSignInNeeded(scope: AccountScope, verified: VerifiedSubmission, failure: Exclude<ApiResult<unknown>, { kind: "ok" }>): TimesheetSubmissionRecord | null {
  if (!verified.isVerified()) return null;
  const { record } = verified;
  if (record.state !== SUBMISSION_STATE.waiting || classifyFailure(failure) !== FAILURE.session) return null;
  return advance(scope, record, { ...record, seq: record.seq + 1, problem: problemOf(failure, FAILURE.session) });
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

/**
 * THE FINAL CHECK, at the dispatch boundary (independent retest of d6060a8):
 * is this record STILL the authoritative generation, now — after however
 * long the identity step took? Re-read from disk: the record (owner, day,
 * generation, sequence, `sending`), every seal, staged seal and sent-marker
 * of the day (nothing beyond this generation), and this generation's own
 * seal (owner, the exact bytes, the membership). Returns the bytes to send,
 * or `null`: send nothing.
 *
 * It runs inside the `withIdentity` callback — on every call, a renewed one
 * included — and the request is started in the SAME synchronous turn: the
 * API client reaches `fetch` before its first `await`. JavaScript runs one
 * turn to completion, and every write this app makes to submission files is
 * synchronous (`submissionStore.ts`), so no application change can fall
 * between the check and the request leaving — with no lock held across the
 * network, and none taken that `withIdentity`, the runner or the store's
 * write queue could wait on.
 *
 * ASSUMPTION (outside the app's control): another process changing these
 * files in that same instant — a backup restore, a file manager — is not
 * excluded. It is caught at the next run's resolution.
 */
function confirmAtDispatch(scope: AccountScope, sending: TimesheetSubmissionRecord): string | null {
  const read = readSubmission(scope, sending.dayId);
  if (read.kind !== "ok") return null;
  const current = read.record;
  if (current.ownerUserId !== scope.userId || current.dayId !== sending.dayId || current.generation !== sending.generation
    || current.seq !== sending.seq || current.state !== SUBMISSION_STATE.sending) return null;
  // Any evidence of a later generation — a marker above all — and this one is no longer authoritative.
  if (highestEvidenceGeneration(scope, sending.dayId) > sending.generation) return null;
  const sent = highestSentGeneration(scope, sending.dayId);
  if (sent !== null && sent > sending.generation) return null;
  const seal = readSeal(scope, sending.dayId, sending.generation);
  if (seal === null || seal.ownerUserId !== scope.userId || seal.membershipId !== current.membershipId
    || seal.snapshotJson !== JSON.stringify(current.snapshot)) return null;
  return seal.snapshotJson;
}

/** What `withIdentity` is answered with when the final check refused: nothing left the phone. */
const NOT_DISPATCHED: { kind: "network"; message: string; detail: null } = { kind: "network", message: "Not dispatched: the evidence changed", detail: null };

/** Send one queued record; the record as it now stands, or `null` when it could not be advanced. */
export async function sendSubmission(scope: AccountScope, verified: VerifiedSubmission, compatible: CompatibleApi, withIdentity: WithIdentity, at: Date): Promise<TimesheetSubmissionRecord | null> {
  if (!verified.isVerified() || !isLive(scope, compatible)) return null;
  const { record } = verified;
  const bytes = sealedBytes(scope, record);
  if (bytes === null) return null;
  const sealed: unknown = JSON.parse(bytes);
  const sending = advance(scope, record, {
    ...record, state: SUBMISSION_STATE.sending, attempts: record.attempts + 1, lastAttemptAt: at.toISOString(), seq: record.seq + 1,
    // Found `sending`: the app stopped while a request may have been on its way.
    uncertain: record.uncertain || record.state === SUBMISSION_STATE.sending,
  });
  if (sending === null) return null;
  // Before the request may leave: from now on, "never sent" can no longer be assumed.
  markSent(scope, sending.dayId, sending.generation);

  let refusedAtDispatch = false;
  const result = await withIdentity(token => {
    // The final check and the request leaving: one synchronous turn (`confirmAtDispatch`).
    const final = confirmAtDispatch(scope, sending);
    if (final === null || final !== bytes || !isLive(scope, compatible)) {
      refusedAtDispatch = true;
      return Promise.resolve(NOT_DISPATCHED);
    }
    return sendTimesheet(token, {
      membershipId:  sending.membershipId,
      clientEventId: sending.dayId,
      revision:      sending.revision,
      // The SEAL's bytes — exactly what was frozen, every time.
      snapshot:      sealed,
    });
  });
  // The evidence changed while the identity step ran: nothing more is written here; the next run re-resolves.
  if (refusedAtDispatch) return null;

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
    const uncertain = sending.uncertain || outcomeUnknown(result);
    const unlocking = failure === FAILURE.invalid || failure === FAILURE.refused;
    // A rejection, refusal or conflict is DEFINITIVE only from an answer naming the contract exactly —
    // the API checked may have been rolled back since, or another version answered.
    const definitive = unlocking || failure === FAILURE.conflict;
    const compatibleAnswer = result.kind === "api" && result.contract === SUBMISSION_CONTRACT;
    if (definitive && !compatibleAnswer) {
      // Not this contract's answer: it proves nothing about what is kept. Kept, locked, uncertain, replayed.
      next = { ...sending, seq: sending.seq + 1, uncertain: true, state: SUBMISSION_STATE.waiting, problem: { ...problemOf(result, failure), kind: INCOMPATIBLE } };
    } else if (unlocking && uncertain && !provesNothingKept(result)) {
      // The server may keep an earlier transmission of these bytes: nothing is proven. Kept, locked, replayed.
      next = { ...sending, seq: sending.seq + 1, uncertain, state: SUBMISSION_STATE.waiting, problem: { ...problemOf(result, failure), kind: UNCONFIRMED } };
    } else {
      const state = failure === FAILURE.session || failure === FAILURE.temporary ? SUBMISSION_STATE.waiting : STATE_FOR[failure];
      next = { ...sending, seq: sending.seq + 1, uncertain, state, problem: problemOf(result, failure) };
    }
  }
  // If this write fails the record stays `sending`: the next run replays it.
  return advance(scope, sending, next);
}
