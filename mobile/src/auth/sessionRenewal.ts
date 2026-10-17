/**
 * What `withIdentity` answers when the identity could not be renewed for a
 * reason other than the server's refusal — a network-kind result, so a
 * screen says "connection", and named here so the sync runner can tell it
 * from a plain network failure: both are retried, but this one is about the
 * session (`submissionErrors.ts`).
 */
export const SESSION_RENEWAL_UNAVAILABLE = "The session could not be renewed";
