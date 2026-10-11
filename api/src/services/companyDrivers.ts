/**
 * A company manages its drivers (D65): lists them, and deactivates,
 * reactivates or removes one.
 *
 * Every operation passes D54's one company-web gate, `authorizeCompanyAdmin`,
 * and acts in the TenantContext it returns — the administrator's own
 * company, from the token's membership row, never from the request. The
 * driver's other companies are not expressible here: each is a different
 * membership row.
 *
 * What a transition does to the driver is entirely `active` (AUTH.md):
 * deactivated or removed, no new shift and no company authority, from the
 * driver's next request. It never deletes the membership, its shifts or the
 * driver's account, and a shift the driver already started keeps its
 * company (D65, Option A).
 */
import { z } from "zod";
import type { AuthContext } from "../lib/auth.js";
import { authorizeCompanyAdmin } from "../lib/authorization.js";
import { driverStatusOf, type DriverStatus } from "../lib/driverStatus.js";
import { AppError } from "../lib/errors.js";
import type { CompanyDriverRepository, CompanyDriverRow, DriverAction } from "../repositories/companyDriverRepository.js";

/** The membership id in a path — a cuid, as the database issues them. */
export const DriverParams = z.object({ membershipId: z.string().min(1).max(64) }).strict();

/** How the company sees one of its drivers: the account's name and email, its own payroll reference, where they stand. */
export interface CompanyDriverView {
  membershipId: string;
  firstName: string;
  lastName: string;
  email: string;
  payrollRef: string | null;
  status: DriverStatus;
  joinedAt: string;
}

function viewOf(row: CompanyDriverRow): CompanyDriverView {
  return {
    membershipId: row.membershipId,
    firstName:    row.firstName,
    lastName:     row.lastName,
    email:        row.email,
    payrollRef:   row.payrollRef,
    status:       driverStatusOf(row),
    joinedAt:     row.joinedAt.toISOString(),
  };
}

export async function listDrivers(auth: AuthContext, drivers: CompanyDriverRepository): Promise<CompanyDriverView[]> {
  const ctx = authorizeCompanyAdmin(auth);
  return (await drivers.list(ctx)).map(viewOf);
}

const WRONG_STATE: Record<DriverAction, string> = {
  deactivate: "This driver is already deactivated",
  reactivate: "This driver is already active",
  remove:     "This driver cannot be removed",
};

export async function changeDriver(
  auth: AuthContext,
  membershipId: string,
  action: DriverAction,
  drivers: CompanyDriverRepository,
  now: Date = new Date(),
): Promise<CompanyDriverView> {
  const ctx = authorizeCompanyAdmin(auth);
  const outcome = await drivers.apply(ctx, membershipId, action, now);
  if (outcome.kind === "not_found") throw new AppError(404, "Not found", "NOT_FOUND");
  if (outcome.kind === "wrong_state") throw new AppError(409, WRONG_STATE[action], "MEMBERSHIP_STATE");
  return viewOf(outcome.driver);
}
