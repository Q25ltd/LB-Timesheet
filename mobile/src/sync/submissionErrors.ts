/**
 * What a failed send MEANS for a queued timesheet (D66 stage S6) — decided by
 * the server's structured error code and the session lifecycle, never by the
 * HTTP status alone.
 *
 *   session      the identity is gone or could not be renewed → kept, sent
 *                again once the driver is signed in (never discarded)
 *   temporary    no answer, a timeout, the cap (429), a server fault, or any
 *                answer not listed below → kept, sent again — the same bytes
 *   refused      the membership is not this driver's to submit with
 *                (403 FORBIDDEN, 404 NOT_FOUND) — authorised before anything
 *                is stored, so NOTHING was stored: the day unlocks
 *   invalid      the server rejected this snapshot itself (400
 *                TIMESHEET_REJECTED; and, from older servers, VALIDATION,
 *                TIMESHEET_INVALID, 413 body too large) — the day unlocks
 *                for the driver to correct ONLY when that proves nothing
 *                is kept (`provesNothingKept`, or no earlier transmission
 *                of it had an unknown outcome — `submissionQueue.ts`)
 *   conflict     the server already holds a DIFFERENT version of this day
 *                (409 SUBMISSION_MISMATCH): the frozen snapshot is kept and
 *                the day stays locked for an amendment (S9)
 *
 * Only an exact (status, code) pair the server documents makes an outcome
 * final; anything unrecognised is retried, so no submission is ever given up
 * on because of an answer nobody meant as final.
 */
import type { ApiResult } from "../api/client";
import { SESSION_RENEWAL_UNAVAILABLE } from "../auth/sessionRenewal";

export const FAILURE = {
  session:   "session",
  temporary: "temporary",
  refused:   "refused",
  invalid:   "invalid",
  conflict:  "conflict",
} as const;

export type Failure = (typeof FAILURE)[keyof typeof FAILURE];

type NotOk = Exclude<ApiResult<unknown>, { kind: "ok" }>;

/**
 * The server's refusal of a NEW day (S4, since the 2026-10-17 remediation):
 * issued only after it found nothing kept under the day's id — so it, and it
 * alone, proves nothing is kept, whatever came before.
 */
const TIMESHEET_REJECTED = "TIMESHEET_REJECTED";

/** The (status, code) pairs the server means as final — and nothing else. */
const FINAL: readonly { status: number; code: string; failure: Failure }[] = [
  { status: 400, code: TIMESHEET_REJECTED,            failure: FAILURE.invalid },
  { status: 400, code: "VALIDATION",                  failure: FAILURE.invalid },
  { status: 400, code: "TIMESHEET_INVALID",           failure: FAILURE.invalid },
  { status: 413, code: "FST_ERR_CTP_BODY_TOO_LARGE",  failure: FAILURE.invalid },
  { status: 403, code: "FORBIDDEN",                   failure: FAILURE.refused },
  { status: 404, code: "NOT_FOUND",                   failure: FAILURE.refused },
  { status: 409, code: "SUBMISSION_MISMATCH",         failure: FAILURE.conflict },
];

export function classifyFailure(result: NotOk): Failure {
  if (result.kind === "network") {
    return result.message === SESSION_RENEWAL_UNAVAILABLE ? FAILURE.session : FAILURE.temporary;
  }
  if (result.status === 401) return FAILURE.session;
  const final = FINAL.find(entry => entry.status === result.status && entry.code === result.body.code);
  return final?.failure ?? FAILURE.temporary;
}

/** Whether this answer PROVES the server keeps nothing under the day's id. */
export function provesNothingKept(result: NotOk): boolean {
  return result.kind === "api" && result.status === 400 && result.body.code === TIMESHEET_REJECTED;
}

/**
 * Whether the request may have reached the server without the phone learning
 * what it did: no usable answer (except a session that could not be renewed —
 * its request was refused before anything), a server fault, or an answer this
 * app does not recognise. A 401 and a 429 are answers: nothing was kept.
 */
export function outcomeUnknown(result: NotOk): boolean {
  if (result.kind === "network") return result.message !== SESSION_RENEWAL_UNAVAILABLE;
  if (result.status === 401 || result.status === 429) return false;
  if (result.status >= 500) return true;
  return !FINAL.some(entry => entry.status === result.status && entry.code === result.body.code);
}
