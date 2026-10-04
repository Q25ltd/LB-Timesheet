import { apiRequest, type ApiResult } from "./http";
import { parseConfirmation, parseNoContent } from "./responses";

/**
 * The account flows that need no session: the emailed token, or nothing at
 * all, is the credential. None of them touches the refresh cookie.
 */
export type PublicOutcome = "done" | "invalid-link" | "rejected" | "rate-limited" | "offline" | "unexpected";

function outcome(result: ApiResult<unknown>): PublicOutcome {
  if (result.kind === "ok") return "done";
  if (result.kind === "offline") return "offline";
  if (result.code === "TOKEN_INVALID") return "invalid-link";
  if (result.status === 429) return "rate-limited";
  if (result.status === 400) return "rejected";
  return "unexpected";
}

/** Confirm an emailed link. For a company registration, confirming it completes it (D51). */
export async function confirmEmail(token: string): Promise<{ outcome: PublicOutcome; companyRegistered: boolean }> {
  const result = await apiRequest("/auth/email-verification/confirm", { body: { token } }, parseConfirmation);
  if (result.kind === "ok") return { outcome: "done", companyRegistered: result.value.companyRegistered };
  return { outcome: outcome(result), companyRegistered: false };
}

/** Always answered the same way by the API, whether or not the address has an account. */
export async function requestPasswordReset(email: string): Promise<PublicOutcome> {
  return outcome(await apiRequest("/auth/password/forgot", { body: { email } }, parseNoContent));
}

export async function resetPassword(token: string, password: string): Promise<PublicOutcome> {
  return outcome(await apiRequest("/auth/password/reset", { body: { token, password } }, parseNoContent));
}
