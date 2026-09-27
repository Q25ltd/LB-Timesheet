/**
 * The Add Fuel / Add AdBlue route. Wiring only.
 *
 * A Stack sibling of the tab group, like Vehicle Checks, so it shows no tab
 * bar and sits inside the `(app)` gate. Which of the two it is comes from the
 * `type` parameter; anything else is not a screen, so it goes back rather
 * than guessing one.
 *
 * IT IS ALWAYS OPENED FOR ONE EXACT USE (D31). `usage` is that use's
 * `startedAt`, and `usageState` says which kind of use the opener meant:
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
  readOpenShift,
  recordVehicleFill,
  removeVehicleFill,
  type LocalShift,
  type UsageState,
} from "../../src/shift/localShift";
import { FILL_TYPES, type FillType } from "../../src/shift/vehicleFill";
import { formatClockTime } from "../../src/screens/format";

export default function VehicleFillRoute() {
  const { type, usage, usageState } = useLocalSearchParams<{ type?: string; usage?: string; usageState?: string }>();
  const [shift, setShift] = useState<LocalShift | null | "loading">("loading");

  // Re-read on every return, so a fill stored here — or a vehicle changed
  // behind this screen — is what the driver sees.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void readOpenShift().then(open => { if (!cancelled) setShift(open); });
      return () => { cancelled = true; };
    }, []),
  );

  const fillType = FILL_TYPES.find(entry => entry.id === type)?.id ?? null;
  const state = Object.values(USAGE_STATE).find(entry => entry === usageState) ?? null;
  if (fillType === null || state === null || usage === undefined) return <Redirect href="/active-shift" />;

  // Reading the phone's own shift file — not signing anyone in.
  if (shift === "loading") return <Restoring message="Loading shift…" />;
  if (shift === null) return <Redirect href="/today" />;

  const target = fillUsage(shift, usage, state);
  if (target === null) return <Redirect href="/active-shift" />;

  const named = { shiftId: shift.id, vehicleStartedAt: usage, usageState: state };
  return (
    <VehicleFillScreen
      type={fillType}
      usage={target}
      onLeave={() => { router.back(); }}
      onSave={entry => save(named, fillType, entry, setShift)}
      onRemove={fillId => remove(named, fillId, setShift)}
    />
  );
}

/**
 * The use named, in the state the opener expected — or `null`. By `startedAt`
 * alone: a day may hold the same registration three times.
 */
function fillUsage(shift: LocalShift, startedAt: string, state: UsageState): FillUsage | null {
  if (state === USAGE_STATE.inUse) {
    const current = shift.vehicle;
    if (current?.startedAt !== startedAt) return null;
    return { numberPlate: current.numberPlate, hours: null, fills: current.fills };
  }
  const ended = shift.previousVehicles.find(use => use.startedAt === startedAt);
  if (ended === undefined) return null;
  return {
    numberPlate: ended.numberPlate,
    hours: `${formatClockTime(ended.startedAt)}–${formatClockTime(ended.endedAt)}`,
    fills: ended.fills,
  };
}

interface NamedUsage { shiftId: string; vehicleStartedAt: string; usageState: UsageState }
type Show = (shift: LocalShift | null) => void;

/** Store the fill, then show the day it produced — no second read. */
async function save(named: NamedUsage, type: FillType, entry: FillEntry, show: Show): Promise<void> {
  try {
    const day = await recordVehicleFill({
      ...named,
      // A correction keeps the entry's own id; a new fill gets one.
      fillId: entry.fillId ?? newLocalId(),
      type,
      recordedAt: entry.recordedAt,
      litres: entry.litres,
      note: entry.note,
    });
    settle(day, show);
  } catch (error: unknown) {
    Alert.alert("Couldn't save that", "Nothing was changed. Please try again.");
    throw error;
  }
}

async function remove(named: NamedUsage, fillId: string, show: Show): Promise<void> {
  try {
    settle(await removeVehicleFill({ ...named, fillId }), show);
  } catch (error: unknown) {
    Alert.alert("Couldn't remove that", "Nothing was changed. Please try again.");
    throw error;
  }
}

/**
 * `null` means the day or the use moved on beneath this screen — the day was
 * discarded, or the vehicle it was opened for has been handed back. Nothing
 * was written, and the driver is told so and returned to the day rather than
 * left typing into a form that can no longer store anything.
 */
function settle(day: LocalShift | null, show: Show): void {
  if (day === null) {
    Alert.alert("Nothing was saved", "That vehicle is no longer the one this was opened for.");
    router.dismissTo("/active-shift");
    return;
  }
  show(day);
}
