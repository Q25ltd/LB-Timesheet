/**
 * The ONE registry of measurement units (D52, D66; CLAUDE.md, "one status
 * string registry"). The values are the database's own enums; this is
 * where a request's unit is validated, so every route accepts exactly these
 * and nothing that merely looks like one ("KILOMETRE", "gallon").
 */
import { z } from "zod";
import { DistanceUnit, VolumeUnit } from "../generated/enums.js";

export const DistanceUnitField = z.enum([DistanceUnit.kilometre, DistanceUnit.mile]);
export const VolumeUnitField = z.enum([VolumeUnit.litre, VolumeUnit.us_gallon, VolumeUnit.imperial_gallon]);

/** A company's units: each chosen, or null where the company has not chosen yet — never defaulted. */
export interface CompanyUnits {
  distanceUnit: DistanceUnit | null;
  volumeUnit: VolumeUnit | null;
}
