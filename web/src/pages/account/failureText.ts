import type { Failure } from "../../auth/AuthProvider";

/** What a person is told for each kind of refusal. Never which check failed. */
export function failureText(failure: Failure): string {
  switch (failure) {
    case "invalid":      return "Please check the details and try again.";
    case "credentials":  return "Email or password is incorrect.";
    case "email-in-use": return "An account with this email already exists. Sign in instead.";
    case "undeliverable": return "Email cannot be delivered to this address. Correct your email address and try again.";
    case "forbidden":    return "That is not allowed.";
    case "conflict":     return "That cannot be done right now.";
    case "rate-limited": return "Too many attempts. Please wait a while and try again.";
    case "unavailable":  return "That could not be completed just now. Please try again shortly.";
    case "offline":      return "We could not reach LogisticBay Timesheets. Check your connection and try again.";
    case "signed-out":   return "Your session has ended. Please sign in again.";
    case "unexpected":   return "Something went wrong. Please try again.";
  }
}
