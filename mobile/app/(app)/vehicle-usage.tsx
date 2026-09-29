/**
 * The Vehicle Use route — one ended use, to read and correct. Wiring only.
 *
 * A Stack sibling of the tab group, so it shows no tab bar. Opened from a USED
 * THIS SHIFT row with `usage`, the use's `useId`, which is the use's
 * identity and the only thing that names it (D42). Never a plate: a day may hold the
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
import {
  USAGE_STATE,
  UseTimesError,
  correctEndMileage,
  correctStartMileage,
  correctVehicleUseTimes,
  type LocalShift,
  type UsageState,
} from "../../src/shift/localShift";
import { useTimesMessage, type UseTimes } from "../../src/screens/UseTimesEditor";
import { leaveStale, missingHref, readScreenDay, withTimesheet, withVia } from "../../src/navigation/useScreenDay";
import { saveFailureMessage } from "../../src/screens/format";

export default function VehicleUsageRoute() {
  const { usage, usageState, timesheet, via } = useLocalSearchParams<{ usage?: string; usageState?: string; timesheet?: string; via?: string }>();
  // Ended unless named otherwise: the vehicle IN USE is opened from the Finish Review (D41).
  const state: UsageState = usageState === USAGE_STATE.inUse ? USAGE_STATE.inUse : USAGE_STATE.ended;
  const [shift, setShift] = useState<LocalShift | null | "loading">("loading");

  // Re-read on every return, so fuel corrected on the fill screen shows here.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void readScreenDay(timesheet).then(open => { if (!cancelled) setShift(open); });
      return () => { cancelled = true; };
    }, [timesheet]),
  );

  if (shift === "loading") return <Restoring message="Loading shift…" />;
  if (shift === null) return <Redirect href={missingHref(timesheet, false)} />;

  const use = usage === undefined
    ? undefined
    : state === USAGE_STATE.inUse
      ? (shift.vehicle !== null && shift.vehicle.useId === usage ? shift.vehicle : undefined)
      : shift.previousVehicles.find(entry => entry.useId === usage);
  if (use === undefined) return <Redirect href={missingHref(timesheet, true)} />;

  return (
    <VehicleUsageScreen
      use={use}
      onLeave={() => { router.back(); }}
      onVehicleChecks={() => {
        router.push({ pathname: "/vehicle-check", params: withVia(withTimesheet({ usage: use.useId, usageState: state }, timesheet), via) });
      }}
      onFills={type => {
        router.push({ pathname: "/vehicle-fill", params: withVia(withTimesheet({ type, usage: use.useId, usageState: state }, timesheet), via) });
      }}
      onSaveEndMileage={endMileage => saveEndMileage(shift.id, use.useId, endMileage, setShift, timesheet)}
      onSaveTimes={times => saveTimes({ shiftId: shift.id, useId: use.useId, usageState: state, ...times }, setShift, timesheet)}
      onSaveStartMileage={startMileage => saveStartMileage({ shiftId: shift.id, vehicleUseId: use.useId, usageState: state, startMileage }, setShift, timesheet)}
      onCorrectPlate={() => {
        router.push({ pathname: "/correct-name", params: withVia(withTimesheet({ asset: "vehicle", usage: use.useId, usageState: state }, timesheet), via) });
      }}
    />
  );
}

async function saveEndMileage(
  shiftId: string,
  vehicleUseId: string,
  endMileage: number,
  show: (shift: LocalShift) => void,
  timesheet: string | undefined,
): Promise<void> {
  try {
    const day = await correctEndMileage({ shiftId, vehicleUseId, endMileage });
    if (day === null) {
      // The day was discarded beneath this screen, or the use is gone.
      Alert.alert("Nothing was saved", timesheet === undefined ? "That vehicle use is no longer part of the open shift." : "That vehicle use is no longer part of this timesheet.");
      leaveStale(timesheet);
      return;
    }
    show(day);
  } catch (error: unknown) {
    Alert.alert("Couldn't save that", saveFailureMessage(error));
    throw error;
  }
}

async function saveStartMileage(
  input: { shiftId: string; vehicleUseId: string; usageState: UsageState; startMileage: number },
  show: (shift: LocalShift) => void,
  timesheet: string | undefined,
): Promise<void> {
  try {
    const day = await correctStartMileage(input);
    if (day === null) {
      Alert.alert("Nothing was saved", "That vehicle is no longer the one this was opened for.");
      leaveStale(timesheet);
      return;
    }
    show(day);
  } catch (error: unknown) {
    Alert.alert("Couldn't save that", saveFailureMessage(error));
    throw error;
  }
}

async function saveTimes(
  input: { shiftId: string; useId: string; usageState: UsageState } & UseTimes,
  show: (shift: LocalShift) => void,
  timesheet: string | undefined,
): Promise<void> {
  try {
    const day = await correctVehicleUseTimes(input);
    if (day === null) {
      Alert.alert("Nothing was saved", "That vehicle is no longer the one this was opened for.");
      leaveStale(timesheet);
      return;
    }
    show(day);
  } catch (error: unknown) {
    Alert.alert("Couldn't save those times", error instanceof UseTimesError ? useTimesMessage(error.problem) : saveFailureMessage(error));
    throw error;
  }
}
