/**
 * A company's settings (D66): its measurement units (D52).
 *
 * Every operation passes D54's company-web gate, `authorizeCompanyAdmin`,
 * and acts in the administrator's own company. Changing the units never
 * relabels anything already recorded: each reading and quantity carries the
 * unit it was recorded in.
 */
import { z } from "zod";
import type { AuthContext } from "../lib/auth.js";
import { authorizeCompanyAdmin } from "../lib/authorization.js";
import { DistanceUnitField, VolumeUnitField, type CompanyUnits } from "../lib/units.js";
import type { CompanySettingsRepository } from "../repositories/companySettingsRepository.js";

/** Both units, chosen together. Strict: a company, or anything else, in the body is refused. */
export const UnitsBody = z.object({
  distanceUnit: DistanceUnitField,
  volumeUnit:   VolumeUnitField,
}).strict();

export type UnitsInput = z.infer<typeof UnitsBody>;

export function companyUnits(auth: AuthContext, settings: CompanySettingsRepository): Promise<CompanyUnits> {
  return settings.units(authorizeCompanyAdmin(auth));
}

export function setCompanyUnits(auth: AuthContext, input: UnitsInput, settings: CompanySettingsRepository): Promise<CompanyUnits> {
  return settings.setUnits(authorizeCompanyAdmin(auth), input);
}
