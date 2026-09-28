/**
 * The Vehicle Use route — one ended use, to read and correct. Wiring only.
 *
 * A Stack sibling of the tab group, so it shows no tab bar. Opened from a USED
 * THIS SHIFT row with `usage`, the use's `startedAt`, which is the use's
 * identity and the only thing that names it. Never a plate: a day may hold the
 * same registration three times, and they are three different records.
 *
 * A `usage` that names no ENDED use of the open day is not a screen — it goes
 * back to Active Shift rather than showing, or correcting, another use. With no
 * open day it goes Home.
 *
 * Works whether or not a vehicle is in use now (D31, D32).
 */
import { useCallback, useState } from "react";
import { Alert } from "react-native";
import { Redirect, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { VehicleUsageScreen } from "../../src/screens/VehicleUsageScreen";
import { Restoring } from "../../src/components/Restoring";
import { USAGE_STATE, correctEndMileage, readOpenShift, type LocalShift } from "../../src/shift/localShift";
import { saveFailureMessage } from "../../src/screens/format";

export default function VehicleUsageRoute() {
  const { usage } = useLocalSearchParams<{ usage?: string }>();
  const [shift, setShift] = useState<LocalShift | null | "loading">("loading");

  // Re-read on every return, so fuel corrected on the fill screen shows here.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void readOpenShift().then(open => { if (!cancelled) setShift(open); });
      return () => { cancelled = true; };
    }, []),
  );

  if (shift === "loading") return <Restoring message="Loading shift…" />;
  if (shift === null) return <Redirect href="/today" />;

  const use = usage === undefined ? undefined : shift.previousVehicles.find(entry => entry.startedAt === usage);
  if (use === undefined) return <Redirect href="/active-shift" />;

  return (
    <VehicleUsageScreen
      use={use}
      onLeave={() => { router.back(); }}
      onVehicleChecks={() => {
        router.push({ pathname: "/vehicle-check", params: { usage: use.startedAt, usageState: USAGE_STATE.ended } });
      }}
      onFills={type => {
        router.push({ pathname: "/vehicle-fill", params: { type, usage: use.startedAt, usageState: USAGE_STATE.ended } });
      }}
      onSaveEndMileage={endMileage => saveEndMileage(shift.id, use.startedAt, endMileage, setShift)}
    />
  );
}

async function saveEndMileage(
  shiftId: string,
  vehicleStartedAt: string,
  endMileage: number,
  show: (shift: LocalShift) => void,
): Promise<void> {
  try {
    const day = await correctEndMileage({ shiftId, vehicleStartedAt, endMileage });
    if (day === null) {
      // The day was discarded beneath this screen, or the use is gone.
      Alert.alert("Nothing was saved", "That vehicle use is no longer part of the open shift.");
      router.dismissTo("/active-shift");
      return;
    }
    show(day);
  } catch (error: unknown) {
    Alert.alert("Couldn't save that", saveFailureMessage(error));
    throw error;
  }
}
