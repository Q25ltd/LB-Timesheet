/**
 * The Change Unit / Change Vehicle route. Wiring only.
 *
 * A Stack sibling of the tab group, like Add Vehicle, so it shows no tab bar
 * and sits inside the `(app)` gate.
 *
 * ONLY FOR A DAY WITH A VEHICLE IN USE: with no open day it goes to Home, and
 * with no vehicle — there is nothing to end — back to Active Shift, where Add
 * Vehicle is.
 *
 * After the change: to Vehicle Checks for the NEW vehicle when the driver
 * chose to check a vehicle they are returning to, otherwise back to Active
 * Shift. Vehicle Checks replaces this screen, so its Back lands on the day.
 *
 * TWO STORE OPERATIONS, ONE SCREEN. A next vehicle is a change
 * (`changeVehicle`); no next vehicle is an end (`endVehicleUse`, D32). The
 * screen asks; which one is written is decided here, by whether the driver
 * named a vehicle. Both land back on Active Shift, which then shows either the
 * new vehicle or no active vehicle.
 */
import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { Redirect, router } from "expo-router";
import { ChangeVehicleScreen, type VehicleChange } from "../../src/screens/ChangeVehicleScreen";
import { Restoring } from "../../src/components/Restoring";
import {
  USAGE_STATE,
  UseEndsBeforeItStartedError,
  changeVehicle,
  endVehicleUse,
  readOpenShift,
  type LocalShift,
  type LocalVehicle,
} from "../../src/shift/localShift";
import { usedThisShift } from "../../src/shift/usedVehicles";
import { saveFailureMessage } from "../../src/screens/format";

export default function ChangeVehicleRoute() {
  const [shift, setShift] = useState<LocalShift | null | "loading">("loading");

  useEffect(() => {
    let cancelled = false;
    void readOpenShift().then(open => { if (!cancelled) setShift(open); });
    return () => { cancelled = true; };
  }, []);

  // Reading the phone's own shift file — not signing anyone in.
  if (shift === "loading") return <Restoring message="Loading shift…" />;
  if (shift === null) return <Redirect href="/today" />;
  if (shift.vehicle === null) return <Redirect href="/active-shift" />;

  const current = shift.vehicle;
  return (
    <ChangeVehicleScreen
      current={current}
      candidates={usedThisShift(shift)}
      trailerInUse={shift.trailer?.trailerNumber ?? null}
      onLeave={() => { router.back(); }}
      onConfirm={change => confirm(shift, current, change)}
    />
  );
}

/**
 * Write the change, then go where the driver goes next.
 *
 * The moment of the press ends the vehicle in use and begins the next one —
 * the same instant for both; see `changeVehicle`. With NO next vehicle that
 * moment only ends one: nothing begins, and a vehicle added later starts its
 * own use then (`endVehicleUse`).
 */
async function confirm(shift: LocalShift, current: LocalVehicle, change: VehicleChange): Promise<void> {
  const noun = current.vehicleClass === "class1" ? "unit" : "vehicle";
  const next = change.next;
  const at = new Date();
  try {
    const day = next === null
      ? await endVehicleUse({
          shiftId: shift.id,
          endingUseId: current.useId,
          endMileage: change.endMileage,
          endedAt: at,
        })
      : await changeVehicle({
          shiftId: shift.id,
          endingUseId: current.useId,
          endMileage: change.endMileage,
          next,
          changedAt: at,
        });
    // The day was discarded or finished while this screen was open.
    if (day === null) { router.replace("/today"); return; }
    // The store applies a change only while the vehicle on screen is still the
    // one in use; otherwise it returns the day untouched. Success is the named
    // use having ended AT THIS PRESS — ended by something else is a screen that
    // went stale, and the driver is told rather than shown success, or a check
    // for another vehicle.
    const endedHere = day.previousVehicles.some(use => use.useId === current.useId && use.endedAt === at.toISOString());
    if (!endedHere) {
      Alert.alert("Nothing was saved", `That ${noun} is no longer the one in use.`);
      router.dismissTo("/active-shift");
      return;
    }
    // The check opens for EXACTLY the use just begun.
    if (change.performChecks && day.vehicle !== null) {
      router.replace({ pathname: "/vehicle-check", params: { usage: day.vehicle.useId, usageState: USAGE_STATE.inUse } });
    } else {
      router.dismissTo("/active-shift");
    }
  } catch (error: unknown) {
    Alert.alert(
      next === null ? `Couldn't end the ${noun}` : `Couldn't change the ${noun}`,
      // The phone's clock went back since this use began. Never corrected
      // here: the driver fixes the clock, and nothing was written.
      error instanceof UseEndsBeforeItStartedError
        ? `The phone's clock is earlier than when this ${noun} started. Nothing was changed. Check the phone's date and time, then try again.`
        : saveFailureMessage(error),
    );
    throw error;
  }
}
