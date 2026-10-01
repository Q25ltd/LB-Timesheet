import type { ZodError } from "zod";
import { AppError } from "./errors.js";

/**
 * A Zod failure in the project's one error envelope.
 *
 * Only the field path and the message travel. `password` is EXCLUDED from
 * the details entirely: Zod's issues do not carry the input value, but a
 * future custom refinement could easily interpolate one into its message,
 * and a validation response is the last place a credential should be able to
 * appear. The rule the driver needs is stable text the client already knows.
 */
export function invalidRequest(error: ZodError): AppError {
  const details = error.issues.map(issue => ({
    path:    issue.path.join("."),
    message: issue.path[0] === "password" ? "Password does not meet the requirements" : issue.message,
  }));
  return new AppError(400, "Invalid request", "VALIDATION", details);
}
