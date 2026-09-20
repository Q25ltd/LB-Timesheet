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
 */
import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { Redirect, router } from "expo-router";
import { ChangeVehicleScreen, type VehicleChange } from "../../src/screens/ChangeVehicleScreen";
import { Restoring } from "../../src/components/Restoring";
import { changeVehicle, readOpenShift, type LocalShift, type LocalVehicle } from "../../src/shift/localShift";
import { usedThisShift } from "../../src/shift/usedVehicles";

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
      onLeave={() => { router.back(); }}
      onConfirm={change => confirm(shift, current, change)}
    />
  );
}

/**
 * Write the change, then go where the driver goes next.
 *
 * The moment of the press ends the vehicle in use and begins the next one —
 * the same instant for both; see `changeVehicle`.
 */
async function confirm(shift: LocalShift, current: LocalVehicle, change: VehicleChange): Promise<void> {
  const noun = current.vehicleClass === "class1" ? "unit" : "vehicle";
  try {
    const day = await changeVehicle({
      shiftId: shift.id,
      endingStartedAt: current.startedAt,
      endMileage: change.endMileage,
      next: change.next,
      changedAt: new Date(),
    });
    // The day was discarded or finished while this screen was open.
    if (day === null) { router.replace("/today"); return; }
    if (change.performChecks) router.replace("/vehicle-check");
    else router.dismissTo("/active-shift");
  } catch (error: unknown) {
    Alert.alert(`Couldn't change the ${noun}`, "Nothing was changed. Please try again.");
    throw error;
  }
}
