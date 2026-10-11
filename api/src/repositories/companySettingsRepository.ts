/**
 * A company's own settings (D66) — the only place they are read or changed.
 *
 * Every method takes the administrator's `TenantContext` and addresses the
 * Company by ITS `companyId` and nothing else, so another company's settings
 * are not expressible here.
 */
import type { DistanceUnit, VolumeUnit } from "../generated/enums.js";
import type { TenantContext } from "../lib/tenantContext.js";
import type { CompanyUnits } from "../lib/units.js";

const UNITS = { distanceUnit: true, volumeUnit: true } as const;

export interface CompanySettingsDatabase {
  company: {
    findUnique(args: { where: { id: string }; select: typeof UNITS }): Promise<CompanyUnits | null>;
    update(args: { where: { id: string }; data: { distanceUnit: DistanceUnit; volumeUnit: VolumeUnit }; select: typeof UNITS }): Promise<CompanyUnits>;
  };
}

export function companySettingsRepository(db: CompanySettingsDatabase) {
  return {
    async units(ctx: TenantContext): Promise<CompanyUnits> {
      const row = await db.company.findUnique({ where: { id: ctx.companyId }, select: UNITS });
      // The token's membership was matched to this company on THIS request.
      if (row === null) throw new Error("an authorised company is missing");
      return { distanceUnit: row.distanceUnit, volumeUnit: row.volumeUnit };
    },

    /** Both at once: a company never holds one unit chosen and the other half-changed. */
    async setUnits(ctx: TenantContext, units: { distanceUnit: DistanceUnit; volumeUnit: VolumeUnit }): Promise<CompanyUnits> {
      const row = await db.company.update({ where: { id: ctx.companyId }, data: units, select: UNITS });
      return { distanceUnit: row.distanceUnit, volumeUnit: row.volumeUnit };
    },
  };
}

export type CompanySettingsRepository = ReturnType<typeof companySettingsRepository>;
