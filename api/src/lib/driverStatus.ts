/**
 * The ONE registry of how a company sees a driver's standing (D65; CLAUDE.md,
 * "one status string registry").
 *
 * Not a column: derived from the membership's `active` and `removedAt`, which
 * the CHECK `CompanyMembership_removed_is_inactive` keeps consistent. A
 * removed driver is not listed; `removed` is only ever the answer to the
 * action that removed them.
 */
const DRIVER_STATUS = {
  active:   "active",
  inactive: "inactive",
  removed:  "removed",
} as const;

export type DriverStatus = (typeof DRIVER_STATUS)[keyof typeof DRIVER_STATUS];

export function driverStatusOf(membership: { active: boolean; removedAt: Date | null }): DriverStatus {
  if (membership.removedAt !== null) return DRIVER_STATUS.removed;
  return membership.active ? DRIVER_STATUS.active : DRIVER_STATUS.inactive;
}
