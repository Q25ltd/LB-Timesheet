/**
 * Which units a NEW reading or quantity is recorded in (D66) — decided once,
 * when it is recorded, and stored with it.
 *
 *   a company's day  the company's units, as the account last read them
 *   a Personal day   the driver's own (`unitPreferences.ts`)
 *
 * Where none is set — a company that has not chosen, a company no longer
 * among the account's companies, a driver with no preference — the unit is
 * `null`, and `unset` says why, so the screen can say it. Never a default.
 */
import { useEffect, useState } from "react";
import type { AccountMembership } from "../api/account";
import { useActiveMemberships } from "../auth/useActiveMemberships";
import type { WorkingContext } from "./localShift";
import { readUnitPreferences, type UnitPreferences } from "./unitPreferences";
import { useAccountScope } from "./useAccountScope";
import type { DistanceUnit, VolumeUnit } from "./units";

export type UnitsUnset =
  | null
  | { kind: "company"; companyName: string }
  | { kind: "personal" };

export interface RecordingUnits {
  distanceUnit: DistanceUnit | null;
  volumeUnit: VolumeUnit | null;
  /** Why one or both are not set — or null when both are. */
  unset: UnitsUnset;
}

export function recordingUnits(
  workingFor: WorkingContext,
  memberships: readonly AccountMembership[] | null,
  preferences: UnitPreferences,
): RecordingUnits {
  if (workingFor.kind === "personal") {
    const { distanceUnit, volumeUnit } = preferences;
    return { distanceUnit, volumeUnit, unset: distanceUnit === null || volumeUnit === null ? { kind: "personal" } : null };
  }
  const membership = memberships?.find(entry => entry.membershipId === workingFor.membershipId);
  const distanceUnit = membership?.distanceUnit ?? null;
  const volumeUnit = membership?.volumeUnit ?? null;
  return {
    distanceUnit,
    volumeUnit,
    unset: distanceUnit === null || volumeUnit === null ? { kind: "company", companyName: workingFor.companyName } : null,
  };
}

/** What the screen says when a unit is not set — or null when both are. */
export function unsetUnitsText(unset: UnitsUnset): string | null {
  if (unset === null) return null;
  return unset.kind === "company"
    ? `${unset.companyName} has not chosen its units yet, so this is recorded without a unit.`
    : "You have not chosen your units for Personal days, so this is recorded without a unit. Choose them in Settings.";
}

/**
 * Resolves the recording units for any Working For — what Start Shift needs
 * while the driver is still choosing. `null` until the signed-in account's
 * preferences are read.
 */
export function useUnitResolver(): ((workingFor: WorkingContext) => RecordingUnits) | null {
  const scope = useAccountScope();
  const memberships = useActiveMemberships();
  const [preferences, setPreferences] = useState<UnitPreferences | null>(null);

  useEffect(() => {
    setPreferences(scope === null ? null : readUnitPreferences(scope));
  }, [scope]);

  if (preferences === null) return null;
  return workingFor => recordingUnits(workingFor, memberships, preferences);
}

/**
 * The recording units for a day being worked for `workingFor`, read for the
 * signed-in account. `null` until there is a day and an account to read for.
 */
export function useRecordingUnits(workingFor: WorkingContext | null): RecordingUnits | null {
  const resolve = useUnitResolver();
  return workingFor === null || resolve === null ? null : resolve(workingFor);
}
