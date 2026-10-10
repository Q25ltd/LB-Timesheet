/**
 * The Add Fuel / Add AdBlue route. Wiring only.
 *
 * A Stack sibling of the tab group, like Vehicle Checks, so it shows no tab
 * bar and sits inside the `(app)` gate. Which of the two it is comes from the
 * `type` parameter; anything else is not a screen, so it goes back rather
 * than guessing one.
 *
 * IT IS ALWAYS OPENED FOR ONE EXACT USE (D31). `usage` is that use's
 * `useId` (D42), and `usageState` says which kind of use the opener meant:
 *
 *   in-use   Fuel / AdBlue in the current vehicle card on Active Shift
 *   ended    a used vehicle's Edit, correcting what it holds
 *
 * Both are required. A use the day does not hold in that state is not a
 * screen: it redirects rather than falling back to the vehicle in use, looking
 * the plate up, or quietly treating a vehicle that has since been handed back
 * as history. And the store checks the same two facts again when the driver
 * saves, so a vehicle ended between opening and saving is refused there too.
 *
 * An ENDED use is correctable with no vehicle in use at all — a driver between
 * vehicles must not have to take one to fix the morning's fuel.
 */
import { useCallback, useState } from "react";
import { Alert } from "react-native";
import { Redirect, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { VehicleFillScreen, type FillEntry, type FillUsage } from "../../src/screens/VehicleFillScreen";
import { Restoring } from "../../src/components/Restoring";
import {
  USAGE_STATE,
  newLocalId,
  recordVehicleFill,
  removeVehicleFill,
  type LocalShift,
  type UsageState,
} from "../../src/shift/localShift";
import { FILL_TYPES, fillTypeLabel, fillsOfType, type FillType } from "../../src/shift/vehicleFill";
import { formatClockTime, saveFailureMessage } from "../../src/screens/format";
import { leaveStale, missingHref, readScreenDay } from "../../src/navigation/useScreenDay";
import { useAccountScope } from "../../src/shift/useAccountScope";
import type { AccountScope } from "../../src/shift/accountScope";

export default function VehicleFillRoute() {
  const scope = useAccountScope();
  const { type, usage, usageState, timesheet } = useLocalSearchParams<{ type?: string; usage?: string; usageState?: string; timesheet?: string }>();
  const [shift, setShift] = useState<LocalShift | null | "loading">("loading");

  // Re-read on every return, so a fill stored here — or a vehicle changed
  // behind this screen — is what the driver sees.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      if (scope === null) return undefined;
      void readScreenDay(scope, timesheet).then(open => { if (!cancelled) setShift(open); });
      return () => { cancelled = true; };
    }, [scope, timesheet]),
  );

  const fillType = FILL_TYPES.find(entry => entry.id === type)?.id ?? null;
  const state = Object.values(USAGE_STATE).find(entry => entry === usageState) ?? null;
  // No signed-in account's scope yet: nothing of anyone's is read (F-31).
  if (scope === null) return <Restoring />;
  if (fillType === null || state === null || usage === undefined) return <Redirect href={missingHref(timesheet, true)} />;

  // Reading the phone's own shift file — not signing anyone in.
  if (shift === "loading") return <Restoring message="Loading shift…" />;
  if (shift === null) return <Redirect href={missingHref(timesheet, false)} />;

  const target = fillUsage(shift, usage, state, fillType);
  if (target === null) return <Redirect href={missingHref(timesheet, true)} />;

  const named = { shiftId: shift.id, vehicleUseId: usage, usageState: state };
  return (
    <VehicleFillScreen
      label={fillTypeLabel(fillType)}
      asset="vehicle"
      usage={target}
      onLeave={() => { router.back(); }}
      onSave={entry => save(scope, named, fillType, entry, setShift, timesheet)}
      onRemove={fillId => remove(scope, named, fillId, setShift, timesheet)}
    />
  );
}

/**
 * The use named, in the state the opener expected — or `null`. By `useId`
 * alone: a day may hold the same registration three times.
 */
function fillUsage(shift: LocalShift, useId: string, state: UsageState, type: FillType): FillUsage | null {
  if (state === USAGE_STATE.inUse) {
    const current = shift.vehicle;
    if (current?.useId !== useId) return null;
    return { name: current.numberPlate, hours: null, fills: fillsOfType(current.fills, type) };
  }
  const ended = shift.previousVehicles.find(use => use.useId === useId);
  if (ended === undefined) return null;
  return {
    name: ended.numberPlate,
    hours: `${formatClockTime(ended.startedAt)}–${formatClockTime(ended.endedAt)}`,
    fills: fillsOfType(ended.fills, type),
  };
}

interface NamedUsage { shiftId: string; vehicleUseId: string; usageState: UsageState }
type Show = (shift: LocalShift | null) => void;

/** Store the fill, then show the day it produced — no second read. */
async function save(scope: AccountScope, named: NamedUsage, type: FillType, entry: FillEntry, show: Show, timesheet: string | undefined): Promise<void> {
  try {
    const day = await recordVehicleFill(scope, {
      ...named,
      // A correction keeps the entry's own id; a new fill gets one.
      fillId: entry.fillId ?? newLocalId(),
      type,
      recordedAt: entry.recordedAt,
      litres: entry.litres,
      note: entry.note,
    });
    settle(day, show, timesheet);
  } catch (error: unknown) {
    Alert.alert("Couldn't save that", saveFailureMessage(error));
    throw error;
  }
}

async function remove(scope: AccountScope, named: NamedUsage, fillId: string, show: Show, timesheet: string | undefined): Promise<void> {
  try {
    settle(await removeVehicleFill(scope, { ...named, fillId }), show, timesheet);
  } catch (error: unknown) {
    Alert.alert("Couldn't remove that", saveFailureMessage(error));
    throw error;
  }
}

/**
 * `null` means the day or the use moved on beneath this screen — the day was
 * discarded, or the vehicle it was opened for has been handed back. Nothing
 * was written, and the driver is told so and returned to the day rather than
 * left typing into a form that can no longer store anything.
 */
function settle(day: LocalShift | null, show: Show, timesheet: string | undefined): void {
  if (day === null) {
    Alert.alert("Nothing was saved", "That vehicle is no longer the one this was opened for.");
    leaveStale(timesheet);
    return;
  }
  show(day);
}
