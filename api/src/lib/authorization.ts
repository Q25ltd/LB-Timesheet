/**
 * The ONE place authenticated identity becomes tenant authority (F-14).
 *
 * AUTH.md separates two questions that look alike and are not:
 *
 *   "is there a valid identity?"  → requireAuth  (auth.ts)  → 401 on failure
 *   "may this identity do this?"  → HERE                    → 403 on failure
 *
 * requireAuth deliberately authenticates a DEACTIVATED membership: the day's
 * work already happened and the company should still receive the record, so
 * deactivation limits authority rather than erasing identity. That makes
 * `membershipStatus` authenticated INFORMATION, not permission. This module is
 * where it finally becomes a decision.
 *
 * AUTH.md, "Deactivated membership — limited authority": *"Default is deny:
 * every route requires an active membership unless it explicitly opts in."*
 * The opting in is the part that does not exist yet and is not invented here —
 * see the note on the future exception below.
 */
import type { AuthContext } from "./auth.js";
import { AppError } from "./errors.js";
import { TenantContext } from "./tenantContext.js";

/**
 * The ONE failure this boundary produces, and deliberately a generic one.
 *
 * It never says *why*. A response distinguishing "your membership was
 * deactivated" from "that is not yours" turns the boundary into an oracle for
 * account state, which is the same mistake the 401 path avoids by returning
 * one identical body for every authentication failure (auth.ts,
 * `unauthenticated`). Mirrors that shape on purpose: same structure, different
 * question, different status.
 *
 * Constructed fresh each time rather than shared, so stacks stay honest.
 */
function forbidden(): AppError {
  return new AppError(403, "Not allowed", "FORBIDDEN");
}

/**
 * Ordinary tenant authority for a protected business operation.
 *
 * Takes the trusted `AuthContext` and NOTHING else. That is the security
 * property, and it is structural rather than defensive: there is no parameter
 * for a companyId, membershipId, userId, role, request, body, query or
 * options bag, so hostile client identity has no channel to arrive through and
 * this function needs no code to reject it. Absence beats comparison.
 *
 * No database read. requireAuth has already loaded the Session and the
 * CompanyMembership, cross-checked the token's `companyId` against the
 * membership row, and built this context from the ROW rather than the claims.
 * Re-reading here would be a second, divergent source of truth for an identity
 * that was already validated against persistence.
 *
 * ACTIVE ONLY, by construction. The comparison is `!== "active"` rather than
 * `=== "inactive"`: anything that is not exactly active is denied, so a future
 * third membership state fails closed instead of silently inheriting full
 * authority — the same polarity requireAuth uses for `membership.active`.
 *
 * The future inactive exceptions AUTH.md anticipates (read, and update/submit,
 * an ALREADY-OPEN shift) are NOT reachable from here and must never be added
 * as a flag, an options bag or an extra argument to this function. They belong
 * in a separate, separately-named export, designed with the business feature
 * that needs them — so that granting an inactive membership any authority is a
 * visible, greppable act rather than a truthy argument at one call site.
 */
export function authorizeTenant(auth: AuthContext): TenantContext {
  if (auth.membershipStatus !== "active") throw forbidden();

  // Every dimension the repositories scope on, taken straight from the
  // authenticated context. membershipId is not optional detail: shiftRepository
  // filters findById/update/delete on it, and dropping it would widen each of
  // them from "this driver's shift" to "anyone's shift in this company" (D15).
  return TenantContext.trust({
    companyId:    auth.companyId,
    userId:       auth.userId,
    membershipId: auth.membershipId,
  });
}
