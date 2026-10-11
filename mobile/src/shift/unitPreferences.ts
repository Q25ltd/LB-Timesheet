/**
 * The driver's OWN units, for Personal days (D66) — a company's day uses the
 * company's. One small file in the signed-in account's own directory (F-31):
 * another driver on the same phone neither sees nor uses it.
 *
 * Unset is a real answer: a Personal day recorded with no preference records
 * its readings with no unit, and the app says how to set one. A file that
 * cannot be read is treated as unset — never as a guessed unit — and is not
 * rewritten until the driver chooses again.
 */
import { File } from "expo-file-system";
import { accountDirectory, type AccountScope } from "./accountScope";
import { isDistanceUnit, isVolumeUnit, type DistanceUnit, type VolumeUnit } from "./units";

export const UNIT_PREFERENCES_FILE = "logisticbay-unit-preferences.json";

export interface UnitPreferences {
  distanceUnit: DistanceUnit | null;
  volumeUnit: VolumeUnit | null;
}

const UNSET: UnitPreferences = { distanceUnit: null, volumeUnit: null };

function preferencesFile(scope: AccountScope): File {
  return new File(accountDirectory(scope), UNIT_PREFERENCES_FILE);
}

export function readUnitPreferences(scope: AccountScope): UnitPreferences {
  const file = preferencesFile(scope);
  if (!file.exists) return UNSET;
  try {
    const parsed: unknown = JSON.parse(file.textSync());
    if (typeof parsed !== "object" || parsed === null) return UNSET;
    const { distanceUnit, volumeUnit } = parsed as Record<string, unknown>;
    return {
      distanceUnit: isDistanceUnit(distanceUnit) ? distanceUnit : null,
      volumeUnit:   isVolumeUnit(volumeUnit) ? volumeUnit : null,
    };
  } catch {
    // Unreadable is unset: nothing is guessed, and the driver can choose again.
    return UNSET;
  }
}

/** Both at once, written in full and read back; throws when that could not be done. */
export function saveUnitPreferences(scope: AccountScope, preferences: { distanceUnit: DistanceUnit; volumeUnit: VolumeUnit }): void {
  if (!isDistanceUnit(preferences.distanceUnit) || !isVolumeUnit(preferences.volumeUnit)) throw new Error("Refusing an unknown unit");
  const serialised = JSON.stringify({ distanceUnit: preferences.distanceUnit, volumeUnit: preferences.volumeUnit });
  const file = preferencesFile(scope);
  file.create({ overwrite: true });
  file.write(serialised);
  if (file.textSync() !== serialised) throw new Error("Your units were not saved in full");
}
