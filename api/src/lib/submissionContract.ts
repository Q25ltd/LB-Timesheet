/**
 * The versioned SUBMISSION CONTRACT this API keeps (D66, S6 compatibility):
 *
 *   replay-first-1   a day already kept under its id is answered by its
 *                    stored hash before anything else — identical bytes are
 *                    replayed (200), different bytes are a conflict (409),
 *                    never re-validated; accepted submissions are immutable;
 *                    only a NEW day is validated, and its refused snapshot is
 *                    answered TIMESHEET_REJECTED — issued only once nothing is
 *                    kept under the id (`services/timesheetSubmissions.ts`).
 *
 * The phone sends only to an API that advertises it (`GET /driver/capabilities`)
 * and trusts a refusal as final only from a response that names it
 * (`X-LB-Submission-Contract`): an older API, or a rollback to one between the
 * two, can then never be read as proof that nothing is kept. A change to any
 * of the behaviour above is a NEW contract name, never this one.
 */
export const SUBMISSION_CONTRACT = "replay-first-1";

/** The response header naming the contract a submission answer was given under. */
export const SUBMISSION_CONTRACT_HEADER = "x-lb-submission-contract";
